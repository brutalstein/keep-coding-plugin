import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { VerificationEvidence } from "../src/domain/model.js";
import {
  activeCheckpointRun,
  beginCheckpointRun,
  claimCheckpointRun,
  completeCheckpointRun,
  expireCheckpointLease,
  getCheckpointRun,
  listCheckpointRuns,
  listRecoverableCheckpointRuns,
  markCheckpointRetryable,
  markCheckpointStateCommitted,
  markCheckpointStep,
  markCheckpointTerminal,
  recordCheckpointCommit,
  recordCheckpointEvidence,
  renewCheckpointLease,
  setCheckpointReverificationRequired
} from "../src/storage/checkpoint-runs.js";

const databases: DatabaseSync[] = [];
afterEach(() => { while (databases.length > 0) databases.pop()!.close(); });

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE phases (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE checkpoint_runs (
      id TEXT PRIMARY KEY, phase_id TEXT NOT NULL, execution_mode TEXT NOT NULL, summary TEXT NOT NULL,
      status TEXT NOT NULL, workspace_baseline_sha TEXT NOT NULL, target_baseline_sha TEXT NOT NULL,
      actual_git_sha TEXT, diff_hash TEXT, changed_files_json TEXT NOT NULL DEFAULT '[]',
      impacted_completed_phases_json TEXT NOT NULL DEFAULT '[]',
      reverification_required_json TEXT NOT NULL DEFAULT '[]', evidence_json TEXT, correction_id TEXT,
      lease_owner TEXT, lease_expires_at TEXT, last_error TEXT, index_completed_at TEXT,
      reverification_completed_at TEXT, memory_completed_at TEXT, cleanup_completed_at TEXT,
      correction_completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE UNIQUE INDEX checkpoint_runs_active_phase
      ON checkpoint_runs(phase_id) WHERE status NOT IN ('DONE','FAILED_TERMINAL');
  `);
  return db;
}

function insertPhase(db: DatabaseSync, id = "phase", status = "IN_PROGRESS"): void {
  db.prepare("INSERT INTO phases(id,status) VALUES(?,?)").run(id, status);
}

function begin(db: DatabaseSync, owner = "owner-a") {
  return beginCheckpointRun(db, {
    phaseId: "phase",
    executionMode: "serial",
    summary: "verified change",
    workspaceBaselineSha: "base-workspace",
    targetBaselineSha: "base-target",
    leaseOwner: owner,
    leaseDurationMs: 60_000
  });
}

function evidence(passed = true): VerificationEvidence {
  return {
    passed,
    scopePassed: passed,
    scopeViolations: [],
    changedFiles: ["src/main.ts"],
    secretScan: { passed: true, scannedFiles: ["src/main.ts"], findings: [] },
    budget: {
      passed: true,
      limits: {},
      usage: { tokens: 0, estimatedTokens: 0, costUsd: 0, wallClockMs: 0, updatedAt: "" },
      violations: []
    },
    selectiveCommands: [],
    commands: [],
    critic: { configured: false, blocking: false, passed: true, summary: "not configured", findings: [], rawOutput: "" },
    impactedCompletedPhases: ["previous"],
    diffHash: "diff-hash",
    gitSha: ""
  };
}

describe("checkpoint journal primitives", () => {
  it("persists a complete idempotent checkpoint lifecycle", () => {
    const db = database();
    insertPhase(db);
    const run = begin(db);

    expect(getCheckpointRun(db, run.id)).toMatchObject({ status: "VERIFYING", leaseOwner: "owner-a" });
    expect(activeCheckpointRun(db, "phase")?.id).toBe(run.id);
    expect(listCheckpointRuns(db)).toHaveLength(1);
    expect(listRecoverableCheckpointRuns(db)).toHaveLength(1);

    claimCheckpointRun(db, run.id, "owner-a", 60_000);
    renewCheckpointLease(db, run.id, "owner-a", 60_000);
    recordCheckpointEvidence(db, run.id, "owner-a", {
      evidence: evidence(),
      impactedCompletedPhases: ["previous"],
      correctionId: "correction"
    }, 60_000);
    const committed = recordCheckpointCommit(db, run.id, "owner-a", "git-sha", 60_000);
    expect(committed.evidence?.gitSha).toBe("git-sha");
    expect(committed.actualGitSha).toBe("git-sha");

    markCheckpointStateCommitted(db, run.id, "owner-a", 60_000);
    markCheckpointStep(db, run.id, "owner-a", "index_completed_at", 60_000);
    const reverification = setCheckpointReverificationRequired(
      db,
      run.id,
      "owner-a",
      ["previous", "previous", "other"],
      60_000
    );
    expect(reverification.reverificationRequired).toEqual(["previous", "other"]);
    markCheckpointStep(db, run.id, "owner-a", "memory_completed_at", 60_000);
    markCheckpointStep(db, run.id, "owner-a", "cleanup_completed_at", 60_000);
    const done = completeCheckpointRun(db, run.id, "owner-a");

    expect(done).toMatchObject({ status: "DONE", leaseOwner: null, leaseExpiresAt: null, lastError: null });
    expect(done.completedAt).not.toBeNull();
    expect(activeCheckpointRun(db, "phase")).toBeNull();
    expect(listRecoverableCheckpointRuns(db)).toHaveLength(0);
    expect(claimCheckpointRun(db, run.id, "owner-b", 60_000)).toMatchObject({ status: "DONE" });
  });

  it("enforces lease ownership, phase CAS, and retryable replay", () => {
    const db = database();
    expect(() => claimCheckpointRun(db, "missing", "owner", 60_000)).toThrow(/unknown checkpoint run/u);
    expect(() => begin(db)).toThrow(/CHECKPOINT_PHASE_CAS_FAILED/u);

    insertPhase(db);
    const run = begin(db);
    expect(() => begin(db, "owner-b")).toThrow(/CHECKPOINT_ALREADY_ACTIVE/u);
    expect(() => claimCheckpointRun(db, run.id, "owner-b", 60_000)).toThrow(/CHECKPOINT_LEASE_HELD/u);
    expect(claimCheckpointRun(db, run.id, "owner-b", 60_000, true).leaseOwner).toBe("owner-b");
    expect(() => renewCheckpointLease(db, run.id, "owner-a", 60_000)).toThrow(/CHECKPOINT_LEASE_LOST/u);
    expect(() => recordCheckpointEvidence(db, run.id, "owner-a", {
      evidence: evidence(),
      impactedCompletedPhases: [],
      correctionId: null
    }, 60_000)).toThrow(/CHECKPOINT_EVIDENCE_CAS_FAILED/u);
    expect(() => recordCheckpointCommit(db, run.id, "owner-b", "git-sha", 60_000))
      .toThrow(/checkpoint evidence missing/u);

    expireCheckpointLease(db, run.id, "owner-b");
    const retryable = markCheckpointRetryable(db, run.id, "owner-b", "transient failure");
    expect(retryable).toMatchObject({ status: "FAILED_RETRYABLE", lastError: "transient failure", leaseOwner: null });
    claimCheckpointRun(db, run.id, "owner-c", 60_000);
    const verified = recordCheckpointEvidence(db, run.id, "owner-c", {
      evidence: evidence(),
      impactedCompletedPhases: [],
      correctionId: null
    }, 60_000);
    expect(verified).toMatchObject({ status: "VERIFIED", lastError: null });
    expect(() => markCheckpointStep(db, run.id, "owner-c", "not_a_step", 60_000))
      .toThrow(/invalid checkpoint step column/u);
    expect(() => completeCheckpointRun(db, run.id, "wrong-owner"))
      .toThrow(/CHECKPOINT_COMPLETE_CAS_FAILED/u);
  });

  it("supports terminal recovery records and rejects invalid transition owners", () => {
    const db = database();
    insertPhase(db);
    const run = begin(db);
    recordCheckpointEvidence(db, run.id, "owner-a", {
      evidence: evidence(false),
      impactedCompletedPhases: [],
      correctionId: null
    }, 60_000);
    markCheckpointStateCommitted(db, run.id, "owner-a", 60_000);

    expect(() => markCheckpointRetryable(db, run.id, "owner-b", "wrong owner"))
      .toThrow(/CHECKPOINT_RETRYABLE_CAS_FAILED/u);
    const terminal = markCheckpointTerminal(db, run.id, "owner-a", "manual reconciliation required");
    expect(terminal).toMatchObject({
      status: "FAILED_TERMINAL",
      lastError: "manual reconciliation required",
      leaseOwner: null
    });
    expect(terminal.completedAt).not.toBeNull();
    expect(listRecoverableCheckpointRuns(db)).toHaveLength(0);
    expect(claimCheckpointRun(db, run.id, "owner-c", 60_000)).toMatchObject({ status: "FAILED_TERMINAL" });
    expect(() => markCheckpointTerminal(db, run.id, "owner-c", "second terminal"))
      .toThrow(/CHECKPOINT_TERMINAL_CAS_FAILED/u);
  });
});
