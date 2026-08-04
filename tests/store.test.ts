import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlatformStore } from "../src/storage/platform-store.js";
import type { VerificationEvidence } from "../src/domain/model.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function subject(): PlatformStore {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-store-"));
  roots.push(root);
  return new PlatformStore(root);
}

const contract = {
  goal: "Deliver a verified application", nonGoals: [], constraints: [], deliverables: ["application"],
  invariants: ["tests pass"], doneWhen: ["npm test passes"], budget: { maxTokens: 100 }, playbookOptIn: false
};
const phases = [
  { id: "foundation", title: "Foundation", goal: "Create foundation", dependencies: [], allowedScope: ["src/**"], acceptanceCommands: ["npm test"], maxAttempts: 2, parallelSafe: true },
  { id: "feature", title: "Feature", goal: "Build feature", dependencies: ["foundation"], allowedScope: ["docs/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 }
];

function evidence(passed = true): VerificationEvidence {
  return {
    passed, scopePassed: passed, scopeViolations: passed ? [] : ["README.md"],
    changedFiles: passed ? ["src/a.ts"] : ["README.md"],
    secretScan: { passed, scannedFiles: [], findings: [] },
    budget: { passed, limits: {}, usage: { tokens: 0, costUsd: 0, wallClockMs: 0, updatedAt: "now" }, violations: passed ? [] : ["budget"] },
    selectiveCommands: [], commands: passed ? [{ command: "npm test", exitCode: 0, passed: true, durationMs: 1, stdout: "", stderr: "", timedOut: false }] : [],
    critic: { configured: false, blocking: false, passed: true, summary: "advisory", findings: [], rawOutput: "" },
    impactedCompletedPhases: [], diffHash: "hash", gitSha: "abc"
  };
}

describe("project state machine", () => {
  it("preserves evidence across amendments and approvals", () => {
    const store = subject();
    store.initialize("Build everything");
    store.savePlan(contract, phases);
    store.startPhase("foundation", "abc");
    store.markVerifying("foundation");
    store.finishVerification("foundation", "done", evidence());
    expect(store.getPhase("feature")?.status).toBe("READY");
    const amended = store.amendPlan({
      reason: "A discovered deployment requirement needs a final approval phase",
      addPhases: [{ id: "approval", title: "Approval", goal: "Approve release", dependencies: ["feature"], allowedScope: ["docs/**"], acceptanceCommands: ["npm test"], maxAttempts: 1, requiresApproval: true }],
      supersedePhaseIds: []
    });
    expect(amended.project.planVersion).toBe(2);
    expect(amended.checkpoints).toHaveLength(1);
    store.startPhase("feature", "abc");
    store.markVerifying("feature");
    store.finishVerification("feature", "done", { ...evidence(), changedFiles: ["docs/a.md"] });
    expect(() => store.startPhase("approval", "abc")).toThrow(/awaiting human approval/);
    const pending = store.listApprovals()[0]!;
    store.resolveApproval(pending.id, true, "approved");
    expect(store.startPhase("approval", "abc").status).toBe("IN_PROGRESS");
    store.close();
  });

  it("enforces budgets, reverification, impact and worktree records", () => {
    const store = subject();
    const project = store.initialize("Build everything");
    store.savePlan(contract, [phases[0]!]);
    store.recordBudgetUsage("project", project.id, { tokens: 101, estimatedTokens: 20 });
    expect(store.budgetEvidence("foundation").passed).toBe(false);
    expect(store.listBudgetUsage()[`project:${project.id}`]?.estimatedTokens).toBe(20);
    store.startPhase("foundation", "abc");
    store.markVerifying("foundation");
    store.finishVerification("foundation", "done", evidence());
    expect(store.markReverification(["foundation"], "later change", "other")).toEqual(["foundation"]);
    store.setWorktree({ phaseId: "foundation", path: "/tmp/w", branch: "b", status: "prepared", baseSha: "abc", createdAt: "now" });
    expect(store.getWorktree("foundation")?.branch).toBe("b");
    store.upsertGraphNode({ id: "file:src/a.ts", type: "file", label: "a.ts", path: "src/a.ts", symbol: null, contentHash: "x", metadata: {} });
    expect(store.impact("src/a.ts")[0]?.node.path).toBe("src/a.ts");
    store.close();
  });

  it("rejects cycles and blocks budget failures", () => {
    const store = subject();
    store.initialize("Build");
    expect(() => store.savePlan(contract, [{ ...phases[0]!, acceptanceCommands: ["true"] }])).toThrow(/no-op/);
    expect(() => store.savePlan(contract, [{ ...phases[0]!, dependencies: ["feature"] }, { ...phases[1]!, dependencies: ["foundation"] }])).toThrow(/cycle/);
    store.savePlan(contract, [{ ...phases[0]!, maxAttempts: 1 }]);
    store.startPhase("foundation", "abc");
    store.markVerifying("foundation");
    store.finishVerification("foundation", "failed", evidence(false));
    expect(store.getProject()?.status).toBe("BLOCKED_BUDGET");
    store.close();
  });

  it("clusters equivalent failures despite timestamps paths and line numbers", () => {
    const store = subject();
    try {
      store.initialize("Build");
      store.savePlan(contract, [phases[0]!]);
      const first = store.recordFailure("foundation", "2026-08-04T10:00:00Z Error in /tmp/repo/src/a.ts:12: migration failed with code 500");
      const second = store.recordFailure("foundation", "2026-08-04T10:03:15Z Error in /home/agent/work/src/a.ts:99: migration failed with code 404");
      expect(second.id).toBe(first.id);
      expect(second.count).toBe(2);
      expect(store.listFailures()).toHaveLength(1);
    } finally { store.close(); }
  });
});
