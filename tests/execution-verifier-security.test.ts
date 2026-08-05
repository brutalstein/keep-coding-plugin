import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    const command = result.commands[0] as unknown as {
      attestation: {
        backend: string;
        commandSpecHash: string;
        policyHash: string;
        executableSha256: string;
        inputTreeHash: string;
      };
      policyViolations: string[];
    };
    expect(command.policyViolations).toEqual([]);
    expect(command.attestation).toMatchObject({
      backend: "process",
      inputTreeHash: expect.any(String)
    });
    expect(command.attestation.commandSpecHash).toHaveLength(64);
    expect(command.attestation.policyHash).toHaveLength(64);
    expect(command.attestation.executableSha256).toHaveLength(64);
  });
});
