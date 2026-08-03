import type { PhaseDefinition, PlanAmendment, ProjectContract } from "../domain/model.js";
import { PlatformStore } from "../storage/platform-store.js";
import { PlaybookStore } from "../storage/playbook.js";
import { compileContext } from "./context.js";
import { GitRepository } from "./git.js";
import { indexRepository } from "./indexer.js";
import { ParallelOrchestrator } from "./orchestrator.js";
import { PhaseVerifier } from "./verifier.js";
import { WorkspaceTools } from "./workspace.js";
import { generateCommitMessage, generatePullRequestDescription } from "../integrations/github.js";

export class KeepCodingService {
  static async open(projectRoot: string): Promise<KeepCodingService> {
    const git = await GitRepository.open(projectRoot);
    const store = new PlatformStore(git.root);
    return new KeepCodingService(git, store, new WorkspaceTools(git, store));
  }

  private constructor(
    readonly git: GitRepository,
    readonly store: PlatformStore,
    readonly workspace: WorkspaceTools
  ) {}

  close(): void { this.store.close(); }

  async initialize(prompt: string): Promise<Record<string, unknown>> {
    const project = this.store.initialize(prompt);
    const index = await indexRepository(this.store, this.git);
    return { project, index, nextAction: project.planVersion === 0 ? "save_plan" : "get_context" };
  }

  savePlan(contract: ProjectContract, phases: PhaseDefinition[]): Record<string, unknown> {
    const snapshot = this.store.savePlan(contract, phases);
    return { project: snapshot.project, phases: snapshot.phases, nextAction: "start_phase" };
  }

  amendPlan(amendment: PlanAmendment): Record<string, unknown> {
    return { snapshot: this.store.amendPlan(amendment), nextAction: "get_context" };
  }

  context(maxChars?: number): string { return compileContext(this.store, maxChars); }

  impact(target: string, depth?: number): Record<string, unknown> {
    return { target, nodes: this.store.impact(target, depth), impactedTests: this.store.impactedTests([target]) };
  }

  async startPhase(phaseId: string): Promise<Record<string, unknown>> {
    this.store.setPhaseBaseline(phaseId, await this.git.workingTreeSnapshot());
    const phase = this.store.startPhase(phaseId, await this.git.headSha());
    return { phase, context: this.context(), nextAction: "implement_and_checkpoint" };
  }

  async checkpoint(phaseId: string, summary: string): Promise<Record<string, unknown>> {
    const phase = this.store.getPhase(phaseId);
    if (!phase) throw new Error(`unknown phase: ${phaseId}`);
    const project = this.store.getProject();
    if (!project?.contract) throw new Error("project contract is missing");
    this.store.markVerifying(phaseId);
    const verifying = this.store.getPhase(phaseId);
    if (!verifying) throw new Error(`unknown phase: ${phaseId}`);
    const baseline = this.store.getPhaseBaseline(phaseId) ?? undefined;
    const changedFiles = baseline ? await this.git.changedFilesSince(baseline) : await this.git.changedFiles();
    const impactedCompletedPhases = this.store.completedPhasesTouching(changedFiles, phaseId);
    const impactedTests = this.store.impactedTests(changedFiles);
    const selectiveCommands = project.contract.selectiveTests && impactedTests.length > 0
      ? [project.contract.selectiveTests.commandTemplate.replace("{tests}", impactedTests.map(shellQuote).join(" "))]
      : [];
    const evidence = await new PhaseVerifier().verify(this.git, verifying, {
      ...(baseline ? { baseline } : {}),
      selectiveCommands,
      budget: this.store.budgetEvidence(phaseId),
      contract: project.contract,
      impactedCompletedPhases
    });
    if (evidence.passed) {
      evidence.gitSha = await this.git.commitFiles(evidence.changedFiles, generateCommitMessage(phaseId, summary));
    }
    const updated = this.store.finishVerification(phaseId, summary, evidence);
    let reverificationRequired: string[] = [];
    if (evidence.passed) {
      await indexRepository(this.store, this.git);
      reverificationRequired = this.store.markReverification(
        impactedCompletedPhases,
        `Files affected by ${phaseId}: ${changedFiles.join(", ")}`,
        phaseId
      );
      this.rememberSuccessfulPhase(updated);
    }
    return {
      phase: updated,
      evidence,
      reverificationRequired,
      project: this.store.getProject(),
      nextAction: evidence.passed ? (this.store.currentPhase() ? "start_phase" : "complete_project") : "repair_phase"
    };
  }

  async restorePhaseBaseline(phaseId: string): Promise<Record<string, unknown>> {
    const baseline = this.store.getPhaseBaseline(phaseId);
    if (!baseline) throw new Error(`phase baseline not found: ${phaseId}`);
    const changed = await this.git.changedFilesSince(baseline);
    await this.git.restoreFiles(this.store.getPhase(phaseId)?.baseSha ?? "HEAD", changed);
    this.store.appendEvent("phase_baseline_restored", phaseId, { files: changed });
    return { restored: changed };
  }

  async complete(): Promise<Record<string, unknown>> {
    const project = this.store.getProject();
    if (!project?.contract) throw new Error("project contract is missing");
    const fullSuite = project.contract.selectiveTests?.fullSuiteCommands ?? [];
    const commands = await new PhaseVerifier().runCommands(fullSuite, this.git.root);
    if (commands.length !== fullSuite.length || commands.some((command) => !command.passed)) {
      this.store.appendEvent("project_completion_gate_failed", null, { commands });
      throw new Error("full-suite project completion gate failed");
    }
    const completed = this.store.completeProject();
    return {
      project: completed,
      commands,
      pullRequestDescription: generatePullRequestDescription(this.store.snapshot())
    };
  }

  parallel(): ParallelOrchestrator { return new ParallelOrchestrator(this.git, this.store); }

  suggestPhases(query: string): Record<string, unknown> {
    const contract = this.store.getProject()?.contract;
    if (!contract?.playbookOptIn) return { enabled: false, suggestions: [] };
    const playbook = new PlaybookStore();
    try { return { enabled: true, suggestions: playbook.suggest(query) }; }
    finally { playbook.close(); }
  }

  rememberPhaseTemplate(phaseId: string): Record<string, unknown> {
    const project = this.store.getProject();
    const phase = this.store.getPhase(phaseId);
    if (!project?.contract?.playbookOptIn) throw new Error("playbook memory is not enabled by the project contract");
    if (!phase) throw new Error(`unknown phase: ${phaseId}`);
    const playbook = new PlaybookStore();
    try { return { template: playbook.rememberPhase(project.root, phase, [project.contract.goal]) }; }
    finally { playbook.close(); }
  }

  private rememberSuccessfulPhase(phase: PhaseDefinition): void {
    if (!this.store.getProject()?.contract?.playbookOptIn) return;
    const playbook = new PlaybookStore();
    try {
      const project = this.store.getProject();
      playbook.rememberPhase(project?.root ?? this.git.root, phase, [project?.contract?.goal ?? phase.goal]);
    } finally {
      playbook.close();
    }
  }
}

function shellQuote(value: string): string {
  return process.platform === "win32" ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`;
}
