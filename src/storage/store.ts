import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ApprovalRecord,
  CheckpointRecord,
  DecisionRecord,
  EventRecord,
  FailureRecord,
  GraphEdge,
  GraphNode,
  ImpactResult,
  PhaseDefinition,
  PhaseRecord,
  PhaseStatus,
  PlanAmendment,
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
  private readonly db: DatabaseSync;

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
      throw new Error("The plan cannot be replaced after implementation has started; use amend_plan instead.");
    }

    this.transaction(() => {
      this.db.exec("DELETE FROM phases; DELETE FROM graph_edges WHERE type IN ('depends_on', 'implements', 'supersedes'); DELETE FROM graph_nodes WHERE type IN ('phase', 'requirement');");
      const nextVersion = project.planVersion + 1;
      definitions.forEach((phase, ordinal) => this.insertPhase(phase, ordinal, nextVersion));
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE project SET contract_json = ?, plan_version = ?, status = 'ACTIVE',
          current_phase_id = ?, updated_at = ?
      `).run(JSON.stringify(contract), nextVersion, definitions.find((phase) => phase.dependencies.length === 0)?.id ?? null, now);
      this.appendEvent("plan_saved", null, { phaseCount: definitions.length, planVersion: nextVersion });
    });
    return this.snapshot();
  }

  amendPlan(amendment: PlanAmendment): ProjectSnapshot {
    const project = must(this.getProject(), "initialize the project before amending a plan");
    if (!project.contract) throw new Error("save the initial plan before amending it");
    const additions = amendment.addPhases ?? [];
    const supersede = [...new Set(amendment.supersedePhaseIds ?? [])];
    if (amendment.reason.trim().length < 10) throw new Error("amendment reason is too short");
    if (additions.length === 0 && supersede.length === 0) throw new Error("amendment must add or supersede at least one phase");

    const existing = this.listPhases();
    const existingIds = new Set(existing.map((phase) => phase.id));
    for (const id of supersede) {
      const phase = must(this.getPhase(id), `unknown phase to supersede: ${id}`);
      if (["IN_PROGRESS", "VERIFYING", "COMPLETED"].includes(phase.status)) {
        throw new Error(`phase ${id} cannot be superseded from ${phase.status}`);
      }
    }
    for (const phase of additions) {
      if (existingIds.has(phase.id)) throw new Error(`duplicate phase id: ${phase.id}`);
    }
    validatePlan([...existing.filter((phase) => phase.status !== "SUPERSEDED").map(toDefinition), ...additions]);

    this.transaction(() => {
      const nextVersion = project.planVersion + 1;
      const replacement = additions[0]?.id ?? null;
      for (const id of supersede) {
        this.db.prepare("UPDATE phases SET status = 'SUPERSEDED', superseded_by = ? WHERE id = ?").run(replacement, id);
        if (replacement) {
          this.upsertGraphEdge({ sourceId: `phase:${replacement}`, targetId: `phase:${id}`, type: "supersedes", metadata: { planVersion: nextVersion } });
        }
      }
      let ordinal = existing.reduce((maximum, phase) => Math.max(maximum, phase.ordinal), -1) + 1;
      for (const phase of additions) this.insertPhase(phase, ordinal++, nextVersion);
      this.promoteReadyPhases();
      const current = this.nextRunnablePhase();
      const now = new Date().toISOString();
      this.db.prepare("UPDATE project SET plan_version = ?, status = 'ACTIVE', current_phase_id = ?, updated_at = ?")
        .run(nextVersion, current?.id ?? null, now);
      this.appendEvent("plan_amended", null, {
        planVersion: nextVersion,
        reason: amendment.reason.trim(),
        addedPhaseIds: additions.map((phase) => phase.id),
        supersededPhaseIds: supersede
      });
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
    if (!["READY", "FAILED", "NEEDS_REVERIFICATION"].includes(phase.status)) {
      throw new Error(`phase ${id} cannot start from ${phase.status}`);
    }
    const dependencies = phase.dependencies.map((dependency) => must(this.getPhase(dependency), `missing dependency: ${dependency}`));
    if (dependencies.some((dependency) => !["COMPLETED", "SUPERSEDED"].includes(dependency.status))) {
      throw new Error(`phase ${id} has unfinished dependencies`);
    }
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE phases SET status = 'IN_PROGRESS', started_at = COALESCE(started_at, ?), base_sha = COALESCE(base_sha, ?) WHERE id = ?`)
      .run(now, baseSha, id);
    this.db.prepare("UPDATE project SET status = 'ACTIVE', current_phase_id = ?, updated_at = ?").run(id, now);
    this.appendEvent("phase_started", id, { baseSha, reverification: phase.status === "NEEDS_REVERIFICATION" });
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
      const budgetBlocked = evidence.budget !== null && !evidence.budget.passed;
      const status: PhaseStatus = budgetBlocked ? "BLOCKED_BUDGET" : attempts >= phase.maxAttempts ? "BLOCKED" : "FAILED";
      this.db.prepare("UPDATE phases SET status = ?, attempts = ?, summary = ? WHERE id = ?")
        .run(status, attempts, summary, id);
      if (["BLOCKED", "BLOCKED_BUDGET"].includes(status)) {
        this.db.prepare("UPDATE project SET status = 'BLOCKED', updated_at = ?").run(now);
      }
      this.appendEvent("phase_verification_failed", id, {
        attempts,
        status,
        scopeViolations: evidence.scopeViolations,
        secretFindings: evidence.secretFindings.length,
        budgetViolations: evidence.budget?.violations ?? [],
        failedCommands: [...evidence.selectiveCommands, ...evidence.commands].filter((command) => !command.passed).map((command) => command.command)
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
      this.refreshProjectProgress(now);
      this.appendEvent("phase_completed", id, {
        checkpointId,
        checkpointCommitSha: evidence.checkpointCommitSha,
        changedFiles: evidence.changedFiles,
        nextPhaseId: this.nextRunnablePhase()?.id ?? null
      });
    });
    return must(this.getPhase(id), "phase completion update failed");
  }

  completeProject(): ProjectRecord {
    const phases = this.listPhases().filter((phase) => phase.status !== "SUPERSEDED");
    if (phases.length === 0 || phases.some((phase) => phase.status !== "COMPLETED")) {
      throw new Error("all active planned phases must be verified before project completion");
    }
    const pendingApprovals = this.listApprovals().filter((approval) => approval.status === "pending");
    if (pendingApprovals.length > 0) throw new Error("pending human approvals must be resolved before completion");
    const now = new Date().toISOString();
    this.db.prepare("UPDATE project SET status = 'COMPLETED', current_phase_id = NULL, updated_at = ?").run(now);
    this.appendEvent("project_completed", null, { phaseCount: phases.length });
    return must(this.getProject(), "project completion failed");
  }

  requestApproval(phaseId: string, question: string, details: string): ApprovalRecord {
    const phase = must(this.getPhase(phaseId), `unknown phase: ${phaseId}`);
    if (!["READY", "IN_PROGRESS", "FAILED"].includes(phase.status)) throw new Error(`phase ${phaseId} cannot request approval from ${phase.status}`);
    const existing = this.db.prepare("SELECT * FROM approvals WHERE phase_id = ? AND status = 'pending' LIMIT 1").get(phaseId) as Row | undefined;
    if (existing) return approvalFromRow(existing);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO approvals (id, phase_id, question, details, status, response, created_at, resolved_at)
      VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL)
    `).run(id, phaseId, question.trim(), details.trim(), now);
    this.db.prepare("UPDATE phases SET status = 'AWAITING_APPROVAL' WHERE id = ?").run(phaseId);
    this.db.prepare("UPDATE project SET current_phase_id = ?, updated_at = ?").run(phaseId, now);
    this.appendEvent("approval_requested", phaseId, { approvalId: id, question: question.trim() });
    return must(this.getApproval(id), "approval insert failed");
  }

  resolveApproval(approvalId: string, approved: boolean, response: string): ApprovalRecord {
    const approval = must(this.getApproval(approvalId), `unknown approval: ${approvalId}`);
    if (approval.status !== "pending") throw new Error(`approval ${approvalId} is already resolved`);
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("UPDATE approvals SET status = ?, response = ?, resolved_at = ? WHERE id = ?")
        .run(approved ? "approved" : "rejected", response.trim(), now, approvalId);
      this.db.prepare("UPDATE phases SET status = ? WHERE id = ?")
        .run(approved ? "READY" : "BLOCKED", approval.phaseId);
      if (!approved) this.db.prepare("UPDATE project SET status = 'BLOCKED', updated_at = ?").run(now);
      else this.refreshProjectProgress(now);
      this.appendEvent("approval_resolved", approval.phaseId, { approvalId, approved, response: response.trim() });
    });
    return must(this.getApproval(approvalId), "approval update failed");
  }

  listApprovals(): ApprovalRecord[] {
    return (this.db.prepare("SELECT * FROM approvals ORDER BY created_at").all() as Row[]).map(approvalFromRow);
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
    const normalizedFingerprint = fingerprint?.trim() || sha256(normalizeFailure(summary)).slice(0, 24);
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
      failures: this.listFailures(),
      approvals: this.listApprovals(),
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
    const value = this.getMetadata("last_stop_progress_sequence");
    return value ? Number(value) : 0;
  }

  setLastStopProgressSequence(sequence: number): void {
    this.setMetadata("last_stop_progress_sequence", String(sequence));
  }

  getPhaseBaseline(phaseId: string): Record<string, string> | null {
    const value = this.getMetadata(`phase_baseline:${phaseId}`);
    return value ? JSON.parse(value) as Record<string, string> : null;
  }

  setPhaseBaseline(phaseId: string, baseline: Record<string, string>): void {
    if (this.getMetadata(`phase_baseline:${phaseId}`) === null) this.setMetadata(`phase_baseline:${phaseId}`, JSON.stringify(baseline));
  }

  getRestoreSnapshot(phaseId: string): Record<string, string | null> | null {
    const value = this.getMetadata(`phase_restore:${phaseId}`);
    return value ? JSON.parse(value) as Record<string, string | null> : null;
  }

  setRestoreSnapshot(phaseId: string, snapshot: Record<string, string | null>): void {
    if (this.getMetadata(`phase_restore:${phaseId}`) === null) this.setMetadata(`phase_restore:${phaseId}`, JSON.stringify(snapshot));
  }

  getMetadata(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as Row | undefined;
    return row ? asText(row.value) : null;
  }

  setMetadata(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
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
    this.db.exec("DELETE FROM graph_edges WHERE source_id LIKE 'file:%' OR target_id LIKE 'file:%' OR source_id LIKE 'symbol:%' OR target_id LIKE 'symbol:%' OR source_id LIKE 'test:%' OR target_id LIKE 'test:%'; DELETE FROM graph_nodes WHERE type IN ('file', 'symbol', 'test');");
  }

  searchGraph(terms: string[], limit = 30): GraphNode[] {
    if (terms.length === 0) return [];
    const clauses = terms.slice(0, 8).map(() => "(LOWER(label) LIKE ? OR LOWER(COALESCE(path, '')) LIKE ?)").join(" OR ");
    const values = terms.slice(0, 8).flatMap((term) => [`%${term.toLowerCase()}%`, `%${term.toLowerCase()}%`]);
    return (this.db.prepare(`SELECT * FROM graph_nodes WHERE active = 1 AND (${clauses}) ORDER BY type, label LIMIT ?`)
      .all(...values, limit) as Row[]).map(graphNodeFromRow);
  }

  getImpact(subject: string, maxDepth = 4): ImpactResult {
    const normalized = subject.replaceAll("\\", "/");
    const seeds = (this.db.prepare(`
      SELECT * FROM graph_nodes WHERE active = 1 AND (id = ? OR path = ? OR symbol = ? OR label = ?) LIMIT 20
    `).all(subject, normalized, subject, subject) as Row[]).map(graphNodeFromRow);
    if (seeds.length === 0) return { subject, files: [], symbols: [], tests: [], phases: [], explanation: ["No indexed node matched the subject."] };
    const visited = new Set(seeds.map((node) => node.id));
    let frontier = [...visited];
    const explanation: string[] = [];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next = new Set<string>();
      for (const id of frontier) {
        const rows = this.db.prepare("SELECT source_id, target_id, type FROM graph_edges WHERE source_id = ? OR target_id = ?").all(id, id) as Row[];
        for (const row of rows) {
          const other = String(row.source_id) === id ? String(row.target_id) : String(row.source_id);
          if (!visited.has(other)) next.add(other);
          explanation.push(`${id} --${String(row.type)}--> ${other}`);
        }
      }
      for (const id of next) visited.add(id);
      frontier = [...next];
    }
    const nodes = [...visited].map((id) => {
      const row = this.db.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(id) as Row | undefined;
      return row ? graphNodeFromRow(row) : null;
    }).filter((node): node is GraphNode => node !== null);
    return {
      subject,
      files: unique(nodes.filter((node) => node.type === "file").flatMap((node) => node.path ? [node.path] : [])),
      symbols: unique(nodes.filter((node) => node.type === "symbol").map((node) => node.label)),
      tests: unique(nodes.filter((node) => node.type === "test").flatMap((node) => node.path ? [node.path] : [])),
      phases: unique(nodes.filter((node) => node.type === "phase").map((node) => node.id.replace(/^phase:/, ""))),
      explanation: explanation.slice(0, 100)
    };
  }

  impactedTests(changedFiles: string[]): string[] {
    const tests = new Set<string>();
    for (const file of changedFiles) {
      for (const test of this.getImpact(file, 3).tests) tests.add(test);
    }
    return [...tests].sort();
  }

  completedPhasesImpactedByFiles(changedFiles: string[], excludePhaseId: string): string[] {
    if (changedFiles.length === 0) return [];
    const changed = new Set(changedFiles);
    return this.listCheckpoints()
      .filter((checkpoint) => checkpoint.phaseId !== excludePhaseId && checkpoint.changedFiles.some((file) => changed.has(file)))
      .map((checkpoint) => checkpoint.phaseId)
      .filter((id, index, values) => values.indexOf(id) === index)
      .filter((id) => this.getPhase(id)?.status === "COMPLETED");
  }

  markNeedsReverification(phaseIds: string[], causedByPhaseId: string): void {
    if (phaseIds.length === 0) return;
    this.transaction(() => {
      for (const id of phaseIds) {
        this.db.prepare("UPDATE phases SET status = 'NEEDS_REVERIFICATION' WHERE id = ? AND status = 'COMPLETED'").run(id);
        this.appendEvent("phase_reverification_required", id, { causedByPhaseId });
      }
      this.refreshProjectProgress(new Date().toISOString());
    });
  }

  private insertPhase(phase: PhaseDefinition, ordinal: number, planVersion: number): void {
    const status: PhaseStatus = phase.dependencies.length === 0 ? "READY" : "PENDING";
    this.db.prepare(`
      INSERT INTO phases (
        id, ordinal, title, goal, status, dependencies_json, allowed_scope_json,
        acceptance_commands_json, max_attempts, attempts, started_at, completed_at,
        base_sha, head_sha, summary, budget_json, requires_approval, plan_version, superseded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL)
    `).run(
      phase.id,
      ordinal,
      phase.title,
      phase.goal,
      status,
      JSON.stringify(phase.dependencies),
      JSON.stringify(phase.allowedScope),
      JSON.stringify(phase.acceptanceCommands),
      phase.maxAttempts,
      JSON.stringify(phase.budget ?? null),
      phase.requiresApproval ? 1 : 0,
      planVersion
    );
    this.upsertGraphNode({
      id: `phase:${phase.id}`,
      type: "phase",
      label: phase.title,
      path: null,
      symbol: null,
      contentHash: sha256(JSON.stringify(phase)),
      metadata: { goal: phase.goal, ordinal, planVersion }
    });
    for (const dependency of phase.dependencies) {
      this.upsertGraphEdge({ sourceId: `phase:${phase.id}`, targetId: `phase:${dependency}`, type: "depends_on", metadata: {} });
    }
  }

  private getDecision(id: string): DecisionRecord | null {
    const row = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as Row | undefined;
    return row ? decisionFromRow(row) : null;
  }

  private getFailure(id: string): FailureRecord | null {
    const row = this.db.prepare("SELECT * FROM failures WHERE id = ?").get(id) as Row | undefined;
    return row ? failureFromRow(row) : null;
  }

  private getApproval(id: string): ApprovalRecord | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return row ? approvalFromRow(row) : null;
  }

  private promoteReadyPhases(): void {
    const phases = this.listPhases();
    const satisfied = new Set(phases.filter((phase) => ["COMPLETED", "SUPERSEDED"].includes(phase.status)).map((phase) => phase.id));
    const update = this.db.prepare("UPDATE phases SET status = 'READY' WHERE id = ? AND status = 'PENDING'");
    for (const phase of phases) {
      if (phase.status === "PENDING" && phase.dependencies.every((dependency) => satisfied.has(dependency))) update.run(phase.id);
    }
  }

  private nextRunnablePhase(): PhaseRecord | null {
    return this.listPhases().find((phase) => ["READY", "FAILED", "NEEDS_REVERIFICATION", "AWAITING_APPROVAL"].includes(phase.status)) ?? null;
  }

  private refreshProjectProgress(now: string): void {
    const phases = this.listPhases().filter((phase) => phase.status !== "SUPERSEDED");
    const next = this.nextRunnablePhase();
    const status: ProjectStatus = phases.length > 0 && phases.every((phase) => phase.status === "COMPLETED") ? "READY_TO_COMPLETE" : "ACTIVE";
    this.db.prepare("UPDATE project SET status = ?, current_phase_id = ?, updated_at = ?").run(status, next?.id ?? null, now);
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
        started_at TEXT, completed_at TEXT, base_sha TEXT, head_sha TEXT, summary TEXT,
        budget_json TEXT, requires_approval INTEGER NOT NULL DEFAULT 0, plan_version INTEGER NOT NULL DEFAULT 1,
        superseded_by TEXT
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY, phase_id TEXT, title TEXT NOT NULL, rationale TEXT NOT NULL,
        alternatives_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS failures (
        id TEXT PRIMARY KEY, phase_id TEXT NOT NULL, fingerprint TEXT NOT NULL, summary TEXT NOT NULL,
        count INTEGER NOT NULL, last_seen_at TEXT NOT NULL, resolution TEXT,
        UNIQUE(phase_id, fingerprint)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, phase_id TEXT NOT NULL, question TEXT NOT NULL, details TEXT NOT NULL,
        status TEXT NOT NULL, response TEXT, created_at TEXT NOT NULL, resolved_at TEXT
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
      CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);
    `);
    this.ensureColumn("phases", "budget_json", "TEXT");
    this.ensureColumn("phases", "requires_approval", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("phases", "plan_version", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("phases", "superseded_by", "TEXT");
  }

  private ensureColumn(table: string, column: string, declaration: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (!columns.some((row) => String(row.name) === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

function validateContract(contract: ProjectContract): void {
  if (contract.goal.trim().length < 10) throw new Error("contract goal is too short");
  if (contract.deliverables.length === 0) throw new Error("contract requires deliverables");
  if (contract.doneWhen.length === 0) throw new Error("contract requires measurable done-when criteria");
  validateBudget(contract.budget, "project contract");
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
    validateBudget(phase.budget, `phase ${phase.id}`);
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

function validateBudget(budget: PhaseDefinition["budget"], owner: string): void {
  if (!budget) return;
  for (const [key, value] of Object.entries(budget)) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`${owner} ${key} must be positive`);
  }
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
    budget: row.budget_json ? JSON.parse(String(row.budget_json)) as PhaseDefinition["budget"] : undefined,
    requiresApproval: Number(row.requires_approval ?? 0) === 1,
    startedAt: nullable(row.started_at), completedAt: nullable(row.completed_at), baseSha: nullable(row.base_sha),
    headSha: nullable(row.head_sha), summary: nullable(row.summary), planVersion: Number(row.plan_version ?? 1),
    supersededBy: nullable(row.superseded_by)
  };
}

function toDefinition(phase: PhaseRecord): PhaseDefinition {
  return {
    id: phase.id,
    title: phase.title,
    goal: phase.goal,
    dependencies: phase.dependencies,
    allowedScope: phase.allowedScope,
    acceptanceCommands: phase.acceptanceCommands,
    maxAttempts: phase.maxAttempts,
    budget: phase.budget,
    requiresApproval: phase.requiresApproval
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

function approvalFromRow(row: Row): ApprovalRecord {
  return {
    id: String(row.id), phaseId: String(row.phase_id), question: String(row.question), details: String(row.details),
    status: String(row.status) as ApprovalRecord["status"], response: nullable(row.response),
    createdAt: String(row.created_at), resolvedAt: nullable(row.resolved_at)
  };
}

function checkpointFromRow(row: Row): CheckpointRecord {
  return {
    id: String(row.id), phaseId: String(row.phase_id), gitSha: String(row.git_sha), summary: String(row.summary),
    changedFiles: JSON.parse(String(row.changed_files_json)) as string[],
    verification: normalizeVerification(JSON.parse(String(row.verification_json)) as Partial<VerificationEvidence>),
    createdAt: String(row.created_at)
  };
}

function normalizeVerification(value: Partial<VerificationEvidence>): VerificationEvidence {
  return {
    passed: Boolean(value.passed),
    scopePassed: Boolean(value.scopePassed),
    scopeViolations: value.scopeViolations ?? [],
    changedFiles: value.changedFiles ?? [],
    commands: value.commands ?? [],
    selectiveCommands: value.selectiveCommands ?? [],
    impactedTests: value.impactedTests ?? [],
    secretScanPassed: value.secretScanPassed ?? true,
    secretFindings: value.secretFindings ?? [],
    budget: value.budget ?? null,
    critic: value.critic ?? null,
    diffHash: value.diffHash ?? "",
    gitSha: value.gitSha ?? "UNBORN",
    checkpointCommitSha: value.checkpointCommitSha ?? null
  };
}

function eventFromRow(row: Row): EventRecord {
  return {
    sequence: Number(row.sequence), timestamp: String(row.timestamp), type: String(row.type),
    phaseId: nullable(row.phase_id), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>
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

function normalizeFailure(value: string): string {
  return value.toLowerCase().replace(/0x[0-9a-f]+/g, "<hex>").replace(/\d+/g, "<n>").replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
