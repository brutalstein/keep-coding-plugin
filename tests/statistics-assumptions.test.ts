import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { summarizeAssumptionLedger } from "../src/eval/statistics.js";
import { PlatformStore } from "../src/storage/platform-store.js";

describe("assumption ledger evaluation metrics", () => {
  it("computes containment rate and a Wilson interval from mixed outcomes", () => {
    const result = summarizeAssumptionLedger({
      corrections: [
        ...Array.from({ length: 7 }, () => ({ outcome: "contained" as const, tokenStart: 0, tokenEnd: 10 })),
        ...Array.from({ length: 3 }, () => ({ outcome: "expanded" as const, tokenStart: 0, tokenEnd: 20 }))
      ],
      antiPatternHits: 4,
      matchingSituations: 5
    });
    expect(result).toMatchObject({
      completedCorrections: 10,
      containedCorrections: 7,
      expandedCorrections: 3,
      containmentRate: 0.7,
      antiPatternHitRate: 0.8
    });
    expect(result.containmentWilson95[0]).toBeLessThan(0.7);
    expect(result.containmentWilson95[1]).toBeGreaterThan(0.7);
  });

  it("computes tokens per correction from real project-scoped token records", () => {
    const root = mkdtempSync(path.join(tmpdir(), "keep-coding-eval-tokens-"));
    const store = new PlatformStore(root);
    try {
      const project = store.initialize("Correct an export response assumption");
      store.recordBudgetUsage("project", project.id, { tokens: 100 });
      store.recordBudgetUsage("phase", "phase", { tokens: 999 });
      const assumptionId = store.recordAssumption({ phaseId: null, statement: "Export returns CSV", confidence: 0.5, alternatives: [] });
      const correction = store.invalidateAssumption(assumptionId, "Actual requirement is JSON", 3, store.totalRecordedTokens());
      store.recordBudgetUsage("project", project.id, { tokens: 50 });
      const completed = store.assessCorrectionOutcome(correction.id, [], store.totalRecordedTokens(), true).correction;
      const result = summarizeAssumptionLedger({ corrections: [completed], antiPatternHits: 0, matchingSituations: 0 });
      expect(completed.tokenStart).toBe(100);
      expect(completed.tokenEnd).toBe(150);
      expect(result.totalCorrectionTokens).toBe(50);
      expect(result.tokensPerCorrection).toBe(50);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
