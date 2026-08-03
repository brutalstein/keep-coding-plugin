import { describe, expect, it } from "vitest";
import {
  ClaudeCodeContinuityAdapter,
  CodexContinuityAdapter,
  PollingContinuityAdapter,
  continuityAdapter
} from "../src/adapters/continuity.js";

describe("continuity adapters", () => {
  it("normalizes Codex lifecycle hooks", () => {
    const adapter = new CodexContinuityAdapter();
    expect(adapter.normalizeEvent("UserPromptSubmit")).toBe("prompt_submit");
    expect(adapter.injectContext("SessionStart", "context")).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "context" }
    });
    expect(adapter.blockStop("continue")).toEqual({ decision: "block", reason: "continue" });
  });

  it("supports Claude-style and generic polling runtimes", () => {
    const claude = new ClaudeCodeContinuityAdapter();
    expect(claude.normalizeEvent("post-compact")).toBe("post_compact");
    expect(claude.injectContext("session-start", "state")).toEqual({ additionalContext: "state" });
    const polling = new PollingContinuityAdapter();
    expect(polling.normalizeEvent("poll")).toBe("poll");
    expect(polling.injectContext("poll", "state")).toEqual({ active: true, context: "state" });
    expect(continuityAdapter("generic").id).toBe("generic-polling");
  });

  it("rejects unknown runtimes", () => {
    expect(() => continuityAdapter("unknown")).toThrow(/unsupported/);
  });
});
