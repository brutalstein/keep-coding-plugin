import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitRepository } from "../src/core/git.js";
import { compressCommandOutput, PhaseVerifier, stripCommandNoise } from "../src/core/verifier.js";
import type { PhaseRecord, ProjectContract } from "../src/domain/model.js";

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-git-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "a.js"), "export const a = 1;\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

function phase(scope: string[], commands: string[]): PhaseRecord {
  return {
    id: "phase", ordinal: 0, title: "Phase", goal: "Test", status: "IN_PROGRESS",
    dependencies: [], allowedScope: scope, acceptanceCommands: commands, maxAttempts: 3,
    attempts: 0, startedAt: null, completedAt: null, baseSha: null, headSha: null, summary: null
  };
}

const contract: ProjectContract = {
  goal: "Deliver verified code", nonGoals: [], constraints: [], deliverables: ["code"], invariants: [], doneWhen: ["checks pass"]
};
const options = {
  budget: { passed: true, limits: {}, usage: { tokens: 0, costUsd: 0, wallClockMs: 0, updatedAt: "now" }, violations: [] },
  contract
};

describe("phase verifier", () => {
  it("passes scope, selective and command gates", async () => {
    const root = repository();
    try {
      writeFileSync(path.join(root, "src", "a.js"), "export const a = 2;\n");
      const result = await new PhaseVerifier(2_000).verify(
        await GitRepository.open(root), phase(["src/**"], ["node --check src/a.js"]),
        { ...options, selectiveCommands: ["node --check src/a.js"] }
      );
      expect(result.passed).toBe(true);
      expect(result.selectiveCommands).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("blocks secret findings before commands", async () => {
    const root = repository();
    try {
      writeFileSync(path.join(root, "src", "a.js"), "export const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456';\n");
      const result = await new PhaseVerifier().verify(await GitRepository.open(root), phase(["src/**"], ["node --version"]), options);
      expect(result.secretScan.passed).toBe(false);
      expect(result.commands).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("blocks a configured budget violation", async () => {
    const root = repository();
    try {
      writeFileSync(path.join(root, "src", "a.js"), "export const a = 3;\n");
      const result = await new PhaseVerifier().verify(
        await GitRepository.open(root), phase(["src/**"], ["node --version"]),
        { ...options, budget: { ...options.budget, passed: false, violations: ["tokens"] } }
      );
      expect(result.passed).toBe(false);
      expect(result.commands).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("diffs repeated failures into a smaller second payload", () => {
    const common = Array.from({ length: 80 }, (_, index) => `shared setup line ${index}`).join("\n");
    const firstRaw = `${common}\nError: expected old value\nshared footer`;
    const secondRaw = `${common}\nError: expected new value\nshared footer`;
    const first = compressCommandOutput(firstRaw, null, 8_000);
    const second = compressCommandOutput(secondRaw, { output: firstRaw, attempt: 1 }, 8_000);
    expect(second.output).toContain("lines unchanged from attempt 1");
    expect(second.output).toContain("Error: expected new value");
    expect(second.output.length).toBeLessThan(first.output.length / 2);
    expect(second.compression.unchangedLines).toBeGreaterThan(70);
  });

  it("strips noise and preserves actionable marker windows within budget", () => {
    const noise = Array.from({ length: 300 }, (_, index) => `\u001b[31mprogress ${index}\u001b[0m\n    at node:internal/modules/file:${index}`).join("\n");
    const raw = `${noise}\ncontext before\nError: database migration failed at durable checkpoint\ncontext after\n${noise}`;
    const cleaned = stripCommandNoise(raw);
    expect(cleaned).not.toContain("\u001b[");
    expect(cleaned).not.toContain("node:internal");
    const compressed = compressCommandOutput(raw, null, 600);
    expect(compressed.output).toContain("Error: database migration failed");
    expect(compressed.output.length).toBeLessThanOrEqual(600);
    expect(compressed.compression.emittedChars).toBeLessThan(compressed.compression.originalChars);
  });
});
