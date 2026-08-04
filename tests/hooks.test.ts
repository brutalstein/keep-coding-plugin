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

describe("apology-language correction nudge", () => {
  it("injects a nudge when English apology language has no correction", async () => {
    const root = repository();
    try {
      const service = await KeepCodingService.open(root);
      await service.initialize("Build a precise feature");
      service.close();
      const response = await handleHook("Stop", { cwd: root, runtime: "polling-cli", transcript_tail: "sorry, I misunderstood the requirement" });
      const output = response.hookSpecificOutput as { additionalContext?: string };
      expect(output.additionalContext).toContain("invalidate_assumption");
      expect(response.decision).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not inject the nudge after invalidate_assumption was recorded", async () => {
    const root = repository();
    try {
      const service = await KeepCodingService.open(root);
      await service.initialize("Build a precise feature");
      const id = service.recordAssumption(null, "README describes CSV", 0.5, []).assumption_id;
      service.invalidateAssumption(id, "It must describe JSON");
      service.close();
      const response = await handleHook("Stop", { cwd: root, runtime: "polling-cli", transcript_tail: "sorry, I misunderstood" });
      const output = response.hookSpecificOutput as { additionalContext?: string };
      expect(output.additionalContext).not.toContain("invalidate_assumption");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("recognizes Turkish apology language equivalently", async () => {
    const root = repository();
    try {
      const service = await KeepCodingService.open(root);
      await service.initialize("Build a precise feature");
      service.close();
      const response = await handleHook("Stop", { cwd: root, runtime: "polling-cli", transcript_tail: "özür dilerim, yanlış anlamışım" });
      const output = response.hookSpecificOutput as { additionalContext?: string };
      expect(output.additionalContext).toContain("invalidate_assumption");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("never changes a continuing Stop directive into a hard block", async () => {
    const root = repository();
    try {
      const service = await KeepCodingService.open(root);
      await service.initialize("Build a precise feature");
      service.close();
      const response = await handleHook("Stop", { cwd: root, runtime: "polling-cli", transcript_tail: "I apologize, wrong interpretation, start over" });
      expect(response.continue).toBe(true);
      expect(response.decision).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
