import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionKernel } from "../src/core/execution-kernel.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-kernel-"));
  roots.push(root);
  return root;
}

describe("attested execution kernel", () => {
  it("executes an allowlisted argv command without a shell", async () => {
    const root = project();
    const kernel = await ExecutionKernel.open(root);
    const result = await kernel.execute({
      command: "node --version",
      cwd: root,
      purpose: "acceptance",
      writeScopes: []
    });
    expect(result.passed).toBe(true);
    expect(result.stdout).toMatch(/^v\d+/u);
    expect(result.spec).toMatchObject({ executable: "node", argv: ["--version"] });
    expect(result.attestation).toMatchObject({
      version: 1,
      backend: "process",
      purpose: "acceptance",
      policySource: "builtin",
      outputLimitExceeded: false,
      producedFiles: []
    });
    expect(result.attestation.capabilities).toContain("shell-free");
    expect(result.attestation.executableSha256).toHaveLength(64);
    expect(result.attestation.commandSpecHash).toHaveLength(64);
    expect(result.attestation.policyHash).toHaveLength(64);
  });

  it("rejects shell syntax and non-allowlisted executables before spawning", async () => {
    const root = project();
    const kernel = await ExecutionKernel.open(root);
    const shell = await kernel.execute({
      command: "node --version && node --version",
      cwd: root,
      purpose: "acceptance",
      writeScopes: []
    });
    expect(shell.passed).toBe(false);
    expect(shell.attestation.backend).toBe("denied");
    expect(shell.policyViolations.join("\n")).toMatch(/COMMAND_SPEC_SHELL_SYNTAX/u);

    const executable = await kernel.execute({
      command: "echo hello",
      cwd: root,
      purpose: "acceptance",
      writeScopes: []
    });
    expect(executable.passed).toBe(false);
    expect(executable.policyViolations).toContain("EXECUTION_EXECUTABLE_DENIED: echo");
  });

  it("does not expose unapproved host secrets to child processes", async () => {
    const root = project();
    const kernel = await ExecutionKernel.open(root, {
      ...process.env,
      KEEP_CODING_TEST_SECRET: "sensitive-value"
    });
    const result = await kernel.execute({
      command: 'node -p "process.env.KEEP_CODING_TEST_SECRET || \'missing\'"',
      cwd: root,
      purpose: "acceptance",
      writeScopes: []
    });
    expect(result.passed).toBe(true);
    expect(result.stdout.trim()).toBe("missing");
    expect(result.attestation.environmentKeys).not.toContain("KEEP_CODING_TEST_SECRET");
  });

  it("kills a timed-out process group and records the timeout", async () => {
    const root = project();
    writeFileSync(path.join(root, "hang.js"), "setInterval(() => {}, 1000);\n");
    const kernel = await ExecutionKernel.open(root);
    const result = await kernel.execute({
      command: "node hang.js",
      cwd: root,
      purpose: "acceptance",
      writeScopes: [],
      timeoutMs: 50
    });
    expect(result.passed).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(2_000);
  });

  it.runIf(process.platform !== "win32")("rejects repository-controlled PATH shadowing", async () => {
    const root = project();
    const fakeNode = path.join(root, "node");
    writeFileSync(fakeNode, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeNode, 0o755);
    const kernel = await ExecutionKernel.open(root, {
      ...process.env,
      PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`
    });
    const result = await kernel.execute({
      command: "node --version",
      cwd: root,
      purpose: "acceptance",
      writeScopes: []
    });
    expect(result.passed).toBe(false);
    expect(result.policyViolations).toContain("EXECUTION_EXECUTABLE_DENIED: node");
  });

  it("enforces an operator-owned exact command set", async () => {
    const root = project();
    const policyRoot = mkdtempSync(path.join(tmpdir(), "keep-coding-exact-command-policy-"));
    roots.push(policyRoot);
    const policyPath = path.join(policyRoot, "policy.json");
    writeFileSync(policyPath, JSON.stringify({
      version: 1,
      allowedExecutables: ["node"],
      allowedCommands: ["node --version"],
      sandbox: "process",
      network: "inherit",
      projectWrites: "deny"
    }));
    const kernel = await ExecutionKernel.open(root, {
      ...process.env,
      KEEP_CODING_EXECUTION_POLICY_PATH: policyPath
    });
    expect((await kernel.execute({
      command: "node --version",
      cwd: root,
      purpose: "acceptance",
      writeScopes: []
    })).passed).toBe(true);
    const denied = await kernel.execute({
      command: 'node -p "1 + 1"',
      cwd: root,
      purpose: "acceptance",
      writeScopes: []
    });
    expect(denied.passed).toBe(false);
    expect(denied.policyViolations).toContain(
      "EXECUTION_COMMAND_DENIED: command is not present in the operator policy"
    );
  });

  it("fails closed when operator-required isolation is unavailable", async () => {
    const root = project();
    const policyRoot = mkdtempSync(path.join(tmpdir(), "keep-coding-kernel-policy-"));
    roots.push(policyRoot);
    const policyPath = path.join(policyRoot, "policy.json");
    writeFileSync(policyPath, JSON.stringify({
      version: 1,
      allowedExecutables: ["node"],
      sandbox: "process",
      network: "deny",
      projectWrites: "deny",
      requiredCapabilities: ["shell-free", "network-denied"],
      maxTimeoutMs: 1_000,
      maxOutputBytes: 4_096
    }));
    const kernel = await ExecutionKernel.open(root, {
      ...process.env,
      KEEP_CODING_EXECUTION_POLICY_PATH: policyPath
    });
    const result = await kernel.execute({
      command: "node --version",
      cwd: root,
      purpose: "acceptance",
      writeScopes: []
    });
    expect(result.passed).toBe(false);
    expect(result.attestation.backend).toBe("denied");
    expect(result.policyViolations.join("\n")).toMatch(
      /EXECUTION_CAPABILITY_UNAVAILABLE|EXECUTION_NETWORK_ISOLATION_UNAVAILABLE/u
    );
  });
});
