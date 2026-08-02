import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CheckpointRecord,
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
    this.db.exec("DELETE FROM graph_edges WHERE source_id LIKE 'file:%' OR target_id LIKE 'file:%' OR source_id LIKE 'symbol:%' OR target_id LIKE 'symbol:%'; DELETE FROM graph_nodes WHERE type IN ('file', 'symbol');");
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

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
