import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointCrashError, CheckpointPipeline } from "../src/core/checkpoint.js";
import { GitRepository } from "../src/core/git.js";
import { KeepCodingService } from "../src/core/service.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function initializeRepository(parallel = false): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-recovery-branches-"));
  roots.push(root);
  if (parallel) {
    mkdirSync(path.join(root, "src", "alpha"), { recursive: true });
    mkdirSync(path.join(root, "src", "beta"), { recursive: true });
    writeFileSync(path.join(root, "src", "alpha", "main.js"), "export const alpha = false;\n");
    writeFileSync(path.join(root, "src", "beta", "main.js"), "export const beta = false;\n");
  } else {
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "main.js"), "export const ready = false;\n");
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

async function activeSerial(root: string): Promise<KeepCodingService> {
  const service = await KeepCodingService.open(root);
  await service.initialize("Enable the module and verify JavaScript syntax");
  service.savePlan(
    {
      goal: "Enable the module",
      nonGoals: [],
      constraints: [],
      deliverables: ["enabled module"],
      invariants: [],
      doneWhen: ["src/main.js exports ready as true"]
    },
    [{
      id: "implementation",
      title: "Enable module",
      goal: "Set ready to true",
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

async function crashAfterEvidence(service: KeepCodingService, executionMode: "serial" | "parallel", phaseId: string, workspaceGit: GitRepository): Promise<string> {
  let runId = "";
  const pipeline = new CheckpointPipeline(service.store, {
    faultInjector(point, currentRunId) {
      if (point === "after_evidence_persisted") {
        runId = currentRunId;
        throw new CheckpointCrashError(point, currentRunId);
      }
    }
  });
  await expect(pipeline.run({
    phaseId,
    summary: `verified ${phaseId}`,
    executionMode,
    workspaceGit,
    indexGit: service.git,
    reverificationReason: (files) => `Recovered branch test changed: ${files.join(", ")}`
  })).rejects.toBeInstanceOf(CheckpointCrashError);
  return runId;
}

function trailerCount(root: string, trailer: string): number {
  const output = execFileSync("git", ["log", "--all", "--format=%B%x00"], { cwd: root, encoding: "utf8" });
  return output.split("\0").filter((message) => message.includes(trailer)).length;
}

describe("checkpoint recovery decisions", () => {
  it("replays a verified serial checkpoint that crashed before Git commit", async () => {
    const root = initializeRepository();
    let service = await activeSerial(root);
    const runId = await crashAfterEvidence(service, "serial", "implementation", service.git);
    expect(trailerCount(root, `Keep-Coding-Commit: ${runId}`)).toBe(0);
    service.close();

    service = await KeepCodingService.open(root);
    try {
      expect(service.store.getCheckpointRun(runId)).toMatchObject({ status: "DONE" });
      expect(service.store.getPhase("implementation")?.status).toBe("COMPLETED");
      expect(service.store.listCheckpoints()).toHaveLength(1);
      expect(trailerCount(root, `Keep-Coding-Commit: ${runId}`)).toBe(1);
    } finally {
      service.close();
    }
  });

  it("fails closed when repository history diverges before a verified checkpoint can commit", async () => {
    const root = initializeRepository();
    let service = await activeSerial(root);
    const runId = await crashAfterEvidence(service, "serial", "implementation", service.git);
    service.close();

    writeFileSync(path.join(root, "external.txt"), "external change\n");
    execFileSync("git", ["add", "external.txt"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "external change"], { cwd: root });

    service = await KeepCodingService.open(root);
    try {
      expect(service.store.getCheckpointRun(runId)).toMatchObject({
        status: "FAILED_TERMINAL"
      });
      expect(service.store.getCheckpointRun(runId)?.lastError).toMatch(/CHECKPOINT_BASELINE_DIVERGED/u);
      expect(service.store.getPhase("implementation")?.status).toBe("BLOCKED");
      expect(service.store.getProject()?.status).toBe("BLOCKED");
      expect(service.store.listCheckpoints()).toHaveLength(0);
      expect(trailerCount(root, `Keep-Coding-Commit: ${runId}`)).toBe(0);
    } finally {
      service.close();
    }
  });

  it("defers recovery while an unexpired remote lease is still authoritative", async () => {
    const root = initializeRepository();
    const service = await activeSerial(root);
    const head = await service.git.headSha();
    const owner = "remote-worker:4242:lease-token";
    const checkpointRun = service.store.beginCheckpointRun({
      phaseId: "implementation",
      executionMode: "serial",
      summary: "remote claimant",
      workspaceBaselineSha: head,
      targetBaselineSha: head,
      leaseOwner: owner,
      leaseDurationMs: 60_000
    });
    try {
      const report = await CheckpointPipeline.recover(service.git, service.store);
      expect(report).toEqual({
        recovered: [],
        reset: [],
        blocked: [],
        deferred: [checkpointRun.id]
      });
      expect(service.store.getCheckpointRun(checkpointRun.id)).toMatchObject({
        status: "VERIFYING",
        leaseOwner: owner
      });
      expect(service.store.getPhase("implementation")?.status).toBe("VERIFYING");
    } finally {
      service.store.resetCheckpointRun(checkpointRun.id, owner, "test cleanup");
      service.close();
    }
  });

  it("reconstructs a parallel phase commit and merge from verified worktree evidence", async () => {
    const root = initializeRepository(true);
    let service = await KeepCodingService.open(root);
    await service.initialize("Enable alpha and beta independently");
    service.savePlan(
      {
        goal: "Enable independent modules",
        nonGoals: [],
        constraints: [],
        deliverables: ["alpha", "beta"],
        invariants: [],
        doneWhen: ["Both modules export true"]
      },
      [
        {
          id: "alpha",
          title: "Enable alpha",
          goal: "Set alpha to true",
          dependencies: [],
          allowedScope: ["src/alpha/**"],
          acceptanceCommands: ["node --check src/alpha/main.js"],
          maxAttempts: 3,
          parallelSafe: true
        },
        {
          id: "beta",
          title: "Enable beta",
          goal: "Set beta to true",
          dependencies: [],
          allowedScope: ["src/beta/**"],
          acceptanceCommands: ["node --check src/beta/main.js"],
          maxAttempts: 3,
          parallelSafe: true
        }
      ]
    );
    const prepared = await service.parallel().prepare(["alpha", "beta"]) as {
      worktrees: Array<{ phaseId: string; path: string; branch: string }>;
    };
    roots.push(...prepared.worktrees.map((item) => item.path));
    const alpha = prepared.worktrees.find((item) => item.phaseId === "alpha")!;
    const beta = prepared.worktrees.find((item) => item.phaseId === "beta")!;
    writeFileSync(path.join(alpha.path, "src", "alpha", "main.js"), "export const alpha = true;\n");
    const alphaGit = await GitRepository.open(alpha.path);
    const runId = await crashAfterEvidence(service, "parallel", "alpha", alphaGit);
    expect(trailerCount(root, `Keep-Coding-Commit: ${runId}`)).toBe(0);
    expect(trailerCount(root, `Keep-Coding-Merge: ${runId}`)).toBe(0);
    service.close();

    service = await KeepCodingService.open(root);
    try {
      expect(service.store.getCheckpointRun(runId)).toMatchObject({ status: "DONE" });
      expect(service.store.getPhase("alpha")?.status).toBe("COMPLETED");
      expect(service.store.getWorktree("alpha")?.status).toBe("cleaned");
      expect(existsSync(alpha.path)).toBe(false);
      expect(trailerCount(root, `Keep-Coding-Commit: ${runId}`)).toBe(1);
      expect(trailerCount(root, `Keep-Coding-Merge: ${runId}`)).toBe(1);
    } finally {
      await service.git.removeWorktree(beta.path, beta.branch);
      service.store.setWorktree({
        ...service.store.getWorktree("beta")!,
        status: "cleaned"
      });
      service.close();
    }
  });
});
