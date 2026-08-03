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
    expect(adapter.normalizeEvent("unknown")).toBeNull();
    expect(adapter.continue()).toEqual({ continue: true });
    expect(adapter.injectContext("SessionStart", "context")).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "context" }
    });
    expect(adapter.blockStop("continue")).toEqual({ decision: "block", reason: "continue" });
  });

  it("supports Claude-style and generic polling runtimes", () => {
    const claude = new ClaudeCodeContinuityAdapter();
    expect(claude.normalizeEvent("post-compact")).toBe("post_compact");
    expect(claude.normalizeEvent("unknown")).toBeNull();
    expect(claude.continue()).toEqual({});
    expect(claude.injectContext("session-start", "state")).toEqual({ additionalContext: "state" });
    expect(claude.blockStop("approval required")).toEqual({ continue: false, reason: "approval required" });

    const polling = new PollingContinuityAdapter();
    expect(polling.normalizeEvent("poll")).toBe("poll");
    expect(polling.normalizeEvent("stop")).toBeNull();
    expect(polling.continue()).toEqual({ active: false });
    expect(polling.injectContext("poll", "state")).toEqual({ active: true, context: "state" });
    expect(polling.blockStop("keep working")).toEqual({ active: true, reason: "keep working" });
  });

  it("selects every supported runtime alias", () => {
    expect(continuityAdapter("codex").id).toBe("codex");
    expect(continuityAdapter("claude").id).toBe("claude-code");
    expect(continuityAdapter("claude-code").id).toBe("claude-code");
    expect(continuityAdapter("poll").id).toBe("generic-polling");
    expect(continuityAdapter("generic").id).toBe("generic-polling");
  });

  it("rejects unknown runtimes", () => {
    expect(() => continuityAdapter("unknown")).toThrow(/unsupported/);
  });
});
