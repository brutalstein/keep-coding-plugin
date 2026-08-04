import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssumptionRecord, CorrectionRecord, FailureRecord, PhaseDefinition, PlaybookPattern } from "../domain/model.js";
import { normalizedDiagnosticSignature } from "../core/signature.js";

type Row = Record<string, unknown>;

export class PlaybookStore {
  private readonly db: DatabaseSync;

  constructor(databasePath = process.env.KEEP_CODING_PLAYBOOK_PATH?.trim() || path.join(homedir(), ".keep-coding", "playbook.db")) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS phase_templates (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, keywords_json TEXT NOT NULL, phase_json TEXT NOT NULL,
        source_project TEXT NOT NULL, success_count INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS playbook_patterns (
        id TEXT PRIMARY KEY, signature TEXT NOT NULL UNIQUE, pattern TEXT NOT NULL,
        trigger_conditions_json TEXT NOT NULL, resolution_json TEXT NOT NULL,
        applicability_scope_json TEXT NOT NULL, source_projects_json TEXT NOT NULL,
        success_count INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS failure_patterns (
        fingerprint TEXT PRIMARY KEY, summary TEXT NOT NULL, resolution TEXT, occurrences INTEGER NOT NULL,
        source_project TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    addColumn(this.db, "playbook_patterns", "kind", "TEXT NOT NULL DEFAULT 'phase'");
    addColumn(this.db, "playbook_patterns", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
    this.migrateLegacyTemplates();
  }

  close(): void { this.db.close(); }

  rememberPhase(sourceProject: string, phase: PhaseDefinition, keywords: string[]): PlaybookPattern {
    const tuple = compactPhase(phase, keywords);
    const signature = patternSignature(tuple.pattern, tuple.triggerConditions, tuple.resolution, tuple.applicabilityScope);
    const existing = this.db.prepare("SELECT * FROM playbook_patterns WHERE signature = ?").get(signature) as Row | undefined;
    const now = new Date().toISOString();
    const id = existing ? String(existing.id) : signature;
    const sources = existing
      ? [...new Set([...jsonArray(existing.source_projects_json), sourceProject])]
      : [sourceProject];
    this.db.prepare(`
      INSERT INTO playbook_patterns (
        id, signature, pattern, trigger_conditions_json, resolution_json, applicability_scope_json,
        source_projects_json, success_count, created_at, updated_at, kind, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'phase', '{}')
      ON CONFLICT(signature) DO UPDATE SET
        pattern = excluded.pattern,
        trigger_conditions_json = excluded.trigger_conditions_json,
        resolution_json = excluded.resolution_json,
        applicability_scope_json = excluded.applicability_scope_json,
        source_projects_json = excluded.source_projects_json,
        success_count = playbook_patterns.success_count + 1,
        updated_at = excluded.updated_at
    `).run(
      id, signature, tuple.pattern, JSON.stringify(tuple.triggerConditions), JSON.stringify(tuple.resolution),
      JSON.stringify(tuple.applicabilityScope), JSON.stringify(sources), now, now
    );
    return patternFromRow(required(this.db.prepare("SELECT * FROM playbook_patterns WHERE signature = ?").get(signature) as Row | undefined), 1);
  }

  rememberCorrection(sourceProject: string, assumption: AssumptionRecord, correction: CorrectionRecord): PlaybookPattern {
    const pattern = `Avoid assumption: ${assumption.statement}`;
    const triggerConditions = normalizeKeywords(`${assumption.statement} ${correction.rootCause}`);
    const resolution = [`Wrong assumption: ${assumption.statement}`, `Actual case: ${correction.rootCause}`];
    const applicabilityScope = correction.blastRadius.files.slice(0, 12);
    const signature = normalizedDiagnosticSignature(`${assumption.statement}\n${correction.rootCause}`, 32);
    const existing = this.db.prepare("SELECT * FROM playbook_patterns WHERE signature = ?").get(signature) as Row | undefined;
    const timestamp = new Date().toISOString();
    const id = existing ? String(existing.id) : signature;
    const sources = existing ? [...new Set([...jsonArray(existing.source_projects_json), sourceProject])] : [sourceProject];
    const metadata = { assumptionId: assumption.id, correctionId: correction.id, wrongAssumption: assumption.statement, actualCase: correction.rootCause, outcome: correction.outcome };
    this.db.prepare(`
      INSERT INTO playbook_patterns (
        id, signature, pattern, trigger_conditions_json, resolution_json, applicability_scope_json,
        source_projects_json, success_count, created_at, updated_at, kind, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'anti_pattern', ?)
      ON CONFLICT(signature) DO UPDATE SET
        pattern=excluded.pattern,trigger_conditions_json=excluded.trigger_conditions_json,resolution_json=excluded.resolution_json,
        applicability_scope_json=excluded.applicability_scope_json,source_projects_json=excluded.source_projects_json,
        success_count=playbook_patterns.success_count+1,updated_at=excluded.updated_at,kind='anti_pattern',metadata_json=excluded.metadata_json
    `).run(id, signature, pattern, JSON.stringify(triggerConditions), JSON.stringify(resolution), JSON.stringify(applicabilityScope), JSON.stringify(sources), timestamp, timestamp, JSON.stringify(metadata));
    return patternFromRow(required(this.db.prepare("SELECT * FROM playbook_patterns WHERE signature = ?").get(signature) as Row | undefined), 1);
  }

  list(kind?: "phase" | "anti_pattern"): PlaybookPattern[] {
    const rows = kind
      ? this.db.prepare("SELECT * FROM playbook_patterns WHERE kind = ? ORDER BY updated_at DESC").all(kind)
      : this.db.prepare("SELECT * FROM playbook_patterns ORDER BY updated_at DESC").all();
    return (rows as Row[]).map((row) => patternFromRow(row, 1));
  }

  rememberFailure(sourceProject: string, failure: FailureRecord): void {
    this.db.prepare(`
      INSERT INTO failure_patterns (fingerprint, summary, resolution, occurrences, source_project, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET summary = excluded.summary,
        resolution = COALESCE(excluded.resolution, failure_patterns.resolution),
        occurrences = failure_patterns.occurrences + excluded.occurrences,
        source_project = CASE
          WHEN instr(failure_patterns.source_project, excluded.source_project) > 0 THEN failure_patterns.source_project
          ELSE failure_patterns.source_project || ',' || excluded.source_project
        END,
        updated_at = excluded.updated_at
    `).run(failure.fingerprint, failure.summary, failure.resolution, failure.count, sourceProject, new Date().toISOString());
  }

  suggest(query: string, limit = 8): PlaybookPattern[] {
    const terms = normalizeKeywords(query);
    const rows = this.db.prepare("SELECT * FROM playbook_patterns ORDER BY success_count DESC, updated_at DESC LIMIT 300").all() as Row[];
    return rows.map((row) => {
      const triggers = jsonArray(row.trigger_conditions_json);
      const patternTerms = normalizeKeywords(String(row.pattern));
      const searchable = new Set([...triggers, ...patternTerms]);
      const overlap = terms.filter((term) => searchable.has(term)).length;
      const score = terms.length === 0 || overlap === 0 ? 0 : overlap / terms.length + Math.min(0.25, Number(row.success_count) / 100);
      return patternFromRow(row, score);
    }).filter((suggestion) => suggestion.score > 0)
      .sort((left, right) => right.score - left.score || right.successCount - left.successCount)
      .slice(0, Math.max(1, Math.min(limit, 20)));
  }

  private migrateLegacyTemplates(): void {
    const legacy = this.db.prepare("SELECT * FROM phase_templates").all() as Row[];
    for (const row of legacy) {
      const phase = JSON.parse(String(row.phase_json)) as PhaseDefinition;
      const tuple = compactPhase(phase, jsonArray(row.keywords_json));
      const signature = patternSignature(tuple.pattern, tuple.triggerConditions, tuple.resolution, tuple.applicabilityScope);
      const now = String(row.updated_at);
      this.db.prepare(`
        INSERT OR IGNORE INTO playbook_patterns (
          id, signature, pattern, trigger_conditions_json, resolution_json, applicability_scope_json,
          source_projects_json, success_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        signature, signature, tuple.pattern, JSON.stringify(tuple.triggerConditions), JSON.stringify(tuple.resolution),
        JSON.stringify(tuple.applicabilityScope), JSON.stringify([String(row.source_project)]),
        Number(row.success_count), String(row.created_at), now
      );
    }
  }
}

function compactPhase(phase: PhaseDefinition, keywords: string[]): Omit<PlaybookPattern, "id" | "score" | "successCount" | "sourceProjects"> {
  return {
    pattern: phase.title.trim(),
    triggerConditions: normalizeKeywords([phase.title, phase.goal, ...keywords].join(" ")),
    resolution: [phase.goal.trim(), ...phase.acceptanceCommands.map((command) => command.trim())].filter(Boolean).slice(0, 6),
    applicabilityScope: [...new Set(phase.allowedScope.map((scope) => scope.trim()).filter(Boolean))].slice(0, 12)
  };
}

function patternFromRow(row: Row, score: number): PlaybookPattern {
  return {
    id: String(row.id), pattern: String(row.pattern), score,
    kind: row.kind === "anti_pattern" ? "anti_pattern" : "phase",
    triggerConditions: jsonArray(row.trigger_conditions_json),
    resolution: jsonArray(row.resolution_json),
    applicabilityScope: jsonArray(row.applicability_scope_json),
    sourceProjects: jsonArray(row.source_projects_json),
    successCount: Number(row.success_count),
    metadata: row.metadata_json ? JSON.parse(scalar(row.metadata_json)) as Record<string, unknown> : {}
  };
}

function patternSignature(pattern: string, triggers: string[], resolution: string[], scope: string[]): string {
  const canonical = JSON.stringify({
    pattern: pattern.toLowerCase().replace(/\s+/g, " ").trim(),
    triggers: [...triggers].sort(), resolution: resolution.map(normalizeText), scope: [...scope].sort()
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
function normalizeText(value: string): string {
  return value.toLowerCase().replace(/(?:[a-z]:\\|\/)(?:[^\s]+[\\/])+[^\s]+/giu, "<path>")
    .replace(/\b\d+\b/gu, "<n>").replace(/\s+/gu, " ").trim();
}
function normalizeKeywords(value: string | string[]): string[] {
  const source = Array.isArray(value) ? value.join(" ") : value;
  const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "phase", "build", "create", "bir", "ve", "ile", "için", "faz"]);
  return [...new Set(source.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])]
    .filter((term) => !stop.has(term)).slice(0, 40);
}
function jsonArray(value: unknown): string[] { return JSON.parse(scalar(value)) as string[]; }
function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  throw new Error("non-scalar playbook value");
}
function required<T>(value: T | null | undefined): T { if (value === null || value === undefined) throw new Error("playbook write failed"); return value; }

function addColumn(db: DatabaseSync, table: string, name: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
  if (!columns.some((row) => String(row.name) === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}
