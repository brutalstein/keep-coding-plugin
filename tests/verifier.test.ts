import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitRepository } from "../src/core/git.js";
import { PhaseVerifier } from "../src/core/verifier.js";
import type { PhaseRecord } from "../src/domain/model.js";

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
  return { id: "phase", ordinal: 0, title: "Phase", goal: "Test", status: "IN_PROGRESS", dependencies: [], allowedScope: scope, acceptanceCommands: commands, maxAttempts: 3, attempts: 0, startedAt: null, completedAt: null, baseSha: null, headSha: null, summary: null };
}

describe("phase verifier", () => {
  it("passes matching scope and commands", async () => {
    const root = repository();
    writeFileSync(path.join(root, "src", "a.js"), "export const a = 2;\n");
    const result = await new PhaseVerifier(2_000).verify(await GitRepository.open(root), phase(["src/**"], ["node --check src/a.js"]));
    expect(result.passed).toBe(true);
    expect(result.secretScan).toMatchObject({ passed: true, findings: [] });
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects changes outside scope before commands", async () => {
    const root = repository();
    writeFileSync(path.join(root, "README.md"), "changed\n");
    const result = await new PhaseVerifier().verify(await GitRepository.open(root), phase(["src/**"], ["node --version"]));
    expect(result.scopeViolations).toEqual(["README.md"]);
    expect(result.commands).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("blocks a checkpoint containing a secret before commands execute", async () => {
    const root = repository();
    writeFileSync(path.join(root, "src", "a.js"), "export const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456';\n");
    const result = await new PhaseVerifier().verify(await GitRepository.open(root), phase(["src/**"], ["node --version"]));
    expect(result.passed).toBe(false);
    expect(result.secretScan.passed).toBe(false);
    expect(result.secretScan.findings).toEqual([
      expect.objectContaining({ ruleId: "github-token", file: "src/a.js", line: 1 })
    ]);
    expect(result.secretScan.findings[0]?.preview).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(result.commands).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("scans untracked files and ignores ordinary source text", async () => {
    const root = repository();
    writeFileSync(path.join(root, "src", "new.js"), "export const message = 'ordinary text';\n");
    const result = await new PhaseVerifier().verify(await GitRepository.open(root), phase(["src/**"], ["node --check src/new.js"]));
    expect(result.passed).toBe(true);
    expect(result.secretScan.scannedFiles).toContain("src/new.js");
    rmSync(root, { recursive: true, force: true });
  });
});
