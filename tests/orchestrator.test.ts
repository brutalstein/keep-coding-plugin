import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitRepository } from "../src/core/git.js";
import { ParallelPhaseOrchestrator } from "../src/core/orchestrator.js";
import { ProjectStore } from "../src/storage/store.js";

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-orchestrator-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "# project\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd: root });
  return root;
}

describe("parallel phase orchestration", () => {
  it("prepares and discards independent worktrees", async () => {
    const root = repository();
    const store = new ProjectStore(root);
    store.initialize("Build independent features");
    store.savePlan(
      { goal: "Deliver independent verified features", nonGoals: [], constraints: [], deliverables: ["a", "b"], invariants: [], doneWhen: ["tests pass"] },
      [
        { id: "feature-a", title: "A", goal: "Build A", dependencies: [], allowedScope: ["src/a/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 },
        { id: "feature-b", title: "B", goal: "Build B", dependencies: [], allowedScope: ["src/b/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 }
      ]
    );
    const orchestrator = new ParallelPhaseOrchestrator(await GitRepository.open(root), store);
    const workspaces = await orchestrator.prepare(2);
    expect(workspaces).toHaveLength(2);
    expect(workspaces.every((workspace) => existsSync(workspace.path))).toBe(true);
    for (const workspace of workspaces) await orchestrator.discard(workspace.phaseId);
    expect(workspaces.every((workspace) => !existsSync(workspace.path))).toBe(true);
    store.close();
    rmSync(path.dirname(workspaces[0]!.path), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects scopes that may overlap", async () => {
    const root = repository();
    const store = new ProjectStore(root);
    store.initialize("Build related features");
    store.savePlan(
      { goal: "Deliver related verified features", nonGoals: [], constraints: [], deliverables: ["a", "b"], invariants: [], doneWhen: ["tests pass"] },
      [
        { id: "feature-a", title: "A", goal: "Build A", dependencies: [], allowedScope: ["src/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 },
        { id: "feature-b", title: "B", goal: "Build B", dependencies: [], allowedScope: ["src/b/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 }
      ]
    );
    const orchestrator = new ParallelPhaseOrchestrator(await GitRepository.open(root), store);
    await expect(orchestrator.prepare(2)).rejects.toThrow(/independent scopes/);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
});
