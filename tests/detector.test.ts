import { afterEach, describe, expect, it } from "vitest";
import { detectLargeProject } from "../src/core/detector.js";

afterEach(() => {
  delete process.env.KEEP_CODING_ACTIVATE;
  delete process.env.KEEP_CODING_DISABLE;
});

describe("large-project detector", () => {
  it("activates with an explainable confidence score", () => {
    const prompt = "Build a production-ready modular application with architecture, integration, tests, deployment and a complete project plan. ".repeat(4);
    const result = detectLargeProject(prompt);
    expect(result.activate).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.52);
    expect(result.signals.length).toBeGreaterThan(2);
    expect(result.reasons.join(" ")).toContain("project_scale_language");
  });

  it("does not activate for a small edit", () => {
    const result = detectLargeProject("Rename this variable.");
    expect(result.activate).toBe(false);
    expect(result.confidence).toBeLessThan(0.52);
  });

  it("supports explicit activation and disable overrides", () => {
    expect(detectLargeProject("Rename this variable.", { force: true })).toMatchObject({ activate: true, manualOverride: "activate" });
    expect(detectLargeProject("Build a production-ready architecture with tests and deployment.", { force: false })).toMatchObject({ activate: false, manualOverride: "disable" });
    process.env.KEEP_CODING_ACTIVATE = "1";
    expect(detectLargeProject("tiny").activate).toBe(true);
  });
});
