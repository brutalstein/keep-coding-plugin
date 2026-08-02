import { describe, expect, it } from "vitest";
import { exactMcNemar, summarizeOutcomes, wilson95 } from "../src/eval/statistics.js";

describe("paired evaluation statistics", () => {
  it("computes paired rates, delta and exact McNemar", () => {
    const result = summarizeOutcomes([
      { baseline: false, keepCoding: true },
      { baseline: false, keepCoding: true },
      { baseline: true, keepCoding: true },
      { baseline: false, keepCoding: false }
    ]);
    expect(result.baselineRate).toBe(0.25);
    expect(result.keepCodingRate).toBe(0.75);
    expect(result.absoluteDelta).toBe(0.5);
    expect(result.mcnemarExactP).toBe(0.5);
  });

  it("bounds confidence intervals", () => {
    expect(wilson95(0, 10)[0]).toBe(0);
    expect(wilson95(10, 10)[1]).toBe(1);
    expect(exactMcNemar(0, 0)).toBe(1);
  });
});

