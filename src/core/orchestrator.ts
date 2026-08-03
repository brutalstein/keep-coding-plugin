import type { PhaseRecord, VerificationEvidence } from "../domain/model.js";
import type { PlatformStore } from "../storage/platform-store.js";
import { generateCommitMessage } from "../integrations/github.js";
import { GitRepository } from "./git.js";
import { PhaseVerifier } from "./verifier.js";

export class ParallelOrchestrator {
  constructor(private readonly git: GitRepository, private readonly store: PlatformStore) {}

  eligiblePhases(limit = 4): PhaseRecord[] {
    const candidates = this.store.readyPhases().filter((phase) => phase.parallelSafe);
    const selected: PhaseRecord[] = [];
    for (const phase of candidates) {
      if (selected.every((other) => scopesIndependent(phase.allowedScope, other.allowedScope))) selected.push(phase);
      if (selected.length >= limit) break;
    }
    return selected;
  }

  async prepare(phaseIds?: string[]): Promise<Record<string, unknown>> {
    const requested = phaseIds?.map((id) => {
      const phase = this.store.getPhase(id);
      if (!phase) throw new Error(`unknown phase: ${id}`);
      return phase;
    }) ?? this.eligiblePhases();
    if (requested.length < 2) throw new Error("parallel execution requires at least two independent READY phases");
    if (requested.some((phase) => phase.status !== "READY" || !phase.parallelSafe)) throw new Error("every parallel phase must be READY and parallelSafe");
    for (let left = 0; left < requested.length; left += 1) {
      for (let right = left + 1; right < requested.length; right += 1) {
        if (!scopesIndependent(requested[left]!.allowedScope, requested[right]!.allowedScope)) {
          throw new Error(`parallel phase scopes overlap: ${requested[left]!.id}, ${requested[right]!.id}`);
        }
      }
    }
    const baseSha = await this.git.headSha();
    const worktrees = [];
    for (const phase of requested) {
      const created = await this.git.createWorktree(phase.id, baseSha);
      const isolated = await GitRepository.open(created.path);
      this.store.setPhaseBaseline(phase.id, await isolated.workingTreeSnapshot());
      this.store.startPhase(phase.id, baseSha, true);
      const record = {
        phaseId: phase.id, path: created.path, branch: created.branch, status: "active" as const,
        baseSha, createdAt: new Date().toISOString()
      };
      this.store.setWorktree(record);
      worktrees.push(record);
    }
    return { baseSha, worktrees };
  }

  async checkpoint(phaseId: string, summary: string): Promise<{ evidence: VerificationEvidence; mergeSha: string }> {
    const record = this.store.getWorktree(phaseId);
    if (!record || record.status !== "active") throw new Error(`active worktree not found for phase ${phaseId}`);
    const phase = this.store.getPhase(phaseId);
    if (!phase) throw new Error(`unknown phase: ${phaseId}`);
    const isolated = await GitRepository.open(record.path);
    this.store.markVerifying(phaseId);
    const baseline = this.store.getPhaseBaseline(phaseId);
    const evidence = await new PhaseVerifier().verify(isolated, { ...phase, status: "VERIFYING" }, {
      ...(baseline ? { baseline } : {}),
      budget: this.store.budgetEvidence(phaseId),
      contract: this.store.getProject()?.contract ?? {
        goal: phase.goal, nonGoals: [], constraints: [], deliverables: [phase.goal], invariants: [], doneWhen: phase.acceptanceCommands
      }
    });
    if (!evidence.passed) {
      this.store.finishVerification(phaseId, summary, evidence);
      this.store.setWorktree({ ...record, status: "failed" });
      throw new Error(`parallel phase ${phaseId} failed verification`);
    }
    const commitSha = await isolated.commitFiles(evidence.changedFiles, generateCommitMessage(phaseId, summary));
    const mergeSha = await this.git.mergeWorktree(record.branch);
    evidence.gitSha = mergeSha;
    this.store.finishVerification(phaseId, summary, evidence);
    this.store.setWorktree({ ...record, status: "merged" });
    await this.git.removeWorktree(record.path, record.branch);
    return { evidence, mergeSha: commitSha === mergeSha ? commitSha : mergeSha };
  }
}

function scopesIndependent(left: string[], right: string[]): boolean {
  const roots = (scope: string): string => scope.replace(/^!/, "").split(/[/*?{[]/, 1)[0] ?? "";
  return left.every((a) => right.every((b) => {
    const x = roots(a);
    const y = roots(b);
    return x !== "" && y !== "" && !x.startsWith(y) && !y.startsWith(x);
  }));
}
