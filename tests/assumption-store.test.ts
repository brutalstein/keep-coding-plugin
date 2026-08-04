import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlatformStore } from "../src/storage/platform-store.js";
import { ProjectStore } from "../src/storage/store.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function subject(platform = false): ProjectStore {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-assumptions-"));
  roots.push(root);
  const store = platform ? new PlatformStore(root) : new ProjectStore(root);
  store.initialize("Build a CSV export endpoint");
  return store;
}

function node(store: ProjectStore, file: string): void {
  store.upsertGraphNode({ id: `file:${file}`, type: "file", label: file, path: file, symbol: null, contentHash: null, metadata: {} });
}

function assumption(store: ProjectStore, confidence = 0.5): string {
  return store.recordAssumption({
    phaseId: null, statement: "Export endpoint returns CSV", confidence,
    alternatives: [{ interpretation: "JSON", whyRejected: "Existing exports use CSV" }]
  });
}

describe("assumption ledger schema", () => {
  it("creates an open assumption with a graph node counterpart", () => {
    const store = subject();
    try {
      const id = assumption(store);
      expect(store.getAssumption(id)).toMatchObject({ status: "open", confidence: 0.5 });
      expect(store.getGraphNode(id)).toMatchObject({ type: "assumption", id });
    } finally { store.close(); }
  });

  it.each([1.4, -0.1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid confidence %s instead of clamping", (confidence) => {
    const store = subject();
    try {
      expect(() => assumption(store, confidence)).toThrow(/INVALID_CONFIDENCE/);
      expect(store.listAssumptions()).toEqual([]);
    } finally { store.close(); }
  });

  it("rejects a non-array alternatives payload", () => {
    const store = subject();
    try {
      expect(() => store.recordAssumption({ phaseId: null, statement: "x", confidence: 0.5, alternatives: {} as never })).toThrow(/INVALID_ALTERNATIVES/);
    } finally { store.close(); }
  });

  it("links an assumption to a file graph node", () => {
    const store = subject();
    try {
      const id = assumption(store); node(store, "src/export.ts");
      expect(store.linkAssumption(id, ["file:src/export.ts"])).toBe(1);
      expect(store.getEdgesFrom(id, "depends_on_assumption").map((edge) => edge.targetId)).toEqual(["file:src/export.ts"]);
      expect(store.getAssumption(id)?.explicitLinkedAt).not.toBeNull();
    } finally { store.close(); }
  });

  it("links a raw decision id through its graph counterpart", () => {
    const store = subject();
    try {
      const id = assumption(store);
      const decision = store.recordDecision({ phaseId: null, title: "Use CSV", rationale: "Matches assumption", alternatives: [] });
      store.linkAssumption(id, [decision.id]);
      expect(store.computeBlastRadius(id, { maxHops: 0 }).decisionIds).toContain(decision.id);
    } finally { store.close(); }
  });

  it("enforces terminal confirmed status", () => {
    const store = subject();
    try {
      const id = assumption(store);
      expect(store.confirmAssumption(id, "contract confirmed").status).toBe("confirmed");
      expect(() => store.setAssumptionStatus(id, "open")).toThrow(/one-way transition/);
      expect(() => store.invalidateAssumption(id, "later contradiction")).toThrow(/already confirmed/);
    } finally { store.close(); }
  });

  it("enforces terminal invalidated status and creates one correction", () => {
    const store = subject();
    try {
      const id = assumption(store);
      const correction = store.invalidateAssumption(id, "Actual requirement was JSON");
      expect(store.getAssumption(id)?.status).toBe("invalidated");
      expect(correction.rootCause).toContain("JSON");
      expect(() => store.setAssumptionStatus(id, "open")).toThrow(/one-way transition/);
      expect(() => store.invalidateAssumption(id, "again")).toThrow(/already invalidated/);
    } finally { store.close(); }
  });

  it("persists the same ledger entities through PlatformStore", () => {
    const store = subject(true) as PlatformStore;
    try {
      const id = assumption(store);
      const snapshot = store.snapshot();
      expect(snapshot.assumptions.map((item) => item.id)).toEqual([id]);
      expect(snapshot.corrections).toEqual([]);
    } finally { store.close(); }
  });
});

describe("blast-radius traversal", () => {
  it("returns exact nodes reachable within one and two hops", () => {
    const store = subject();
    try {
      const id = assumption(store);
      for (const file of ["a.ts", "b.ts", "c.ts"]) node(store, file);
      store.linkAssumption(id, ["file:a.ts"]);
      store.addEdge("file:a.ts", "file:b.ts", "imports");
      store.addEdge("file:b.ts", "file:c.ts", "imports");
      expect(store.computeBlastRadius(id, { maxHops: 1 }).files).toEqual(["a.ts", "b.ts"]);
      expect(store.computeBlastRadius(id, { maxHops: 2 }).files).toEqual(["a.ts", "b.ts", "c.ts"]);
    } finally { store.close(); }
  });

  it("projects indexed test and symbol nodes back to their source file paths", () => {
    const store = subject();
    try {
      const id = assumption(store);
      store.upsertGraphNode({ id: "file:src/export.test.js", type: "test", label: "export.test.js", path: "src/export.test.js", symbol: null, contentHash: null, metadata: {} });
      store.upsertGraphNode({ id: "symbol:src/export.test.js:variable:sample", type: "symbol", label: "sample", path: "src/export.test.js", symbol: "sample", contentHash: null, metadata: {} });
      store.linkAssumption(id, ["file:src/export.test.js"]);
      store.addEdge("file:src/export.test.js", "symbol:src/export.test.js:variable:sample", "contains");
      expect(store.computeBlastRadius(id, { maxHops: 1 }).files).toEqual(["src/export.test.js"]);
    } finally { store.close(); }
  });

  it("does not include unrelated graph nodes", () => {
    const store = subject();
    try {
      const id = assumption(store); node(store, "a.ts"); node(store, "unrelated.ts");
      store.linkAssumption(id, ["file:a.ts"]);
      expect(store.computeBlastRadius(id, { maxHops: 3 }).files).toEqual(["a.ts"]);
    } finally { store.close(); }
  });

  it("terminates and deduplicates a cyclic graph", () => {
    const store = subject();
    try {
      const id = assumption(store); node(store, "a.ts"); node(store, "b.ts");
      store.linkAssumption(id, ["file:a.ts"]);
      store.addEdge("file:a.ts", "file:b.ts", "imports");
      store.addEdge("file:b.ts", "file:a.ts", "imports");
      expect(store.computeBlastRadius(id, { maxHops: 5 }).files).toEqual(["a.ts", "b.ts"]);
    } finally { store.close(); }
  });

  it("returns an empty blast radius for an assumption with no links", () => {
    const store = subject();
    try {
      expect(store.computeBlastRadius(assumption(store), { maxHops: 3 })).toEqual({ nodeIds: [], files: [], decisionIds: [] });
    } finally { store.close(); }
  });
});
