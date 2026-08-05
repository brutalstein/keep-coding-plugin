import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordCommandOutputUsage } from "../src/core/checkpoint.js";
import { KeepCodingService } from "../src/core/service.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

async function service(): Promise<KeepCodingService> {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-telemetry-"));
  roots.push(root);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "main.js"), "export const ready = true;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return KeepCodingService.open(root);
}

describe("command output telemetry fallback", () => {
  it("is a no-op before durable project initialization and for empty output", async () => {
    const instance = await service();
    try {
      recordCommandOutputUsage(instance.store, null, [{ stdout: "unowned output", stderr: "" }]);
      recordCommandOutputUsage(instance.store, null, [{ stdout: "", stderr: "" }]);
      expect(instance.store.listBudgetUsage()).toEqual({});
    } finally {
      instance.close();
    }
  });

  it("records receipt-free project usage without inventing phase usage", async () => {
    const instance = await service();
    try {
      const project = instance.store.initialize("Measure standalone verifier output");
      recordCommandOutputUsage(instance.store, null, [{ stdout: "12345678", stderr: "" }]);
      expect(instance.store.listBudgetUsage()).toEqual({
        [`project:${project.id}`]: expect.objectContaining({
          tokens: 2,
          estimatedTokens: 2
        })
      });
    } finally {
      instance.close();
    }
  });
});
