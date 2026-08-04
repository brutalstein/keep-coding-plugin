import { DatabaseSync } from "node:sqlite";
import type { ApprovalRecord, BudgetUsage, WorktreeRecord } from "../domain/model.js";

export type DbRow = Record<string, unknown>;

export class PlatformDb {
  readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.migrate();
  }

  close(): void { this.db.close(); }

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
        cost_usd REAL NOT NULL DEFAULT 0, wall_clock_ms INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL, PRIMARY KEY (scope, scope_id)
      );
      CREATE TABLE IF NOT EXISTS critic_reviews (
        id TEXT PRIMARY KEY, phase_id TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worktrees (
        phase_id TEXT PRIMARY KEY, path TEXT NOT NULL, branch TEXT NOT NULL, status TEXT NOT NULL,
        base_sha TEXT NOT NULL, created_at TEXT NOT NULL
      );
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
      reverify_reason: "TEXT"
    };
    for (const [name, definition] of Object.entries(additions)) {
      const columns = this.db.prepare("PRAGMA table_info(phases)").all() as DbRow[];
      if (!columns.some((row) => text(row.name) === name)) this.db.exec(`ALTER TABLE phases ADD COLUMN ${name} ${definition}`);
    }
  }
}

export function approvalFromRow(row: DbRow): ApprovalRecord {
  return {
    id: text(row.id), phaseId: text(row.phase_id), prompt: text(row.prompt),
    status: text(row.status) as ApprovalRecord["status"], requestedAt: text(row.requested_at),
    resolvedAt: nullable(row.resolved_at), resolutionNote: nullable(row.resolution_note)
  };
}

export function usageFromRow(row: DbRow): BudgetUsage {
  return { tokens: Number(row.tokens), costUsd: Number(row.cost_usd), wallClockMs: Number(row.wall_clock_ms), updatedAt: text(row.updated_at) };
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
