import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizedDiagnosticSignature } from "../core/signature.js";
import type {
  AssumptionAlternative,
  AssumptionRecord,
  AssumptionStatus,
  BlastRadius,
  CheckpointRecord,
  CorrectionRecord,
  CorrectionScopeExpansion,
  DecisionRecord,
  EventRecord,
  FailureRecord,
  GraphEdge,
  GraphNode,
  PhaseDefinition,
  PhaseRecord,
  PhaseStatus,
  ProjectContract,
  ProjectRecord,
  ProjectSnapshot,
  ProjectStatus,
  VerificationEvidence
} from "../domain/model.js";

type Row = Record<string, unknown>;

export class ProjectStore {
  readonly projectRoot: string;
  readonly databasePath: string;
  protected readonly db: DatabaseSync;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
    const stateDirectory = path.join(this.projectRoot, ".keep-coding");
    mkdirSync(stateDirectory, { recursive: true });
    this.databasePath = path.join(stateDirectory, "state.db");
    this.db = new DatabaseSync(this.databasePath);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  initialize(originalPrompt: string): ProjectRecord {
    const existing = this.getProject();
    if (existing) return existing;
    const now = new Date().toISOString();
    const id = createHash("sha256").update(this.projectRoot).digest("hex").slice(0, 16);
    this.db.prepare(`
      INSERT INTO project (id, root, original_prompt, status, contract_json, plan_version, current_phase_id, created_at, updated_at)
      VALUES (?, ?, ?, 'PLANNING', NULL, 0, NULL, ?, ?)
    `).run(id, this.projectRoot, originalPrompt.trim(), now, now);
    this.appendEvent("project_initialized", null, { promptHash: sha256(originalPrompt) });
    return must(this.getProject(), "project initialization failed");
  }

  getProject(): ProjectRecord | null {
    const row = this.db.prepare("SELECT * FROM project LIMIT 1").get() as Row | undefined;
    return row ? projectFromRow(row) : null;
  }

  savePlan(contract: ProjectContract, definitions: PhaseDefinition[]): ProjectSnapshot {
    validateContract(contract);
    validatePlan(definitions);
    const project = must(this.getProject(), "initialize the project before saving a plan");
    const existing = this.listPhases();
    if (existing.some((phase) => !["PENDING", "READY"].includes(phase.status))) {
      throw new Error("The plan cannot be replaced after implementation has started; record an explicit decision instead.");
    }

    this.transaction(() => {
      this.db.exec("DELETE FROM phases; DELETE FROM graph_edges WHERE type IN ('depends_on', 'implements'); DELETE FROM graph_nodes WHERE type IN ('phase', 'requirement');");
      const insert = this.db.prepare(`
        INSERT INTO phases (
          id, ordinal, title, goal, status, dependencies_json, allowed_scope_json,
          acceptance_commands_json, max_attempts, attempts, started_at, completed_at,
          base_sha, head_sha, summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL)
      `);
      definitions.forEach((phase, ordinal) => {
        const status: PhaseStatus = phase.dependencies.length === 0 ? "READY" : "PENDING";
        insert.run(
          phase.id,
          ordinal,
          phase.title,
          phase.goal,
          status,
          JSON.stringify(phase.dependencies),
          JSON.stringify(phase.allowedScope),
          JSON.stringify(phase.acceptanceCommands),
          phase.maxAttempts
        );
        this.upsertGraphNode({
          id: `phase:${phase.id}`,
          type: "phase",
          label: phase.title,
          path: null,
          symbol: null,
          contentHash: sha256(JSON.stringify(phase)),
          metadata: { goal: phase.goal, ordinal }
        });
        for (const dependency of phase.dependencies) {
          this.upsertGraphEdge({
            sourceId: `phase:${phase.id}`,
            targetId: `phase:${dependency}`,
            type: "depends_on",
            metadata: {}
          });
        }
      });
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE project SET contract_json = ?, plan_version = ?, status = 'ACTIVE',
          current_phase_id = ?, updated_at = ?
      `).run(JSON.stringify(contract), project.planVersion + 1, definitions.find((phase) => phase.dependencies.length === 0)?.id ?? null, now);
      this.appendEvent("plan_saved", null, { phaseCount: definitions.length, planVersion: project.planVersion + 1 });
    });
    return this.snapshot();
  }

  listPhases(): PhaseRecord[] {
    return (this.db.prepare("SELECT * FROM phases ORDER BY ordinal").all() as Row[]).map(phaseFromRow);
  }

  getPhase(id: string): PhaseRecord | null {
    const row = this.db.prepare("SELECT * FROM phases WHERE id = ?").get(id) as Row | undefined;
    return row ? phaseFromRow(row) : null;
  }

  currentPhase(): PhaseRecord | null {
    const project = this.getProject();
    return project?.currentPhaseId ? this.getPhase(project.currentPhaseId) : null;
  }

  startPhase(id: string, baseSha: string): PhaseRecord {
    const phase = must(this.getPhase(id), `unknown phase: ${id}`);
    if (!["READY", "FAILED"].includes(phase.status)) {
      throw new Error(`phase ${id} cannot start from ${phase.status}`);
    }
    const dependencies = phase.dependencies.map((dependency) => must(this.getPhase(dependency), `missing dependency: ${dependency}`));
    if (dependencies.some((dependency) => dependency.status !== "COMPLETED")) {
      throw new Error(`phase ${id} has unfinished dependencies`);
    }
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE phases SET status = 'IN_PROGRESS', started_at = COALESCE(started_at, ?), base_sha = COALESCE(base_sha, ?) WHERE id = ?`)
      .run(now, baseSha, id);
    this.db.prepare("UPDATE project SET status = 'ACTIVE', current_phase_id = ?, updated_at = ?").run(id, now);
    this.appendEvent("phase_started", id, { baseSha });
    return must(this.getPhase(id), "phase start failed");
  }

  markVerifying(id: string): void {
    const phase = must(this.getPhase(id), `unknown phase: ${id}`);
    if (phase.status !== "IN_PROGRESS") throw new Error(`phase ${id} is not in progress`);
    this.db.prepare("UPDATE phases SET status = 'VERIFYING' WHERE id = ?").run(id);
    this.appendEvent("phase_verification_started", id, {});
  }

  finishVerification(id: string, summary: string, evidence: VerificationEvidence): PhaseRecord {
    const phase = must(this.getPhase(id), `unknown phase: ${id}`);
    if (phase.status !== "VERIFYING") throw new Error(`phase ${id} is not being verified`);
    const now = new Date().toISOString();
    if (!evidence.passed) {
      const attempts = phase.attempts + 1;
      const status: PhaseStatus = attempts >= phase.maxAttempts ? "BLOCKED" : "FAILED";
      this.db.prepare("UPDATE phases SET status = ?, attempts = ?, summary = ? WHERE id = ?")
        .run(status, attempts, summary, id);
      if (status === "BLOCKED") {
        this.db.prepare("UPDATE project SET status = 'BLOCKED', updated_at = ?").run(now);
      }
      this.appendEvent("phase_verification_failed", id, {
        attempts,
        status,
        scopeViolations: evidence.scopeViolations,
        failedCommands: evidence.commands.filter((command) => !command.passed).map((command) => command.command)
      });
      return must(this.getPhase(id), "phase failure update failed");
    }

    this.transaction(() => {
      this.db.prepare(`
        UPDATE phases SET status = 'COMPLETED', completed_at = ?, head_sha = ?, summary = ? WHERE id = ?
      `).run(now, evidence.gitSha, summary, id);
      const checkpointId = randomUUID();
      this.db.prepare(`
        INSERT INTO checkpoints (id, phase_id, git_sha, summary, changed_files_json, verification_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(checkpointId, id, evidence.gitSha, summary, JSON.stringify(evidence.changedFiles), JSON.stringify(evidence), now);
      for (const file of evidence.changedFiles) {
        this.upsertGraphEdge({
          sourceId: `phase:${id}`,
          targetId: `file:${file}`,
          type: "modifies",
          metadata: { checkpointId, diffHash: evidence.diffHash }
        });
      }
      this.promoteReadyPhases();
      const phases = this.listPhases();
      const next = phases.find((candidate) => candidate.status === "READY") ?? null;
      const status: ProjectStatus = phases.every((candidate) => candidate.status === "COMPLETED") ? "READY_TO_COMPLETE" : "ACTIVE";
      this.db.prepare("UPDATE project SET status = ?, current_phase_id = ?, updated_at = ?").run(status, next?.id ?? null, now);
      this.appendEvent("phase_completed", id, { checkpointId, changedFiles: evidence.changedFiles, nextPhaseId: next?.id ?? null });
    });
    return must(this.getPhase(id), "phase completion update failed");
  }

  completeProject(): ProjectRecord {
    const phases = this.listPhases();
    if (phases.length === 0 || phases.some((phase) => phase.status !== "COMPLETED")) {
      throw new Error("all planned phases must be verified before project completion");
    }
    const now = new Date().toISOString();
    this.db.prepare("UPDATE project SET status = 'COMPLETED', current_phase_id = NULL, updated_at = ?").run(now);
    this.appendEvent("project_completed", null, { phaseCount: phases.length });
    return must(this.getProject(), "project completion failed");
  }


  recordAssumption(input: { phaseId: string | null; statement: string; confidence: number; alternatives: AssumptionAlternative[] }): string {
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new Error("INVALID_CONFIDENCE: confidence must be a finite number in [0, 1]");
    }
    if (!Array.isArray(input.alternatives)) throw new Error("INVALID_ALTERNATIVES: alternatives must be an array");
    if (input.phaseId !== null) must(this.getPhase(input.phaseId), `unknown phase: ${input.phaseId}`);
    const statement = input.statement.trim();
    if (!statement) throw new Error("assumption statement is required");
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO assumptions (id, phase_id, statement, confidence, alternatives_json, status, created_at, resolved_at, resolution_evidence, explicit_linked_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, NULL, NULL, NULL)
    `).run(id, input.phaseId, statement, input.confidence, JSON.stringify(input.alternatives), createdAt);
    this.upsertGraphNode({
      id, type: "assumption", label: statement, path: null, symbol: null, contentHash: sha256(statement),
      metadata: { phaseId: input.phaseId, confidence: input.confidence, alternatives: input.alternatives, status: "open" }
    });
    if (input.phaseId) this.upsertGraphEdge({ sourceId: `phase:${input.phaseId}`, targetId: id, type: "implements", metadata: { entity: "assumption" } });
    this.appendEvent("assumption_recorded", input.phaseId, { id, statement, confidence: input.confidence });
    return id;
  }

  getAssumption(id: string): AssumptionRecord | null {
    const row = this.db.prepare("SELECT * FROM assumptions WHERE id = ?").get(id) as Row | undefined;
    return row ? assumptionFromRow(row) : null;
  }

  listAssumptions(phaseId?: string | null, status?: AssumptionStatus): AssumptionRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (phaseId !== undefined) { clauses.push(phaseId === null ? "phase_id IS NULL" : "phase_id = ?"); if (phaseId !== null) values.push(phaseId); }
    if (status !== undefined) { clauses.push("status = ?"); values.push(status); }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM assumptions${where} ORDER BY confidence ASC, created_at ASC`).all(...values) as Row[]).map(assumptionFromRow);
  }

  setAssumptionStatus(id: string, status: AssumptionStatus, evidence = ""): AssumptionRecord {
    const current = must(this.getAssumption(id), `unknown assumption: ${id}`);
    if (current.status !== "open") throw new Error(`one-way transition: ${current.status} -> ${status} is not allowed`);
    if (status === "open") return current;
    const resolvedAt = new Date().toISOString();
    this.db.prepare("UPDATE assumptions SET status = ?, resolved_at = ?, resolution_evidence = ? WHERE id = ?")
      .run(status, resolvedAt, evidence.trim() || null, id);
    const node = this.getGraphNode(id);
    if (node) this.upsertGraphNode({ ...node, metadata: { ...node.metadata, status, resolvedAt } });
    this.appendEvent(status === "confirmed" ? "assumption_confirmed" : "assumption_invalidated", current.phaseId, { id, evidence: evidence.trim() });
    return must(this.getAssumption(id), "assumption status update failed");
  }

  confirmAssumption(id: string, evidence: string): AssumptionRecord { return this.setAssumptionStatus(id, "confirmed", evidence); }

  linkAssumption(assumptionId: string, nodeIds: string[], explicit = true): number {
    const assumption = must(this.getAssumption(assumptionId), `unknown assumption: ${assumptionId}`);
    if (assumption.status !== "open") throw new Error(`assumption ${assumptionId} is ${assumption.status}`);
    let linked = 0;
    for (const requested of [...new Set(nodeIds)]) {
      const nodeId = this.resolveGraphNodeId(requested);
      if (!nodeId) throw new Error(`unknown graph node: ${requested}`);
      this.upsertGraphEdge({ sourceId: assumptionId, targetId: nodeId, type: "depends_on_assumption", metadata: { explicit } });
      linked += 1;
    }
    if (explicit) this.db.prepare("UPDATE assumptions SET explicit_linked_at = ? WHERE id = ?").run(new Date().toISOString(), assumptionId);
    this.appendEvent(explicit ? "assumption_linked" : "assumption_auto_linked", assumption.phaseId, { assumptionId, nodeIds, linked });
    return linked;
  }

  autoLinkChangedFiles(phaseId: string, changedFiles: string[]): number {
    const candidates = this.listAssumptions(phaseId, "open").filter((item) => item.explicitLinkedAt === null);
    if (candidates.length !== 1 || changedFiles.length === 0) return 0;
    const nodeIds = changedFiles.map((file) => {
      const normalized = file.replaceAll("\\", "/").replace(/^\.\//u, "");
      const id = `file:${normalized}`;
      if (!this.getGraphNode(id)) this.upsertGraphNode({ id, type: "file", label: normalized, path: normalized, symbol: null, contentHash: null, metadata: { autoLinked: true } });
      return id;
    });
    return this.linkAssumption(candidates[0]!.id, nodeIds, false);
  }

  getGraphNode(id: string): GraphNode | null {
    const row = this.db.prepare("SELECT * FROM graph_nodes WHERE id = ? AND active = 1").get(id) as Row | undefined;
    return row ? graphNodeFromRow(row) : null;
  }

  getEdgesFrom(sourceId: string, type?: GraphEdge["type"]): GraphEdge[] {
    const rows = type
      ? this.db.prepare("SELECT * FROM graph_edges WHERE source_id = ? AND type = ? ORDER BY target_id").all(sourceId, type)
      : this.db.prepare("SELECT * FROM graph_edges WHERE source_id = ? ORDER BY type, target_id").all(sourceId);
    return (rows as Row[]).map(graphEdgeFromRow);
  }

  addEdge(sourceId: string, targetId: string, type: GraphEdge["type"], metadata: Record<string, unknown> = {}): void {
    this.upsertGraphEdge({ sourceId, targetId, type, metadata });
  }

  computeBlastRadius(assumptionId: string, options: { maxHops?: number } = {}): BlastRadius {
    must(this.getAssumption(assumptionId), `unknown assumption: ${assumptionId}`);
    const maxHops = Math.max(0, Math.min(options.maxHops ?? 3, 12));
    const direct = this.getEdgesFrom(assumptionId, "depends_on_assumption").map((edge) => edge.targetId);
    if (direct.length === 0) return { nodeIds: [], files: [], decisionIds: [] };
    const visited = new Set<string>();
    const queue = direct.map((id) => ({ id, depth: 0 }));
    while (queue.length > 0 && visited.size < 2_000) {
      const current = queue.shift()!;
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      if (current.depth >= maxHops) continue;
      for (const edge of this.getEdgesFrom(current.id)) {
        if (edge.type === "depends_on_assumption") continue;
        if (!visited.has(edge.targetId)) queue.push({ id: edge.targetId, depth: current.depth + 1 });
      }
    }
    const nodes = [...visited].map((id) => this.getGraphNode(id)).filter((node): node is GraphNode => node !== null);
    const files = [...new Set(nodes.map((node) => node.path).filter((value): value is string => Boolean(value)))].sort();
    const decisionIds = [...new Set(nodes.filter((node) => node.type === "decision").map((node) => node.id.replace(/^decision:/u, "")))].sort();
    return { nodeIds: [...visited].sort(), files, decisionIds };
  }

  invalidateAssumption(id: string, rootCause: string, maxHops = 3, tokenStart = 0): CorrectionRecord {
    const assumption = must(this.getAssumption(id), `unknown assumption: ${id}`);
    if (assumption.status !== "open") throw new Error(`assumption ${id} is already ${assumption.status}`);
    const cause = rootCause.trim();
    if (!cause) throw new Error("root cause is required");
    const blastRadius = this.computeBlastRadius(id, { maxHops });
    const correctionId = randomUUID();
    const appliedAt = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("UPDATE assumptions SET status='invalidated',resolved_at=?,resolution_evidence=? WHERE id=?").run(appliedAt, cause, id);
      this.db.prepare(`
        INSERT INTO corrections (id, assumption_id, phase_id, root_cause, blast_radius_json, blast_radius_size, applied_at, outcome, expansions_json, completed_at, token_start, token_end)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '[]', NULL, ?, NULL)
      `).run(correctionId, id, assumption.phaseId, cause, JSON.stringify(blastRadius), blastRadius.nodeIds.length, appliedAt, tokenStart);
      this.appendEvent("assumption_invalidated", assumption.phaseId, { id, rootCause: cause, correctionId });
      this.appendEvent("correction_recorded", assumption.phaseId, { correctionId, assumptionId: id, blastRadiusSize: blastRadius.nodeIds.length });
    });
    return must(this.getCorrection(correctionId), "correction insert failed");
  }

  getCorrection(id: string): CorrectionRecord | null {
    const row = this.db.prepare("SELECT * FROM corrections WHERE id = ?").get(id) as Row | undefined;
    return row ? correctionFromRow(row) : null;
  }

  listCorrections(phaseId?: string | null): CorrectionRecord[] {
    if (phaseId === undefined) return (this.db.prepare("SELECT * FROM corrections ORDER BY applied_at").all() as Row[]).map(correctionFromRow);
    const rows = phaseId === null
      ? this.db.prepare("SELECT * FROM corrections WHERE phase_id IS NULL ORDER BY applied_at").all()
      : this.db.prepare("SELECT * FROM corrections WHERE phase_id = ? ORDER BY applied_at").all(phaseId);
    return (rows as Row[]).map(correctionFromRow);
  }

  activeCorrection(phaseId: string): CorrectionRecord | null {
    const row = this.db.prepare("SELECT * FROM corrections WHERE phase_id = ? AND completed_at IS NULL ORDER BY applied_at DESC LIMIT 1").get(phaseId) as Row | undefined;
    return row ? correctionFromRow(row) : null;
  }

  expandCorrectionScope(id: string, additionalNodeIds: string[], justification: string): CorrectionRecord {
    const correction = must(this.getCorrection(id), `unknown correction: ${id}`);
    const reason = justification.trim();
    if (!reason) throw new Error("justification must be non-empty");
    const normalized = [...new Set(additionalNodeIds.map((nodeId) => this.resolveGraphNodeId(nodeId) ?? nodeId))];
    for (const nodeId of normalized) if (!this.getGraphNode(nodeId)) throw new Error(`unknown graph node: ${nodeId}`);
    const expansion: CorrectionScopeExpansion = { nodeIds: normalized, justification: reason, expandedAt: new Date().toISOString() };
    const expansions = [...correction.expansions, expansion];
    this.db.prepare("UPDATE corrections SET expansions_json = ? WHERE id = ?").run(JSON.stringify(expansions), id);
    this.appendEvent("correction_scope_expanded", correction.phaseId, { correctionId: id, nodeIds: normalized, justification: reason });
    return must(this.getCorrection(id), "correction expansion failed");
  }

  assessCorrectionOutcome(id: string, changedFiles: string[], tokenEnd: number, complete: boolean): { correction: CorrectionRecord; unauthorizedFiles: string[] } {
    const correction = must(this.getCorrection(id), `unknown correction: ${id}`);
    const original = new Set(correction.blastRadius.files);
    const expandedFiles = new Set(correction.expansions.flatMap((item) => item.nodeIds.map((nodeId) => this.getGraphNode(nodeId)?.path).filter((value): value is string => Boolean(value))));
    const excess = changedFiles.filter((file) => !original.has(file));
    const unauthorizedFiles = excess.filter((file) => !expandedFiles.has(file));
    const outcome = excess.length === 0 ? "contained" : "expanded";
    const completedAt = complete && unauthorizedFiles.length === 0 ? new Date().toISOString() : null;
    this.db.prepare("UPDATE corrections SET outcome = ?, completed_at = ?, token_end = ? WHERE id = ?").run(outcome, completedAt, tokenEnd, id);
    this.appendEvent(unauthorizedFiles.length === 0 ? "correction_outcome_recorded" : "correction_scope_violation", correction.phaseId, {
      correctionId: id, outcome, changedFiles, unauthorizedFiles, complete: completedAt !== null
    });
    return { correction: must(this.getCorrection(id), "correction outcome update failed"), unauthorizedFiles };
  }

  correctionAllowedFiles(id: string): string[] {
    const correction = must(this.getCorrection(id), `unknown correction: ${id}`);
    const expanded = correction.expansions.flatMap((item) => item.nodeIds.map((nodeId) => this.getGraphNode(nodeId)?.path).filter((value): value is string => Boolean(value)));
    return [...new Set([...correction.blastRadius.files, ...expanded])].sort();
  }

  correctionRecordedSince(sequence: number): boolean {
    const row = this.db.prepare("SELECT 1 AS found FROM events WHERE sequence > ? AND type IN ('assumption_invalidated','correction_recorded') LIMIT 1").get(sequence) as Row | undefined;
    return Boolean(row);
  }

  lastCheckpointEventSequence(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE type IN ('phase_completed','phase_verification_failed')").get() as Row;
    return Number(row.sequence);
  }

  recordAntiPatternHits(phaseId: string | null, patternIds: string[]): number {
    let recorded = 0;
    for (const patternId of [...new Set(patternIds)]) {
      const key = `anti_pattern_hit:${phaseId ?? "project"}:${patternId}`;
      const result = this.db.prepare("INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)").run(key, new Date().toISOString());
      if (Number(result.changes) === 0) continue;
      recorded += 1;
      this.appendEvent("anti_pattern_warning_fired", phaseId, { patternId });
    }
    return recorded;
  }

  countAntiPatternHits(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM metadata WHERE key LIKE 'anti_pattern_hit:%'").get() as Row;
    return Number(row.count);
  }

  totalRecordedTokens(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(tokens),0) AS tokens FROM budget_usage WHERE scope = 'project'").get() as Row | undefined;
    return Number(row?.tokens ?? 0);
  }

  private resolveGraphNodeId(requested: string): string | null {
    if (this.getGraphNode(requested)) return requested;
    if (this.getGraphNode(`decision:${requested}`)) return `decision:${requested}`;
    if (this.getGraphNode(`file:${requested.replaceAll("\\", "/").replace(/^\.\//u, "")}`)) return `file:${requested.replaceAll("\\", "/").replace(/^\.\//u, "")}`;
    return null;
  }

  recordDecision(input: Omit<DecisionRecord, "id" | "status" | "createdAt">): DecisionRecord {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO decisions (id, phase_id, title, rationale, alternatives_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?)
    `).run(id, input.phaseId, input.title.trim(), input.rationale.trim(), JSON.stringify(input.alternatives), createdAt);
    this.upsertGraphNode({
      id: `decision:${id}`,
      type: "decision",
      label: input.title.trim(),
      path: null,
      symbol: null,
      contentHash: sha256(input.rationale),
      metadata: { phaseId: input.phaseId, alternatives: input.alternatives }
    });
    if (input.phaseId) {
      this.upsertGraphEdge({ sourceId: `phase:${input.phaseId}`, targetId: `decision:${id}`, type: "implements", metadata: {} });
    }
    this.appendEvent("decision_recorded", input.phaseId, { id, title: input.title });
    return must(this.getDecision(id), "decision insert failed");
  }

  recordFailure(phaseId: string, summary: string, fingerprint?: string): FailureRecord {
    must(this.getPhase(phaseId), `unknown phase: ${phaseId}`);
    const normalizedFingerprint = fingerprint?.trim() || normalizedDiagnosticSignature(summary);
    const existing = this.db.prepare("SELECT * FROM failures WHERE phase_id = ? AND fingerprint = ?")
      .get(phaseId, normalizedFingerprint) as Row | undefined;
    const now = new Date().toISOString();
    if (existing) {
      this.db.prepare("UPDATE failures SET count = count + 1, summary = ?, last_seen_at = ? WHERE id = ?")
        .run(summary.trim(), now, String(existing.id));
      this.appendEvent("failure_repeated", phaseId, { fingerprint: normalizedFingerprint, count: Number(existing.count) + 1 });
      return must(this.getFailure(String(existing.id)), "failure update failed");
    }
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO failures (id, phase_id, fingerprint, summary, count, last_seen_at, resolution)
      VALUES (?, ?, ?, ?, 1, ?, NULL)
    `).run(id, phaseId, normalizedFingerprint, summary.trim(), now);
    this.appendEvent("failure_recorded", phaseId, { fingerprint: normalizedFingerprint });
    return must(this.getFailure(id), "failure insert failed");
  }

  listDecisions(): DecisionRecord[] {
    return (this.db.prepare("SELECT * FROM decisions ORDER BY created_at").all() as Row[]).map(decisionFromRow);
  }

  listFailures(): FailureRecord[] {
    return (this.db.prepare("SELECT * FROM failures ORDER BY last_seen_at").all() as Row[]).map(failureFromRow);
  }

  listCheckpoints(): CheckpointRecord[] {
    return (this.db.prepare("SELECT * FROM checkpoints ORDER BY created_at").all() as Row[]).map(checkpointFromRow);
  }

  recentEvents(limit = 30): EventRecord[] {
    return (this.db.prepare("SELECT * FROM events ORDER BY sequence DESC LIMIT ?").all(limit) as Row[])
      .map(eventFromRow)
      .reverse();
  }

  snapshot(): ProjectSnapshot {
    return {
      project: must(this.getProject(), "project is not initialized"),
      phases: this.listPhases(),
      decisions: this.listDecisions(),
      assumptions: this.listAssumptions(),
      corrections: this.listCorrections(),
      failures: this.listFailures(),
      checkpoints: this.listCheckpoints(),
      recentEvents: this.recentEvents()
    };
  }

  appendEvent(type: string, phaseId: string | null, payload: Record<string, unknown>): number {
    const result = this.db.prepare("INSERT INTO events (timestamp, type, phase_id, payload_json) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), type, phaseId, JSON.stringify(payload));
    return Number(result.lastInsertRowid);
  }

  latestEventSequence(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events").get() as Row;
    return Number(row.sequence);
  }

  lastStopProgressSequence(): number {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key = 'last_stop_progress_sequence'").get() as Row | undefined;
    return row ? Number(row.value) : 0;
  }

  setLastStopProgressSequence(sequence: number): void {
    this.db.prepare(`
      INSERT INTO metadata (key, value) VALUES ('last_stop_progress_sequence', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(sequence));
  }

  getPhaseBaseline(phaseId: string): Record<string, string> | null {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(`phase_baseline:${phaseId}`) as Row | undefined;
    return row ? JSON.parse(asText(row.value)) as Record<string, string> : null;
  }

  setPhaseBaseline(phaseId: string, baseline: Record<string, string>): void {
    this.db.prepare("INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)")
      .run(`phase_baseline:${phaseId}`, JSON.stringify(baseline));
  }

  upsertGraphNode(node: GraphNode): void {
    this.db.prepare(`
      INSERT INTO graph_nodes (id, type, label, path, symbol, content_hash, metadata_json, updated_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET type = excluded.type, label = excluded.label, path = excluded.path,
        symbol = excluded.symbol, content_hash = excluded.content_hash, metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at, active = 1
    `).run(node.id, node.type, node.label, node.path, node.symbol, node.contentHash, JSON.stringify(node.metadata), new Date().toISOString());
  }

  upsertGraphEdge(edge: GraphEdge): void {
    this.db.prepare(`
      INSERT INTO graph_edges (source_id, target_id, type, metadata_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_id, target_id, type) DO UPDATE SET metadata_json = excluded.metadata_json, updated_at = excluded.updated_at
    `).run(edge.sourceId, edge.targetId, edge.type, JSON.stringify(edge.metadata), new Date().toISOString());
  }

  clearFileGraph(): void {
    this.db.exec("DELETE FROM graph_edges WHERE type != 'depends_on_assumption' AND (source_id LIKE 'file:%' OR target_id LIKE 'file:%' OR source_id LIKE 'symbol:%' OR target_id LIKE 'symbol:%'); DELETE FROM graph_nodes WHERE type IN ('file', 'symbol');");
  }

  searchGraph(terms: string[], limit = 30): GraphNode[] {
    if (terms.length === 0) return [];
    const clauses = terms.slice(0, 8).map(() => "(LOWER(label) LIKE ? OR LOWER(COALESCE(path, '')) LIKE ?)").join(" OR ");
    const values = terms.slice(0, 8).flatMap((term) => [`%${term.toLowerCase()}%`, `%${term.toLowerCase()}%`]);
    return (this.db.prepare(`SELECT * FROM graph_nodes WHERE active = 1 AND (${clauses}) ORDER BY type, label LIMIT ?`)
      .all(...values, limit) as Row[]).map(graphNodeFromRow);
  }

  private getDecision(id: string): DecisionRecord | null {
    const row = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as Row | undefined;
    return row ? decisionFromRow(row) : null;
  }

  private getFailure(id: string): FailureRecord | null {
    const row = this.db.prepare("SELECT * FROM failures WHERE id = ?").get(id) as Row | undefined;
    return row ? failureFromRow(row) : null;
  }

  private promoteReadyPhases(): void {
    const phases = this.listPhases();
    const completed = new Set(phases.filter((phase) => phase.status === "COMPLETED").map((phase) => phase.id));
    const update = this.db.prepare("UPDATE phases SET status = 'READY' WHERE id = ? AND status = 'PENDING'");
    for (const phase of phases) {
      if (phase.status === "PENDING" && phase.dependencies.every((dependency) => completed.has(dependency))) update.run(phase.id);
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS project (
        id TEXT PRIMARY KEY, root TEXT NOT NULL, original_prompt TEXT NOT NULL, status TEXT NOT NULL,
        contract_json TEXT, plan_version INTEGER NOT NULL, current_phase_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS phases (
        id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
        status TEXT NOT NULL, dependencies_json TEXT NOT NULL, allowed_scope_json TEXT NOT NULL,
        acceptance_commands_json TEXT NOT NULL, max_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL,
        started_at TEXT, completed_at TEXT, base_sha TEXT, head_sha TEXT, summary TEXT
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY, phase_id TEXT, title TEXT NOT NULL, rationale TEXT NOT NULL,
        alternatives_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assumptions (
        id TEXT PRIMARY KEY, phase_id TEXT, statement TEXT NOT NULL, confidence REAL NOT NULL,
        alternatives_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT,
        resolution_evidence TEXT, explicit_linked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS corrections (
        id TEXT PRIMARY KEY, assumption_id TEXT NOT NULL REFERENCES assumptions(id), phase_id TEXT,
        root_cause TEXT NOT NULL, blast_radius_json TEXT NOT NULL, blast_radius_size INTEGER NOT NULL,
        applied_at TEXT NOT NULL, outcome TEXT, expansions_json TEXT NOT NULL DEFAULT '[]', completed_at TEXT,
        token_start INTEGER NOT NULL DEFAULT 0, token_end INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_assumptions_phase ON assumptions(phase_id, status);
      CREATE INDEX IF NOT EXISTS idx_corrections_assumption ON corrections(assumption_id);
      CREATE TABLE IF NOT EXISTS failures (
        id TEXT PRIMARY KEY, phase_id TEXT NOT NULL, fingerprint TEXT NOT NULL, summary TEXT NOT NULL,
        count INTEGER NOT NULL, last_seen_at TEXT NOT NULL, resolution TEXT,
        UNIQUE(phase_id, fingerprint)
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY, phase_id TEXT NOT NULL, git_sha TEXT NOT NULL, summary TEXT NOT NULL,
        changed_files_json TEXT NOT NULL, verification_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, type TEXT NOT NULL,
        phase_id TEXT, payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS graph_nodes (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL, path TEXT, symbol TEXT,
        content_hash TEXT, metadata_json TEXT NOT NULL, updated_at TEXT NOT NULL, active INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS graph_edges (
        source_id TEXT NOT NULL, target_id TEXT NOT NULL, type TEXT NOT NULL,
        metadata_json TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id, type)
      );
      CREATE INDEX IF NOT EXISTS idx_events_phase ON events(phase_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_path ON graph_nodes(path);
    `);
  }
}

function validateContract(contract: ProjectContract): void {
  if (contract.goal.trim().length < 10) throw new Error("contract goal is too short");
  if (contract.deliverables.length === 0) throw new Error("contract requires deliverables");
  if (contract.doneWhen.length === 0) throw new Error("contract requires measurable done-when criteria");
  if (contract.assumptionConfidenceThreshold !== undefined && (!Number.isFinite(contract.assumptionConfidenceThreshold) || contract.assumptionConfidenceThreshold < 0 || contract.assumptionConfidenceThreshold > 1)) throw new Error("assumptionConfidenceThreshold must be in [0, 1]");
}

function validatePlan(phases: PhaseDefinition[]): void {
  if (phases.length === 0) throw new Error("plan requires at least one phase");
  const ids = new Set<string>();
  for (const phase of phases) {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(phase.id)) throw new Error(`invalid phase id: ${phase.id}`);
    if (ids.has(phase.id)) throw new Error(`duplicate phase id: ${phase.id}`);
    if (phase.acceptanceCommands.length === 0) throw new Error(`phase ${phase.id} requires verification commands`);
    if (phase.acceptanceCommands.some((command) => /^(?:true|echo\b|exit\s+0)$/i.test(command.trim()))) {
      throw new Error(`phase ${phase.id} contains a no-op verification command`);
    }
    if (phase.maxAttempts < 1 || phase.maxAttempts > 10) throw new Error(`phase ${phase.id} maxAttempts must be 1..10`);
    ids.add(phase.id);
  }
  for (const phase of phases) {
    for (const dependency of phase.dependencies) {
      if (!ids.has(dependency)) throw new Error(`phase ${phase.id} has unknown dependency ${dependency}`);
      if (dependency === phase.id) throw new Error(`phase ${phase.id} cannot depend on itself`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("phase dependency graph contains a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of must(byId.get(id), `missing phase ${id}`).dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  phases.forEach((phase) => visit(phase.id));
}

function projectFromRow(row: Row): ProjectRecord {
  return {
    id: String(row.id), root: String(row.root), originalPrompt: String(row.original_prompt),
    status: String(row.status) as ProjectStatus,
    contract: row.contract_json ? JSON.parse(asText(row.contract_json)) as ProjectContract : null,
    planVersion: Number(row.plan_version), currentPhaseId: row.current_phase_id ? asText(row.current_phase_id) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function phaseFromRow(row: Row): PhaseRecord {
  return {
    id: String(row.id), ordinal: Number(row.ordinal), title: String(row.title), goal: String(row.goal),
    status: String(row.status) as PhaseStatus,
    dependencies: JSON.parse(String(row.dependencies_json)) as string[],
    allowedScope: JSON.parse(String(row.allowed_scope_json)) as string[],
    acceptanceCommands: JSON.parse(String(row.acceptance_commands_json)) as string[],
    maxAttempts: Number(row.max_attempts), attempts: Number(row.attempts),
    startedAt: nullable(row.started_at), completedAt: nullable(row.completed_at), baseSha: nullable(row.base_sha),
    headSha: nullable(row.head_sha), summary: nullable(row.summary)
  };
}

function decisionFromRow(row: Row): DecisionRecord {
  return {
    id: String(row.id), phaseId: nullable(row.phase_id), title: String(row.title), rationale: String(row.rationale),
    alternatives: JSON.parse(String(row.alternatives_json)) as string[], status: String(row.status) as "active" | "superseded",
    createdAt: String(row.created_at)
  };
}

function failureFromRow(row: Row): FailureRecord {
  return {
    id: String(row.id), phaseId: String(row.phase_id), fingerprint: String(row.fingerprint), summary: String(row.summary),
    count: Number(row.count), lastSeenAt: String(row.last_seen_at), resolution: nullable(row.resolution)
  };
}


function assumptionFromRow(row: Row): AssumptionRecord {
  const alternatives = JSON.parse(String(row.alternatives_json)) as unknown;
  if (!Array.isArray(alternatives)) throw new Error("INVALID_ALTERNATIVES: stored alternatives must be an array");
  return {
    id: String(row.id), phaseId: nullable(row.phase_id), statement: String(row.statement), confidence: Number(row.confidence),
    alternatives: alternatives as AssumptionAlternative[], status: String(row.status) as AssumptionStatus,
    createdAt: String(row.created_at), resolvedAt: nullable(row.resolved_at), resolutionEvidence: nullable(row.resolution_evidence),
    explicitLinkedAt: nullable(row.explicit_linked_at)
  };
}

function correctionFromRow(row: Row): CorrectionRecord {
  return {
    id: String(row.id), assumptionId: String(row.assumption_id), phaseId: nullable(row.phase_id), rootCause: String(row.root_cause),
    blastRadius: JSON.parse(String(row.blast_radius_json)) as BlastRadius, blastRadiusSize: Number(row.blast_radius_size),
    appliedAt: String(row.applied_at), outcome: row.outcome ? asText(row.outcome) as "contained" | "expanded" : null,
    expansions: JSON.parse(asText(row.expansions_json ?? "[]")) as CorrectionScopeExpansion[], completedAt: nullable(row.completed_at),
    tokenStart: Number(row.token_start ?? 0), tokenEnd: row.token_end === null || row.token_end === undefined ? null : Number(row.token_end)
  };
}

function checkpointFromRow(row: Row): CheckpointRecord {
  return {
    id: String(row.id), phaseId: String(row.phase_id), gitSha: String(row.git_sha), summary: String(row.summary),
    changedFiles: JSON.parse(String(row.changed_files_json)) as string[],
    verification: JSON.parse(String(row.verification_json)) as VerificationEvidence,
    createdAt: String(row.created_at)
  };
}

function eventFromRow(row: Row): EventRecord {
  return {
    sequence: Number(row.sequence), timestamp: String(row.timestamp), type: String(row.type),
    phaseId: nullable(row.phase_id), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>
  };
}

function graphEdgeFromRow(row: Row): GraphEdge {
  return {
    sourceId: String(row.source_id), targetId: String(row.target_id), type: String(row.type) as GraphEdge["type"],
    metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>
  };
}

function graphNodeFromRow(row: Row): GraphNode {
  return {
    id: String(row.id), type: String(row.type) as GraphNode["type"], label: String(row.label), path: nullable(row.path),
    symbol: nullable(row.symbol), contentHash: nullable(row.content_hash),
    metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>
  };
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : asText(value);
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return `${value}`;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  throw new Error("database returned a non-scalar value");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
