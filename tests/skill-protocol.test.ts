import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const text = readFileSync("plugins/keep-coding/skills/keep-coding/SKILL.md", "utf8");

describe("SKILL.md assumption protocol contract", () => {
  it("requires invalidate_assumption instead of apology-and-restart behavior", () => {
    expect(text).toMatch(/invalidate_assumption/);
    expect(text).toMatch(/do not apologize/i);
    expect(text).toMatch(/do not broadly re-read/i);
  });

  it("requires recording uncertainty and justified scope expansion", () => {
    expect(text).toMatch(/record_assumption/);
    expect(text).toMatch(/expand_correction_scope/);
    expect(text).toMatch(/non-empty justification/i);
  });
});
