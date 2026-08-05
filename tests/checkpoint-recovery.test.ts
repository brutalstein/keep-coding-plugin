import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CheckpointCrashError,
  CheckpointPipeline,
  type CheckpointFaultPoint
} from "../src/core/checkpoint.js";
import { KeepCodingService } from "../src/core/service.js";
import { PlaybookStore } from "../src/storage/playbook.js";

const roots: string[] = [];
const previousPlaybookPath = process.env.KEEP_CODING_PLAYBOOK_PATH;

afterEach(() => {
  if (previousPlaybookPath === undefined) delete process.env.KEEP_CODING_PLAYBOOK_PATH;
  else process.env.KEEP_CODING_PLAYBOOK_PATH = previousPlaybookPath;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-recovery-"));
  roots.push(root);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "main.js"), "export const ready = false;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

async function active(root: string, playbookOptIn = false): Promise<KeepCodingService> {
  const service = await KeepCodingService.open(root);
  await service.initialize("Set the ready export to true and verify JavaScript syntax");
  service.savePlan(
    {
      goal: "Set the ready export to true",
      nonGoals: [],
      constraints: [],
      deliverables: ["updated module"],
      invariants: [],
      doneWhen: ["src/main.js exports ready as true and parses as JavaScript"],
      playbookOptIn
    },
    [{
      id: "implementation",
      title: "Enable module",
      goal: "Set the ready export to true",
      dependencies: [],
      allowedScope: ["src/main.js"],
      acceptanceCommands: ["node --check src/main.js"],
      maxAttempts: 3
    }]
  );
  await service.startPhase("implementation");
  writeFileSync(path.join(root, "src", "main.js"), "export const ready = true;\n");
  return service;
}

function crashing(service: KeepCodingService, point: CheckpointFaultPoint): CheckpointPipeline {
  return new CheckpointPipeline(service.store, {
    faultInjector(current, runId) {
      if (current === point) throw new CheckpointCrashError(current, runId);
    }
  });
}

async function run(service: KeepCodingService, pipeline: CheckpointPipeline): Promise<void> {
  await pipeline.run({
    phaseId: "implementation",
    summary: "enabled the module",
    executionMode: "serial",
    workspaceGit: service.git,
    indexGit: service.git,
    reverificationReason: (files) => `Recovery test changed: ${files.join(", ")}`
  });
}

function trailerCount(root: string, trailer: string): number {
  const output = execFileSync("git", ["log", "--format=%B%x00"], { cwd: root, encoding: "utf8" });
  return output.split("\0").filter((message) => message.includes(trailer)).length;
}

describe("crash-safe serial checkpoints", () => {
  it("resets a pre-evidence crash to an implementable phase", async () => {
    const root = repository();
    let service = await active(root);
    await expect(run(service, crashing(service, "after_run_started")))
      .rejects.toBeInstanceOf(CheckpointCrashError);
    service.close();

    service = await KeepCodingService.open(root);
    try {
      expect(service.store.getPhase("implementation")?.status).toBe("IN_PROGRESS");
      expect(service.store.listCheckpointRuns()[0]).toMatchObject({ status: "DONE", evidence: null });
      expect(service.store.listCheckpoints()).toHaveLength(0);
      const result = await service.checkpoint("implementation", "completed after recovery reset");
      expect(result.evidence.passed).toBe(true);
      expect(service.store.getPhase("implementation")?.status).toBe("COMPLETED");
    } finally {
      service.close();
    }
  });

  it("reconciles a Git commit created before durable phase state without duplication", async () => {
    const root = repository();
    let service = await active(root);
    let runId = "";
    const pipeline = new CheckpointPipeline(service.store, {
      faultInjector(point, currentRunId) {
        if (point === "after_git_committed") {
          runId = currentRunId;
          throw new CheckpointCrashError(point, currentRunId);
        }
      }
    });
    await expect(run(service, pipeline)).rejects.toBeInstanceOf(CheckpointCrashError);
    expect(trailerCount(root, `Keep-Coding-Commit: ${runId}`)).toBe(1);
    service.close();

    service = await KeepCodingService.open(root);
    expect(service.store.getPhase("implementation")?.status).toBe("COMPLETED");
    expect(service.store.listCheckpoints()).toHaveLength(1);
    expect(service.store.getCheckpointRun(runId)).toMatchObject({ status: "DONE" });
    expect(trailerCount(root, `Keep-Coding-Commit: ${runId}`)).toBe(1);
    service.close();

    service = await KeepCodingService.open(root);
    try {
      expect(service.store.listCheckpoints()).toHaveLength(1);
      expect(trailerCount(root, `Keep-Coding-Commit: ${runId}`)).toBe(1);
    } finally {
      service.close();
    }
  });

  it("rejects a mutation after verification instead of committing stale evidence", async () => {
    const root = repository();
    const service = await active(root);
    const pipeline = new CheckpointPipeline(service.store, {
      faultInjector(point) {
        if (point === "after_evidence_persisted") {
          writeFileSync(path.join(root, "src", "main.js"), "export const ready = 'mutated-after-verification';\n");
        }
      }
    });
    try {
      await expect(run(service, pipeline)).rejects.toThrow(/WORKTREE_CHANGED_AFTER_VERIFICATION/u);
      expect(service.store.getPhase("implementation")?.status).toBe("IN_PROGRESS");
      expect(service.store.listCheckpoints()).toHaveLength(0);
      expect(trailerCount(root, "Keep-Coding-Commit:")).toBe(0);
      expect(service.store.listCheckpointRuns()[0]).toMatchObject({ status: "DONE" });
    } finally {
      service.close();
    }
  });

  it("applies playbook memory exactly once across the external-database crash window", async () => {
    const root = repository();
    const playbookRoot = mkdtempSync(path.join(tmpdir(), "keep-coding-playbook-recovery-"));
    roots.push(playbookRoot);
    const playbookPath = path.join(playbookRoot, "patterns.db");
    process.env.KEEP_CODING_PLAYBOOK_PATH = playbookPath;
    let service = await active(root, true);
    await expect(run(service, crashing(service, "after_memory_write")))
      .rejects.toBeInstanceOf(CheckpointCrashError);
    service.close();

    service = await KeepCodingService.open(root);
    service.close();
    service = await KeepCodingService.open(root);
    try {
      const memoryEvents = service.store.eventsSince(0)
        .filter((event) => event.type === "playbook_pattern_recorded");
      expect(memoryEvents).toHaveLength(1);
    } finally {
      service.close();
    }

    const playbook = new PlaybookStore(playbookPath);
    try {
      const patterns = playbook.list("phase");
      expect(patterns).toHaveLength(1);
      expect(patterns[0]?.successCount).toBe(1);
    } finally {
      playbook.close();
    }
  });

  it("serializes competing checkpoint attempts with CAS and active-run uniqueness", async () => {
    const root = repository();
    const service = await active(root);
    const owner = "test-owner";
    const head = await service.git.headSha();
    const checkpointRun = service.store.beginCheckpointRun({
      phaseId: "implementation",
      executionMode: "serial",
      summary: "first claimant",
      workspaceBaselineSha: head,
      targetBaselineSha: head,
      leaseOwner: owner,
      leaseDurationMs: 60_000
    });
    try {
      expect(() => service.store.beginCheckpointRun({
        phaseId: "implementation",
        executionMode: "serial",
        summary: "second claimant",
        workspaceBaselineSha: head,
        targetBaselineSha: head,
        leaseOwner: "second-owner",
        leaseDurationMs: 60_000
      })).toThrow(/CHECKPOINT_ALREADY_ACTIVE|CHECKPOINT_PHASE_CAS_FAILED/u);
    } finally {
      service.store.resetCheckpointRun(checkpointRun.id, owner, "test cleanup");
      service.close();
    }
  });
});
