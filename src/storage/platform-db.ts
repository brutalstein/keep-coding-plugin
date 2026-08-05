import { DatabaseSync } from "node:sqlite";
import type { ApprovalRecord, BudgetUsage, WorktreeRecord } from "../domain/model.js";

export type DbRow = Record<string, unknown>;

export class PlatformDb {
  readonly db: DatabaseSync;
  private readonly ownsDatabase: boolean;

  constructor(database: string | DatabaseSync) {
    this.ownsDatabase = typeof database === "string";
    this.db = typeof database === "string" ? new DatabaseSync(database) : database;
    this.migrate();
  }

  close(): void { if (this.ownsDatabase) this.db.close(); }

  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS plan_revisions (
        version INTEGER PRIMARY KEY, contract_json TEXT NOT NULL, amendment_json TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, phase_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL,
        requested_at TEXT NOT NULL, resolved_at TEXT, resolution_note TEXT
      );
      CREATE TABLE IF NOT EXISTS budget_usage (
        scope TEXT NOT NULL, scope_id TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0,
        estimated_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
        wall_clock_ms INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (scope, scope_id)
      );
      CREATE TABLE IF NOT EXISTS budget_usage_receipts (
        receipt_key TEXT PRIMARY KEY, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS critic_reviews (
        id TEXT PRIMARY KEY, phase_id TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worktrees (
        phase_id TEXT PRIMARY KEY, path TEXT NOT NULL, branch TEXT NOT NULL, status TEXT NOT NULL,
        base_sha TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_failures (
        phase_id TEXT NOT NULL, command TEXT NOT NULL, attempt INTEGER NOT NULL,
        stdout TEXT NOT NULL, stderr TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (phase_id, command, attempt)
      );
      CREATE TABLE IF NOT EXISTS checkpoint_runs (
        id TEXT PRIMARY KEY, phase_id TEXT NOT NULL, execution_mode TEXT NOT NULL, summary TEXT NOT NULL,
        status TEXT NOT NULL, workspace_baseline_sha TEXT NOT NULL, target_baseline_sha TEXT NOT NULL,
        actual_git_sha TEXT, diff_hash TEXT, changed_files_json TEXT NOT NULL DEFAULT '[]',
        impacted_completed_phases_json TEXT NOT NULL DEFAULT '[]',
        reverification_required_json TEXT NOT NULL DEFAULT '[]', evidence_json TEXT, correction_id TEXT,
        lease_owner TEXT, lease_expires_at TEXT, last_error TEXT, index_completed_at TEXT,
        reverification_completed_at TEXT, memory_completed_at TEXT, cleanup_completed_at TEXT,
        correction_completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_command_failures_latest ON command_failures(phase_id, command, attempt DESC);
      CREATE INDEX IF NOT EXISTS idx_checkpoint_runs_recovery ON checkpoint_runs(status, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_checkpoint_runs_active_phase
        ON checkpoint_runs(phase_id) WHERE status NOT IN ('DONE','FAILED_TERMINAL');
    `);
    addColumn(this.db, "budget_usage", "estimated_tokens", "INTEGER NOT NULL DEFAULT 0");
    addColumn(this.db, "checkpoints", "run_id", "TEXT");
    addColumn(this.db, "critic_reviews", "run_id", "TEXT");
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_checkpoints_run_id
        ON checkpoints(run_id) WHERE run_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_critic_reviews_run_id
        ON critic_reviews(run_id) WHERE run_id IS NOT NULL;
    `);
    const additions: Record<string, string> = {
      revision: "INTEGER NOT NULL DEFAULT 1",
      superseded_by: "TEXT",
      requires_approval: "INTEGER NOT NULL DEFAULT 0",
      approval_prompt: "TEXT",
      approved_at: "TEXT",
      budget_json: "TEXT NOT NULL DEFAULT '{}'",
      critic_blocking: "INTEGER NOT NULL DEFAULT 0",
      parallel_safe: "INTEGER NOT NULL DEFAULT 0",
      reverify_reason: "TEXT",
      verification_kind: "TEXT NOT NULL DEFAULT 'code'"
    };
    for (const [name, definition] of Object.entries(additions)) addColumn(this.db, "phases", name, definition);
  }
}

function addColumn(db: DatabaseSync, table: string, name: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as DbRow[];
  if (!columns.some((row) => text(row.name) === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

export function approvalFromRow(row: DbRow): ApprovalRecord {
  return {
    id: text(row.id), phaseId: text(row.phase_id), prompt: text(row.prompt),
    status: text(row.status) as ApprovalRecord["status"], requestedAt: text(row.requested_at),
    resolvedAt: nullable(row.resolved_at), resolutionNote: nullable(row.resolution_note)
  };
}

export function usageFromRow(row: DbRow): BudgetUsage {
  return {
    tokens: Number(row.tokens),
    estimatedTokens: Number(row.estimated_tokens ?? 0),
    costUsd: Number(row.cost_usd),
    wallClockMs: Number(row.wall_clock_ms),
    updatedAt: text(row.updated_at)
  };
}

export function worktreeFromRow(row: DbRow): WorktreeRecord {
  return {
    phaseId: text(row.phase_id), path: text(row.path), branch: text(row.branch),
    status: text(row.status) as WorktreeRecord["status"], baseSha: text(row.base_sha), createdAt: text(row.created_at)
  };
}

export function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  throw new Error("non-scalar database value");
}
export function nullable(value: unknown): string | null { return value === null || value === undefined ? null : text(value); }
export function json<T>(value: unknown): T { return JSON.parse(text(value)) as T; }
export function now(): string { return new Date().toISOString(); }
export function must<T>(value: T | null | undefined, message: string): T { if (value === null || value === undefined) throw new Error(message); return value; }
