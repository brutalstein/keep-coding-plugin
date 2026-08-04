import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeepCodingService } from "../src/core/service.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-correction-integration-"));
  roots.push(root);
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "math.js"), "export const format = 'unknown';\n");
  writeFileSync(path.join(root, "src", "extra.js"), "export const extra = false;\n");
  writeFileSync(path.join(root, "package.json"), '{"type":"module","scripts":{"test":"node --check src/math.js && node --check src/extra.js"}}\n');
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

async function active(root: string): Promise<KeepCodingService> {
  const service = await KeepCodingService.open(root);
  await service.initialize("Build a data export implementation");
  service.savePlan(
    { goal: "Deliver a verified export implementation", nonGoals: [], constraints: [], deliverables: ["export"], invariants: [], doneWhen: ["npm test passes"] },
    [{ id: "export", title: "Export", goal: "Implement export format", dependencies: [], allowedScope: ["src/**"], acceptanceCommands: ["npm test"], maxAttempts: 3 }]
  );
  await service.startPhase("export");
  return service;
}

function record(service: KeepCodingService, confidence: number): string {
  return service.recordAssumption("export", "Export response is CSV", confidence, [{ interpretation: "JSON", whyRejected: "CSV seemed likely" }]).assumption_id;
}

describe("assumption checkpoint and correction lifecycle", () => {
  it("rejects verification while a low-confidence assumption remains open", async () => {
    const root = repository(); const service = await active(root);
    try {
      const id = record(service, 0.4);
      writeFileSync(path.join(root, "src", "math.js"), "export const format = 'csv';\n");
      await expect(service.checkpoint("export", "implemented CSV")).rejects.toThrow(new RegExp(`${id}.*Export response is CSV`));
      expect(service.store.getPhase("export")?.status).toBe("IN_PROGRESS");
    } finally { service.close(); }
  });

  it("succeeds once the low-confidence assumption is confirmed", async () => {
    const root = repository(); const service = await active(root);
    try {
      const id = record(service, 0.4);
      service.confirmAssumption(id, "Product owner confirmed CSV");
      writeFileSync(path.join(root, "src", "math.js"), "export const format = 'csv';\n");
      const result = await service.checkpoint("export", "implemented confirmed CSV");
      expect(result.evidence).toMatchObject({ passed: true });
      expect(service.store.getAssumption(id)?.status).toBe("confirmed");
    } finally { service.close(); }
  });

  it("records a contained correction when actual edits stay inside the radius", async () => {
    const root = repository(); const service = await active(root);
    try {
      const id = record(service, 0.5);
      service.linkAssumption(id, ["file:src/math.js"]);
      const invalidated = service.invalidateAssumption(id, "Actual response must be JSON");
      writeFileSync(path.join(root, "src", "math.js"), "export const format = 'json';\n");
      const result = await service.checkpoint("export", "corrected response format");
      expect(result.evidence).toMatchObject({ passed: true });
      expect(service.store.getCorrection(invalidated.correction_id)).toMatchObject({ outcome: "contained" });
      expect(service.store.getCorrection(invalidated.correction_id)?.completedAt).not.toBeNull();
    } finally { service.close(); }
  });

  it("flags expanded outcome and blocks an edit outside the radius without authorization", async () => {
    const root = repository(); const service = await active(root);
    try {
      const id = record(service, 0.5);
      service.linkAssumption(id, ["file:src/math.js"]);
      const invalidated = service.invalidateAssumption(id, "Actual response must be JSON");
      writeFileSync(path.join(root, "src", "math.js"), "export const format = 'json';\n");
      writeFileSync(path.join(root, "src", "extra.js"), "export const extra = true;\n");
      const result = await service.checkpoint("export", "attempted broad correction");
      expect(result.evidence).toMatchObject({ passed: false, scopePassed: false });
      expect((result.evidence as { scopeViolations: string[] }).scopeViolations).toContain("src/extra.js");
      expect(service.store.getCorrection(invalidated.correction_id)).toMatchObject({ outcome: "expanded", completedAt: null });
    } finally { service.close(); }
  });

  it("allows an expanded checkpoint after explicit scope expansion with justification", async () => {
    const root = repository(); const service = await active(root);
    try {
      const id = record(service, 0.5);
      service.linkAssumption(id, ["file:src/math.js"]);
      const invalidated = service.invalidateAssumption(id, "Actual response must be JSON");
      const expanded = service.expandCorrectionScope(invalidated.correction_id, ["file:src/extra.js"], "The serializer contract also lives in extra.js");
      expect(expanded.expanded).toBe(1);
      writeFileSync(path.join(root, "src", "math.js"), "export const format = 'json';\n");
      writeFileSync(path.join(root, "src", "extra.js"), "export const extra = true;\n");
      const result = await service.checkpoint("export", "completed justified correction");
      expect(result.evidence).toMatchObject({ passed: true });
      const correction = service.store.getCorrection(invalidated.correction_id)!;
      expect(correction).toMatchObject({ outcome: "expanded" });
      expect(correction.expansions[0]?.justification).toBe("The serializer contract also lives in extra.js");
      expect(correction.completedAt).not.toBeNull();
    } finally { service.close(); }
  });

  it("rejects an empty expansion justification without mutating the correction", async () => {
    const root = repository(); const service = await active(root);
    try {
      const id = record(service, 0.5);
      service.linkAssumption(id, ["file:src/math.js"]);
      const invalidated = service.invalidateAssumption(id, "Actual response must be JSON");
      expect(() => service.expandCorrectionScope(invalidated.correction_id, ["file:src/extra.js"], "   ")).toThrow(/non-empty/);
      expect(service.store.getCorrection(invalidated.correction_id)?.expansions).toEqual([]);
    } finally { service.close(); }
  });
});
