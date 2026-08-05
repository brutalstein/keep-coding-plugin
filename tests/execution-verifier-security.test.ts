import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionKernel, type KernelCommandEvidence } from "../src/core/execution-kernel.js";
import { GitRepository } from "../src/core/git.js";
import { PhaseVerifier } from "../src/core/verifier.js";
import type { PhaseRecord, ProjectContract } from "../src/domain/model.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function repository(script: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-verifier-security-"));
  roots.push(root);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "main.js"), "export const ready = false;\n");
  writeFileSync(path.join(root, "verify.js"), script);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  writeFileSync(path.join(root, "src", "main.js"), "export const ready = true;\n");
  return root;
}

function phase(command: string): PhaseRecord {
  return {
    id: "implementation",
    ordinal: 0,
    title: "Implementation",
    goal: "Enable module",
    status: "IN_PROGRESS",
    dependencies: [],
    allowedScope: ["src/**"],
    acceptanceCommands: [command],
    maxAttempts: 3,
    attempts: 0,
    startedAt: null,
    completedAt: null,
    baseSha: null,
    headSha: null,
    summary: null
  };
}

const contract: ProjectContract = {
  goal: "Deliver verified code",
  nonGoals: [],
  constraints: [],
  deliverables: ["code"],
  invariants: [],
  doneWhen: ["checks pass"]
};
const options = {
  budget: {
    passed: true,
    limits: {},
    usage: { tokens: 0, costUsd: 0, wallClockMs: 0, updatedAt: "now" },
    violations: []
  },
  contract
};

describe("verifier execution boundaries", () => {
  it("rejects files produced outside the phase scope", async () => {
    const root = repository("require('node:fs').writeFileSync('outside.txt', 'created');\n");
    const result = await new PhaseVerifier(2_000).verify(
      await GitRepository.open(root),
      phase("node verify.js"),
      options
    );
    expect(result.passed).toBe(false);
    expect(result.scopeViolations).toContain("outside.txt");
    expect(result.commands[0]?.stderr).toMatch(/EXECUTION_WRITE_SCOPE_VIOLATION/u);
  });

  it("rejects writes allowed by the phase but denied by operator policy", async () => {
    const root = repository("require('node:fs').writeFileSync('src/operator-denied.js', 'created');\n");
    mkdirSync(path.join(root, "src", "generated"));
    const policyRoot = mkdtempSync(path.join(tmpdir(), "keep-coding-write-policy-"));
    roots.push(policyRoot);
    const policyPath = path.join(policyRoot, "policy.json");
    writeFileSync(policyPath, JSON.stringify({
      version: 1,
      allowedExecutables: ["node"],
      sandbox: "process",
      network: "inherit",
      projectWrites: "phase",
      allowedWriteScopes: ["src/generated/**"]
    }));
    const kernel = await ExecutionKernel.open(root, {
      ...process.env,
      KEEP_CODING_EXECUTION_POLICY_PATH: policyPath
    });
    const result = await new PhaseVerifier(2_000).verify(
      await GitRepository.open(root),
      phase("node verify.js"),
      { ...options, executionKernel: kernel }
    );
    expect(result.scopeViolations).toEqual([]);
    expect(result.commands[0]?.stderr).toMatch(/EXECUTION_WRITE_SCOPE_VIOLATION.*src\/operator-denied\.js/u);
    expect(result.passed).toBe(false);
  });

  it("rescans secrets produced by a passing command", async () => {
    const root = repository(
      "require('node:fs').writeFileSync('src/generated.js', \"export const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456';\\n\");\n"
    );
    const result = await new PhaseVerifier(2_000).verify(
      await GitRepository.open(root),
      phase("node verify.js"),
      options
    );
    expect(result.commands[0]?.exitCode).toBe(0);
    expect(result.secretScan.passed).toBe(false);
    expect(result.secretScan.scannedFiles).toContain("src/generated.js");
    expect(result.passed).toBe(false);
  });

  it("persists execution attestation for successful gates", async () => {
    const root = repository("process.stdout.write('verified');\n");
    const result = await new PhaseVerifier(2_000).verify(
      await GitRepository.open(root),
      phase("node verify.js"),
      options
    );
    expect(result.passed).toBe(true);
    const command = result.commands[0] as KernelCommandEvidence | undefined;
    expect(command).toBeDefined();
    if (!command) throw new Error("command evidence missing");
    expect(command.policyViolations).toEqual([]);
    expect(command.attestation.backend).toBe("process");
    expect(command.attestation.inputTreeHash).not.toBeNull();
    expect(command.attestation.inputTreeHash).toHaveLength(64);
    expect(command.attestation.commandSpecHash).toHaveLength(64);
    expect(command.attestation.policyHash).toHaveLength(64);
    expect(command.attestation.executableSha256).toHaveLength(64);
  });
});
