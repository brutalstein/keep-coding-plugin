import type { PhaseRecord } from "../domain/model.js";
import type { ProjectStore } from "../storage/store.js";
import type { GitRepository, WorktreeRecord } from "./git.js";

export interface ParallelPhaseWorkspace extends WorktreeRecord {
  phase: PhaseRecord;
}

export class ParallelPhaseOrchestrator {
  constructor(
    private readonly git: GitRepository,
    private readonly store: ProjectStore
  ) {}

  async prepare(limit = 2): Promise<ParallelPhaseWorkspace[]> {
    if (!Number.isInteger(limit) || limit < 2 || limit > 8) throw new Error("parallel phase limit must be 2..8");
    const candidates = this.store.listPhases().filter((phase) => phase.status === "READY");
    const selected: PhaseRecord[] = [];
    for (const candidate of candidates) {
      if (selected.every((phase) => independentScopes(phase, candidate))) selected.push(candidate);
      if (selected.length >= limit) break;
    }
    if (selected.length < 2) throw new Error("at least two dependency-ready phases with independent scopes are required");

    const workspaces: ParallelPhaseWorkspace[] = [];
    try {
      for (const phase of selected) {
        const record = await this.git.createPhaseWorktree(phase.id);
        const workspace = { ...record, phase };
        this.store.setMetadata(`parallel_worktree:${phase.id}`, JSON.stringify(record));
        this.store.appendEvent("parallel_worktree_prepared", phase.id, {
          branch: record.branch,
          path: record.path,
          baseSha: record.baseSha
        });
        workspaces.push(workspace);
      }
      return workspaces;
    } catch (error) {
      for (const workspace of workspaces) await this.git.removePhaseWorktree(workspace);
      throw error;
    }
  }

  prepared(phaseId: string): WorktreeRecord {
    const encoded = this.store.getMetadata(`parallel_worktree:${phaseId}`);
    if (!encoded) throw new Error(`no prepared worktree for phase ${phaseId}`);
    return parseWorktree(encoded);
  }

  async merge(phaseId: string): Promise<{ phaseId: string; gitSha: string }> {
    const record = this.prepared(phaseId);
    const gitSha = await this.git.mergePhaseWorktree(record);
    this.store.setMetadata(`parallel_worktree:${phaseId}`, "");
    this.store.appendEvent("parallel_worktree_merged", phaseId, { branch: record.branch, gitSha });
    return { phaseId, gitSha };
  }

  async discard(phaseId: string): Promise<{ phaseId: string; discarded: true }> {
    const record = this.prepared(phaseId);
    await this.git.removePhaseWorktree(record);
    this.store.setMetadata(`parallel_worktree:${phaseId}`, "");
    this.store.appendEvent("parallel_worktree_discarded", phaseId, { branch: record.branch });
    return { phaseId, discarded: true };
  }
}

function independentScopes(left: PhaseRecord, right: PhaseRecord): boolean {
  for (const leftPattern of left.allowedScope) {
    for (const rightPattern of right.allowedScope) {
      if (patternsMayOverlap(leftPattern, rightPattern)) return false;
    }
  }
  return true;
}

function patternsMayOverlap(left: string, right: string): boolean {
  const leftPrefix = staticPrefix(left);
  const rightPrefix = staticPrefix(right);
  if (!leftPrefix || !rightPrefix) return true;
  return leftPrefix === rightPrefix ||
    leftPrefix.startsWith(`${rightPrefix}/`) ||
    rightPrefix.startsWith(`${leftPrefix}/`);
}

function staticPrefix(pattern: string): string {
  const normalized = pattern.replaceAll("\\", "/");
  const special = normalized.search(/[*?{[(]/);
  return (special === -1 ? normalized : normalized.slice(0, special)).replace(/\/$/, "");
}

function parseWorktree(value: string): WorktreeRecord {
  const parsed = JSON.parse(value) as Partial<WorktreeRecord>;
  if (!parsed.phaseId || !parsed.branch || !parsed.path || !parsed.baseSha) throw new Error("stored worktree metadata is invalid");
  return {
    phaseId: parsed.phaseId,
    branch: parsed.branch,
    path: parsed.path,
    baseSha: parsed.baseSha
  };
}
