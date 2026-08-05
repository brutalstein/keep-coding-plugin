import { createHash } from "node:crypto";
import type {
  CommandFailureRecord, CorrectionRecord, PhaseDefinition, PhaseRecord, ProjectRecord, VerificationEvidence
} from "../domain/model.js";
import { PlaybookStore } from "../storage/playbook.js";
import type { PlatformStore } from "../storage/platform-store.js";
import { CriticRunner } from "./critic.js";
import { assessAmbiguity } from "./detector.js";
import type { GitRepository } from "./git.js";
import { indexRepository } from "./indexer.js";
import { PhaseVerifier } from "./verifier.js";

export interface CheckpointRunOptions {
  phaseId: string;
  summary: string;
  workspaceGit: GitRepository;
  indexGit: GitRepository;
  commitEvidence: (evidence: VerificationEvidence) => Promise<string>;
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

/**
 * Executes every checkpoint through one policy path, regardless of whether
 * the implementation lives in the primary worktree or an isolated worktree.
 */
export class CheckpointPipeline {
  constructor(private readonly store: PlatformStore) {}

  async run(options: CheckpointRunOptions): Promise<CheckpointRunResult> {
    const phase = this.store.getPhase(options.phaseId);
    if (!phase) throw new Error(`unknown phase: ${options.phaseId}`);
    const project = this.store.getProject();
    if (!project?.contract) throw new Error("project contract is missing");

    const baseline = this.store.getPhaseBaseline(options.phaseId) ?? undefined;
    const changedFiles = baseline
      ? await options.workspaceGit.changedFilesSince(baseline)
      : await options.workspaceGit.changedFiles();

    this.store.autoLinkChangedFiles(options.phaseId, changedFiles);
    await this.enforceAssumptionPolicy(options.workspaceGit, phase, project.contract, changedFiles);

    const correction = this.store.activeCorrection(options.phaseId);
    const correctionAllowedFiles = correction ? this.store.correctionAllowedFiles(correction.id) : undefined;
    this.store.markVerifying(options.phaseId);
    const verifying = this.store.getPhase(options.phaseId);
    if (!verifying) throw new Error(`unknown phase: ${options.phaseId}`);

    const impactedCompletedPhases = this.store.completedPhasesTouching(changedFiles, options.phaseId);
    const impactedTests = this.store.impactedTests(changedFiles);
    const selectiveCommands = project.contract.selectiveTests && impactedTests.length > 0
      ? [project.contract.selectiveTests.commandTemplate.replace("{tests}", impactedTests.map(shellQuote).join(" "))]
      : [];
    const previousFailures = [...new Set([...selectiveCommands, ...verifying.acceptanceCommands])]
      .map((command) => this.store.latestCommandFailure(options.phaseId, command))
      .filter((record): record is CommandFailureRecord => record !== null);

    const evidence = await new PhaseVerifier().verify(options.workspaceGit, verifying, {
      ...(baseline ? { baseline } : {}),
      selectiveCommands,
      budget: this.store.budgetEvidence(options.phaseId),
      contract: project.contract,
      impactedCompletedPhases,
      previousFailures,
      ...(correctionAllowedFiles ? { correctionAllowedFiles } : {})
    });
    this.persistCommandFailures(options.phaseId, phase.attempts + 1, [...evidence.selectiveCommands, ...evidence.commands]);
    recordCommandOutputUsage(this.store, options.phaseId, [...evidence.selectiveCommands, ...evidence.commands]);

    let correctionResult: CorrectionRecord | null = null;
    if (correction) {
      const assessed = this.store.assessCorrectionOutcome(
        correction.id,
        changedFiles,
        this.store.totalRecordedTokens(),
        false
      );
      correctionResult = assessed.correction;
      if (assessed.unauthorizedFiles.length > 0) {
        evidence.passed = false;
        evidence.scopePassed = false;
        evidence.scopeViolations = [...new Set([...evidence.scopeViolations, ...assessed.unauthorizedFiles])];
      }
    }

    if (evidence.passed) {
      evidence.gitSha = await options.commitEvidence(evidence);
      if (correction) {
        correctionResult = this.store.assessCorrectionOutcome(
          correction.id,
          changedFiles,
          this.store.totalRecordedTokens(),
          true
        ).correction;
      }
    }

    const updated = this.store.finishVerification(options.phaseId, options.summary, evidence);
    let reverificationRequired: string[] = [];
    if (evidence.passed) {
      await indexRepository(this.store, options.indexGit);
      reverificationRequired = this.store.markReverification(
        impactedCompletedPhases,
        options.reverificationReason(changedFiles),
        options.phaseId
      );
      this.rememberSuccessfulPhase(updated, options.indexGit.root);
      if (correctionResult?.completedAt) this.rememberCorrection(correctionResult);
    }

    return {
      phase: updated,
      evidence,
      correction: correctionResult,
      reverificationRequired,
      project: this.store.getProject(),
      nextAction: evidence.passed
        ? (this.store.currentPhase() ? "start_phase" : "complete_project")
        : "repair_phase"
    };
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

  private rememberCorrection(correction: CorrectionRecord): void {
    const project = this.store.getProject();
    if (!project?.contract?.playbookOptIn || correction.outcome === null) return;
    const assumption = this.store.getAssumption(correction.assumptionId);
    if (!assumption) return;
    const playbook = new PlaybookStore();
    try {
      const pattern = playbook.rememberCorrection(project.root, assumption, correction);
      this.store.appendEvent("playbook_antipattern_recorded", correction.phaseId, {
        correctionId: correction.id,
        patternId: pattern.id
      });
    } finally {
      playbook.close();
    }
  }

  private rememberSuccessfulPhase(phase: PhaseDefinition, fallbackRoot: string): void {
    if (!this.store.getProject()?.contract?.playbookOptIn) return;
    const playbook = new PlaybookStore();
    try {
      const project = this.store.getProject();
      playbook.rememberPhase(project?.root ?? fallbackRoot, phase, [project?.contract?.goal ?? phase.goal]);
      this.store.appendEvent("playbook_pattern_recorded", phase.id, { phaseId: phase.id });
    } finally {
      playbook.close();
    }
  }
}

export function recordCommandOutputUsage(
  store: PlatformStore,
  phaseId: string | null,
  commands: Array<{ stdout: string; stderr: string }>
): void {
  const chars = commands.reduce((sum, command) => sum + command.stdout.length + command.stderr.length, 0);
  const tokens = Math.ceil(chars / 4);
  if (tokens <= 0) return;
  const project = store.getProject();
  if (!project) return;
  const delta = { tokens, estimatedTokens: tokens };
  store.recordBudgetUsage("project", project.id, delta, "plugin_token_command_output_estimated");
  if (phaseId) store.recordBudgetUsage("phase", phaseId, delta, "plugin_token_command_output_estimated");
}

function shellQuote(value: string): string {
  return process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
}
