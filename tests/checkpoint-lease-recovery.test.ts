import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointPipeline } from "../src/core/checkpoint.js";
import { KeepCodingService } from "../src/core/service.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

async function activeService(): Promise<KeepCodingService> {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-lease-recovery-"));
  roots.push(root);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "main.js"), "export const ready = false;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });

  const service = await KeepCodingService.open(root);
  await service.initialize("Enable the module");
  service.savePlan(
    {
      goal: "Enable the module",
      nonGoals: [],
      constraints: [],
      deliverables: ["module"],
      invariants: [],
      doneWhen: ["Module is enabled"]
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
  return service;
}

async function begin(service: KeepCodingService, owner: string) {
  const head = await service.git.headSha();
  return service.store.beginCheckpointRun({
    phaseId: "implementation",
    executionMode: "serial",
    summary: "lease decision",
    workspaceBaselineSha: head,
    targetBaselineSha: head,
    leaseOwner: owner,
    leaseDurationMs: 60_000
  });
}

describe("checkpoint recovery lease ownership", () => {
  it("defers to a live checkpoint owner on the current host", async () => {
    const service = await activeService();
    const owner = `${hostname()}:${process.pid}:live-owner`;
    const checkpointRun = await begin(service, owner);
    try {
      const report = await CheckpointPipeline.recover(service.git, service.store);
      expect(report.deferred).toEqual([checkpointRun.id]);
      expect(service.store.getCheckpointRun(checkpointRun.id)?.leaseOwner).toBe(owner);
    } finally {
      service.store.resetCheckpointRun(checkpointRun.id, owner, "test cleanup");
      service.close();
    }
  });

  it("does not steal a malformed same-host lease", async () => {
    const service = await activeService();
    const owner = `${hostname()}:not-a-pid:malformed-owner`;
    const checkpointRun = await begin(service, owner);
    try {
      const report = await CheckpointPipeline.recover(service.git, service.store);
      expect(report.deferred).toEqual([checkpointRun.id]);
      expect(service.store.getPhase("implementation")?.status).toBe("VERIFYING");
    } finally {
      service.store.resetCheckpointRun(checkpointRun.id, owner, "test cleanup");
      service.close();
    }
  });

  it("takes over an orphaned same-host lease and resets an evidence-free run", async () => {
    const service = await activeService();
    const owner = `${hostname()}:2147483647:dead-owner`;
    const checkpointRun = await begin(service, owner);
    try {
      const report = await CheckpointPipeline.recover(service.git, service.store);
      expect(report.reset).toEqual([checkpointRun.id]);
      expect(report.deferred).toEqual([]);
      expect(service.store.getCheckpointRun(checkpointRun.id)).toMatchObject({
        status: "DONE",
        evidence: null,
        leaseOwner: null
      });
      expect(service.store.getPhase("implementation")?.status).toBe("IN_PROGRESS");
    } finally {
      service.close();
    }
  });
});
