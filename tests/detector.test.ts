import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectLargeProject } from "../src/core/detector.js";

interface CorpusCase { activate: boolean; prompt: string }
const corpus = JSON.parse(readFileSync(new URL("./fixtures/detector-corpus.json", import.meta.url), "utf8")) as CorpusCase[];

describe("large-project detector", () => {
  it("activates for a multi-part production project", () => {
    const prompt = "Build a production-ready modular application with architecture, integration, tests, deployment and a complete project plan. ".repeat(4);
    expect(detectLargeProject(prompt).activate).toBe(true);
  });

  it("does not activate for a small edit", () => {
    expect(detectLargeProject("Rename this variable.").activate).toBe(false);
  });

  it("maintains bilingual corpus precision and recall", () => {
    const outcomes = corpus.map((item) => ({ expected: item.activate, actual: detectLargeProject(item.prompt).activate }));
    const truePositive = outcomes.filter((item) => item.expected && item.actual).length;
    const falsePositive = outcomes.filter((item) => !item.expected && item.actual).length;
    const falseNegative = outcomes.filter((item) => item.expected && !item.actual).length;
    const precision = truePositive / Math.max(1, truePositive + falsePositive);
    const recall = truePositive / Math.max(1, truePositive + falseNegative);
    expect(precision).toBeGreaterThanOrEqual(0.85);
    expect(recall).toBeGreaterThanOrEqual(0.85);
  });

  it("labels confidence as heuristic strength rather than probability", () => {
    const weak = detectLargeProject("Create a button label.");
    const strong = detectLargeProject("Build a complete production-ready architecture with tests, CI, deployment and phases.");
    expect(weak.confidence).toBeLessThan(0.5);
    expect(strong.confidence).toBeGreaterThanOrEqual(0.55);
  });
});
