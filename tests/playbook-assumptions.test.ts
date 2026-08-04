import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeepCodingService } from "../src/core/service.js";
import { PlaybookStore } from "../src/storage/playbook.js";
import { ProjectStore } from "../src/storage/store.js";

const roots: string[] = [];
const originalPath = process.env.KEEP_CODING_PLAYBOOK_PATH;
afterEach(() => {
  if (originalPath === undefined) delete process.env.KEEP_CODING_PLAYBOOK_PATH;
  else process.env.KEEP_CODING_PLAYBOOK_PATH = originalPath;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function temp(name: string): string { const root = mkdtempSync(path.join(tmpdir(), name)); roots.push(root); return root; }

function correction(rootCause = "Actual export response format is JSON"): { store: ProjectStore; assumptionId: string; correctionId: string } {
  const root = temp("keep-coding-antipattern-store-");
  const store = new ProjectStore(root); store.initialize("Build export");
  const assumptionId = store.recordAssumption({ phaseId: null, statement: "Export endpoint response format is CSV", confidence: 0.5, alternatives: [] });
  store.upsertGraphNode({ id: "file:src/export.js", type: "file", label: "src/export.js", path: "src/export.js", symbol: null, contentHash: null, metadata: {} });
  store.linkAssumption(assumptionId, ["file:src/export.js"]);
  const item = store.invalidateAssumption(assumptionId, rootCause);
  store.assessCorrectionOutcome(item.id, ["src/export.js"], 100, true);
  return { store, assumptionId, correctionId: item.id };
}

function repository(): string {
  const root = temp("keep-coding-antipattern-service-"); mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "export.js"), "export const format = 'unknown';\n");
  writeFileSync(path.join(root, "package.json"), '{"type":"module","scripts":{"test":"node --check src/export.js"}}\n');
  execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root }); execFileSync("git", ["config", "user.name", "Test"], { cwd: root }); execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["commit", "-qm", "initial"], { cwd: root }); return root;
}

async function runCorrection(playbookOptIn: boolean): Promise<void> {
  const root = repository(); const service = await KeepCodingService.open(root);
  try {
    await service.initialize("Build export endpoint response format");
    service.savePlan(
      { goal: "Deliver export endpoint response format", nonGoals: [], constraints: [], deliverables: ["export"], invariants: [], doneWhen: ["GET /export returns JSON"], playbookOptIn },
      [{ id: "export", title: "Export", goal: "Add GET /export returning JSON", dependencies: [], allowedScope: ["src/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 }]
    );
    await service.startPhase("export");
    const id = service.recordAssumption("export", "Export endpoint response format is CSV", 0.5, []).assumption_id;
    service.linkAssumption(id, ["file:src/export.js"]);
    service.invalidateAssumption(id, "Actual export endpoint response format is JSON");
    writeFileSync(path.join(root, "src", "export.js"), "export const format = 'json';\n");
    const result = await service.checkpoint("export", "corrected format");
    expect(result.evidence).toMatchObject({ passed: true });
  } finally { service.close(); }
}

describe("assumption anti-pattern promotion", () => {
  it("promotes a contained correction into an anti-pattern", () => {
    const db = path.join(temp("keep-coding-antipattern-db-"), "playbook.db");
    const item = correction(); const playbook = new PlaybookStore(db);
    try {
      const pattern = playbook.rememberCorrection(item.store.projectRoot, item.store.getAssumption(item.assumptionId)!, item.store.getCorrection(item.correctionId)!);
      expect(pattern.kind).toBe("anti_pattern");
      expect(String(pattern.metadata?.wrongAssumption)).toContain("CSV");
      expect(String(pattern.metadata?.actualCase)).toContain("JSON");
      expect(playbook.list("anti_pattern")).toHaveLength(1);
    } finally { playbook.close(); item.store.close(); }
  });

  it("does not promote when playbookOptIn is false", async () => {
    const db = path.join(temp("keep-coding-antipattern-optout-"), "playbook.db"); process.env.KEEP_CODING_PLAYBOOK_PATH = db;
    await runCorrection(false);
    const playbook = new PlaybookStore(db);
    try { expect(playbook.list("anti_pattern")).toEqual([]); }
    finally { playbook.close(); }
  });

  it("injects a matching anti-pattern before a new assumption is recorded", async () => {
    const db = path.join(temp("keep-coding-antipattern-context-"), "playbook.db"); process.env.KEEP_CODING_PLAYBOOK_PATH = db;
    const item = correction(); const playbook = new PlaybookStore(db);
    playbook.rememberCorrection("/old", item.store.getAssumption(item.assumptionId)!, item.store.getCorrection(item.correctionId)!); playbook.close(); item.store.close();
    const root = repository(); const service = await KeepCodingService.open(root);
    try {
      await service.initialize("Build export endpoint response format");
      service.savePlan(
        { goal: "Deliver export endpoint response format", nonGoals: [], constraints: [], deliverables: ["export"], invariants: [], doneWhen: ["GET /export returns JSON"], playbookOptIn: true },
        [{ id: "export", title: "Export", goal: "Implement export endpoint response format", dependencies: [], allowedScope: ["src/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 }]
      );
      const context = service.context();
      expect(context).toContain("Relevant past correction");
      expect(context).toContain("Actual case");
      expect(service.store.listAssumptions("export")).toEqual([]);
      expect(service.store.countAntiPatternHits()).toBe(1);
      service.context();
      expect(service.store.countAntiPatternHits()).toBe(1);
    } finally { service.close(); }
  });

  it("does not inject an anti-pattern for a dissimilar goal", async () => {
    const db = path.join(temp("keep-coding-antipattern-no-match-"), "playbook.db"); process.env.KEEP_CODING_PLAYBOOK_PATH = db;
    const item = correction(); const playbook = new PlaybookStore(db);
    playbook.rememberCorrection("/old", item.store.getAssumption(item.assumptionId)!, item.store.getCorrection(item.correctionId)!); playbook.close(); item.store.close();
    const root = repository(); const service = await KeepCodingService.open(root);
    try {
      await service.initialize("Order database migrations");
      service.savePlan(
        { goal: "Deliver deterministic database migration ordering", nonGoals: [], constraints: [], deliverables: ["migration"], invariants: [], doneWhen: ["migration order is deterministic"], playbookOptIn: true },
        [{ id: "migration", title: "Migration", goal: "Order database migrations deterministically", dependencies: [], allowedScope: ["src/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 }]
      );
      expect(service.context()).not.toContain("Relevant past correction");
    } finally { service.close(); }
  });

  it("deduplicates near-identical anti-patterns with diagnostic normalization", () => {
    const db = path.join(temp("keep-coding-antipattern-dedup-"), "playbook.db"); const playbook = new PlaybookStore(db);
    const first = correction("Actual JSON requirement found in /tmp/repo/src/export.ts:12");
    const second = correction("Actual JSON requirement found in /home/agent/work/src/export.ts:99");
    try {
      playbook.rememberCorrection("/one", first.store.getAssumption(first.assumptionId)!, first.store.getCorrection(first.correctionId)!);
      const merged = playbook.rememberCorrection("/two", second.store.getAssumption(second.assumptionId)!, second.store.getCorrection(second.correctionId)!);
      expect(playbook.list("anti_pattern")).toHaveLength(1);
      expect(merged.successCount).toBe(2);
      expect(merged.sourceProjects).toEqual(expect.arrayContaining(["/one", "/two"]));
    } finally { playbook.close(); first.store.close(); second.store.close(); }
  });
});
