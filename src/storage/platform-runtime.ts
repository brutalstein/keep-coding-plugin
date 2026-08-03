import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ApprovalRecord, BudgetEvidence, BudgetLimits, BudgetUsage, CriticEvidence, ProjectContract, WorktreeRecord } from "../domain/model.js";
import { type DbRow, approvalFromRow, must, now, text, usageFromRow, worktreeFromRow } from "./platform-db.js";

export interface RuntimeHost {
  db: DatabaseSync;
  project(): { id: string; contract: ProjectContract | null } | null;
  phase(id: string): { budget?: BudgetLimits } | null;
  event(type: string, phaseId: string | null, payload: Record<string, unknown>): number;
}

export function requestApproval(host: RuntimeHost, phaseId: string, prompt: string): ApprovalRecord {
  const pending = host.db.prepare("SELECT * FROM approvals WHERE phase_id = ? AND status = 'pending' LIMIT 1").get(phaseId) as DbRow | undefined;
  if (pending) return approvalFromRow(pending);
  const id = randomUUID();
  host.db.prepare("INSERT INTO approvals VALUES (?, ?, ?, 'pending', ?, NULL, NULL)").run(id, phaseId, prompt, now());
  host.db.prepare("UPDATE phases SET status = 'AWAITING_APPROVAL' WHERE id = ?").run(phaseId);
  host.db.prepare("UPDATE project SET status = 'AWAITING_APPROVAL', current_phase_id = ?, updated_at = ?").run(phaseId, now());
  host.event("approval_requested", phaseId, { id, prompt });
  return approvalFromRow(must(host.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as DbRow | undefined, "approval insert failed"));
}

export function resolveApproval(host: RuntimeHost, id: string, approved: boolean, note: string): ApprovalRecord {
  const record = must(host.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as DbRow | undefined, `unknown approval: ${id}`);
  if (text(record.status) !== "pending") throw new Error("approval already resolved");
  host.db.prepare("UPDATE approvals SET status = ?, resolved_at = ?, resolution_note = ? WHERE id = ?").run(approved ? "approved" : "rejected", now(), note, id);
  host.db.prepare("UPDATE phases SET status = ?, approved_at = ? WHERE id = ?").run(approved ? "READY" : "BLOCKED", approved ? now() : null, text(record.phase_id));
  host.db.prepare("UPDATE project SET status = ?, current_phase_id = ?, updated_at = ?").run(approved ? "ACTIVE" : "BLOCKED", text(record.phase_id), now());
  host.event("approval_resolved", text(record.phase_id), { id, approved, note });
  return approvalFromRow(must(host.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as DbRow | undefined, "approval update failed"));
}

export function listApprovals(db: DatabaseSync): ApprovalRecord[] {
  return (db.prepare("SELECT * FROM approvals ORDER BY requested_at").all() as DbRow[]).map(approvalFromRow);
}

export function recordBudgetUsage(db: DatabaseSync, scope: "project" | "phase", scopeId: string, delta: Partial<Omit<BudgetUsage, "updatedAt">>): BudgetUsage {
  for (const value of Object.values(delta)) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error("budget deltas must be non-negative");
  db.prepare(`INSERT INTO budget_usage VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scope, scope_id) DO UPDATE SET tokens = tokens + excluded.tokens, cost_usd = cost_usd + excluded.cost_usd, wall_clock_ms = wall_clock_ms + excluded.wall_clock_ms, updated_at = excluded.updated_at`)
    .run(scope, scopeId, delta.tokens ?? 0, delta.costUsd ?? 0, delta.wallClockMs ?? 0, now());
  return getBudgetUsage(db, scope, scopeId);
}

export function getBudgetUsage(db: DatabaseSync, scope: "project" | "phase", scopeId: string): BudgetUsage {
  const row = db.prepare("SELECT * FROM budget_usage WHERE scope = ? AND scope_id = ?").get(scope, scopeId) as DbRow | undefined;
  return row ? usageFromRow(row) : { tokens: 0, costUsd: 0, wallClockMs: 0, updatedAt: "" };
}

export function budgetEvidence(host: RuntimeHost, phaseId: string): BudgetEvidence {
  const project = must(host.project(), "project missing");
  const phase = must(host.phase(phaseId), `unknown phase: ${phaseId}`);
  const limits = mergeLimits(project.contract?.budget, phase.budget);
  const projectUsage = getBudgetUsage(host.db, "project", project.id);
  const phaseUsage = getBudgetUsage(host.db, "phase", phaseId);
  const usage: BudgetUsage = {
    tokens: Math.max(projectUsage.tokens, phaseUsage.tokens), costUsd: Math.max(projectUsage.costUsd, phaseUsage.costUsd),
    wallClockMs: Math.max(projectUsage.wallClockMs, phaseUsage.wallClockMs), updatedAt: now()
  };
  const violations: string[] = [];
  if (limits.maxTokens !== undefined && usage.tokens > limits.maxTokens) violations.push(`token budget exceeded: ${usage.tokens}/${limits.maxTokens}`);
  if (limits.maxCostUsd !== undefined && usage.costUsd > limits.maxCostUsd) violations.push(`cost budget exceeded: ${usage.costUsd}/${limits.maxCostUsd}`);
  if (limits.maxWallClockMs !== undefined && usage.wallClockMs > limits.maxWallClockMs) violations.push(`wall-clock budget exceeded: ${usage.wallClockMs}/${limits.maxWallClockMs}`);
  return { passed: violations.length === 0, limits, usage, violations };
}

export function listBudgetUsage(db: DatabaseSync): Record<string, BudgetUsage> {
  return Object.fromEntries((db.prepare("SELECT * FROM budget_usage").all() as DbRow[]).map((row) => [`${text(row.scope)}:${text(row.scope_id)}`, usageFromRow(row)]));
}

export function recordCriticReview(db: DatabaseSync, phaseId: string, evidence: CriticEvidence): void {
  db.prepare("INSERT INTO critic_reviews VALUES (?, ?, ?, ?)").run(randomUUID(), phaseId, JSON.stringify(evidence), now());
}

export function setWorktree(db: DatabaseSync, record: WorktreeRecord): void {
  db.prepare(`INSERT INTO worktrees VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(phase_id) DO UPDATE SET path = excluded.path, branch = excluded.branch, status = excluded.status, base_sha = excluded.base_sha`)
    .run(record.phaseId, record.path, record.branch, record.status, record.baseSha, record.createdAt);
}
export function getWorktree(db: DatabaseSync, id: string): WorktreeRecord | null {
  const row = db.prepare("SELECT * FROM worktrees WHERE phase_id = ?").get(id) as DbRow | undefined;
  return row ? worktreeFromRow(row) : null;
}
export function listWorktrees(db: DatabaseSync): WorktreeRecord[] {
  return (db.prepare("SELECT * FROM worktrees").all() as DbRow[]).map(worktreeFromRow);
}

function mergeLimits(a?: BudgetLimits, b?: BudgetLimits): BudgetLimits {
  const min = (x?: number, y?: number): number | undefined => x === undefined ? y : y === undefined ? x : Math.min(x, y);
  const tokens = min(a?.maxTokens, b?.maxTokens), cost = min(a?.maxCostUsd, b?.maxCostUsd), wall = min(a?.maxWallClockMs, b?.maxWallClockMs);
  return { ...(tokens !== undefined ? { maxTokens: tokens } : {}), ...(cost !== undefined ? { maxCostUsd: cost } : {}), ...(wall !== undefined ? { maxWallClockMs: wall } : {}) };
}
