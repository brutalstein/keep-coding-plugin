import type {
  ApprovalRecord, BudgetEvidence, BudgetLimits, BudgetUsage, GraphEdge, GraphNode, ImpactNode,
  PhaseDefinition, PhaseRecord, PlanAmendment, PlanRevisionRecord, ProjectContract, ProjectRecord,
  ProjectSnapshot, VerificationEvidence, WorktreeRecord
} from "../domain/model.js";
import { ProjectStore } from "./store.js";
import { PlatformDb, type DbRow, json, nullable, now, text } from "./platform-db.js";
import { graphNode, impact, impactedTests } from "./platform-impact.js";
import { amendPlan, listPlanRevisions, recordInitialPlan } from "./platform-plan.js";
import {
  budgetEvidence, getWorktree, listApprovals, listBudgetUsage, listWorktrees, recordBudgetUsage,
  recordCriticReview, requestApproval, resolveApproval, setWorktree
} from "./platform-runtime.js";

export class PlatformStore extends ProjectStore {
  private readonly platform: PlatformDb;
  constructor(projectRoot: string) { super(projectRoot); this.platform = new PlatformDb(this.databasePath); }
  override close(): void { this.platform.close(); super.close(); }

  override savePlan(contract: ProjectContract, phases: PhaseDefinition[]): ProjectSnapshot {
    const snapshot = super.savePlan(contract, phases);
    this.platform.transaction(() => recordInitialPlan(this.planHost(), contract, phases, snapshot.project.planVersion));
    return this.snapshot();
  }
  amendPlan(amendment: PlanAmendment): ProjectSnapshot {
    this.platform.transaction(() => amendPlan(this.planHost(), amendment));
    return this.snapshot();
  }

  override listPhases(): PhaseRecord[] { return super.listPhases().map((phase) => this.augment(phase)); }
  override getPhase(id: string): PhaseRecord | null { const phase = super.getPhase(id); return phase ? this.augment(phase) : null; }
  override currentPhase(): PhaseRecord | null { const phase = super.currentPhase(); return phase ? this.augment(phase) : null; }
  activePhases(): PhaseRecord[] { return this.listPhases().filter((phase) => ["IN_PROGRESS", "VERIFYING"].includes(phase.status)); }
  readyPhases(): PhaseRecord[] { return this.listPhases().filter((phase) => phase.status === "READY"); }

  override startPhase(id: string, baseSha: string, allowParallel = false): PhaseRecord {
    const phase = required(this.getPhase(id), `unknown phase: ${id}`);
    if (phase.requiresApproval && !phase.approvedAt) {
      this.requestApproval(id, phase.approvalPrompt ?? `Approve phase ${phase.title}`);
      throw new Error(`phase ${id} is awaiting human approval`);
    }
    if (!["READY", "FAILED", "REVERIFY_REQUIRED"].includes(phase.status)) throw new Error(`phase ${id} cannot start from ${phase.status}`);
    const dependencies = phase.dependencies.map((dependency) => required(this.getPhase(dependency), `missing dependency: ${dependency}`));
    if (dependencies.some((dependency) => !["COMPLETED", "SUPERSEDED"].includes(dependency.status))) throw new Error(`phase ${id} has unfinished dependencies`);
    const active = this.activePhases();
    if (active.length > 0 && (!allowParallel || !phase.parallelSafe || active.some((item) => !item.parallelSafe))) {
      throw new Error("another phase is active; only parallel-safe phases may overlap");
    }
    const timestamp = now();
    this.platform.db.prepare(`UPDATE phases SET status='IN_PROGRESS',started_at=COALESCE(started_at,?),base_sha=COALESCE(base_sha,?),reverify_reason=NULL WHERE id=?`)
      .run(timestamp, baseSha, id);
    this.platform.db.prepare("UPDATE project SET status='ACTIVE',current_phase_id=?,updated_at=?").run(id, timestamp);
    this.appendEvent("phase_started", id, { baseSha, parallel: allowParallel });
    return required(this.getPhase(id), "phase start failed");
  }

  override finishVerification(id: string, summary: string, evidence: VerificationEvidence): PhaseRecord {
    if (!evidence.budget.passed) {
      this.platform.db.prepare("UPDATE phases SET status='BLOCKED_BUDGET',attempts=attempts+1,summary=? WHERE id=?").run(summary, id);
      this.platform.db.prepare("UPDATE project SET status='BLOCKED_BUDGET',current_phase_id=?,updated_at=?").run(id, now());
      this.appendEvent("phase_budget_blocked", id, { violations: evidence.budget.violations });
      return required(this.getPhase(id), "phase budget update failed");
    }
    const result = this.augment(super.finishVerification(id, summary, evidence));
    recordCriticReview(this.platform.db, id, evidence.critic);
    if (evidence.passed) this.refreshReadiness();
    return result;
  }

  override completeProject(): ProjectRecord {
    const phases = this.listPhases();
    if (phases.length === 0 || phases.some((phase) => !["COMPLETED", "SUPERSEDED"].includes(phase.status))) {
      throw new Error("all active phases and required reverifications must be complete");
    }
    const timestamp = now();
    this.platform.db.prepare("UPDATE project SET status='COMPLETED',current_phase_id=NULL,updated_at=?").run(timestamp);
    this.appendEvent("project_completed", null, { phaseCount: phases.filter((phase) => phase.status === "COMPLETED").length });
    return required(this.getProject(), "project completion failed");
  }

  requestApproval(phaseId: string, prompt: string): ApprovalRecord { return requestApproval(this.runtimeHost(), phaseId, prompt); }
  resolveApproval(id: string, approved: boolean, note: string): ApprovalRecord { return resolveApproval(this.runtimeHost(), id, approved, note); }
  listApprovals(): ApprovalRecord[] { return listApprovals(this.platform.db); }
  listPlanRevisions(): PlanRevisionRecord[] { return listPlanRevisions(this.platform.db); }
  recordBudgetUsage(scope: "project" | "phase", scopeId: string, delta: Partial<Omit<BudgetUsage, "updatedAt">>): BudgetUsage { return recordBudgetUsage(this.platform.db, scope, scopeId, delta); }
  budgetEvidence(phaseId: string): BudgetEvidence { return budgetEvidence(this.runtimeHost(), phaseId); }
  listBudgetUsage(): Record<string, BudgetUsage> { return listBudgetUsage(this.platform.db); }
  setWorktree(record: WorktreeRecord): void { setWorktree(this.platform.db, record); }
  getWorktree(id: string): WorktreeRecord | null { return getWorktree(this.platform.db, id); }
  listWorktrees(): WorktreeRecord[] { return listWorktrees(this.platform.db); }

  markReverification(ids: string[], reason: string, sourcePhaseId: string): string[] {
    const marked: string[] = [];
    for (const id of new Set(ids)) {
      const phase = this.getPhase(id);
      if (!phase || phase.status !== "COMPLETED" || id === sourcePhaseId) continue;
      this.platform.db.prepare("UPDATE phases SET status='REVERIFY_REQUIRED',reverify_reason=?,completed_at=NULL WHERE id=?").run(reason, id);
      this.appendEvent("phase_reverification_required", id, { sourcePhaseId, reason });
      marked.push(id);
    }
    if (marked[0]) this.platform.db.prepare("UPDATE project SET status='ACTIVE',current_phase_id=?,updated_at=?").run(marked[0], now());
    return marked;
  }

  completedPhasesTouching(files: string[], exclude?: string): string[] {
    if (files.length === 0) return [];
    const placeholders = files.map(() => "?").join(",");
    const rows = this.platform.db.prepare(`SELECT DISTINCT SUBSTR(source_id,7) AS phase_id FROM graph_edges JOIN phases ON phases.id=SUBSTR(source_id,7) WHERE type='modifies' AND target_id IN (${placeholders}) AND phases.status='COMPLETED'`)
      .all(...files.map((file) => `file:${file}`)) as DbRow[];
    return rows.map((row) => text(row.phase_id)).filter((id) => id !== exclude);
  }

  graphNode(id: string): GraphNode | null { return graphNode(this.platform.db, id); }
  impact(start: string, maxDepth = 3, limit = 100): ImpactNode[] { return impact(this.platform.db, start, maxDepth, limit); }
  impactedTests(files: string[]): string[] { return impactedTests(this.platform.db, files); }

  override snapshot(): ProjectSnapshot {
    return { ...super.snapshot(), approvals: this.listApprovals(), planRevisions: this.listPlanRevisions(), worktrees: this.listWorktrees(), budgetUsage: this.listBudgetUsage() };
  }

  private refreshReadiness(): void {
    const pending = this.listPhases().filter((phase) => phase.status === "PENDING");
    for (const phase of pending) {
      const ready = phase.dependencies.every((dependency) => ["COMPLETED", "SUPERSEDED"].includes(this.getPhase(dependency)?.status ?? ""));
      if (ready) this.platform.db.prepare("UPDATE phases SET status='READY' WHERE id=?").run(phase.id);
    }
    const phases = this.listPhases();
    const active = phases.find((phase) => ["IN_PROGRESS", "VERIFYING", "AWAITING_APPROVAL", "REVERIFY_REQUIRED"].includes(phase.status));
    const next = active ?? phases.find((phase) => phase.status === "READY") ?? null;
    const allDone = phases.every((phase) => ["COMPLETED", "SUPERSEDED"].includes(phase.status));
    this.platform.db.prepare("UPDATE project SET status=?,current_phase_id=?,updated_at=?")
      .run(allDone ? "READY_TO_COMPLETE" : "ACTIVE", next?.id ?? null, now());
  }

  private augment(phase: PhaseRecord): PhaseRecord {
    const row = this.platform.db.prepare(`SELECT revision,superseded_by,requires_approval,approval_prompt,approved_at,budget_json,critic_blocking,parallel_safe,reverify_reason FROM phases WHERE id=?`).get(phase.id) as DbRow | undefined;
    if (!row) return phase;
    const budget = row.budget_json ? json<BudgetLimits>(row.budget_json) : {};
    return {
      ...phase, revision: Number(row.revision ?? 1), supersededBy: nullable(row.superseded_by), approvedAt: nullable(row.approved_at),
      reverifyReason: nullable(row.reverify_reason), requiresApproval: Boolean(row.requires_approval), criticBlocking: Boolean(row.critic_blocking),
      parallelSafe: Boolean(row.parallel_safe), ...(row.approval_prompt ? { approvalPrompt: text(row.approval_prompt) } : {}),
      ...(Object.keys(budget).length > 0 ? { budget } : {})
    };
  }

  private planHost() {
    return {
      db: this.platform.db, phases: () => this.listPhases(), project: () => this.getProject(),
      event: (type: string, phaseId: string | null, payload: Record<string, unknown>) => this.platformEvent(type, phaseId, payload),
      graphNode: (node: GraphNode) => this.platformGraphNode(node), graphEdge: (edge: GraphEdge) => this.platformGraphEdge(edge)
    };
  }
  private runtimeHost() {
    return { db: this.platform.db, project: () => this.getProject(), phase: (id: string) => this.getPhase(id), event: (type: string, phaseId: string | null, payload: Record<string, unknown>) => this.appendEvent(type, phaseId, payload) };
  }
  private platformEvent(type: string, phaseId: string | null, payload: Record<string, unknown>): number {
    const result = this.platform.db.prepare("INSERT INTO events(timestamp,type,phase_id,payload_json) VALUES(?,?,?,?)").run(now(), type, phaseId, JSON.stringify(payload));
    return Number(result.lastInsertRowid);
  }
  private platformGraphNode(node: GraphNode): void {
    this.platform.db.prepare(`INSERT INTO graph_nodes(id,type,label,path,symbol,content_hash,metadata_json,updated_at,active) VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET type=excluded.type,label=excluded.label,path=excluded.path,symbol=excluded.symbol,content_hash=excluded.content_hash,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at,active=1`)
      .run(node.id, node.type, node.label, node.path, node.symbol, node.contentHash, JSON.stringify(node.metadata), now());
  }
  private platformGraphEdge(edge: GraphEdge): void {
    this.platform.db.prepare(`INSERT INTO graph_edges(source_id,target_id,type,metadata_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(source_id,target_id,type) DO UPDATE SET metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
      .run(edge.sourceId, edge.targetId, edge.type, JSON.stringify(edge.metadata), now());
  }
}

function required<T>(value: T | null | undefined, message: string): T { if (value === null || value === undefined) throw new Error(message); return value; }
