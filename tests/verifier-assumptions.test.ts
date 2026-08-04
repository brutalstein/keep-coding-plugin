import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitRepository } from "../src/core/git.js";
import { PhaseVerifier } from "../src/core/verifier.js";
import type { PhaseRecord, ProjectContract } from "../src/domain/model.js";

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-verifier-assumptions-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "a.js"), "export const a = 1;\n");
  writeFileSync(path.join(root, "src", "b.js"), "export const b = 1;\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

function phase(): PhaseRecord {
  return { id: "phase", ordinal: 0, title: "Phase", goal: "Test", status: "IN_PROGRESS", dependencies: [], allowedScope: ["src/**"], acceptanceCommands: ["node --check src/a.js"], maxAttempts: 3, attempts: 0, startedAt: null, completedAt: null, baseSha: null, headSha: null, summary: null };
}
const contract: ProjectContract = { goal: "Deliver verified code", nonGoals: [], constraints: [], deliverables: ["code"], invariants: [], doneWhen: ["checks pass"] };
const budget = { passed: true, limits: {}, usage: { tokens: 0, costUsd: 0, wallClockMs: 0, updatedAt: "now" }, violations: [] };

describe("blast-radius scope narrowing", () => {
  it("rejects a correction edit outside the radius even when phase scope allows it", async () => {
    const root = repository();
    try {
      writeFileSync(path.join(root, "src", "b.js"), "export const b = 2;\n");
      const result = await new PhaseVerifier(2_000).verify(await GitRepository.open(root), phase(), { budget, contract, correctionAllowedFiles: ["src/a.js"] });
      expect(result.passed).toBe(false);
      expect(result.scopeViolations).toContain("src/b.js");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("allows a correction edit inside both phase scope and radius", async () => {
    const root = repository();
    try {
      writeFileSync(path.join(root, "src", "a.js"), "export const a = 2;\n");
      const result = await new PhaseVerifier(2_000).verify(await GitRepository.open(root), phase(), { budget, contract, correctionAllowedFiles: ["src/a.js"] });
      expect(result.passed).toBe(true);
      expect(result.scopeViolations).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
