import type {
  AssumptionAlternative, AssumptionRecord, ContextEnvelope, CorrectionRecord, FailureRecord, FileDigest, PhaseDefinition,
  PlanAmendment, PlaybookPattern, ProjectContract
} from "../domain/model.js";
import { PlatformStore } from "../storage/platform-store.js";
import { PlaybookStore } from "../storage/playbook.js";
import { CheckpointPipeline, recordCommandOutputUsage } from "./checkpoint.js";
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
    return context.unchanged ? "" : context.context;
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

  recordAssumption(phaseId: string | null, statement: string, confidence: number, alternatives: AssumptionAlternative[]): { assumption_id: string; assumption: AssumptionRecord } {
    const assumptionId = this.store.recordAssumption({ phaseId, statement, confidence, alternatives });
    return { assumption_id: assumptionId, assumption: this.store.getAssumption(assumptionId)! };
  }

  linkAssumption(assumptionId: string, nodeIds: string[]): { linked: number } {
    return { linked: this.store.linkAssumption(assumptionId, nodeIds) };
  }

  confirmAssumption(assumptionId: string, evidence: string): { status: "confirmed"; assumption: AssumptionRecord } {
    return { status: "confirmed", assumption: this.store.confirmAssumption(assumptionId, evidence) };
  }

  invalidateAssumption(assumptionId: string, rootCause: string, maxHops?: number): { correction_id: string; blast_radius: CorrectionRecord["blastRadius"]; blast_radius_size: number; correction: CorrectionRecord } {
    const correction = this.store.invalidateAssumption(assumptionId, rootCause, maxHops, this.store.totalRecordedTokens());
    return { correction_id: correction.id, blast_radius: correction.blastRadius, blast_radius_size: correction.blastRadiusSize, correction };
  }

  expandCorrectionScope(correctionId: string, additionalNodeIds: string[], justification: string): { expanded: number; correction: CorrectionRecord } {
    const correction = this.store.expandCorrectionScope(correctionId, additionalNodeIds, justification);
    return { expanded: additionalNodeIds.length, correction };
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
    return new CheckpointPipeline(this.store).run({
      phaseId,
      summary,
      workspaceGit: this.git,
      indexGit: this.git,
      commitEvidence: (evidence) => this.git.commitFiles(
        evidence.changedFiles,
        generateCommitMessage(phaseId, summary)
      ),
      reverificationReason: (changedFiles) => `Files affected by ${phaseId}: ${changedFiles.join(", ")}`
    });
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
    recordCommandOutputUsage(this.store, project.currentPhaseId, commands);
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
    try {
      const suggestions = playbook.suggest(tokenize(query).join(" "), 3);
      const antiPatternIds = suggestions.filter((pattern) => pattern.kind === "anti_pattern").map((pattern) => pattern.id);
      if (antiPatternIds.length > 0) this.store.recordAntiPatternHits(phase?.id ?? null, antiPatternIds);
      return suggestions;
    } finally { playbook.close(); }
  }

  private recordPluginContextUsage(envelope: ContextEnvelope): void {
    if (envelope.unchanged) return;
    if (envelope.estimatedTokens <= 0) return;
    const project = this.store.getProject();
    if (!project) return;
    const delta = { tokens: envelope.estimatedTokens, estimatedTokens: envelope.estimatedTokens };
    this.store.recordBudgetUsage("project", project.id, delta, "plugin_token_context_estimated");
    if (project.currentPhaseId) this.store.recordBudgetUsage("phase", project.currentPhaseId, delta, "plugin_token_context_estimated");
  }
}
