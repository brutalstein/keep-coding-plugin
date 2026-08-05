import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointCrashError, CheckpointPipeline } from "../src/core/checkpoint.js";
import { GitRepository } from "../src/core/git.js";
import { KeepCodingService } from "../src/core/service.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-parallel-recovery-"));
  roots.push(root);
  mkdirSync(path.join(root, "src", "alpha"), { recursive: true });
  mkdirSync(path.join(root, "src", "beta"), { recursive: true });
  writeFileSync(path.join(root, "src", "alpha", "main.js"), "export const alpha = false;\n");
  writeFileSync(path.join(root, "src", "beta", "main.js"), "export const beta = false;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

function trailerCount(root: string, trailer: string): number {
  const output = execFileSync("git", ["log", "--format=%B%x00"], { cwd: root, encoding: "utf8" });
  return output.split("\0").filter((message) => message.includes(trailer)).length;
}

describe("crash-safe parallel checkpoints", () => {
  it("finishes post-processing and cleans a merged worktree after restart", async () => {
    const root = repository();
    let service = await KeepCodingService.open(root);
    await service.initialize("Enable two independent modules in parallel");
    service.savePlan(
      {
        goal: "Enable alpha and beta independently",
        nonGoals: [],
        constraints: [],
        deliverables: ["alpha", "beta"],
        invariants: [],
        doneWhen: ["Both modules parse and export true"]
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
    writeFileSync(path.join(alpha.path, "src", "alpha", "main.js"), "export const alpha = true;\n");

    const alphaGit = await GitRepository.open(alpha.path);
    const pipeline = new CheckpointPipeline(service.store, {
      faultInjector(point, runId) {
        if (point === "after_state_committed") throw new CheckpointCrashError(point, runId);
      }
    });
    await expect(pipeline.run({
      phaseId: "alpha",
      summary: "enabled alpha",
      executionMode: "parallel",
      workspaceGit: alphaGit,
      indexGit: service.git,
      reverificationReason: (files) => `Parallel recovery changed: ${files.join(", ")}`
    })).rejects.toBeInstanceOf(CheckpointCrashError);

    const runId = service.store.listCheckpointRuns()[0]!.id;
    expect(service.store.getWorktree("alpha")?.status).toBe("merged");
    expect(existsSync(alpha.path)).toBe(true);
    service.close();

    service = await KeepCodingService.open(root);
    try {
      expect(service.store.getPhase("alpha")?.status).toBe("COMPLETED");
      expect(service.store.getCheckpointRun(runId)?.status).toBe("DONE");
      expect(service.store.getWorktree("alpha")?.status).toBe("cleaned");
      expect(existsSync(alpha.path)).toBe(false);
      expect(() => execFileSync("git", ["show-ref", "--verify", `refs/heads/${alpha.branch}`], { cwd: root }))
        .toThrow();
      expect(trailerCount(root, `Keep-Coding-Merge: ${runId}`)).toBe(1);
    } finally {
      service.close();
    }
  });
});
