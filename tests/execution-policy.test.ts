import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExecutionEnvironment,
  defaultExecutionPolicy,
  executableAllowed,
  loadExecutionPolicy,
  missingCapabilities
} from "../src/core/execution-policy.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function directory(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("operator-owned execution policy", () => {
  it("uses a deterministic builtin policy and sanitized environment", () => {
    const policy = defaultExecutionPolicy();
    const environment = buildExecutionEnvironment(policy, "/tmp/isolated-home", {
      PATH: "/usr/bin",
      CI: "true",
      TOP_SECRET: "must-not-leak"
    });
    expect(policy.hash).toHaveLength(64);
    expect(executableAllowed(policy, "node", "/usr/bin/node")).toBe(true);
    expect(executableAllowed(policy, "unknown-tool", "/usr/bin/unknown-tool")).toBe(false);
    expect(environment).toMatchObject({
      PATH: "/usr/bin",
      CI: "true",
      HOME: "/tmp/isolated-home",
      USERPROFILE: "/tmp/isolated-home",
      KEEP_CODING_EXECUTION: "1"
    });
    expect(environment.TOP_SECRET).toBeUndefined();
  });

  it("loads a canonical policy outside the repository with a stable hash", async () => {
    const projectRoot = directory("keep-coding-policy-project-");
    const policyRoot = directory("keep-coding-policy-owner-");
    const policyPath = path.join(policyRoot, "policy.json");
    writeFileSync(policyPath, JSON.stringify({
      version: 1,
      allowedExecutables: ["node"],
      allowedEnvironment: ["PATH"],
      fixedEnvironment: { CI: "true" },
      sandbox: "process",
      network: "inherit",
      projectWrites: "deny",
      requiredCapabilities: ["shell-free", "write-audited"],
      maxTimeoutMs: 1_000,
      maxOutputBytes: 4_096
    }));
    const first = await loadExecutionPolicy(projectRoot, {
      KEEP_CODING_EXECUTION_POLICY_PATH: policyPath
    });
    const second = await loadExecutionPolicy(projectRoot, {
      KEEP_CODING_EXECUTION_POLICY_PATH: policyPath
    });
    expect(first).toEqual(second);
    expect(first.source).toBe(policyPath);
    expect(first.projectWrites).toBe("deny");
  });

  it("rejects repository-controlled or malformed policy documents", async () => {
    const projectRoot = directory("keep-coding-policy-boundary-");
    mkdirSync(path.join(projectRoot, "config"));
    const inside = path.join(projectRoot, "config", "policy.json");
    writeFileSync(inside, JSON.stringify({ version: 1, allowedExecutables: ["node"] }));
    await expect(loadExecutionPolicy(projectRoot, {
      KEEP_CODING_EXECUTION_POLICY_PATH: inside
    })).rejects.toThrow(/EXECUTION_POLICY_TRUST_BOUNDARY/u);

    const policyRoot = directory("keep-coding-policy-invalid-");
    const malformed = path.join(policyRoot, "policy.json");
    writeFileSync(malformed, JSON.stringify({
      version: 1,
      allowedExecutables: ["node"],
      requiredCapabilities: ["unknown-capability"]
    }));
    await expect(loadExecutionPolicy(projectRoot, {
      KEEP_CODING_EXECUTION_POLICY_PATH: malformed
    })).rejects.toThrow(/unknown required capability/u);
  });

  it("reports capabilities that the selected backend cannot provide", () => {
    const policy = {
      ...defaultExecutionPolicy(),
      requiredCapabilities: ["shell-free", "network-denied", "process-isolated"] as const
    };
    expect(missingCapabilities(policy, ["shell-free", "environment-sanitized"]))
      .toEqual(["network-denied", "process-isolated"]);
  });
});
