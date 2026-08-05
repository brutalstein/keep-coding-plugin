import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type {
  CheckpointExecutionMode,
  CheckpointRunRecord,
  CommandFailureRecord,
  CorrectionRecord,
  PhaseDefinition,
  PhaseRecord,
  ProjectRecord,
  VerificationEvidence
} from "../domain/model.js";
import { generateCommitMessage } from "../integrations/github.js";
import { PlaybookStore } from "../storage/playbook.js";
import type { PlatformStore } from "../storage/platform-store.js";
import { CriticRunner } from "./critic.js";
import { assessAmbiguity } from "./detector.js";
import { GitRepository } from "./git.js";
import { indexRepository } from "./indexer.js";
import { PhaseVerifier } from "./verifier.js";

const LEASE_DURATION_MS = 90_000;
const HEARTBEAT_INTERVAL_MS = 20_000;

export type CheckpointFaultPoint =
  | "after_run_started"
  | "after_verification"
  | "after_evidence_persisted"
  | "after_git_committed"
  | "after_state_committed"
  | "after_correction"
  | "after_indexing"
  | "after_reverification"
  | "after_memory_write"
  | "after_memory"
  | "after_cleanup";

export interface CheckpointPipelineHooks {
  faultInjector?: ((point: CheckpointFaultPoint, runId: string) => void | Promise<void>) | undefined;
}

export interface CheckpointRunOptions {
  phaseId: string;
  summary: string;
  executionMode?: CheckpointExecutionMode | undefined;
  workspaceGit: GitRepository;
  indexGit: GitRepository;
  reverificationReason: (changedFiles: string[]) => string;
}

export interface CheckpointRunResult {
  phase: PhaseRecord;
  evidence: VerificationEvidence;
  correction: CorrectionRecord | null;
  reverificationRequired: string[];
  project: ProjectRecord | null;
  nextAction: "start_phase" | "complete_project" | "repair_phase";
}

export interface CheckpointRecoveryReport {
  recovered: string[];
  reset: string[];
  blocked: string[];
  deferred: string[];
}

export class CheckpointCrashError extends Error {
  constructor(readonly point: CheckpointFaultPoint, readonly runId: string) {
    super(`simulated checkpoint crash at ${point}: ${runId}`);
    this.name = "CheckpointCrashError";
  }
}

class CheckpointRecoveryBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointRecoveryBlockedError";
  }
}

/**
 * Executes serial and parallel checkpoints through one durable saga.
 * Every irreversible step is journaled and can be replayed after process loss.
 */
export class CheckpointPipeline {
  constructor(
    private readonly store: PlatformStore,
    private readonly hooks: CheckpointPipelineHooks = {}
  ) {}

  static async recover(git: GitRepository, store: PlatformStore): Promise<CheckpointRecoveryReport> {
    const report: CheckpointRecoveryReport = { recovered: [], reset: [], blocked: [], deferred: [] };
    const pipeline = new CheckpointPipeline(store);
    for (const candidate of store.listRecoverableCheckpointRuns()) {
      if (!leaseCanBeTaken(candidate)) {
        report.deferred.push(candidate.id);
        continue;
      }
      const owner = leaseOwner();
      try {
        const run = store.claimCheckpointRun(candidate.id, owner, LEASE_DURATION_MS, true);
        if (!run.evidence) {
          store.resetCheckpointRun(run.id, owner, "Recovery reset a checkpoint that had no durable verification evidence.");
          report.reset.push(run.id);
          continue;
        }
        await pipeline.withLeaseHeartbeat(run.id, owner, async () => {
          await pipeline.resumeCommittedRun(run.id, owner, git);
        });
        report.recovered.push(run.id);
      } catch (error) {
        const current = store.getCheckpointRun(candidate.id);
        const message = errorMessage(error);
        if (current?.leaseOwner === owner && current.status !== "DONE" && current.status !== "FAILED_TERMINAL") {
          if (error instanceof CheckpointRecoveryBlockedError) {
            store.blockCheckpointRecovery(candidate.id, owner, message);
            report.blocked.push(candidate.id);
          } else {
            store.markCheckpointRetryable(candidate.id, owner, message);
            report.deferred.push(candidate.id);
          }
        } else if (current?.status === "FAILED_TERMINAL") {
          report.blocked.push(candidate.id);
        } else {
          report.deferred.push(candidate.id);
        }
      }
    }
    return report;
  }

  async run(options: CheckpointRunOptions): Promise<CheckpointRunResult> {
    const phase = required(this.store.getPhase(options.phaseId), `unknown phase: ${options.phaseId}`);
    const project = this.store.getProject();
    if (!project?.contract) throw new Error("project contract is missing");

    const baseline = this.store.getPhaseBaseline(options.phaseId) ?? undefined;
    const changedFiles = baseline
      ? await options.workspaceGit.changedFilesSince(baseline)
      : await options.workspaceGit.changedFiles();
    this.store.autoLinkChangedFiles(options.phaseId, changedFiles);
    await this.enforceAssumptionPolicy(options.workspaceGit, phase, project.contract, changedFiles);

    const executionMode = options.executionMode ?? "serial";
    const owner = leaseOwner();
    const run = this.store.beginCheckpointRun({
      phaseId: options.phaseId,
      executionMode,
      summary: options.summary,
      workspaceBaselineSha: await options.workspaceGit.headSha(),
      targetBaselineSha: await options.indexGit.headSha(),
      leaseOwner: owner,
      leaseDurationMs: LEASE_DURATION_MS
    });

    try {
      return await this.withLeaseHeartbeat(run.id, owner, async () => {
        await this.fault("after_run_started", run.id);
        const evidence = await this.verifyRun(run, options, phase, project, baseline);
        await this.fault("after_verification", run.id);

        this.persistCommandFailures(
          options.phaseId,
          phase.attempts + 1,
          [...evidence.selectiveCommands, ...evidence.commands]
        );
        recordCommandOutputUsage(
          this.store,
          options.phaseId,
          [...evidence.selectiveCommands, ...evidence.commands],
          `checkpoint:${run.id}:command-output`
        );

        const correction = this.store.activeCorrection(options.phaseId);
        this.store.recordCheckpointEvidence(
          run.id,
          owner,
          evidence,
          evidence.impactedCompletedPhases,
          correction?.id ?? null,
          LEASE_DURATION_MS
        );
        await this.fault("after_evidence_persisted", run.id);

        const currentDiffHash = await options.workspaceGit.diffHash();
        if (currentDiffHash !== evidence.diffHash) {
          this.store.resetCheckpointRun(
            run.id,
            owner,
            `WORKTREE_CHANGED_AFTER_VERIFICATION: expected ${evidence.diffHash}, found ${currentDiffHash}`
          );
          throw new Error("WORKTREE_CHANGED_AFTER_VERIFICATION: checkpoint evidence no longer matches the workspace");
        }

        if (evidence.passed) {
          const gitSha = await this.commitRun(run.id, executionMode, options.workspaceGit, options.indexGit, evidence, options.summary);
          this.store.recordCheckpointCommit(run.id, owner, gitSha, LEASE_DURATION_MS);
          await this.fault("after_git_committed", run.id);
        }

        const committed = this.store.commitCheckpointState(run.id, owner, LEASE_DURATION_MS);
        await this.fault("after_state_committed", run.id);
        const correctionResult = this.store.recordCheckpointCorrectionOutcome(
          run.id,
          owner,
          this.store.totalRecordedTokens(),
          evidence.passed,
          LEASE_DURATION_MS
        );
        await this.fault("after_correction", run.id);

        let reverificationRequired: string[] = [];
        if (evidence.passed) {
          reverificationRequired = await this.postProcessSuccessfulRun(
            run.id,
            owner,
            options.indexGit,
            options.reverificationReason(evidence.changedFiles)
          );
        } else {
          if (executionMode === "parallel") this.markParallelFailure(run.phaseId);
          this.store.completeCheckpointRun(run.id, owner);
        }

        const updatedRun = required(this.store.getCheckpointRun(run.id), `checkpoint run missing: ${run.id}`);
        const updatedEvidence = required(updatedRun.evidence, `checkpoint evidence missing: ${run.id}`);
        const updatedPhase = required(this.store.getPhase(run.phaseId), `unknown phase: ${run.phaseId}`);
        return {
          phase: committed.phase.status === updatedPhase.status ? updatedPhase : committed.phase,
          evidence: updatedEvidence,
          correction: correctionResult,
          reverificationRequired,
          project: this.store.getProject(),
          nextAction: updatedEvidence.passed
            ? (this.store.currentPhase() ? "start_phase" : "complete_project")
            : "repair_phase"
        };
      });
    } catch (error) {
      await this.handleRunError(run.id, owner, error);
      throw error;
    }
  }

  private async verifyRun(
    run: CheckpointRunRecord,
    options: CheckpointRunOptions,
    phase: PhaseRecord,
    project: ProjectRecord & { contract: NonNullable<ProjectRecord["contract"]> },
    baseline: Record<string, string> | undefined
  ): Promise<VerificationEvidence> {
    const correction = this.store.activeCorrection(options.phaseId);
    const correctionAllowedFiles = correction ? this.store.correctionAllowedFiles(correction.id) : undefined;
    const changedFiles = baseline
      ? await options.workspaceGit.changedFilesSince(baseline)
      : await options.workspaceGit.changedFiles();
    const impactedCompletedPhases = this.store.completedPhasesTouching(changedFiles, options.phaseId);
    const impactedTests = this.store.impactedTests(changedFiles);
    const selectiveCommands = project.contract.selectiveTests && impactedTests.length > 0
      ? [project.contract.selectiveTests.commandTemplate.replace("{tests}", impactedTests.map(shellQuote).join(" "))]
      : [];
    const previousFailures = [...new Set([...selectiveCommands, ...phase.acceptanceCommands])]
      .map((command) => this.store.latestCommandFailure(options.phaseId, command))
      .filter((record): record is CommandFailureRecord => record !== null);

    this.store.renewCheckpointLease(run.id, required(run.leaseOwner, "checkpoint lease owner missing"), LEASE_DURATION_MS);
    return new PhaseVerifier().verify(options.workspaceGit, phase, {
      ...(baseline ? { baseline } : {}),
      selectiveCommands,
      budget: this.store.budgetEvidence(options.phaseId),
      contract: project.contract,
      impactedCompletedPhases,
      previousFailures,
      ...(correctionAllowedFiles ? { correctionAllowedFiles } : {})
    });
  }

  private async resumeCommittedRun(runId: string, owner: string, git: GitRepository): Promise<void> {
    let run = required(this.store.getCheckpointRun(runId), `unknown checkpoint run: ${runId}`);
    const evidence = required(run.evidence, `checkpoint evidence missing: ${runId}`);

    if (evidence.passed && !run.actualGitSha) {
      const gitSha = await this.recoverGitCommit(run, git);
      run = this.store.recordCheckpointCommit(run.id, owner, gitSha, LEASE_DURATION_MS);
    }
    if (evidence.passed) {
      const committedSha = required(run.actualGitSha, `checkpoint Git SHA missing: ${run.id}`);
      if (!await git.isAncestor(committedSha, "HEAD")) {
        throw new CheckpointRecoveryBlockedError(
          `CHECKPOINT_GIT_DIVERGED: ${committedSha} is not reachable from current HEAD`
        );
      }
    }

    if (!["STATE_COMMITTED", "POST_PROCESSING", "DONE"].includes(run.status)) {
      this.store.commitCheckpointState(run.id, owner, LEASE_DURATION_MS);
    }
    run = required(this.store.getCheckpointRun(run.id), `checkpoint run missing: ${run.id}`);
    if (!run.correctionCompletedAt && run.correctionId) {
      this.store.recordCheckpointCorrectionOutcome(
        run.id,
        owner,
        this.store.totalRecordedTokens(),
        evidence.passed,
        LEASE_DURATION_MS
      );
    }

    if (evidence.passed) {
      await this.postProcessSuccessfulRun(
        run.id,
        owner,
        git,
        `Recovered files affected by ${run.phaseId}: ${run.changedFiles.join(", ")}`
      );
    } else {
      if (run.executionMode === "parallel") this.markParallelFailure(run.phaseId);
      this.store.completeCheckpointRun(run.id, owner);
    }
  }

  private async recoverGitCommit(run: CheckpointRunRecord, git: GitRepository): Promise<string> {
    if (run.executionMode === "serial") {
      const existing = await git.checkpointCommit(run.id, "HEAD");
      if (existing) return existing;
      const detached = await git.checkpointCommit(run.id, "--all");
      if (detached) {
        if (await git.isAncestor(detached, "HEAD")) return detached;
        throw new CheckpointRecoveryBlockedError(`CHECKPOINT_COMMIT_DIVERGED: ${detached} is outside HEAD`);
      }
      if (await git.headSha() !== run.targetBaselineSha) {
        throw new CheckpointRecoveryBlockedError(
          `CHECKPOINT_BASELINE_DIVERGED: expected HEAD ${run.targetBaselineSha}, found ${await git.headSha()}`
        );
      }
      await this.assertDiffBinding(git, run);
      return git.commitFilesForRun(run.changedFiles, generateCommitMessage(run.phaseId, run.summary), run.id);
    }

    const merged = await git.checkpointMerge(run.id, "HEAD");
    if (merged) return merged;
    const record = this.store.getWorktree(run.phaseId);
    if (!record) throw new CheckpointRecoveryBlockedError(`CHECKPOINT_WORKTREE_MISSING: ${run.phaseId}`);
    let phaseCommit = await git.checkpointCommit(run.id, record.branch);
    if (!phaseCommit) {
      let isolated: GitRepository;
      try {
        isolated = await GitRepository.open(record.path);
      } catch {
        throw new CheckpointRecoveryBlockedError(`CHECKPOINT_WORKTREE_UNAVAILABLE: ${record.path}`);
      }
      if (await isolated.headSha() !== run.workspaceBaselineSha) {
        throw new CheckpointRecoveryBlockedError(
          `CHECKPOINT_WORKTREE_BASELINE_DIVERGED: expected ${run.workspaceBaselineSha}, found ${await isolated.headSha()}`
        );
      }
      await this.assertDiffBinding(isolated, run);
      phaseCommit = await isolated.commitFilesForRun(
        run.changedFiles,
        generateCommitMessage(run.phaseId, run.summary),
        run.id
      );
    }
    if (!await git.isAncestor(run.targetBaselineSha, "HEAD")) {
      throw new CheckpointRecoveryBlockedError(
        `CHECKPOINT_TARGET_HISTORY_DIVERGED: ${run.targetBaselineSha} is not an ancestor of HEAD`
      );
    }
    const mergeSha = await git.mergeWorktreeForRun(record.branch, run.id);
    this.store.setWorktree({ ...record, status: "merged" });
    return mergeSha;
  }

  private async commitRun(
    runId: string,
    executionMode: CheckpointExecutionMode,
    workspaceGit: GitRepository,
    indexGit: GitRepository,
    evidence: VerificationEvidence,
    summary: string
  ): Promise<string> {
    if (executionMode === "serial") {
      return workspaceGit.commitFilesForRun(
        evidence.changedFiles,
        generateCommitMessage(required(this.store.getCheckpointRun(runId), "checkpoint run missing").phaseId, summary),
        runId
      );
    }
    const run = required(this.store.getCheckpointRun(runId), `checkpoint run missing: ${runId}`);
    const record = required(this.store.getWorktree(run.phaseId), `active worktree not found for phase ${run.phaseId}`);
    await workspaceGit.commitFilesForRun(
      evidence.changedFiles,
      generateCommitMessage(run.phaseId, summary),
      runId
    );
    const mergeSha = await indexGit.mergeWorktreeForRun(record.branch, runId);
    this.store.setWorktree({ ...record, status: "merged" });
    return mergeSha;
  }

  private async postProcessSuccessfulRun(
    runId: string,
    owner: string,
    git: GitRepository,
    reverificationReason: string
  ): Promise<string[]> {
    let run = required(this.store.getCheckpointRun(runId), `checkpoint run missing: ${runId}`);
    if (!run.indexCompletedAt) {
      await indexRepository(this.store, git);
      this.store.markCheckpointIndexed(run.id, owner, LEASE_DURATION_MS);
      await this.fault("after_indexing", run.id);
    }

    run = required(this.store.getCheckpointRun(run.id), `checkpoint run missing: ${run.id}`);
    let reverificationRequired = run.reverificationRequired;
    if (!run.reverificationCompletedAt) {
      reverificationRequired = this.store.markCheckpointReverification(
        run.id,
        owner,
        reverificationReason,
        LEASE_DURATION_MS
      );
      await this.fault("after_reverification", run.id);
    }

    run = required(this.store.getCheckpointRun(run.id), `checkpoint run missing: ${run.id}`);
    if (!run.memoryCompletedAt) {
      const memory = this.rememberCheckpoint(run, git.root);
      await this.fault("after_memory_write", run.id);
      for (const event of memory.events) this.store.appendEvent(event.type, event.phaseId, event.payload);
      this.store.markCheckpointMemoryCompleted(run.id, owner, LEASE_DURATION_MS);
      await this.fault("after_memory", run.id);
    }

    run = required(this.store.getCheckpointRun(run.id), `checkpoint run missing: ${run.id}`);
    if (!run.cleanupCompletedAt) {
      if (run.executionMode === "parallel") await this.cleanupParallelRun(run, git);
      this.store.markCheckpointCleanupCompleted(run.id, owner, LEASE_DURATION_MS);
      await this.fault("after_cleanup", run.id);
    }

    this.store.completeCheckpointRun(run.id, owner);
    return reverificationRequired;
  }

  private rememberCheckpoint(
    run: CheckpointRunRecord,
    fallbackRoot: string
  ): { events: Array<{ type: string; phaseId: string | null; payload: Record<string, unknown> }> } {
    const project = this.store.getProject();
    const phase = this.store.getPhase(run.phaseId);
    if (!project?.contract?.playbookOptIn || !phase) return { events: [] };
    const events: Array<{ type: string; phaseId: string | null; payload: Record<string, unknown> }> = [];
    const playbook = new PlaybookStore();
    try {
      const phasePattern = playbook.rememberPhaseOnce(
        `checkpoint:${run.id}:phase`,
        project.root ?? fallbackRoot,
        phase,
        [project.contract.goal]
      );
      events.push({
        type: "playbook_pattern_recorded",
        phaseId: phase.id,
        payload: { phaseId: phase.id, patternId: phasePattern.id, runId: run.id }
      });
      if (run.correctionId) {
        const correction = this.store.getCorrection(run.correctionId);
        const assumption = correction ? this.store.getAssumption(correction.assumptionId) : null;
        if (correction?.completedAt && correction.outcome !== null && assumption) {
          const pattern = playbook.rememberCorrectionOnce(
            `checkpoint:${run.id}:correction`,
            project.root,
            assumption,
            correction
          );
          events.push({
            type: "playbook_antipattern_recorded",
            phaseId: correction.phaseId,
            payload: { correctionId: correction.id, patternId: pattern.id, runId: run.id }
          });
        }
      }
    } finally {
      playbook.close();
    }
    return { events };
  }

  private async cleanupParallelRun(run: CheckpointRunRecord, git: GitRepository): Promise<void> {
    const record = this.store.getWorktree(run.phaseId);
    if (!record) throw new CheckpointRecoveryBlockedError(`CHECKPOINT_WORKTREE_RECORD_MISSING: ${run.phaseId}`);
    await git.removeWorktree(record.path, record.branch);
    this.store.setWorktree({ ...record, status: "cleaned" });
  }

  private markParallelFailure(phaseId: string): void {
    const record = this.store.getWorktree(phaseId);
    if (record && record.status !== "cleaned") this.store.setWorktree({ ...record, status: "failed" });
  }

  private async assertDiffBinding(git: GitRepository, run: CheckpointRunRecord): Promise<void> {
    const actual = await git.diffHash();
    if (actual !== run.diffHash) {
      throw new CheckpointRecoveryBlockedError(
        `CHECKPOINT_EVIDENCE_DIVERGED: expected ${run.diffHash ?? "missing"}, found ${actual}`
      );
    }
  }

  private async enforceAssumptionPolicy(
    git: GitRepository,
    phase: PhaseRecord,
    contract: NonNullable<ProjectRecord["contract"]>,
    changedFiles: string[]
  ): Promise<void> {
    const phaseAssumptions = this.store.listAssumptions(phase.id);
    const ambiguity = assessAmbiguity(phase.goal, contract.doneWhen);
    if (ambiguity.high && phaseAssumptions.length === 0) {
      throw new Error(
        `HIGH_AMBIGUITY_WITHOUT_ASSUMPTION: record_assumption before checkpoint: ${ambiguity.reasons.join("; ")}`
      );
    }

    const threshold = contract.assumptionConfidenceThreshold ?? 0.6;
    const unresolved = phaseAssumptions.filter(
      (assumption) => assumption.status === "open" && assumption.confidence < threshold
    );
    if (unresolved.length === 0) return;

    const critic = await new CriticRunner().review(
      { root: git.root, phase, contract, changedFiles, diff: await git.diff() },
      true
    );
    this.store.appendEvent("assumption_critic_escalated", phase.id, {
      assumptionIds: unresolved.map((item) => item.id),
      critic
    });
    const detail = unresolved.map((assumption) => `${assumption.id}: ${assumption.statement}`).join("; ");
    throw new Error(
      `LOW_CONFIDENCE_ASSUMPTIONS: confirm or invalidate before checkpoint: ${detail}; critic=${critic.summary}`
    );
  }

  private persistCommandFailures(
    phaseId: string,
    attempt: number,
    commands: Array<{ command: string; passed: boolean; stdout: string; stderr: string }>
  ): void {
    for (const command of commands) {
      if (command.passed) continue;
      const fingerprint = createHash("sha256")
        .update(`${command.command}\0${command.stdout}\0${command.stderr}`)
        .digest("hex")
        .slice(0, 24);
      this.store.recordCommandFailure({
        phaseId,
        command: command.command,
        attempt,
        stdout: command.stdout,
        stderr: command.stderr,
        fingerprint,
        createdAt: new Date().toISOString()
      });
    }
  }

  private async handleRunError(runId: string, owner: string, error: unknown): Promise<void> {
    const current = this.store.getCheckpointRun(runId);
    if (!current || current.status === "DONE" || current.status === "FAILED_TERMINAL") return;
    if (current.leaseOwner !== owner) return;
    if (error instanceof CheckpointCrashError) {
      this.store.expireCheckpointLease(runId, owner);
      return;
    }
    if (!current.evidence) {
      this.store.resetCheckpointRun(runId, owner, errorMessage(error));
      return;
    }
    this.store.markCheckpointRetryable(runId, owner, errorMessage(error));
  }

  private async withLeaseHeartbeat<T>(runId: string, owner: string, operation: () => Promise<T>): Promise<T> {
    const heartbeat = setInterval(() => {
      try { this.store.renewCheckpointLease(runId, owner, LEASE_DURATION_MS); }
      catch { clearInterval(heartbeat); }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    try { return await operation(); }
    finally { clearInterval(heartbeat); }
  }

  private async fault(point: CheckpointFaultPoint, runId: string): Promise<void> {
    await this.hooks.faultInjector?.(point, runId);
  }
}

export function recordCommandOutputUsage(
  store: PlatformStore,
  phaseId: string | null,
  commands: Array<{ stdout: string; stderr: string }>,
  receiptKey?: string
): void {
  const chars = commands.reduce((sum, command) => sum + command.stdout.length + command.stderr.length, 0);
  const tokens = Math.ceil(chars / 4);
  if (tokens <= 0) return;
  const project = store.getProject();
  if (!project) return;
  const delta = { tokens, estimatedTokens: tokens };
  if (receiptKey) {
    store.recordBudgetUsageOnce(
      `${receiptKey}:project`,
      "project",
      project.id,
      delta,
      "plugin_token_command_output_estimated"
    );
    if (phaseId) {
      store.recordBudgetUsageOnce(
        `${receiptKey}:phase:${phaseId}`,
        "phase",
        phaseId,
        delta,
        "plugin_token_command_output_estimated"
      );
    }
    return;
  }
  store.recordBudgetUsage("project", project.id, delta, "plugin_token_command_output_estimated");
  if (phaseId) store.recordBudgetUsage("phase", phaseId, delta, "plugin_token_command_output_estimated");
}

function leaseOwner(): string {
  return `${hostname()}:${process.pid}:${randomUUID()}`;
}

function leaseCanBeTaken(run: CheckpointRunRecord): boolean {
  if (!run.leaseOwner || !run.leaseExpiresAt || Date.parse(run.leaseExpiresAt) <= Date.now()) return true;
  const [ownerHost, ownerPid] = run.leaseOwner.split(":");
  if (ownerHost !== hostname() || !ownerPid) return false;
  const pid = Number(ownerPid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function shellQuote(value: string): string {
  return process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
}
