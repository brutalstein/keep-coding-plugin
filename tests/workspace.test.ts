import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KeepCodingService } from "../src/core/service.js";
import { extractPatchPaths } from "../src/core/workspace.js";

function createRepository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-workspace-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "app.ts"), "export const value = 1;\n");
  writeFileSync(path.join(root, ".gitignore"), ".keep-coding/\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Keep Coding Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

describe("remote workspace tools", () => {
  it("reads, searches, patches only active phase scope, and checkpoints", async () => {
    const root = createRepository();
    const service = await KeepCodingService.open(root);
    try {
      await service.initialize("Update the source value and verify the repository without leaving the declared scope.");
      service.savePlan({
        goal: "Update the source value through a verified remote workspace phase.",
        nonGoals: [],
        constraints: ["Only src/** may change"],
        deliverables: ["Updated source"],
        invariants: ["Keep the repository valid"],
        doneWhen: ["git diff --check passes"]
      }, [{
        id: "update-source",
        title: "Update source",
        goal: "Change the exported value",
        dependencies: [],
        allowedScope: ["src/**"],
        acceptanceCommands: ["git diff --check"],
        maxAttempts: 2
      }]);
      await service.startPhase("update-source");

      await expect(service.workspace.listFiles()).resolves.toMatchObject({ files: expect.arrayContaining(["src/app.ts"]) });
      await expect(service.workspace.readTextFile("src/app.ts", 1, 1)).resolves.toMatchObject({ content: "1: export const value = 1;" });
      await expect(service.workspace.searchCode("value")).resolves.toMatchObject({
        matches: [{ path: "src/app.ts", line: 1, text: "export const value = 1;" }]
      });

      const patch = [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1 +1 @@",
        "-export const value = 1;",
        "+export const value = 2;",
        ""
      ].join("\n");
      await expect(service.workspace.applyPatch("update-source", patch)).resolves.toMatchObject({
        applied: true,
        files: ["src/app.ts"]
      });
      await expect(service.workspace.diff()).resolves.toMatchObject({
        diff: expect.stringContaining("export const value = 2;")
      });

      const outOfScope = [
        "diff --git a/README.md b/README.md",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/README.md",
        "@@ -0,0 +1 @@",
        "+outside",
        ""
      ].join("\n");
      await expect(service.workspace.applyPatch("update-source", outOfScope)).rejects.toThrow("outside phase scope");
      await expect(service.workspace.readTextFile("../outside.txt")).rejects.toThrow("invalid repository path");

      const checkpoint = await service.checkpoint("update-source", "Updated the source value");
      expect(checkpoint).toMatchObject({ phase: { status: "COMPLETED" }, evidence: { passed: true } });
    } finally {
      service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symlink escapes and protected metadata paths", async () => {
    const root = createRepository();
    const outside = mkdtempSync(path.join(tmpdir(), "keep-coding-outside-"));
    writeFileSync(path.join(outside, "secret.txt"), "secret\n");
    if (process.platform === "win32") {
      symlinkSync(path.join(outside, "secret.txt"), path.join(root, "src", "escape.txt"), "file");
    } else {
      symlinkSync(path.join(outside, "secret.txt"), path.join(root, "src", "escape.txt"));
    }
    const service = await KeepCodingService.open(root);
    try {
      await expect(service.workspace.readTextFile("src/escape.txt")).rejects.toThrow("path escapes repository");
      expect(() => extractPatchPaths("--- a/.git/config\n+++ b/.git/config\n")).toThrow("invalid repository path");
      expect(() => extractPatchPaths("--- a/.keep-coding/state.db\n+++ b/.keep-coding/state.db\n")).toThrow("invalid repository path");
    } finally {
      service.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
