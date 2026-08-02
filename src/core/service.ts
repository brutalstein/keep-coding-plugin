import type { PhaseDefinition, ProjectContract } from "../domain/model.js";
import { ProjectStore } from "../storage/store.js";
import { compileContext } from "./context.js";
import { GitRepository } from "./git.js";
import { indexRepository } from "./indexer.js";
import { PhaseVerifier } from "./verifier.js";

export class KeepCodingService {
  static async open(projectRoot: string): Promise<KeepCodingService> {
    const git = await GitRepository.open(projectRoot);
    return new KeepCodingService(git, new ProjectStore(git.root));
  }

  private constructor(readonly git: GitRepository, readonly store: ProjectStore) {}

  close(): void {
    this.store.close();
  }

  async initialize(prompt: string): Promise<Record<string, unknown>> {
    const project = this.store.initialize(prompt);
    const index = await indexRepository(this.store, this.git);
    return { project, index, nextAction: project.planVersion === 0 ? "save_plan" : "get_context" };
  }

  savePlan(contract: ProjectContract, phases: PhaseDefinition[]): Record<string, unknown> {
    const snapshot = this.store.savePlan(contract, phases);
    return { project: snapshot.project, phases: snapshot.phases, nextAction: "start_phase" };
  }

  context(maxChars?: number): string {
    return compileContext(this.store, maxChars);
  }

  async startPhase(phaseId: string): Promise<Record<string, unknown>> {
    this.store.setPhaseBaseline(phaseId, await this.git.workingTreeSnapshot());
    const phase = this.store.startPhase(phaseId, await this.git.headSha());
    return { phase, context: this.context(), nextAction: "implement_and_checkpoint" };
  }

  async checkpoint(phaseId: string, summary: string): Promise<Record<string, unknown>> {
    const phase = this.store.getPhase(phaseId);
    if (!phase) throw new Error(`unknown phase: ${phaseId}`);
    this.store.markVerifying(phaseId);
    const verifying = this.store.getPhase(phaseId);
    if (!verifying) throw new Error(`unknown phase: ${phaseId}`);
    const evidence = await new PhaseVerifier().verify(this.git, verifying, this.store.getPhaseBaseline(phaseId) ?? undefined);
    const updated = this.store.finishVerification(phaseId, summary, evidence);
    if (evidence.passed) await indexRepository(this.store, this.git);
    return {
      phase: updated,
      evidence,
      project: this.store.getProject(),
      nextAction: evidence.passed ? (this.store.currentPhase() ? "start_phase" : "complete_project") : "repair_phase"
    };
  }
}
