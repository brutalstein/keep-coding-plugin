import { createHash } from "node:crypto";
import type {
  CommandFailureRecord, ContextEnvelope, FailureRecord, FileDigest, PhaseDefinition,
  PlanAmendment, PlaybookPattern, ProjectContract
} from "../domain/model.js";
import { PlatformStore } from "../storage/platform-store.js";
import { PlaybookStore } from "../storage/playbook.js";
import { lintAcceptanceCommands } from "./command-quality.js";
import { compileContextEnvelope, tokenize } from "./context.js";
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
    const warnings = lintAcceptanceCommands(phases, contract);
    const snapshot = this.store.savePlan(contract, phases);
    return { project: snapshot.project, phases: snapshot.phases, commandQualityWarnings: warnings, nextAction: "start_phase" };
  }

  amendPlan(amendment: PlanAmendment): Record<string, unknown> {
    const contract = this.store.getProject()?.contract ?? null;
    const warnings = lintAcceptanceCommands(amendment.addPhases, contract);
    return { snapshot: this.store.amendPlan(amendment), commandQualityWarnings: warnings, nextAction: "get_context" };
  }

  context(maxChars?: number): string {
    const playbook = this.relevantPlaybook();
    const context = compileContextEnvelope(this.store, { ...(maxChars !== undefined ? { maxChars } : {}), playbook });
    this.recordPluginContextUsage(context);
    return context.context ?? "";
  }

  contextEnvelope(sinceSequence?: number, maxChars?: number): ContextEnvelope {
    const envelope = compileContextEnvelope(this.store, {
      ...(sinceSequence !== undefined ? { sinceSequence } : {}),
      ...(maxChars !== undefined ? { maxChars } : {}),
      playbook: this.relevantPlaybook()
    });
    this.recordPluginContextUsage(envelope);
    return { ...envelope, sequence: this.store.latestEventSequence() };
  }

  impact(target: string, depth?: number): Record<string, unknown> {
    return { target, nodes: this.store.impact(target, depth), impactedTests: this.store.impactedTests([target]) };
  }

  expandGraph(terms: string[], nodeIds: string[], limit = 50): Record<string, unknown> {
    const bounded = Math.max(1, Math.min(limit, 200));
    const exact = nodeIds.map((id) => this.store.graphNode(id)).filter((node) => node !== null);
    const searched = terms.length > 0 ? this.store.searchGraph(terms, bounded) : [];
    const nodes = [...new Map([...exact, ...searched].map((node) => [node.id, node])).values()].slice(0, bounded);
    return { nodes, count: nodes.length, tier: 1, requested: { terms, nodeIds } };
  }

  fileDigest(filePath: string): FileDigest {
    const digest = this.store.fileDigest(filePath);
    if (!digest) throw new Error(`indexed file not found: ${filePath}`);
    return digest;
  }

  async startPhase(phaseId: string): Promise<Record<string, unknown>> {
    this.store.setPhaseBaseline(phaseId, await this.git.workingTreeSnapshot());
    const phase = this.store.startPhase(phaseId, await this.git.headSha());
    return { phase, context: this.context(), nextAction: "implement_and_checkpoint" };
  }

  recordFailure(phaseId: string, summary: string, fingerprint?: string): FailureRecord {
    const failure = this.store.recordFailure(phaseId, summary, fingerprint);
    const project = this.store.getProject();
    if (!project?.contract?.playbookOptIn) return failure;
    const playbook = new PlaybookStore();
    try { playbook.rememberFailure(project.root, failure); }
    finally { playbook.close(); }
    this.store.appendEvent("playbook_failure_compounded", phaseId, { fingerprint: failure.fingerprint });
    return failure;
  }

  recordHostTokenUsage(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const project = this.store.getProject();
    if (!project) return;
    this.store.recordBudgetUsage("project", project.id, { tokens: Math.ceil(tokens) }, "budget_host_tokens_recorded");
    if (project.currentPhaseId) this.store.recordBudgetUsage("phase", project.currentPhaseId, { tokens: Math.ceil(tokens) }, "budget_host_tokens_recorded");
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
    const previousFailures = [...new Set([...selectiveCommands, ...verifying.acceptanceCommands])]
      .map((command) => this.store.latestCommandFailure(phaseId, command))
      .filter((record): record is CommandFailureRecord => record !== null);
    const evidence = await new PhaseVerifier().verify(this.git, verifying, {
      ...(baseline ? { baseline } : {}),
      selectiveCommands,
      budget: this.store.budgetEvidence(phaseId),
      contract: project.contract,
      impactedCompletedPhases,
      previousFailures
    });
    this.persistCommandFailures(phaseId, phase.attempts + 1, [...evidence.selectiveCommands, ...evidence.commands]);
    this.recordCommandOutputUsage(phaseId, [...evidence.selectiveCommands, ...evidence.commands]);
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
    this.recordCommandOutputUsage(project.currentPhaseId, commands);
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
    try {
      const pattern = playbook.rememberPhase(project.root, phase, [project.contract.goal]);
      this.store.appendEvent("playbook_pattern_recorded", phaseId, { pattern: pattern.pattern });
      return { pattern };
    } finally { playbook.close(); }
  }

  private relevantPlaybook(): PlaybookPattern[] {
    const project = this.store.getProject();
    if (!project?.contract?.playbookOptIn) return [];
    const phase = this.store.currentPhase();
    const query = [project.contract.goal, phase?.title, phase?.goal, ...(phase?.allowedScope ?? [])].filter(Boolean).join(" ");
    const playbook = new PlaybookStore();
    try { return playbook.suggest(tokenize(query).join(" "), 3); }
    finally { playbook.close(); }
  }

  private recordPluginContextUsage(envelope: ContextEnvelope): void {
    if (envelope.unchanged || !envelope.context || envelope.estimatedTokens <= 0) return;
    const project = this.store.getProject();
    if (!project) return;
    const delta = { tokens: envelope.estimatedTokens, estimatedTokens: envelope.estimatedTokens };
    this.store.recordBudgetUsage("project", project.id, delta, "plugin_token_context_estimated");
    if (project.currentPhaseId) this.store.recordBudgetUsage("phase", project.currentPhaseId, delta, "plugin_token_context_estimated");
  }

  private recordCommandOutputUsage(phaseId: string | null, commands: Array<{ stdout: string; stderr: string }>): void {
    const chars = commands.reduce((sum, command) => sum + command.stdout.length + command.stderr.length, 0);
    const tokens = Math.ceil(chars / 4);
    if (tokens <= 0) return;
    const project = this.store.getProject();
    if (!project) return;
    const delta = { tokens, estimatedTokens: tokens };
    this.store.recordBudgetUsage("project", project.id, delta, "plugin_token_command_output_estimated");
    if (phaseId) this.store.recordBudgetUsage("phase", phaseId, delta, "plugin_token_command_output_estimated");
  }

  private persistCommandFailures(phaseId: string, attempt: number, commands: Array<{ command: string; passed: boolean; stdout: string; stderr: string }>): void {
    for (const command of commands) {
      if (command.passed) continue;
      const fingerprint = createHash("sha256").update(`${command.command}\0${command.stdout}\0${command.stderr}`).digest("hex").slice(0, 24);
      this.store.recordCommandFailure({ phaseId, command: command.command, attempt, stdout: command.stdout, stderr: command.stderr, fingerprint, createdAt: new Date().toISOString() });
    }
  }

  private rememberSuccessfulPhase(phase: PhaseDefinition): void {
    if (!this.store.getProject()?.contract?.playbookOptIn) return;
    const playbook = new PlaybookStore();
    try {
      const project = this.store.getProject();
      playbook.rememberPhase(project?.root ?? this.git.root, phase, [project?.contract?.goal ?? phase.goal]);
      this.store.appendEvent("playbook_pattern_recorded", phase.id, { phaseId: phase.id });
    } finally {
      playbook.close();
    }
  }
}

function shellQuote(value: string): string {
  return process.platform === "win32" ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`;
}
