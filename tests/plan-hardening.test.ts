import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CriticRunner } from "../src/core/critic.js";
import type { PhaseDefinition, PhaseRecord, ProjectContract } from "../src/domain/model.js";
import { PlatformStore } from "../src/storage/platform-store.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });
function store(): PlatformStore { const root = mkdtempSync(path.join(tmpdir(), "keep-coding-plan-hardening-")); roots.push(root); return new PlatformStore(root); }
const contract: ProjectContract = { goal: "Deliver a verified system", nonGoals: [], constraints: [], deliverables: ["system"], invariants: ["verified"], doneWhen: ["tests pass"], budget: { maxTokens: 100, maxCostUsd: 10, maxWallClockMs: 1_000 } };
const phase = (id = "base", dependencies: string[] = []): PhaseDefinition => ({ id, title: id, goal: `Implement ${id}`, dependencies, allowedScope: ["src/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 });

describe("plan rejection branches", () => {
  it("rejects every named malformed amendment independently", () => {
    const subject = store(); subject.initialize("Build a verified system"); subject.savePlan(contract, [phase()]);
    const amend = (addPhases: PhaseDefinition[], supersedePhaseIds: string[] = [], reason = "A concrete discovered requirement requires this amendment") =>
      subject.amendPlan({ reason, addPhases, supersedePhaseIds });
    expect(() => amend([], [], "short")).toThrow(/concrete reason/);
    expect(() => amend([{ ...phase("BAD") }])).toThrow(/invalid phase id/);
    expect(() => amend([phase("base")])).toThrow(/duplicate phase id/);
    expect(() => amend([phase("new"), phase("new")])).toThrow(/duplicate phase id/);
    expect(() => amend([{ ...phase("new"), allowedScope: [] }])).toThrow(/requires scope and commands/);
    expect(() => amend([{ ...phase("new"), acceptanceCommands: [] }])).toThrow(/requires scope and commands/);
    expect(() => amend([{ ...phase("new"), acceptanceCommands: ["echo"] }])).toThrow(/no-op command/);
    expect(() => amend([phase("new", ["missing"])] )).toThrow(/unknown dependency/);
    expect(() => amend([phase("one", ["two"]), phase("two", ["one"])] )).toThrow(/cycle/);
    expect(() => amend([], ["missing"])).toThrow(/unknown superseded phase/);
    subject.startPhase("base", "abc");
    expect(() => amend([phase("replacement")], ["base"])).toThrow(/in-progress phase cannot be superseded/);
    subject.close();
  });

  it("rejects non-positive or non-finite project and phase budgets", () => {
    const subject = store(); subject.initialize("Build a verified system");
    expect(() => subject.savePlan({ ...contract, budget: { maxTokens: 0 } }, [phase()])).toThrow(/must be positive/);
    expect(() => subject.savePlan(contract, [{ ...phase(), budget: { maxCostUsd: Number.NaN } }])).toThrow(/must be positive/);
    subject.savePlan(contract, [phase()]);
    expect(() => subject.amendPlan({ reason: "A concrete budget amendment is required", addPhases: [], supersedePhaseIds: [], contractPatch: { budget: { maxWallClockMs: -1 } } })).toThrow(/must be positive/);
    expect(() => subject.amendPlan({ reason: "A concrete phase amendment is required", addPhases: [{ ...phase("new"), budget: { maxTokens: 0 } }], supersedePhaseIds: [] })).toThrow(/must be positive/);
    subject.close();
  });
});

describe("budget and approval branch semantics", () => {
  it("uses the stricter project/phase limit in both directions", () => {
    const subject = store(); const project = subject.initialize("Build a verified system");
    subject.savePlan(contract, [{ ...phase(), budget: { maxTokens: 200, maxCostUsd: 5, maxWallClockMs: 2_000 } }]);
    subject.recordBudgetUsage("project", project.id, { tokens: 101, costUsd: 4, wallClockMs: 900 });
    let evidence = subject.budgetEvidence("base");
    expect(evidence.limits).toEqual({ maxTokens: 100, maxCostUsd: 5, maxWallClockMs: 1_000 });
    expect(evidence.violations).toContain("token budget exceeded: 101/100");
    subject.recordBudgetUsage("phase", "base", { costUsd: 6, wallClockMs: 1_100 });
    evidence = subject.budgetEvidence("base");
    expect(evidence.violations).toEqual(expect.arrayContaining(["cost budget exceeded: 6/5", "wall-clock budget exceeded: 1100/1000"]));
    expect(() => subject.recordBudgetUsage("phase", "base", { tokens: -1 })).toThrow(/non-negative/);
    subject.close();
  });

  it("deduplicates pending approvals and rejects double resolution", () => {
    const subject = store(); subject.initialize("Build a verified system"); subject.savePlan(contract, [{ ...phase(), requiresApproval: true, approvalPrompt: "Approve?" }]);
    const first = subject.requestApproval("base", "Approve?");
    expect(subject.requestApproval("base", "Different prompt").id).toBe(first.id);
    expect(subject.resolveApproval(first.id, false, "rejected").status).toBe("rejected");
    expect(() => subject.resolveApproval(first.id, true, "again")).toThrow(/already resolved/);
    expect(() => subject.resolveApproval("missing", true, "none")).toThrow(/unknown approval/);
    subject.close();
  });
});

describe("critic fail-closed contract", () => {
  const definition = phase();
  const record: PhaseRecord = { ...definition, ordinal: 0, status: "IN_PROGRESS", attempts: 0, startedAt: null, completedAt: null, baseSha: null, headSha: null, summary: null };
  const input = { root: process.cwd(), phase: record, contract, changedFiles: [], diff: "" };
  it("fails closed only for a blocking unconfigured critic", async () => {
    const blocking = await new CriticRunner("").review(input, true);
    const advisory = await new CriticRunner("").review(input, false);
    expect(blocking).toMatchObject({ configured: false, blocking: true, passed: false });
    expect(blocking.findings[0]?.rule).toBe("critic-not-configured");
    expect(advisory).toMatchObject({ configured: false, blocking: false, passed: true, findings: [] });
  });
});
