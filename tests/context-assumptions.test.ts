import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileContextEnvelope } from "../src/core/context.js";
import { PlatformStore } from "../src/storage/platform-store.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function subject(): PlatformStore {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-context-assumptions-"));
  roots.push(root);
  const store = new PlatformStore(root);
  store.initialize("Build an export endpoint");
  store.savePlan(
    { goal: "Deliver a tested export endpoint", nonGoals: [], constraints: [], deliverables: ["export"], invariants: [], doneWhen: ["tests pass"] },
    [{ id: "export", title: "Export", goal: "Implement export", dependencies: [], allowedScope: ["src/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 }]
  );
  return store;
}

function add(store: PlatformStore, statement: string, confidence: number): string {
  return store.recordAssumption({ phaseId: "export", statement, confidence, alternatives: [] });
}

describe("assumption context sections", () => {
  it("renders open assumptions sorted by ascending confidence", () => {
    const store = subject();
    try {
      add(store, "High confidence format", 0.8);
      add(store, "Low confidence authentication", 0.3);
      const context = compileContextEnvelope(store);
      expect(context.unchanged).toBe(false);
      const text = context.unchanged ? "" : context.context;
      expect(text.indexOf("Low confidence authentication")).toBeLessThan(text.indexOf("High confidence format"));
    } finally { store.close(); }
  });

  it("renders a directive only for assumptions below the threshold", () => {
    const store = subject();
    try {
      add(store, "Potential CSV format", 0.4);
      add(store, "Confirmed pagination behavior", 0.9);
      const envelope = compileContextEnvelope(store);
      const text = envelope.unchanged ? "" : envelope.context;
      const low = text.slice(text.indexOf("Potential CSV format"), text.indexOf("Confirmed pagination behavior"));
      const high = text.slice(text.indexOf("Confirmed pagination behavior"));
      expect(low).toContain("Confidence below 0.60");
      expect(high).not.toContain("Confidence below");
    } finally { store.close(); }
  });

  it("excludes confirmed and invalidated assumptions from open assumptions", () => {
    const store = subject();
    try {
      const confirmed = add(store, "Confirmed item", 0.5);
      const invalidated = add(store, "Invalidated item", 0.5);
      store.confirmAssumption(confirmed, "evidence");
      store.invalidateAssumption(invalidated, "wrong interpretation");
      const envelope = compileContextEnvelope(store);
      const text = envelope.unchanged ? "" : envelope.context;
      const section = text.split("## Open assumptions")[1]?.split("##")[0] ?? "";
      expect(section).not.toContain("Confirmed item");
      expect(section).not.toContain("Invalidated item");
      expect(text).toContain("Known corrections");
    } finally { store.close(); }
  });

  it("marks only assumptions changed after record_assumption", () => {
    const store = subject();
    try {
      const first = compileContextEnvelope(store);
      add(store, "CSV is required", 0.7);
      const delta = compileContextEnvelope(store, { sinceSequence: first.sequence });
      expect(delta.unchanged).toBe(false);
      if (delta.unchanged) return;
      expect(delta.changedSections).toEqual(["assumptions"]);
      expect(delta.unchangedSections).toEqual(expect.arrayContaining(["contract", "budget", "checkpoints", "decisions", "failures"]));
      expect(delta.context).toContain("CSV is required");
    } finally { store.close(); }
  });
});
