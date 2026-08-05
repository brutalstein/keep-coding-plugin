import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  CheckpointExecutionMode,
  CheckpointRunRecord,
  CheckpointRunStatus,
  VerificationEvidence
} from "../domain/model.js";
import { type DbRow, json, nullable, now, text } from "./platform-db.js";

const TERMINAL_STATUSES: CheckpointRunStatus[] = ["DONE", "FAILED_TERMINAL"];
const STEP_COLUMNS = new Set([
  "index_completed_at",
  "reverification_completed_at",
  "memory_completed_at",
  "cleanup_completed_at",
  "correction_completed_at"
]);

export interface BeginCheckpointRunInput {
  phaseId: string;
  executionMode: CheckpointExecutionMode;
  summary: string;
  workspaceBaselineSha: string;
  targetBaselineSha: string;
  leaseOwner: string;
  leaseDurationMs: number;
}

export interface CheckpointEvidenceInput {
  evidence: VerificationEvidence;
  impactedCompletedPhases: string[];
  correctionId: string | null;
}

export function beginCheckpointRun(db: DatabaseSync, input: BeginCheckpointRunInput): CheckpointRunRecord {
  const existing = activeCheckpointRun(db, input.phaseId);
  if (existing) throw new Error(`CHECKPOINT_ALREADY_ACTIVE: ${existing.id} (${existing.status})`);

  const phaseUpdate = db.prepare("UPDATE phases SET status='VERIFYING' WHERE id=? AND status='IN_PROGRESS'")
    .run(input.phaseId);
  if (Number(phaseUpdate.changes) !== 1) {
    const row = db.prepare("SELECT status FROM phases WHERE id=?").get(input.phaseId) as DbRow | undefined;
    throw new Error(`CHECKPOINT_PHASE_CAS_FAILED: ${input.phaseId} is ${row ? text(row.status) : "missing"}`);
  }

  const id = randomUUID();
  const timestamp = now();
  db.prepare(`
    INSERT INTO checkpoint_runs (
      id, phase_id, execution_mode, summary, status, workspace_baseline_sha, target_baseline_sha,
      actual_git_sha, diff_hash, changed_files_json, impacted_completed_phases_json,
      reverification_required_json, evidence_json, correction_id, lease_owner, lease_expires_at,
      last_error, index_completed_at, reverification_completed_at, memory_completed_at,
      cleanup_completed_at, correction_completed_at, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, 'VERIFYING', ?, ?, NULL, NULL, '[]', '[]', '[]', NULL, NULL, ?, ?,
      NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)
  `).run(
    id,
    input.phaseId,
    input.executionMode,
    input.summary,
    input.workspaceBaselineSha,
    input.targetBaselineSha,
    input.leaseOwner,
    leaseExpiration(input.leaseDurationMs),
    timestamp,
    timestamp
  );
  return required(getCheckpointRun(db, id), "checkpoint run insert failed");
}

export function getCheckpointRun(db: DatabaseSync, id: string): CheckpointRunRecord | null {
  const row = db.prepare("SELECT * FROM checkpoint_runs WHERE id=?").get(id) as DbRow | undefined;
  return row ? checkpointRunFromRow(row) : null;
}

export function activeCheckpointRun(db: DatabaseSync, phaseId: string): CheckpointRunRecord | null {
  const row = db.prepare(`
    SELECT * FROM checkpoint_runs
    WHERE phase_id=? AND status NOT IN ('DONE','FAILED_TERMINAL')
    ORDER BY created_at DESC LIMIT 1
  `).get(phaseId) as DbRow | undefined;
  return row ? checkpointRunFromRow(row) : null;
}

export function listRecoverableCheckpointRuns(db: DatabaseSync): CheckpointRunRecord[] {
  return (db.prepare(`
    SELECT * FROM checkpoint_runs
    WHERE status NOT IN ('DONE','FAILED_TERMINAL')
    ORDER BY created_at, id
  `).all() as DbRow[]).map(checkpointRunFromRow);
}

export function listCheckpointRuns(db: DatabaseSync): CheckpointRunRecord[] {
  return (db.prepare("SELECT * FROM checkpoint_runs ORDER BY created_at, id").all() as DbRow[])
    .map(checkpointRunFromRow);
}

export function claimCheckpointRun(
  db: DatabaseSync,
  id: string,
  leaseOwner: string,
  leaseDurationMs: number,
  force = false
): CheckpointRunRecord {
  const run = required(getCheckpointRun(db, id), `unknown checkpoint run: ${id}`);
  if (TERMINAL_STATUSES.includes(run.status)) return run;
  const activeLease = run.leaseOwner !== null
    && run.leaseOwner !== leaseOwner
    && run.leaseExpiresAt !== null
    && Date.parse(run.leaseExpiresAt) > Date.now();
  if (activeLease && !force) {
    throw new Error(`CHECKPOINT_LEASE_HELD: ${id} by ${run.leaseOwner} until ${run.leaseExpiresAt}`);
  }
  db.prepare("UPDATE checkpoint_runs SET lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=?")
    .run(leaseOwner, leaseExpiration(leaseDurationMs), now(), id);
  return required(getCheckpointRun(db, id), "checkpoint lease claim failed");
}

export function renewCheckpointLease(
  db: DatabaseSync,
  id: string,
  leaseOwner: string,
  leaseDurationMs: number
): void {
  const result = db.prepare(`
    UPDATE checkpoint_runs SET lease_expires_at=?,updated_at=?
    WHERE id=? AND lease_owner=? AND status NOT IN ('DONE','FAILED_TERMINAL')
  `).run(leaseExpiration(leaseDurationMs), now(), id, leaseOwner);
  if (Number(result.changes) !== 1) throw new Error(`CHECKPOINT_LEASE_LOST: ${id}`);
}

export function recordCheckpointEvidence(
  db: DatabaseSync,
  id: string,
  leaseOwner: string,
  input: CheckpointEvidenceInput,
  leaseDurationMs: number
): CheckpointRunRecord {
  const result = db.prepare(`
    UPDATE checkpoint_runs SET status='VERIFIED',diff_hash=?,changed_files_json=?,
      impacted_completed_phases_json=?,evidence_json=?,correction_id=?,last_error=NULL,
      lease_expires_at=?,updated_at=?
    WHERE id=? AND lease_owner=? AND status IN ('VERIFYING','FAILED_RETRYABLE')
  `).run(
    input.evidence.diffHash,
    JSON.stringify(input.evidence.changedFiles),
    JSON.stringify(input.impactedCompletedPhases),
    JSON.stringify(input.evidence),
    input.correctionId,
    leaseExpiration(leaseDurationMs),
    now(),
    id,
    leaseOwner
  );
  assertChanged(result.changes, `CHECKPOINT_EVIDENCE_CAS_FAILED: ${id}`);
  return required(getCheckpointRun(db, id), "checkpoint evidence update failed");
}

export function recordCheckpointCommit(
  db: DatabaseSync,
  id: string,
  leaseOwner: string,
  gitSha: string,
  leaseDurationMs: number
): CheckpointRunRecord {
  const result = db.prepare(`
    UPDATE checkpoint_runs SET status='GIT_COMMITTED',actual_git_sha=?,lease_expires_at=?,updated_at=?
    WHERE id=? AND lease_owner=? AND status IN ('VERIFIED','FAILED_RETRYABLE')
  `).run(gitSha, leaseExpiration(leaseDurationMs), now(), id, leaseOwner);
  assertChanged(result.changes, `CHECKPOINT_COMMIT_CAS_FAILED: ${id}`);
  return required(getCheckpointRun(db, id), "checkpoint commit update failed");
}

export function markCheckpointStateCommitted(
  db: DatabaseSync,
  id: string,
  leaseOwner: string,
  leaseDurationMs: number
): CheckpointRunRecord {
  const result = db.prepare(`
    UPDATE checkpoint_runs SET status='STATE_COMMITTED',lease_expires_at=?,updated_at=?
    WHERE id=? AND lease_owner=? AND status IN ('GIT_COMMITTED','FAILED_RETRYABLE')
  `).run(leaseExpiration(leaseDurationMs), now(), id, leaseOwner);
  assertChanged(result.changes, `CHECKPOINT_STATE_CAS_FAILED: ${id}`);
  return required(getCheckpointRun(db, id), "checkpoint state update failed");
}

export function markCheckpointStep(
  db: DatabaseSync,
  id: string,
  leaseOwner: string,
  column: string,
  leaseDurationMs: number
): CheckpointRunRecord {
  if (!STEP_COLUMNS.has(column)) throw new Error(`invalid checkpoint step column: ${column}`);
  const result = db.prepare(`
    UPDATE checkpoint_runs SET ${column}=COALESCE(${column},?),status='POST_PROCESSING',
      lease_expires_at=?,updated_at=?
    WHERE id=? AND lease_owner=? AND status IN ('STATE_COMMITTED','POST_PROCESSING','FAILED_RETRYABLE')
  `).run(now(), leaseExpiration(leaseDurationMs), now(), id, leaseOwner);
  assertChanged(result.changes, `CHECKPOINT_STEP_CAS_FAILED: ${id}/${column}`);
  return required(getCheckpointRun(db, id), "checkpoint step update failed");
}

export function setCheckpointReverificationRequired(
  db: DatabaseSync,
  id: string,
  leaseOwner: string,
  phaseIds: string[],
  leaseDurationMs: number
): CheckpointRunRecord {
  const result = db.prepare(`
    UPDATE checkpoint_runs SET reverification_required_json=?,reverification_completed_at=COALESCE(reverification_completed_at,?),
      status='POST_PROCESSING',lease_expires_at=?,updated_at=?
    WHERE id=? AND lease_owner=? AND status IN ('STATE_COMMITTED','POST_PROCESSING','FAILED_RETRYABLE')
  `).run(
    JSON.stringify([...new Set(phaseIds)]),
    now(),
    leaseExpiration(leaseDurationMs),
    now(),
    id,
    leaseOwner
  );
  assertChanged(result.changes, `CHECKPOINT_REVERIFY_CAS_FAILED: ${id}`);
  return required(getCheckpointRun(db, id), "checkpoint reverification update failed");
}

export function completeCheckpointRun(db: DatabaseSync, id: string, leaseOwner: string): CheckpointRunRecord {
  const timestamp = now();
  const result = db.prepare(`
    UPDATE checkpoint_runs SET status='DONE',lease_owner=NULL,lease_expires_at=NULL,
      last_error=NULL,updated_at=?,completed_at=COALESCE(completed_at,?)
    WHERE id=? AND lease_owner=? AND status NOT IN ('DONE','FAILED_TERMINAL')
  `).run(timestamp, timestamp, id, leaseOwner);
  assertChanged(result.changes, `CHECKPOINT_COMPLETE_CAS_FAILED: ${id}`);
  return required(getCheckpointRun(db, id), "checkpoint completion update failed");
}

export function markCheckpointRetryable(
  db: DatabaseSync,
  id: string,
  leaseOwner: string,
  error: string
): CheckpointRunRecord {
  const result = db.prepare(`
    UPDATE checkpoint_runs SET status='FAILED_RETRYABLE',last_error=?,lease_owner=NULL,
      lease_expires_at=NULL,updated_at=?
    WHERE id=? AND lease_owner=? AND status NOT IN ('DONE','FAILED_TERMINAL')
  `).run(error, now(), id, leaseOwner);
  assertChanged(result.changes, `CHECKPOINT_RETRYABLE_CAS_FAILED: ${id}`);
  return required(getCheckpointRun(db, id), "checkpoint retryable update failed");
}

export function markCheckpointTerminal(
  db: DatabaseSync,
  id: string,
  leaseOwner: string,
  error: string
): CheckpointRunRecord {
  const timestamp = now();
  const result = db.prepare(`
    UPDATE checkpoint_runs SET status='FAILED_TERMINAL',last_error=?,lease_owner=NULL,
      lease_expires_at=NULL,updated_at=?,completed_at=COALESCE(completed_at,?)
    WHERE id=? AND lease_owner=? AND status!='DONE'
  `).run(error, timestamp, timestamp, id, leaseOwner);
  assertChanged(result.changes, `CHECKPOINT_TERMINAL_CAS_FAILED: ${id}`);
  return required(getCheckpointRun(db, id), "checkpoint terminal update failed");
}

export function expireCheckpointLease(db: DatabaseSync, id: string, leaseOwner: string): void {
  db.prepare(`
    UPDATE checkpoint_runs SET lease_expires_at=?,updated_at=?
    WHERE id=? AND lease_owner=? AND status NOT IN ('DONE','FAILED_TERMINAL')
  `).run(new Date(0).toISOString(), now(), id, leaseOwner);
}

function checkpointRunFromRow(row: DbRow): CheckpointRunRecord {
  return {
    id: text(row.id),
    phaseId: text(row.phase_id),
    executionMode: text(row.execution_mode) as CheckpointExecutionMode,
    summary: text(row.summary),
    status: text(row.status) as CheckpointRunStatus,
    workspaceBaselineSha: text(row.workspace_baseline_sha),
    targetBaselineSha: text(row.target_baseline_sha),
    actualGitSha: nullable(row.actual_git_sha),
    diffHash: nullable(row.diff_hash),
    changedFiles: json<string[]>(row.changed_files_json),
    impactedCompletedPhases: json<string[]>(row.impacted_completed_phases_json),
    reverificationRequired: json<string[]>(row.reverification_required_json),
    evidence: row.evidence_json === null ? null : json<VerificationEvidence>(row.evidence_json),
    correctionId: nullable(row.correction_id),
    leaseOwner: nullable(row.lease_owner),
    leaseExpiresAt: nullable(row.lease_expires_at),
    lastError: nullable(row.last_error),
    indexCompletedAt: nullable(row.index_completed_at),
    reverificationCompletedAt: nullable(row.reverification_completed_at),
    memoryCompletedAt: nullable(row.memory_completed_at),
    cleanupCompletedAt: nullable(row.cleanup_completed_at),
    correctionCompletedAt: nullable(row.correction_completed_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    completedAt: nullable(row.completed_at)
  };
}

function leaseExpiration(durationMs: number): string {
  return new Date(Date.now() + Math.max(30_000, durationMs)).toISOString();
}

function assertChanged(changes: number | bigint, message: string): void {
  if (Number(changes) !== 1) throw new Error(message);
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
