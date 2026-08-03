import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KeepCodingService } from "../src/core/service.js";
import type { ParallelPhaseWorkspace } from "../src/core/orchestrator.js";

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-parallel-service-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  mkdirSync(path.join(root, "src", "a"), { recursive: true });
  mkdirSync(path.join(root, "src", "b"), { recursive: true });
  writeFileSync(path.join(root, "src", "a", "value.js"), "const valueA = 1;\n");
  writeFileSync(path.join(root, "src", "b", "value.js"), "const valueB = 1;\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

async function plannedService(root: string): Promise<KeepCodingService> {
  const service = await KeepCodingService.open(root);
  await service.initialize("Build two independent verified features");
  service.savePlan(
    {
      goal: "Deliver two independent verified features",
      nonGoals: [],
      constraints: [],
      deliverables: ["feature a", "feature b"],
      invariants: ["only passing branches merge"],
      doneWhen: ["both syntax checks pass"]
    },
    [
      {
        id: "feature-a",
        title: "Feature A",
        goal: "Implement feature A",
        dependencies: [],
        allowedScope: ["src/a/**"],
        acceptanceCommands: ["node --check src/a/value.js"],
        maxAttempts: 2
      },
      {
        id: "feature-b",
        title: "Feature B",
        goal: "Implement feature B",
        dependencies: [],
        allowedScope: ["src/b/**"],
        acceptanceCommands: ["node --check src/b/value.js"],
        maxAttempts: 2
      }
    ]
  );
  return service;
}

function workspaces(result: Record<string, unknown>): ParallelPhaseWorkspace[] {
  return result.workspaces as ParallelPhaseWorkspace[];
}

function commit(workspace: ParallelPhaseWorkspace, relativePath: string, content: string): void {
  writeFileSync(path.join(workspace.path, relativePath), content);
  execFileSync("git", ["add", relativePath], { cwd: workspace.path });
  execFileSync("git", ["commit", "-qm", `update ${workspace.phaseId}`], { cwd: workspace.path });
}

describe("evidence-gated parallel phase merges", () => {
  it("verifies a committed worktree before merging and completing the phase", async () => {
    const root = repository();
    const service = await plannedService(root);
    const prepared = workspaces(await service.prepareParallelPhases(2));
    const featureA = prepared.find((workspace) => workspace.phaseId === "feature-a")!;
    const featureB = prepared.find((workspace) => workspace.phaseId === "feature-b")!;
    try {
      commit(featureA, "src/a/value.js", "const valueA = 2;\n");
      const result = await service.mergeParallelPhase("feature-a", "Implement feature A");
      expect(result).toMatchObject({ merged: true, phase: { status: "COMPLETED" }, evidence: { passed: true } });
      expect(readFileSync(path.join(root, "src", "a", "value.js"), "utf8")).toContain("valueA = 2");
      expect(existsSync(featureA.path)).toBe(false);
      expect(service.store.listCheckpoints().some((checkpoint) => checkpoint.phaseId === "feature-a")).toBe(true);
      await service.discardParallelPhase("feature-b");
      expect(existsSync(featureB.path)).toBe(false);
    } finally {
      service.close();
      rmSync(path.dirname(featureA.path), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a failing committed branch isolated from the primary repository", async () => {
    const root = repository();
    const service = await plannedService(root);
    const prepared = workspaces(await service.prepareParallelPhases(2));
    const featureA = prepared.find((workspace) => workspace.phaseId === "feature-a")!;
    const featureB = prepared.find((workspace) => workspace.phaseId === "feature-b")!;
    try {
      commit(featureA, "src/a/value.js", "const = ;\n");
      const result = await service.mergeParallelPhase("feature-a", "Broken feature A");
      expect(result).toMatchObject({ merged: false, phase: { status: "FAILED" }, evidence: { passed: false } });
      expect(readFileSync(path.join(root, "src", "a", "value.js"), "utf8")).toContain("valueA = 1");
      expect(existsSync(featureA.path)).toBe(true);
      await service.discardParallelPhase("feature-a");
      await service.discardParallelPhase("feature-b");
      expect(existsSync(featureB.path)).toBe(false);
    } finally {
      service.close();
      rmSync(path.dirname(featureA.path), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
