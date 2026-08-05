import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CriticRunner } from "../src/core/critic.js";
import type { PhaseRecord, ProjectContract } from "../src/domain/model.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function repository(script: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-critic-security-"));
  roots.push(root);
  writeFileSync(path.join(root, "critic.js"), script);
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "main.js"), "export const ready = true;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

const phase: PhaseRecord = {
  id: "phase",
  ordinal: 0,
  title: "Phase",
  goal: "Review change",
  status: "VERIFYING",
  dependencies: [],
  allowedScope: ["src/**"],
  acceptanceCommands: ["node --check src/main.js"],
  maxAttempts: 1,
  attempts: 0,
  startedAt: null,
  completedAt: null,
  baseSha: null,
  headSha: null,
  summary: null
};
const contract: ProjectContract = {
  goal: "Review change",
  nonGoals: [],
  constraints: [],
  deliverables: ["review"],
  invariants: [],
  doneWhen: ["critic passes"]
};

describe("critic execution security", () => {
  it("blocks an advisory critic that mutates the repository", async () => {
    const root = repository(`
      const fs = require('node:fs');
      fs.writeFileSync('critic-owned.txt', 'unauthorized');
      process.stdin.resume();
      process.stdin.on('end', () => process.stdout.write(JSON.stringify({ passed: true, findings: [] })));
    `);
    const evidence = await new CriticRunner("node critic.js", 2_000).review({
      root,
      phase,
      contract,
      changedFiles: ["src/main.js"],
      diff: ""
    }, false);
    expect(evidence.passed).toBe(false);
    expect(evidence.summary).toMatch(/denied by the operator execution policy/u);
    expect(evidence.policyViolations).toEqual([
      "EXECUTION_CRITIC_WRITE_DENIED: critic-owned.txt"
    ]);
    expect(evidence.execution?.producedFiles).toEqual(["critic-owned.txt"]);
    expect(evidence.findings[0]).toMatchObject({
      severity: "error",
      rule: "critic-policy-denied"
    });
  });

  it("keeps an advisory non-zero critic non-blocking when no policy boundary is crossed", async () => {
    const root = repository("process.exit(2);\n");
    const evidence = await new CriticRunner("node critic.js", 2_000).review({
      root,
      phase,
      contract,
      changedFiles: [],
      diff: ""
    }, false);
    expect(evidence.passed).toBe(true);
    expect(evidence.policyViolations).toEqual([]);
    expect(evidence.findings[0]?.rule).toBe("critic-command-failed");
  });
});
