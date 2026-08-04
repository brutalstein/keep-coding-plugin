import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KeepCodingService } from "../src/core/service.js";
import { handleHook } from "../src/hooks/handler.js";

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-hooks-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Hook Test"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "hook test\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

describe("context-injecting hook cursors", () => {
  it("suppresses unchanged delivery per session and resumes after durable progress", async () => {
    const root = repository();
    try {
      const prompt = "Build a production-ready complete modular project with architecture, integrations, tests, documentation, CI, deployment and multiple phases. ".repeat(5);
      const first = await handleHook("UserPromptSubmit", { cwd: root, prompt, runtime: "codex", session_id: "session-a" });
      expect(first.hookSpecificOutput).toBeDefined();

      const unchanged = await handleHook("UserPromptSubmit", { cwd: root, prompt: "continue", runtime: "codex", session_id: "session-a" });
      expect(unchanged).toEqual({ continue: true });

      const service = await KeepCodingService.open(root);
      service.store.recordDecision({ phaseId: null, title: "Preserve delta context", rationale: "Avoid redundant hook payloads", alternatives: [] });
      service.close();

      const changed = await handleHook("UserPromptSubmit", { cwd: root, prompt: "continue", runtime: "codex", session_id: "session-a" });
      const changedContext = changed.hookSpecificOutput as { additionalContext?: string };
      expect(changedContext.additionalContext).toContain("Preserve delta context");
      expect(changedContext.additionalContext).toContain("Unchanged since sequence");

      const otherSession = await handleHook("UserPromptSubmit", { cwd: root, prompt: "continue", runtime: "codex", session_id: "session-b" });
      expect(otherSession.hookSpecificOutput).toBeDefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("records host-provided usage automatically", async () => {
    const root = repository();
    try {
      const prompt = "Build a production-ready complete application with architecture, tests, integration, deployment and phases. ".repeat(5);
      await handleHook("UserPromptSubmit", { cwd: root, prompt, runtime: "codex", session_id: "usage", usage: { input_tokens: 100, output_tokens: 50 } });
      const service = await KeepCodingService.open(root);
      const project = service.store.getProject()!;
      expect(service.store.listBudgetUsage()[`project:${project.id}`]?.tokens).toBeGreaterThanOrEqual(150);
      service.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
