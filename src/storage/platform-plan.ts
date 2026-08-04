import type { DatabaseSync } from "node:sqlite";
import type {
  GraphEdge, GraphNode, PhaseDefinition, PhaseRecord, PlanAmendment, PlanRevisionRecord,
  ProjectContract, ProjectContractPatch
} from "../domain/model.js";
import { type DbRow, json, must, now, text } from "./platform-db.js";

export interface PlanHost {
  db: DatabaseSync;
  phases(): PhaseRecord[];
  project(): { planVersion: number; contract: ProjectContract | null } | null;
  event(type: string, phaseId: string | null, payload: Record<string, unknown>): number;
  graphNode(node: GraphNode): void;
  graphEdge(edge: GraphEdge): void;
}

export function recordInitialPlan(host: PlanHost, contract: ProjectContract, phases: PhaseDefinition[], version: number): void {
  for (const phase of phases) writePhaseOptions(host.db, phase, version);
  host.db.prepare("INSERT OR REPLACE INTO plan_revisions (version, contract_json, amendment_json, created_at) VALUES (?, ?, NULL, ?)")
    .run(version, JSON.stringify(contract), now());
}

export function amendPlan(host: PlanHost, amendment: PlanAmendment): void {
  if (amendment.reason.trim().length < 10) throw new Error("plan amendment requires a concrete reason");
  const project = must(host.project(), "project is not initialized");
  const contract = must(project.contract, "save the initial plan before amending it");
  const existing = new Map(host.phases().map((phase) => [phase.id, phase]));
  validateDefinitions(amendment.addPhases, existing);
  for (const id of amendment.supersedePhaseIds) {
    const phase = must(existing.get(id), `unknown superseded phase: ${id}`);
    if (["IN_PROGRESS", "VERIFYING"].includes(phase.status)) throw new Error("an in-progress phase cannot be superseded");
  }

  const version = project.planVersion + 1;
  const replacement = amendment.addPhases[0]?.id ?? null;
  const nextContract = mergeContract(contract, amendment.contractPatch ?? {});
  validateBudgetLimits(nextContract.budget, "contract budget");
  const startOrdinal = host.phases().reduce((maximum, phase) => Math.max(maximum, phase.ordinal + 1), 0);

  for (const id of amendment.supersedePhaseIds) {
    host.db.prepare("UPDATE phases SET status = 'SUPERSEDED', superseded_by = ? WHERE id = ?").run(replacement, id);
    if (replacement) host.graphEdge({ sourceId: `phase:${replacement}`, targetId: `phase:${id}`, type: "supersedes", metadata: { version } });
  }
  if (replacement) redirectDependencies(host.db, amendment.supersedePhaseIds, replacement);

  const insert = host.db.prepare(`
    INSERT INTO phases (id, ordinal, title, goal, status, dependencies_json, allowed_scope_json,
      acceptance_commands_json, max_attempts, attempts, started_at, completed_at, base_sha, head_sha,
      summary, revision, superseded_by, requires_approval, approval_prompt, approved_at, budget_json,
      critic_blocking, parallel_safe, reverify_reason, verification_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, ?, NULL, ?, ?, ?, NULL, ?)
  `);
  amendment.addPhases.forEach((phase, index) => {
    const ready = phase.dependencies.every((dependency) => dependencySatisfied(host.db, dependency));
    insert.run(
      phase.id, startOrdinal + index, phase.title, phase.goal, ready ? "READY" : "PENDING",
      JSON.stringify(phase.dependencies), JSON.stringify(phase.allowedScope), JSON.stringify(phase.acceptanceCommands),
      phase.maxAttempts, version, phase.requiresApproval ? 1 : 0, phase.approvalPrompt ?? null,
      JSON.stringify(phase.budget ?? {}), phase.criticBlocking ? 1 : 0, phase.parallelSafe ? 1 : 0,
      phase.verificationKind ?? "code"
    );
    host.graphNode({ id: `phase:${phase.id}`, type: "phase", label: phase.title, path: null, symbol: null, contentHash: null, metadata: { revision: version, goal: phase.goal } });
    for (const dependency of phase.dependencies) host.graphEdge({ sourceId: `phase:${phase.id}`, targetId: `phase:${dependency}`, type: "depends_on", metadata: { version } });
  });

  const currentRow = host.db.prepare("SELECT id FROM phases WHERE status IN ('READY','REVERIFY_REQUIRED','AWAITING_APPROVAL') ORDER BY ordinal LIMIT 1").get() as DbRow | undefined;
  const current = currentRow ? text(currentRow.id) : null;
  host.db.prepare("UPDATE project SET contract_json = ?, plan_version = ?, status = 'ACTIVE', current_phase_id = ?, updated_at = ?")
    .run(JSON.stringify(nextContract), version, current, now());
  host.db.prepare("INSERT INTO plan_revisions (version, contract_json, amendment_json, created_at) VALUES (?, ?, ?, ?)")
    .run(version, JSON.stringify(nextContract), JSON.stringify(amendment), now());
  host.event("plan_amended", null, {
    version, reason: amendment.reason, added: amendment.addPhases.map((phase) => phase.id), superseded: amendment.supersedePhaseIds
  });
}

export function listPlanRevisions(db: DatabaseSync): PlanRevisionRecord[] {
  return (db.prepare("SELECT * FROM plan_revisions ORDER BY version").all() as DbRow[]).map((row) => ({
    version: Number(row.version), contract: json<ProjectContract>(row.contract_json),
    amendment: row.amendment_json ? json<PlanAmendment>(row.amendment_json) : null, createdAt: text(row.created_at)
  }));
}

export function writePhaseOptions(db: DatabaseSync, phase: PhaseDefinition, revision: number): void {
  db.prepare("UPDATE phases SET revision = ?, requires_approval = ?, approval_prompt = ?, budget_json = ?, critic_blocking = ?, parallel_safe = ?, verification_kind = ? WHERE id = ?")
    .run(
      revision, phase.requiresApproval ? 1 : 0, phase.approvalPrompt ?? null, JSON.stringify(phase.budget ?? {}),
      phase.criticBlocking ? 1 : 0, phase.parallelSafe ? 1 : 0, phase.verificationKind ?? "code", phase.id
    );
}

function redirectDependencies(db: DatabaseSync, superseded: string[], replacement: string): void {
  const rows = db.prepare("SELECT id, dependencies_json FROM phases WHERE status != 'SUPERSEDED'").all() as DbRow[];
  for (const row of rows) {
    const dependencies = json<string[]>(row.dependencies_json);
    if (!dependencies.some((dependency) => superseded.includes(dependency))) continue;
    const redirected = [...new Set(dependencies.map((dependency) => superseded.includes(dependency) ? replacement : dependency))];
    db.prepare("UPDATE phases SET dependencies_json = ? WHERE id = ?").run(JSON.stringify(redirected), text(row.id));
  }
}

function dependencySatisfied(db: DatabaseSync, id: string): boolean {
  const row = db.prepare("SELECT status FROM phases WHERE id = ?").get(id) as DbRow | undefined;
  return Boolean(row && ["COMPLETED", "SUPERSEDED"].includes(text(row.status)));
}

function validateDefinitions(phases: PhaseDefinition[], existing: Map<string, PhaseRecord>): void {
  const ids = new Set<string>();
  for (const phase of phases) {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(phase.id)) throw new Error(`invalid phase id: ${phase.id}`);
    if (ids.has(phase.id) || existing.has(phase.id)) throw new Error(`duplicate phase id: ${phase.id}`);
    validateBudgetLimits(phase.budget, `phase ${phase.id} budget`);
    if (!phase.allowedScope.length || !phase.acceptanceCommands.length) throw new Error(`phase ${phase.id} requires scope and commands`);
    if (phase.acceptanceCommands.some((command) => /^(true|echo\b|exit\s+0)$/i.test(command.trim()))) throw new Error(`phase ${phase.id} contains a no-op command`);
    ids.add(phase.id);
  }
  for (const phase of phases) for (const dependency of phase.dependencies) {
    if (!ids.has(dependency) && !existing.has(dependency)) throw new Error(`unknown dependency: ${dependency}`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("phase dependency graph contains a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) if (byId.has(dependency)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const phase of phases) visit(phase.id);
}

function validateBudgetLimits(budget: PhaseDefinition["budget"] | undefined, label: string): void {
  if (!budget) return;
  for (const [name, value] of Object.entries(budget)) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`${label} ${name} must be positive`);
  }
}

function mergeContract(contract: ProjectContract, patch: ProjectContractPatch): ProjectContract {
  const definedPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as ProjectContractPatch;
  return {
    ...contract,
    ...definedPatch,
    ...(definedPatch.budget ? { budget: { ...contract.budget, ...definedPatch.budget } } : {}),
    ...(definedPatch.critic ? { critic: { ...contract.critic, ...definedPatch.critic } } : {})
  } as ProjectContract;
}
