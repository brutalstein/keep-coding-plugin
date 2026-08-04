import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FailureRecord, PhaseDefinition } from "../domain/model.js";

type Row = Record<string, unknown>;

export interface PlaybookSuggestion {
  id: string;
  title: string;
  score: number;
  phase: PhaseDefinition;
  sourceProject: string;
  successCount: number;
}

export class PlaybookStore {
  private readonly db: DatabaseSync;

  constructor(databasePath = path.join(homedir(), ".keep-coding", "playbook.db")) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS phase_templates (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, keywords_json TEXT NOT NULL, phase_json TEXT NOT NULL,
        source_project TEXT NOT NULL, success_count INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS failure_patterns (
        fingerprint TEXT PRIMARY KEY, summary TEXT NOT NULL, resolution TEXT, occurrences INTEGER NOT NULL,
        source_project TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void { this.db.close(); }

  rememberPhase(sourceProject: string, phase: PhaseDefinition, keywords: string[]): PlaybookSuggestion {
    const normalizedKeywords = normalizeKeywords([phase.title, phase.goal, ...keywords].join(" "));
    const row = this.db.prepare("SELECT * FROM phase_templates WHERE source_project = ? AND title = ?").get(sourceProject, phase.title) as Row | undefined;
    const now = new Date().toISOString();
    const id = row ? String(row.id) : randomUUID();
    this.db.prepare(`
      INSERT INTO phase_templates (id, title, keywords_json, phase_json, source_project, success_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET keywords_json = excluded.keywords_json, phase_json = excluded.phase_json,
        success_count = phase_templates.success_count + 1, updated_at = excluded.updated_at
    `).run(id, phase.title, JSON.stringify(normalizedKeywords), JSON.stringify(phase), sourceProject, now, now);
    return mustSuggestion(this.db.prepare("SELECT * FROM phase_templates WHERE id = ?").get(id), 1);
  }

  rememberFailure(sourceProject: string, failure: FailureRecord): void {
    this.db.prepare(`
      INSERT INTO failure_patterns (fingerprint, summary, resolution, occurrences, source_project, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET summary = excluded.summary,
        resolution = COALESCE(excluded.resolution, failure_patterns.resolution),
        occurrences = failure_patterns.occurrences + excluded.occurrences,
        updated_at = excluded.updated_at
    `).run(failure.fingerprint, failure.summary, failure.resolution, failure.count, sourceProject, new Date().toISOString());
  }

  suggest(query: string, limit = 8): PlaybookSuggestion[] {
    const terms = normalizeKeywords(query);
    const rows = this.db.prepare("SELECT * FROM phase_templates ORDER BY success_count DESC, updated_at DESC LIMIT 200").all() as Row[];
    return rows.map((row) => {
      const keywords = JSON.parse(String(row.keywords_json)) as string[];
      const overlap = terms.filter((term) => keywords.includes(term)).length;
      const score = terms.length === 0 ? 0 : overlap / terms.length + Math.min(0.25, Number(row.success_count) / 100);
      return mustSuggestion(row, score);
    }).filter((suggestion) => suggestion.score > 0).sort((left, right) => right.score - left.score).slice(0, limit);
  }
}

function mustSuggestion(row: Row | undefined, score: number): PlaybookSuggestion {
  if (!row) throw new Error("playbook write failed");
  return {
    id: String(row.id), title: String(row.title), score,
    phase: JSON.parse(String(row.phase_json)) as PhaseDefinition,
    sourceProject: String(row.source_project), successCount: Number(row.success_count)
  };
}

function normalizeKeywords(value: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "phase", "build", "create", "bir", "ve", "ile", "için", "faz"]);
  return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])]
    .filter((term) => !stop.has(term)).slice(0, 40);
}
