import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandImpactedFiles, withMeasuredWallClock } from "../src/core/service.js";
import { indexRepository } from "../src/core/indexer.js";
import { GitRepository } from "../src/core/git.js";
import type { VerificationEvidence } from "../src/domain/model.js";
import { ProjectStore } from "../src/storage/store.js";

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-impact-budget-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "dependency.js"), "export const dependency = 1;\n");
  writeFileSync(path.join(root, "src", "consumer.js"), "import { dependency } from './dependency.js';\nexport const value = dependency;\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

function evidence(): VerificationEvidence {
  return {
    passed: true,
    scopePassed: true,
    scopeViolations: [],
    changedFiles: ["src/dependency.js"],
    commands: [{ command: "node --check src/dependency.js", exitCode: 0, passed: true, durationMs: 1, stdout: "", stderr: "", timedOut: false }],
    selectiveCommands: [],
    impactedTests: [],
    secretScanPassed: true,
    secretFindings: [],
    budget: null,
    critic: null,
    diffHash: "checkpoint-diff",
    gitSha: "abc123",
    checkpointCommitSha: "abc123"
  };
}

describe("impact-aware re-verification and measured budgets", () => {
  it("expands changed files through the semantic graph and preserves phase ownership after reindex", async () => {
    const root = repository();
    const store = new ProjectStore(root);
    try {
      store.initialize("Build a dependency-aware project");
      store.savePlan(
        { goal: "Deliver dependency-aware verification", nonGoals: [], constraints: [], deliverables: ["verified dependency"], invariants: [], doneWhen: ["checks pass"] },
        [{
          id: "dependency-phase",
          title: "Dependency phase",
          goal: "Own the dependency module",
          dependencies: [],
          allowedScope: ["src/dependency.js"],
          acceptanceCommands: ["node --check src/dependency.js"],
          maxAttempts: 2
        }]
      );
      store.startPhase("dependency-phase", "base");
      store.markVerifying("dependency-phase");
      store.finishVerification("dependency-phase", "verified dependency", evidence());
      await indexRepository(store, await GitRepository.open(root));

      const impacted = expandImpactedFiles(store, ["src/consumer.js"]);
      expect(impacted).toEqual(expect.arrayContaining(["src/consumer.js", "src/dependency.js"]));
      expect(store.getImpact("src/dependency.js").phases).toContain("dependency-phase");
      expect(store.completedPhasesImpactedByFiles(impacted, "other-phase")).toContain("dependency-phase");
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives wall-clock usage unless the caller supplied one", () => {
    const startedAt = new Date(Date.now() - 2_000).toISOString();
    expect(withMeasuredWallClock({}, startedAt).wallClockMs).toBeGreaterThanOrEqual(1_500);
    expect(withMeasuredWallClock({ tokens: 20, wallClockMs: 99 }, startedAt)).toEqual({ tokens: 20, wallClockMs: 99 });
    expect(withMeasuredWallClock({ costUsd: 1 }, null)).toEqual({ costUsd: 1 });
    expect(withMeasuredWallClock({ tokens: 1 }, "invalid")).toEqual({ tokens: 1 });
  });
});
