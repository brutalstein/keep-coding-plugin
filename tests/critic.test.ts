import { afterEach, describe, expect, it } from "vitest";
import { runCritic } from "../src/core/critic.js";
import type { PhaseRecord, ProjectContract } from "../src/domain/model.js";

const phase: PhaseRecord = {
  id: "critic-phase",
  ordinal: 0,
  title: "Critic phase",
  goal: "Review architectural invariants",
  dependencies: [],
  allowedScope: ["src/**"],
  acceptanceCommands: ["npm test"],
  maxAttempts: 2,
  status: "IN_PROGRESS",
  attempts: 0,
  startedAt: null,
  completedAt: null,
  baseSha: null,
  headSha: null,
  summary: null,
  planVersion: 1,
  supersededBy: null
};

function contract(criticGate: ProjectContract["criticGate"]): ProjectContract {
  return {
    goal: "Deliver a critic-reviewed project",
    nonGoals: [],
    constraints: [],
    deliverables: ["review"],
    invariants: ["deterministic checks remain authoritative"],
    doneWhen: ["checks pass"],
    criticGate
  };
}

function nodeCommand(script: string): string {
  return JSON.stringify([process.execPath, "-e", script]);
}

const input = { phase, diff: "+const value = 1;", changedFiles: ["src/value.ts"] };

afterEach(() => {
  delete process.env.KEEP_CODING_CRITIC_COMMAND_JSON;
});

describe("critic adapter", () => {
  it("supports disabled and unconfigured advisory gates and fails closed for blocking", async () => {
    await expect(runCritic({ ...input, contract: contract("disabled") })).resolves.toMatchObject({
      configured: false,
      passed: true,
      blocking: false,
      summary: "Critic gate disabled."
    });
    await expect(runCritic({ ...input, contract: contract("advisory") })).resolves.toMatchObject({
      configured: false,
      passed: true,
      blocking: false
    });
    await expect(runCritic({ ...input, contract: contract("blocking") })).resolves.toMatchObject({
      configured: false,
      passed: false,
      blocking: true,
      findings: ["Configure KEEP_CODING_CRITIC_COMMAND_JSON or change criticGate to advisory."]
    });
  });

  it("accepts a valid JSON critic result without shell interpolation", async () => {
    process.env.KEEP_CODING_CRITIC_COMMAND_JSON = nodeCommand(
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({passed:false,summary:'architecture drift',findings:['layer violation',7]})))"
    );
    await expect(runCritic({ ...input, contract: contract("blocking") })).resolves.toEqual({
      configured: true,
      passed: false,
      blocking: true,
      summary: "architecture drift",
      findings: ["layer violation"]
    });
  });

  it("reports non-zero and invalid JSON critic failures", async () => {
    process.env.KEEP_CODING_CRITIC_COMMAND_JSON = nodeCommand("process.stderr.write('critic failed');process.exit(3)");
    const failed = await runCritic({ ...input, contract: contract("advisory") });
    expect(failed).toMatchObject({ configured: true, passed: false, blocking: false });
    expect(failed.summary).toContain("Critic exited 3");

    process.env.KEEP_CODING_CRITIC_COMMAND_JSON = nodeCommand("process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('not-json'))");
    await expect(runCritic({ ...input, contract: contract("advisory") })).resolves.toMatchObject({
      configured: true,
      passed: false,
      summary: "Critic returned invalid JSON.",
      findings: ["not-json"]
    });
  });

  it("rejects malformed command configuration", async () => {
    process.env.KEEP_CODING_CRITIC_COMMAND_JSON = JSON.stringify([process.execPath, 42]);
    await expect(runCritic({ ...input, contract: contract("advisory") })).rejects.toThrow(/JSON string array/);

    process.env.KEEP_CODING_CRITIC_COMMAND_JSON = "{}";
    await expect(runCritic({ ...input, contract: contract("advisory") })).rejects.toThrow(/JSON string array/);
  });
});
