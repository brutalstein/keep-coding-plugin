import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FailureRecord, PhaseDefinition, ProjectContract } from "../domain/model.js";

type Row = Record<string, unknown>;

export interface PlaybookSuggestion {
  id: string;
  title: string;
  goal: string;
  allowedScope: string[];
  acceptanceCommands: string[];
  score: number;
  source: "phase-template" | "failure-pattern";
}

export class PlaybookStore {
  private readonly db: DatabaseSync | null;

  constructor(enabled = process.env.KEEP_CODING_PLAYBOOK === "1", databasePath?: string) {
    if (!enabled) {
      this.db = null;
      return;
    }
    const target = databasePath ?? path.join(os.homedir(), ".keep-coding", "playbook.db");
    mkdirSync(path.dirname(target), { recursive: true });
    this.db = new DatabaseSync(target);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS phase_templates (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, tags TEXT NOT NULL,
        allowed_scope_json TEXT NOT NULL, acceptance_commands_json TEXT NOT NULL,
        uses INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS failure_patterns (
        fingerprint TEXT PRIMARY KEY, summary TEXT NOT NULL, resolution TEXT,
        count INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
    `);
  }

  get enabled(): boolean {
    return this.db !== null;
  }

  close(): void {
    this.db?.close();
  }

  rememberPhase(phase: PhaseDefinition, contract: ProjectContract): void {
    if (!this.db) return;
    const tags = tokenize(`${contract.goal} ${phase.title} ${phase.goal}`).join(" ");
    const id = createHash("sha256").update(`${phase.title}\0${phase.goal}\0${tags}`).digest("hex").slice(0, 24);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO phase_templates (id, title, goal, tags, allowed_scope_json, acceptance_commands_json, uses, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET uses = uses + 1, updated_at = excluded.updated_at,
        allowed_scope_json = excluded.allowed_scope_json, acceptance_commands_json = excluded.acceptance_commands_json
    `).run(id, phase.title, phase.goal, tags, JSON.stringify(phase.allowedScope), JSON.stringify(phase.acceptanceCommands), now, now);
  }

  rememberFailure(failure: FailureRecord): void {
    if (!this.db) return;
    this.db.prepare(`
      INSERT INTO failure_patterns (fingerprint, summary, resolution, count, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET summary = excluded.summary,
        resolution = COALESCE(excluded.resolution, failure_patterns.resolution),
        count = failure_patterns.count + excluded.count, updated_at = excluded.updated_at
    `).run(failure.fingerprint, failure.summary, failure.resolution, failure.count, new Date().toISOString());
  }

  suggest(query: string, limit = 8): PlaybookSuggestion[] {
    if (!this.db) return [];
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const clauses = terms.map(() => "LOWER(tags || ' ' || title || ' ' || goal) LIKE ?").join(" OR ");
    const rows = this.db.prepare(`SELECT * FROM phase_templates WHERE ${clauses} ORDER BY uses DESC, updated_at DESC LIMIT ?`)
      .all(...terms.map((term) => `%${term}%`), limit) as Row[];
    const phaseSuggestions = rows.map((row) => {
      const haystack = `${String(row.tags)} ${String(row.title)} ${String(row.goal)}`.toLowerCase();
      const matches = terms.filter((term) => haystack.includes(term)).length;
      return {
        id: String(row.id),
        title: String(row.title),
        goal: String(row.goal),
        allowedScope: JSON.parse(String(row.allowed_scope_json)) as string[],
        acceptanceCommands: JSON.parse(String(row.acceptance_commands_json)) as string[],
        score: matches / terms.length,
        source: "phase-template" as const
      };
    });
    const failureRows = this.db.prepare("SELECT * FROM failure_patterns ORDER BY count DESC, updated_at DESC LIMIT ?").all(limit) as Row[];
    const failureSuggestions = failureRows
      .filter((row) => terms.some((term) => String(row.summary).toLowerCase().includes(term)))
      .map((row) => ({
        id: String(row.fingerprint),
        title: "Avoid repeated failure",
        goal: `${String(row.summary)}${row.resolution ? ` Resolution: ${String(row.resolution)}` : ""}`,
        allowedScope: [],
        acceptanceCommands: [],
        score: 0.5,
        source: "failure-pattern" as const
      }));
    return [...phaseSuggestions, ...failureSuggestions].sort((left, right) => right.score - left.score).slice(0, limit);
  }
}

function tokenize(value: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "bir", "ve", "ile", "için", "bu"]);
  return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])]
    .filter((term) => !stop.has(term))
    .slice(0, 16);
}
