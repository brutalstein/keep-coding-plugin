import type { DatabaseSync } from "node:sqlite";

export function migrateProjectDatabase(db: DatabaseSync): void {
  db.exec(`
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
    CREATE TABLE IF NOT EXISTS assumptions (
      id TEXT PRIMARY KEY, phase_id TEXT, statement TEXT NOT NULL, confidence REAL NOT NULL,
      alternatives_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT,
      resolution_evidence TEXT, explicit_linked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS corrections (
      id TEXT PRIMARY KEY, assumption_id TEXT NOT NULL REFERENCES assumptions(id), phase_id TEXT,
      root_cause TEXT NOT NULL, blast_radius_json TEXT NOT NULL, blast_radius_size INTEGER NOT NULL,
      applied_at TEXT NOT NULL, outcome TEXT, expansions_json TEXT NOT NULL DEFAULT '[]', completed_at TEXT,
      token_start INTEGER NOT NULL DEFAULT 0, token_end INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_assumptions_phase ON assumptions(phase_id, status);
    CREATE INDEX IF NOT EXISTS idx_corrections_assumption ON corrections(assumption_id);
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
