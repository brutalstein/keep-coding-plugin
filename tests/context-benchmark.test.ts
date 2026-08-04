import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileContextEnvelope } from "../src/core/context.js";
import { PlatformStore } from "../src/storage/platform-store.js";

describe("context payload benchmark", () => {
  it("measures unchanged and decision-only payload reduction", () => {
    const root = mkdtempSync(path.join(tmpdir(), "keep-coding-benchmark-"));
    const store = new PlatformStore(root);
    try {
      store.initialize("Build a representative multi-phase production system with a large semantic graph.");
      store.savePlan(
        {
          goal: "Deliver a representative multi-phase production system.",
          nonGoals: [],
          constraints: ["Node 22", "preserve evidence gates", "bounded workspace access"],
          deliverables: ["runtime", "tests", "documentation", "CI"],
          invariants: ["scope enforcement", "secret scanning", "budget checks", "critic review"],
          doneWhen: ["all tests pass", "compiled artifact executes"],
          budget: { maxTokens: 50_000 }
        },
        Array.from({ length: 12 }, (_, index) => ({
          id: `phase-${index}`,
          title: `Phase ${index}`,
          goal: `Implement subsystem ${index}`,
          dependencies: index === 0 ? [] : [`phase-${index - 1}`],
          allowedScope: [`src/subsystem-${index}/**`],
          acceptanceCommands: [`npm run test -- subsystem-${index}`],
          maxAttempts: 3
        }))
      );
      for (let index = 0; index < 250; index += 1) {
        store.upsertGraphNode({
          id: `symbol:src/subsystem-0/file-${index}.ts:function:symbol${index}`,
          type: "symbol",
          label: `symbol${index}`,
          path: `src/subsystem-0/file-${index}.ts`,
          symbol: `symbol${index}`,
          contentHash: null,
          metadata: { kind: "function", line: index + 1 }
        });
      }

      const full = compileContextEnvelope(store);
      expect(full.unchanged).toBe(false);
      if (full.unchanged) return;
      const unchanged = compileContextEnvelope(store, { sinceSequence: full.sequence });
      store.recordDecision({
        phaseId: "phase-0",
        title: "Use delta context",
        rationale: "Avoid retransmitting unchanged durable sections.",
        alternatives: ["Send the full snapshot every time"]
      });
      const delta = compileContextEnvelope(store, { sinceSequence: full.sequence });
      expect(delta.unchanged).toBe(false);
      if (delta.unchanged) return;

      const fullBytes = Buffer.byteLength(full.context);
      const unchangedBytes = Buffer.byteLength(JSON.stringify(unchanged));
      const deltaBytes = Buffer.byteLength(delta.context);
      const unchangedReduction = 1 - unchangedBytes / fullBytes;
      const deltaReduction = 1 - deltaBytes / fullBytes;
      console.log(`CONTEXT_BENCHMARK full=${fullBytes}B unchanged=${unchangedBytes}B delta=${deltaBytes}B unchanged_reduction=${(unchangedReduction * 100).toFixed(1)}% delta_reduction=${(deltaReduction * 100).toFixed(1)}%`);

      expect(unchanged).toEqual({ unchanged: true, sequence: full.sequence });
      expect(delta.changedSections).toEqual(["decisions"]);
      expect(delta.unchangedSections).toContain("contract");
      expect(unchangedReduction).toBeGreaterThan(0.9);
      expect(deltaReduction).toBeGreaterThan(0.5);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
