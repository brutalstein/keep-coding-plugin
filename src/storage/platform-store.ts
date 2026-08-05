import { randomUUID } from "node:crypto";
import { normalizedDiagnosticSignature } from "../core/signature.js";
import type {
  ApprovalRecord, BudgetEvidence, BudgetLimits, BudgetUsage, CheckpointExecutionMode, CheckpointRunRecord,
  CommandFailureRecord, CorrectionRecord, EventRecord, FailureRecord, FileDigest, GraphEdge, GraphNode,
  ImpactNode, PhaseDefinition, PhaseRecord, PlanAmendment, PlanRevisionRecord, ProjectContract,
  ProjectRecord, ProjectSnapshot, VerificationEvidence, WorktreeRecord
} from "../domain/model.js";
import {
  beginCheckpointRun as insertCheckpointRun,
  claimCheckpointRun as acquireCheckpointRun,
  completeCheckpointRun as finishCheckpointRun,
  expireCheckpointLease as expireRunLease,
  getCheckpointRun as readCheckpointRun,
  listCheckpointRuns as readCheckpointRuns,
  listRecoverableCheckpointRuns as readRecoverableCheckpointRuns,
  markCheckpointRetryable as setCheckpointRetryable,
  markCheckpointStep,
  markCheckpointTerminal as setCheckpointTerminal,
  recordCheckpointCommit as persistCheckpointCommit,
  recordCheckpointEvidence as persistCheckpointEvidence,
  renewCheckpointLease as extendCheckpointLease,
  setCheckpointReverificationRequired
} from "./checkpoint-runs.js";
import { ProjectStore } from "./store.js";
import { PlatformDb, type DbRow, json, nullable, now, text } from "./platform-db.js";
import { graphNode, impact, impactedTests } from "./platform-impact.js";
import { amendPlan, listPlanRevisions, recordInitialPlan } from "./platform-plan.js";
import {
  budgetEvidence, getBudgetUsage, getWorktree, listApprovals, listBudgetUsage, listWorktrees,
  recordBudgetUsage, recordCriticReview, requestApproval, resolveApproval, setWorktree
} from "./platform-runtime.js";

export class PlatformStore extends ProjectStore {
  private readonly platform: PlatformDb;
  constructor(projectRoot: string) { super(projectRoot); this.platform = new PlatformDb(this.db); }
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
    const updated = this.platform.db.prepare(`
      UPDATE phases SET status='IN_PROGRESS',started_at=COALESCE(started_at,?),
        base_sha=COALESCE(base_sha,?),reverify_reason=NULL
      WHERE id=? AND status IN ('READY','FAILED','REVERIFY_REQUIRED')
    `).run(timestamp, baseSha, id);
    if (Number(updated.changes) !== 1) throw new Error(`phase ${id} changed before it could start`);
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

  override recordFailure(phaseId: string, summary: string, fingerprint?: string): FailureRecord {
    return super.recordFailure(phaseId, summary, fingerprint?.trim() || normalizedDiagnosticSignature(summary));
  }

  requestApproval(phaseId: string, prompt: string): ApprovalRecord { return requestApproval(this.runtimeHost(), phaseId, prompt); }
  resolveApproval(id: string, approved: boolean, note: string): ApprovalRecord { return resolveApproval(this.runtimeHost(), id, approved, note); }
  listApprovals(): ApprovalRecord[] { return listApprovals(this.platform.db); }
  listPlanRevisions(): PlanRevisionRecord[] { return listPlanRevisions(this.platform.db); }
  recordBudgetUsage(scope: "project" | "phase", scopeId: string, delta: Partial<Omit<BudgetUsage, "updatedAt">>, eventType = "budget_usage_recorded"): BudgetUsage {
    const usage = recordBudgetUsage(this.platform.db, scope, scopeId, delta);
    this.appendEvent(eventType, scope === "phase" ? scopeId : null, { scope, scopeId, delta });
    return usage;
  }
  recordBudgetUsageOnce(
    receiptKey: string,
    scope: "project" | "phase",
    scopeId: string,
    delta: Partial<Omit<BudgetUsage, "updatedAt">>,
    eventType = "budget_usage_recorded"
  ): BudgetUsage {
    return this.platform.transaction(() => {
      const receipt = this.platform.db.prepare("INSERT OR IGNORE INTO budget_usage_receipts(receipt_key,created_at) VALUES(?,?)")
        .run(receiptKey, now());
      if (Number(receipt.changes) === 0) return getBudgetUsage(this.platform.db, scope, scopeId);
      const usage = recordBudgetUsage(this.platform.db, scope, scopeId, delta);
      this.appendEvent(eventType, scope === "phase" ? scopeId : null, { scope, scopeId, delta, receiptKey });
      return usage;
    });
  }
  budgetEvidence(phaseId: string): BudgetEvidence { return budgetEvidence(this.runtimeHost(), phaseId); }
  listBudgetUsage(): Record<string, BudgetUsage> { return listBudgetUsage(this.platform.db); }
  setWorktree(record: WorktreeRecord): void { setWorktree(this.platform.db, record); }
  getWorktree(id: string): WorktreeRecord | null { return getWorktree(this.platform.db, id); }
  listWorktrees(): WorktreeRecord[] { return listWorktrees(this.platform.db); }

  beginCheckpointRun(input: {
    phaseId: string;
    executionMode: CheckpointExecutionMode;
    summary: string;
    workspaceBaselineSha: string;
    targetBaselineSha: string;
    leaseOwner: string;
    leaseDurationMs: number;
  }): CheckpointRunRecord {
    return this.platform.transaction(() => {
      const run = insertCheckpointRun(this.platform.db, input);
      this.appendEvent("checkpoint_run_started", input.phaseId, {
        runId: run.id,
        executionMode: input.executionMode,
        workspaceBaselineSha: input.workspaceBaselineSha,
        targetBaselineSha: input.targetBaselineSha
      });
      return run;
    });
  }

  claimCheckpointRun(id: string, leaseOwner: string, leaseDurationMs: number, force = false): CheckpointRunRecord {
    return this.platform.transaction(() => {
      const run = acquireCheckpointRun(this.platform.db, id, leaseOwner, leaseDurationMs, force);
      this.appendEvent("checkpoint_run_claimed", run.phaseId, { runId: id, forced: force });
      return run;
    });
  }

  renewCheckpointLease(id: string, leaseOwner: string, leaseDurationMs: number): void {
    extendCheckpointLease(this.platform.db, id, leaseOwner, leaseDurationMs);
  }

  expireCheckpointLease(id: string, leaseOwner: string): void {
    expireRunLease(this.platform.db, id, leaseOwner);
  }

  getCheckpointRun(id: string): CheckpointRunRecord | null { return readCheckpointRun(this.platform.db, id); }
  listCheckpointRuns(): CheckpointRunRecord[] { return readCheckpointRuns(this.platform.db); }
  listRecoverableCheckpointRuns(): CheckpointRunRecord[] { return readRecoverableCheckpointRuns(this.platform.db); }

  recordCheckpointEvidence(
    id: string,
    leaseOwner: string,
    evidence: VerificationEvidence,
    impactedCompletedPhases: string[],
    correctionId: string | null,
    leaseDurationMs: number
  ): CheckpointRunRecord {
    return this.platform.transaction(() => {
      const run = persistCheckpointEvidence(this.platform.db, id, leaseOwner, {
        evidence,
        impactedCompletedPhases,
        correctionId
      }, leaseDurationMs);
      this.appendEvent("checkpoint_evidence_recorded", run.phaseId, {
        runId: id,
        passed: evidence.passed,
        diffHash: evidence.diffHash,
        changedFiles: evidence.changedFiles
      });
      return run;
    });
  }

  recordCheckpointCommit(id: string, leaseOwner: string, gitSha: string, leaseDurationMs: number): CheckpointRunRecord {
    return this.platform.transaction(() => {
      const run = persistCheckpointCommit(this.platform.db, id, leaseOwner, gitSha, leaseDurationMs);
      this.appendEvent("checkpoint_git_committed", run.phaseId, { runId: id, gitSha });
      return run;
    });
  }

  commitCheckpointState(
    id: string,
    leaseOwner: string,
    leaseDurationMs: number
  ): { run: CheckpointRunRecord; phase: PhaseRecord } {
    return this.platform.transaction(() => {
      const run = required(this.getCheckpointRun(id), `unknown checkpoint run: ${id}`);
      if (["STATE_COMMITTED", "POST_PROCESSING", "DONE"].includes(run.status)) {
        return { run, phase: required(this.getPhase(run.phaseId), `unknown phase: ${run.phaseId}`) };
      }
      if (run.leaseOwner !== leaseOwner) throw new Error(`CHECKPOINT_LEASE_LOST: ${id}`);
      const evidence = required(run.evidence, `checkpoint evidence missing: ${id}`);
      const phase = required(this.getPhase(run.phaseId), `unknown phase: ${run.phaseId}`);
      const timestamp = now();

      if (evidence.passed) {
        const gitSha = required(run.actualGitSha, `checkpoint Git SHA missing: ${id}`);
        if (phase.status === "VERIFYING") {
          const update = this.platform.db.prepare(`
            UPDATE phases SET status='COMPLETED',completed_at=?,head_sha=?,summary=?
            WHERE id=? AND status='VERIFYING'
          `).run(timestamp, gitSha, run.summary, run.phaseId);
          if (Number(update.changes) !== 1) throw new Error(`CHECKPOINT_PHASE_COMMIT_CAS_FAILED: ${run.phaseId}`);
          this.platform.db.prepare(`
            INSERT OR IGNORE INTO checkpoints(
              id,phase_id,git_sha,summary,changed_files_json,verification_json,created_at,run_id
            ) VALUES(?,?,?,?,?,?,?,?)
          `).run(id, run.phaseId, gitSha, run.summary, JSON.stringify(evidence.changedFiles), JSON.stringify(evidence), timestamp, id);
          for (const file of evidence.changedFiles) {
            this.platformGraphEdge({
              sourceId: `phase:${run.phaseId}`,
              targetId: `file:${file}`,
              type: "modifies",
              metadata: { checkpointId: id, diffHash: evidence.diffHash, runId: id }
            });
          }
          this.appendEvent("phase_completed", run.phaseId, {
            checkpointId: id,
            runId: id,
            changedFiles: evidence.changedFiles
          });
        } else if (phase.status !== "COMPLETED") {
          throw new Error(`CHECKPOINT_PHASE_STATE_DIVERGED: ${run.phaseId} is ${phase.status}`);
        }
      } else if (phase.status === "VERIFYING") {
        const attempts = phase.attempts + 1;
        if (!evidence.budget.passed) {
          this.platform.db.prepare("UPDATE phases SET status='BLOCKED_BUDGET',attempts=?,summary=? WHERE id=?")
            .run(attempts, run.summary, run.phaseId);
          this.platform.db.prepare("UPDATE project SET status='BLOCKED_BUDGET',current_phase_id=?,updated_at=?")
            .run(run.phaseId, timestamp);
          this.appendEvent("phase_budget_blocked", run.phaseId, { runId: id, violations: evidence.budget.violations });
        } else {
          const status = attempts >= phase.maxAttempts ? "BLOCKED" : "FAILED";
          this.platform.db.prepare("UPDATE phases SET status=?,attempts=?,summary=? WHERE id=?")
            .run(status, attempts, run.summary, run.phaseId);
          if (status === "BLOCKED") {
            this.platform.db.prepare("UPDATE project SET status='BLOCKED',current_phase_id=?,updated_at=?")
              .run(run.phaseId, timestamp);
          }
          this.appendEvent("phase_verification_failed", run.phaseId, {
            runId: id,
            attempts,
            status,
            scopeViolations: evidence.scopeViolations,
            failedCommands: evidence.commands.filter((command) => !command.passed).map((command) => command.command)
          });
        }
      } else if (!["FAILED", "BLOCKED", "BLOCKED_BUDGET"].includes(phase.status)) {
        throw new Error(`CHECKPOINT_PHASE_STATE_DIVERGED: ${run.phaseId} is ${phase.status}`);
      }

      this.recordCriticReviewOnce(id, run.phaseId, evidence);
      const transition = this.platform.db.prepare(`
        UPDATE checkpoint_runs SET status='STATE_COMMITTED',lease_expires_at=?,updated_at=?
        WHERE id=? AND lease_owner=? AND status IN ('VERIFIED','GIT_COMMITTED','FAILED_RETRYABLE')
      `).run(new Date(Date.now() + Math.max(30_000, leaseDurationMs)).toISOString(), timestamp, id, leaseOwner);
      if (Number(transition.changes) !== 1) throw new Error(`CHECKPOINT_STATE_CAS_FAILED: ${id}`);
      if (evidence.passed) this.refreshReadiness();
      return {
        run: required(this.getCheckpointRun(id), "checkpoint state update failed"),
        phase: required(this.getPhase(run.phaseId), "phase state update failed")
      };
    });
  }

  recordCheckpointCorrectionOutcome(
    id: string,
    leaseOwner: string,
    tokenEnd: number,
    complete: boolean,
    leaseDurationMs: number
  ): CorrectionRecord | null {
    return this.platform.transaction(() => {
      const run = required(this.getCheckpointRun(id), `unknown checkpoint run: ${id}`);
      if (!run.correctionId) return null;
      if (run.correctionCompletedAt) return this.getCorrection(run.correctionId);
      const assessed = super.assessCorrectionOutcome(run.correctionId, run.changedFiles, tokenEnd, complete);
      markCheckpointStep(this.platform.db, id, leaseOwner, "correction_completed_at", leaseDurationMs);
      return assessed.correction;
    });
  }

  markCheckpointIndexed(id: string, leaseOwner: string, leaseDurationMs: number): CheckpointRunRecord {
    return this.platform.transaction(() => markCheckpointStep(
      this.platform.db,
      id,
      leaseOwner,
      "index_completed_at",
      leaseDurationMs
    ));
  }

  markCheckpointReverification(
    id: string,
    leaseOwner: string,
    reason: string,
    leaseDurationMs: number
  ): string[] {
    return this.platform.transaction(() => {
      const run = required(this.getCheckpointRun(id), `unknown checkpoint run: ${id}`);
      if (run.reverificationCompletedAt) return run.reverificationRequired;
      const marked = this.markReverification(run.impactedCompletedPhases, reason, run.phaseId);
      setCheckpointReverificationRequired(this.platform.db, id, leaseOwner, marked, leaseDurationMs);
      return marked;
    });
  }

  markCheckpointMemoryCompleted(id: string, leaseOwner: string, leaseDurationMs: number): CheckpointRunRecord {
    return this.platform.transaction(() => markCheckpointStep(
      this.platform.db,
      id,
      leaseOwner,
      "memory_completed_at",
      leaseDurationMs
    ));
  }

  markCheckpointCleanupCompleted(id: string, leaseOwner: string, leaseDurationMs: number): CheckpointRunRecord {
    return this.platform.transaction(() => markCheckpointStep(
      this.platform.db,
      id,
      leaseOwner,
      "cleanup_completed_at",
      leaseDurationMs
    ));
  }

  completeCheckpointRun(id: string, leaseOwner: string): CheckpointRunRecord {
    return this.platform.transaction(() => {
      const run = finishCheckpointRun(this.platform.db, id, leaseOwner);
      this.appendEvent("checkpoint_run_completed", run.phaseId, { runId: id, passed: run.evidence?.passed ?? false });
      return run;
    });
  }

  resetCheckpointRun(id: string, leaseOwner: string, error: string): CheckpointRunRecord {
    return this.platform.transaction(() => {
      const run = required(this.getCheckpointRun(id), `unknown checkpoint run: ${id}`);
      if (run.leaseOwner !== leaseOwner) throw new Error(`CHECKPOINT_LEASE_LOST: ${id}`);
      this.platform.db.prepare("UPDATE phases SET status='IN_PROGRESS' WHERE id=? AND status='VERIFYING'")
        .run(run.phaseId);
      this.platform.db.prepare("UPDATE project SET status='ACTIVE',current_phase_id=?,updated_at=?")
        .run(run.phaseId, now());
      const timestamp = now();
      const update = this.platform.db.prepare(`
        UPDATE checkpoint_runs SET status='DONE',last_error=?,lease_owner=NULL,lease_expires_at=NULL,
          updated_at=?,completed_at=COALESCE(completed_at,?)
        WHERE id=? AND lease_owner=? AND status NOT IN ('DONE','FAILED_TERMINAL')
      `).run(error, timestamp, timestamp, id, leaseOwner);
      if (Number(update.changes) !== 1) throw new Error(`CHECKPOINT_RESET_CAS_FAILED: ${id}`);
      this.appendEvent("checkpoint_run_reset", run.phaseId, { runId: id, error });
      return required(this.getCheckpointRun(id), "checkpoint reset failed");
    });
  }

  markCheckpointRetryable(id: string, leaseOwner: string, error: string): CheckpointRunRecord {
    return this.platform.transaction(() => {
      const run = setCheckpointRetryable(this.platform.db, id, leaseOwner, error);
      this.appendEvent("checkpoint_run_retryable", run.phaseId, { runId: id, error });
      return run;
    });
  }

  blockCheckpointRecovery(id: string, leaseOwner: string, error: string): CheckpointRunRecord {
    return this.platform.transaction(() => {
      const run = required(this.getCheckpointRun(id), `unknown checkpoint run: ${id}`);
      this.platform.db.prepare("UPDATE phases SET status='BLOCKED',summary=? WHERE id=?")
        .run(`Checkpoint recovery blocked: ${error}`, run.phaseId);
      this.platform.db.prepare("UPDATE project SET status='BLOCKED',current_phase_id=?,updated_at=?")
        .run(run.phaseId, now());
      const terminal = setCheckpointTerminal(this.platform.db, id, leaseOwner, error);
      this.appendEvent("checkpoint_recovery_blocked", run.phaseId, { runId: id, error });
      return terminal;
    });
  }

  eventsSince(sequence: number): EventRecord[] {
    return (this.platform.db.prepare("SELECT * FROM events WHERE sequence > ? ORDER BY sequence").all(sequence) as DbRow[]).map((row) => ({
      sequence: Number(row.sequence), timestamp: text(row.timestamp), type: text(row.type),
      phaseId: nullable(row.phase_id), payload: json<Record<string, unknown>>(row.payload_json)
    }));
  }

  getLastDeliveredSequence(cursor: string): number {
    const row = this.platform.db.prepare("SELECT value FROM metadata WHERE key = ?").get(`context_cursor:${cursor}`) as DbRow | undefined;
    return row ? Number(row.value) : 0;
  }
  setLastDeliveredSequence(cursor: string, sequence: number): void {
    this.platform.db.prepare(`INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(`context_cursor:${cursor}`, String(sequence));
  }

  fileDigest(filePath: string): FileDigest | null {
    const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
    const file = this.platform.db.prepare("SELECT * FROM graph_nodes WHERE id = ? AND active = 1").get(`file:${normalized}`) as DbRow | undefined;
    if (!file) return null;
    const metadata = json<Record<string, unknown>>(file.metadata_json);
    const symbols = (this.platform.db.prepare("SELECT * FROM graph_nodes WHERE path = ? AND type = 'symbol' AND active = 1 ORDER BY CAST(json_extract(metadata_json,'$.line') AS INTEGER), label").all(normalized) as DbRow[])
      .map((row) => {
        const item = json<Record<string, unknown>>(row.metadata_json);
        return {
          name: text(row.label),
          kind: typeof item.kind === "string" ? item.kind : "symbol",
          line: typeof item.line === "number" ? item.line : 0
        };
      });
    const imports = (this.platform.db.prepare("SELECT target_id FROM graph_edges WHERE source_id = ? AND type = 'imports' ORDER BY target_id").all(`file:${normalized}`) as DbRow[])
      .map((row) => text(row.target_id).replace(/^file:/, ""));
    const modifier = this.platform.db.prepare("SELECT source_id FROM graph_edges WHERE target_id = ? AND type = 'modifies' ORDER BY updated_at DESC LIMIT 1").get(`file:${normalized}`) as DbRow | undefined;
    return {
      path: normalized,
      contentHash: nullable(file.content_hash),
      lineCount: Number(metadata.lineCount ?? 0),
      symbols,
      imports,
      lastModifiedByPhase: modifier ? text(modifier.source_id).replace(/^phase:/, "") : null
    };
  }

  latestCommandFailure(phaseId: string, command: string): CommandFailureRecord | null {
    const row = this.platform.db.prepare("SELECT * FROM command_failures WHERE phase_id=? AND command=? ORDER BY attempt DESC LIMIT 1").get(phaseId, command) as DbRow | undefined;
    return row ? commandFailureFromRow(row) : null;
  }
  recordCommandFailure(record: CommandFailureRecord): void {
    this.platform.db.prepare(`INSERT OR REPLACE INTO command_failures(phase_id,command,attempt,stdout,stderr,fingerprint,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(record.phaseId, record.command, record.attempt, record.stdout, record.stderr, record.fingerprint, record.createdAt);
  }

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
    return {
      ...super.snapshot(),
      approvals: this.listApprovals(),
      checkpointRuns: this.listCheckpointRuns(),
      planRevisions: this.listPlanRevisions(),
      worktrees: this.listWorktrees(),
      budgetUsage: this.listBudgetUsage()
    };
  }

  private recordCriticReviewOnce(runId: string, phaseId: string, evidence: VerificationEvidence): void {
    this.platform.db.prepare(`
      INSERT INTO critic_reviews(id,phase_id,evidence_json,created_at,run_id)
      VALUES(?,?,?,?,?) ON CONFLICT(run_id) DO NOTHING
    `).run(randomUUID(), phaseId, JSON.stringify(evidence.critic), now(), runId);
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
    const row = this.platform.db.prepare(`SELECT revision,superseded_by,requires_approval,approval_prompt,approved_at,budget_json,critic_blocking,parallel_safe,reverify_reason,verification_kind FROM phases WHERE id=?`).get(phase.id) as DbRow | undefined;
    if (!row) return phase;
    const budget = row.budget_json ? json<BudgetLimits>(row.budget_json) : {};
    return {
      ...phase, revision: Number(row.revision ?? 1), supersededBy: nullable(row.superseded_by), approvedAt: nullable(row.approved_at),
      reverifyReason: nullable(row.reverify_reason), requiresApproval: Boolean(row.requires_approval), criticBlocking: Boolean(row.critic_blocking),
      parallelSafe: Boolean(row.parallel_safe), verificationKind: text(row.verification_kind) as "code" | "non-code",
      ...(row.approval_prompt ? { approvalPrompt: text(row.approval_prompt) } : {}),
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

function commandFailureFromRow(row: DbRow): CommandFailureRecord {
  return {
    phaseId: text(row.phase_id), command: text(row.command), attempt: Number(row.attempt),
    stdout: text(row.stdout), stderr: text(row.stderr), fingerprint: text(row.fingerprint), createdAt: text(row.created_at)
  };
}
function required<T>(value: T | null | undefined, message: string): T { if (value === null || value === undefined) throw new Error(message); return value; }
