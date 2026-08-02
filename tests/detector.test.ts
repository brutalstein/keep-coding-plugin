import { describe, expect, it } from "vitest";
import { detectLargeProject } from "../src/core/detector.js";

describe("large-project detector", () => {
  it("activates for a multi-part production project", () => {
    const prompt = "Build a production-ready modular application with architecture, integration, tests, deployment and a complete project plan. ".repeat(4);
    expect(detectLargeProject(prompt).activate).toBe(true);
  });

  it("does not activate for a small edit", () => {
    expect(detectLargeProject("Rename this variable.").activate).toBe(false);
  });
});

