import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VerificationEvidence } from "../src/domain/model.js";
import { ProjectStore } from "../src/storage/store.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function store(): ProjectStore {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-store-"));
  roots.push(root);
  return new ProjectStore(root);
}

const contract = { goal: "Deliver a verified application", nonGoals: [], constraints: [], deliverables: ["application"], invariants: ["tests pass"], doneWhen: ["npm test passes"] };
const phases = [
  { id: "foundation", title: "Foundation", goal: "Create foundation", dependencies: [], allowedScope: ["src/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 },
  { id: "feature", title: "Feature", goal: "Build feature", dependencies: ["foundation"], allowedScope: ["src/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 }
];

function evidence(passed: boolean, changedFiles = ["src/a.ts"]): VerificationEvidence {
  return {
    passed,
    scopePassed: passed,
    scopeViolations: passed ? [] : ["README.md"],
    changedFiles,
    commands: passed ? [{ command: "npm test", exitCode: 0, passed: true, durationMs: 1, stdout: "", stderr: "", timedOut: false }] : [],
    selectiveCommands: [],
    impactedTests: [],
    secretScanPassed: true,
    secretFindings: [],
    budget: null,
    critic: null,
    diffHash: "hash",
    gitSha: "abc",
    checkpointCommitSha: null
  };
}

describe("project state machine", () => {
  it("unlocks dependent phases only after passing evidence", () => {
    const subject = store();
    subject.initialize("Build everything");
    subject.savePlan(contract, phases);
    expect(subject.getPhase("feature")?.status).toBe("PENDING");
    subject.startPhase("foundation", "abc");
    subject.markVerifying("foundation");
    subject.finishVerification("foundation", "done", evidence(true));
    expect(subject.getPhase("foundation")?.status).toBe("COMPLETED");
    expect(subject.getPhase("feature")?.status).toBe("READY");
    subject.close();
  });

  it("blocks a phase after its attempt budget", () => {
    const subject = store();
    subject.initialize("Build everything");
    subject.savePlan(contract, [{ ...phases[0]!, maxAttempts: 1 }]);
    subject.startPhase("foundation", "abc");
    subject.markVerifying("foundation");
    subject.finishVerification("foundation", "failed", evidence(false, ["README.md"]));
    expect(subject.getProject()?.status).toBe("BLOCKED");
    expect(subject.getPhase("foundation")?.status).toBe("BLOCKED");
    subject.close();
  });

  it("uses a distinct budget-blocked outcome", () => {
    const subject = store();
    subject.initialize("Build everything");
    subject.savePlan(contract, [{ ...phases[0]!, budget: { maxTokens: 100 } }]);
    subject.startPhase("foundation", "abc");
    subject.markVerifying("foundation");
    const failed = evidence(false);
    failed.scopePassed = true;
    failed.scopeViolations = [];
    failed.budget = { limits: { maxTokens: 100 }, usage: { tokens: 101 }, passed: false, violations: ["tokens exceed limit"] };
    subject.finishVerification("foundation", "budget exceeded", failed);
    expect(subject.getPhase("foundation")?.status).toBe("BLOCKED_BUDGET");
    subject.close();
  });

  it("amends an active plan without deleting completed evidence", () => {
    const subject = store();
    subject.initialize("Build everything");
    subject.savePlan(contract, [
      phases[0]!,
      { id: "optional", title: "Optional", goal: "Old approach", dependencies: [], allowedScope: ["old/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 }
    ]);
    subject.startPhase("foundation", "abc");
    subject.markVerifying("foundation");
    subject.finishVerification("foundation", "done", evidence(true));
    const snapshot = subject.amendPlan({
      reason: "Repository discovery requires a replacement implementation phase.",
      supersedePhaseIds: ["optional"],
      addPhases: [{ id: "replacement", title: "Replacement", goal: "Use discovered architecture", dependencies: ["foundation"], allowedScope: ["src/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 }]
    });
    expect(snapshot.project.planVersion).toBe(2);
    expect(subject.getPhase("foundation")?.status).toBe("COMPLETED");
    expect(subject.getPhase("optional")?.status).toBe("SUPERSEDED");
    expect(subject.getPhase("replacement")?.status).toBe("READY");
    expect(subject.listCheckpoints()).toHaveLength(1);
    subject.close();
  });

  it("models explicit approval pauses", () => {
    const subject = store();
    subject.initialize("Build everything");
    subject.savePlan(contract, [{ ...phases[0]!, requiresApproval: true }]);
    const approval = subject.requestApproval("foundation", "Proceed?", "Material product decision");
    expect(subject.getPhase("foundation")?.status).toBe("AWAITING_APPROVAL");
    subject.resolveApproval(approval.id, true, "Approved");
    expect(subject.getPhase("foundation")?.status).toBe("READY");
    subject.close();
  });

  it("rejects cycles and no-op checks", () => {
    const subject = store();
    subject.initialize("Build everything");
    expect(() => subject.savePlan(contract, [{ ...phases[0]!, acceptanceCommands: ["true"] }])).toThrow(/no-op/);
    expect(() => subject.savePlan(contract, [{ ...phases[0]!, dependencies: ["feature"] }, { ...phases[1]!, dependencies: ["foundation"] }])).toThrow(/cycle/);
    subject.close();
  });
});
