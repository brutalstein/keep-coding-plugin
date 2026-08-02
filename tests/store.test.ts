import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../src/storage/store.js";
import type { VerificationEvidence } from "../src/domain/model.js";

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

describe("project state machine", () => {
  it("unlocks dependent phases only after passing evidence", () => {
    const subject = store();
    subject.initialize("Build everything");
    subject.savePlan(contract, phases);
    expect(subject.getPhase("feature")?.status).toBe("PENDING");
    subject.startPhase("foundation", "abc");
    subject.markVerifying("foundation");
    const evidence: VerificationEvidence = { passed: true, scopePassed: true, scopeViolations: [], changedFiles: ["src/a.ts"], commands: [{ command: "npm test", exitCode: 0, passed: true, durationMs: 1, stdout: "", stderr: "", timedOut: false }], diffHash: "hash", gitSha: "abc" };
    subject.finishVerification("foundation", "done", evidence);
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
    subject.finishVerification("foundation", "failed", { passed: false, scopePassed: false, scopeViolations: ["README.md"], changedFiles: ["README.md"], commands: [], diffHash: "hash", gitSha: "abc" });
    expect(subject.getProject()?.status).toBe("BLOCKED");
    expect(subject.getPhase("foundation")?.status).toBe("BLOCKED");
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

