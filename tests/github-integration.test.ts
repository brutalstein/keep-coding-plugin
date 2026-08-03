import { describe, expect, it } from "vitest";
import type { ProjectSnapshot } from "../src/domain/model.js";
import { generateCheckpointCommitMessage, generatePullRequestDescription } from "../src/integrations/github.js";

const snapshot: ProjectSnapshot = {
  project: {
    id: "project",
    root: "/repo",
    originalPrompt: "Build it",
    status: "READY_TO_COMPLETE",
    contract: { goal: "Deliver the durable platform", nonGoals: [], constraints: [], deliverables: ["adaptive plans"], invariants: [], doneWhen: ["checks pass"] },
    planVersion: 2,
    currentPhaseId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  },
  phases: [{
    id: "adaptive", ordinal: 0, title: "Adaptive", goal: "Amend plans", dependencies: [], allowedScope: ["src/**"],
    acceptanceCommands: ["npm test"], maxAttempts: 2, status: "COMPLETED", attempts: 0, startedAt: null,
    completedAt: "2026-01-01T00:00:00.000Z", baseSha: "a", headSha: "b", summary: "done", planVersion: 2, supersededBy: null
  }],
  decisions: [{ id: "d", phaseId: "adaptive", title: "Version amendments", rationale: "Preserve evidence lineage", alternatives: [], status: "active", createdAt: "2026-01-01T00:00:00.000Z" }],
  failures: [],
  approvals: [],
  checkpoints: [{
    id: "c", phaseId: "adaptive", gitSha: "1234567890abcdef", summary: "implemented amendment", changedFiles: ["src/store.ts"],
    verification: {
      passed: true, scopePassed: true, scopeViolations: [], changedFiles: ["src/store.ts"],
      commands: [{ command: "npm test", exitCode: 0, passed: true, durationMs: 1, stdout: "", stderr: "", timedOut: false }],
      selectiveCommands: [], impactedTests: ["tests/store.test.ts"], secretScanPassed: true, secretFindings: [], budget: null,
      critic: null, diffHash: "hash", gitSha: "1234567890abcdef", checkpointCommitSha: "1234567890abcdef"
    },
    createdAt: "2026-01-01T00:00:00.000Z"
  }],
  recentEvents: []
};

describe("GitHub integration", () => {
  it("generates a decision-sourced pull request description", () => {
    const markdown = generatePullRequestDescription(snapshot);
    expect(markdown).toContain("Deliver the durable platform");
    expect(markdown).toContain("Version amendments");
    expect(markdown).toContain("tests/store.test.ts");
    expect(markdown).toContain("All active phases are verified");
  });

  it("generates checkpoint commit messages from evidence", () => {
    expect(generateCheckpointCommitMessage(snapshot.checkpoints[0]!)).toContain("Verified 1 changed file; 1 impacted test.");
  });
});
