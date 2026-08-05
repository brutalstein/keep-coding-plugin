import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCommandSpec } from "../src/core/command-spec.js";
import {
  commandAllowed,
  defaultExecutionPolicy,
  executableAllowed,
  loadExecutionPolicy,
  operatorAllowsWrite
} from "../src/core/execution-policy.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function directory(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function policyFile(document: unknown): { projectRoot: string; policyPath: string } {
  const projectRoot = directory("keep-coding-policy-coverage-project-");
  const policyRoot = directory("keep-coding-policy-coverage-owner-");
  const policyPath = path.join(policyRoot, "policy.json");
  writeFileSync(policyPath, typeof document === "string" ? document : JSON.stringify(document));
  return { projectRoot, policyPath };
}

describe("execution policy fail-closed branches", () => {
  it("rejects relative policy paths before filesystem access", async () => {
    await expect(loadExecutionPolicy(directory("keep-coding-relative-policy-"), {
      KEEP_CODING_EXECUTION_POLICY_PATH: "relative/policy.json"
    })).rejects.toThrow(/EXECUTION_POLICY_PATH_INVALID/u);
  });

  it("rejects invalid JSON with a preserved parse cause", async () => {
    const fixture = policyFile("{not-json");
    await expect(loadExecutionPolicy(fixture.projectRoot, {
      KEEP_CODING_EXECUTION_POLICY_PATH: fixture.policyPath
    })).rejects.toThrow(/EXECUTION_POLICY_PARSE_FAILED/u);
  });

  it("rejects a policy path that is not a regular file", async () => {
    const projectRoot = directory("keep-coding-directory-policy-project-");
    const policyPath = directory("keep-coding-directory-policy-");
    await expect(loadExecutionPolicy(projectRoot, {
      KEEP_CODING_EXECUTION_POLICY_PATH: policyPath
    })).rejects.toThrow(/policy path must reference a regular file/u);
  });

  it.each([
    [{ version: 2, allowedExecutables: ["node"] }, /version must be exactly 1/u],
    [{ version: 1, allowedExecutables: [] }, /allowedExecutables must not be empty/u],
    [{ version: 1, allowedExecutables: [" node"] }, /non-empty trimmed strings/u],
    [{ version: 1, allowedExecutables: ["node"], sandbox: "vm" }, /sandbox must be one of/u],
    [{ version: 1, allowedExecutables: ["node"], network: "sometimes" }, /network must be one of/u],
    [{ version: 1, allowedExecutables: ["node"], projectWrites: "all" }, /projectWrites must be one of/u],
    [{ version: 1, allowedExecutables: ["node"], allowProjectExecutables: "yes" }, /must be a boolean/u],
    [{ version: 1, allowedExecutables: ["node"], maxTimeoutMs: 0 }, /positive integer/u],
    [{ version: 1, allowedExecutables: ["node"], maxOutputBytes: 1.5 }, /positive integer/u],
    [{ version: 1, allowedExecutables: ["node"], fixedEnvironment: { "": "bad" } }, /fixedEnvironment/u],
    [{ version: 1, allowedExecutables: ["node"], allowedCommands: ["node --version | cat"] }, /EXECUTION_POLICY_COMMAND_INVALID/u]
  ])("rejects invalid policy schema %#", async (document, pattern) => {
    const fixture = policyFile(document);
    await expect(loadExecutionPolicy(fixture.projectRoot, {
      KEEP_CODING_EXECUTION_POLICY_PATH: fixture.policyPath
    })).rejects.toThrow(pattern);
  });

  it("supports absolute executable authority and explicit project executable authority", () => {
    const builtin = defaultExecutionPolicy();
    const absolute = { ...builtin, allowedExecutables: ["/usr/bin/node"] };
    expect(executableAllowed(absolute, "node", "/usr/bin/node", "/work/project")).toBe(true);
    expect(executableAllowed(absolute, "node", "/usr/local/bin/node", "/work/project")).toBe(false);

    const projectEnabled = {
      ...builtin,
      allowedExecutables: ["tool"],
      allowProjectExecutables: true
    };
    expect(executableAllowed(projectEnabled, "tool", "/work/project/bin/tool", "/work/project")).toBe(true);
    expect(executableAllowed(builtin, "node", "/work/project/node", "/work/project")).toBe(false);
  });

  it("treats an empty exact command list as unrestricted and a populated list as exact", () => {
    const builtin = defaultExecutionPolicy();
    expect(commandAllowed(builtin, parseCommandSpec("node --version"))).toBe(true);
    const exact = {
      ...builtin,
      allowedCommandHashes: [
        (await import("../src/core/command-spec.js")).commandSpecHash(parseCommandSpec("node --version"))
      ]
    };
    expect(commandAllowed(exact, parseCommandSpec("node --version"))).toBe(true);
    expect(commandAllowed(exact, parseCommandSpec('node -p "1"'))).toBe(false);
  });

  it("applies deny and minimatch operator write policies", () => {
    const builtin = defaultExecutionPolicy();
    expect(operatorAllowsWrite(builtin, "src/main.ts")).toBe(true);
    expect(operatorAllowsWrite({ ...builtin, projectWrites: "deny" }, "src/main.ts")).toBe(false);
    expect(operatorAllowsWrite({
      ...builtin,
      allowedWriteScopes: ["src/generated/**"]
    }, "src/generated/output.ts")).toBe(true);
    expect(operatorAllowsWrite({
      ...builtin,
      allowedWriteScopes: ["src/generated/**"]
    }, "src/main.ts")).toBe(false);
  });

  it.runIf(process.platform !== "win32")("accepts a private POSIX policy file", async () => {
    const fixture = policyFile({ version: 1, allowedExecutables: ["node"] });
    chmodSync(fixture.policyPath, 0o600);
    await expect(loadExecutionPolicy(fixture.projectRoot, {
      KEEP_CODING_EXECUTION_POLICY_PATH: fixture.policyPath
    })).resolves.toMatchObject({ source: fixture.policyPath });
  });

  it("rejects an inside-repository policy even through a nested directory", async () => {
    const projectRoot = directory("keep-coding-nested-policy-project-");
    const nested = path.join(projectRoot, "config", "security");
    mkdirSync(nested, { recursive: true });
    const policyPath = path.join(nested, "policy.json");
    writeFileSync(policyPath, JSON.stringify({ version: 1, allowedExecutables: ["node"] }));
    await expect(loadExecutionPolicy(projectRoot, {
      KEEP_CODING_EXECUTION_POLICY_PATH: policyPath
    })).rejects.toThrow(/EXECUTION_POLICY_TRUST_BOUNDARY/u);
  });
});
