import type { PhaseRecord, VerificationEvidence } from "../domain/model.js";
import type { PlatformStore } from "../storage/platform-store.js";
import { CheckpointPipeline } from "./checkpoint.js";
import { GitRepository } from "./git.js";

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

  async checkpoint(phaseId: string, summary: string): Promise<{
    evidence: VerificationEvidence;
    mergeSha: string;
    reverificationRequired: string[];
  }> {
    const record = this.store.getWorktree(phaseId);
    if (!record || record.status !== "active") throw new Error(`active worktree not found for phase ${phaseId}`);
    const isolated = await GitRepository.open(record.path);
    const result = await new CheckpointPipeline(this.store).run({
      phaseId,
      summary,
      executionMode: "parallel",
      workspaceGit: isolated,
      indexGit: this.git,
      reverificationReason: (changedFiles) =>
        `Files affected by parallel phase ${phaseId}: ${changedFiles.join(", ")}`
    });

    if (!result.evidence.passed) throw new Error(`parallel phase ${phaseId} failed verification`);
    return {
      evidence: result.evidence,
      mergeSha: result.evidence.gitSha,
      reverificationRequired: result.reverificationRequired
    };
  }
}

function scopesIndependent(left: string[], right: string[]): boolean {
  return left.every((a) => right.every((b) => {
    const x = scopePrefix(a);
    const y = scopePrefix(b);
    if (x === "" || y === "") return false;
    return x !== y && !x.startsWith(`${y}/`) && !y.startsWith(`${x}/`);
  }));
}

function scopePrefix(scope: string): string {
  const withoutNegation = scope.replace(/^!/, "").replaceAll("\\", "/");
  const wildcard = withoutNegation.search(/[*?{[]/);
  const prefix = wildcard >= 0 ? withoutNegation.slice(0, wildcard) : withoutNegation;
  return prefix.replace(/\/+$/, "");
}
