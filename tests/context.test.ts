import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileContext, compileContextEnvelope } from "../src/core/context.js";
import { PlatformStore } from "../src/storage/platform-store.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function subject(maxTokens = 100): PlatformStore {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-context-"));
  roots.push(root);
  const store = new PlatformStore(root);
  store.initialize("Build a tested server with durable context.");
  store.savePlan(
    {
      goal: "Deliver a complete tested server", nonGoals: [], constraints: ["Node 22"],
      deliverables: ["server"], invariants: ["safe"], doneWhen: ["tests pass"], budget: { maxTokens }
    },
    [{ id: "server", title: "Server", goal: "Build the server", dependencies: [], allowedScope: ["src/server/**"], acceptanceCommands: ["npm test"], maxAttempts: 3 }]
  );
  return store;
}

describe("context compiler", () => {
  it("returns a near-zero unchanged envelope and a decision-only delta", () => {
    const store = subject();
    try {
      const full = compileContextEnvelope(store);
      const unchanged = compileContextEnvelope(store, { sinceSequence: full.sequence });
      expect(unchanged).toMatchObject({ unchanged: true, sequence: full.sequence, changedSections: [], estimatedTokens: 0 });
      expect("context" in unchanged).toBe(false);
      expect(JSON.stringify(unchanged).length).toBeLessThan((full.context ?? "").length / 3);

      store.recordDecision({ phaseId: "server", title: "Use SQLite", rationale: "Preserve durable state", alternatives: ["Memory only"] });
      const delta = compileContextEnvelope(store, { sinceSequence: full.sequence });
      expect(delta.changedSections).toEqual(["decisions"]);
      expect(delta.unchangedSections).toContain("contract");
      expect(delta.context).toContain("Use SQLite");
      expect((delta.context ?? "").length).toBeLessThan((full.context ?? "").length);
    } finally { store.close(); }
  });

  it("bounds the default graph section independent of graph size", () => {
    const store = subject();
    try {
      for (let index = 0; index < 500; index += 1) {
        store.upsertGraphNode({
          id: `symbol:src/server/file-${index}.ts:function:server${index}`, type: "symbol",
          label: `server${index}`, path: `src/server/file-${index}.ts`, symbol: `server${index}`,
          contentHash: null, metadata: { kind: "function", line: index + 1 }
        });
      }
      const context = compileContext(store, 12_000);
      const graphBody = (context.split("## Semantic graph — Tier 0")[1] ?? "").split("\n\n")[0] ?? "";
      expect(graphBody.trim().split("\n")).toHaveLength(2);
      expect(context).not.toContain("server499");
      expect(context).toContain("Use `expand_graph`");
    } finally { store.close(); }
  });

  it("clusters rendered failure memory and suppresses overflow", () => {
    const store = subject();
    try {
      for (const word of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]) {
        store.recordFailure("server", `Failure ${word} while validating the server`);
      }
      const context = compileContext(store);
      expect(context).toContain("+3 similar failures suppressed");
      expect((context.match(/\[server\]/g) ?? [])).toHaveLength(5);
    } finally { store.close(); }
  });

  it("injects proactive budget advice only after configured thresholds", () => {
    const store = subject(100);
    try {
      const project = store.getProject()!;
      store.recordBudgetUsage("project", project.id, { tokens: 69 });
      expect(compileContext(store)).not.toContain("Budget 69% used");
      store.recordBudgetUsage("project", project.id, { tokens: 2 });
      expect(compileContext(store)).toContain("Budget 71% used");
      store.recordBudgetUsage("project", project.id, { tokens: 20 });
      expect(compileContext(store)).toContain("Budget 91% used");
    } finally { store.close(); }
  });

  it("respects the configured context budget floor", () => {
    const store = subject();
    try {
      const context = compileContext(store, 1_000);
      expect(context).toContain("KEEP CODING ACTIVE");
      expect(context.length).toBeLessThanOrEqual(1_010);
    } finally { store.close(); }
  });
});
