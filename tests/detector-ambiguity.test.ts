import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessAmbiguity } from "../src/core/detector.js";
import { KeepCodingService } from "../src/core/service.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-ambiguity-")); roots.push(root);
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "export.js"), "export const value = 1;\n");
  writeFileSync(path.join(root, "package.json"), '{"type":"module","scripts":{"test":"node --check src/export.js"}}\n');
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

describe("ambiguity pre-flight", () => {
  it("flags vague quantifiers and unresolved acceptance criteria", () => {
    const result = assessAmbiguity("handle the various edge cases appropriately", ["tests pass"]);
    expect(result.high).toBe(true);
    expect(result.reasons).toEqual(expect.arrayContaining([expect.stringContaining("vague"), expect.stringContaining("acceptance") ]));
  });

  it("does not flag a precisely specified endpoint", () => {
    const result = assessAmbiguity("Add GET /export returning CSV with columns id,name,createdAt, tested by tests/export.test.ts", ["GET /export returns status code 200 with the stated columns"]);
    expect(result.high).toBe(false);
    expect(result.score).toBeLessThan(result.threshold);
  });

  it("recognizes Turkish ambiguity markers equivalently", () => {
    const vague = assessAmbiguity("çeşitli kenar durumlarını uygun şekilde ele al", ["testler geçsin"]);
    const precise = assessAmbiguity("GET /export uç noktası id,name kolonlarıyla CSV döndürür", ["durum kodu 200 ve kolonlar id,name olur"]);
    expect(vague.high).toBe(true);
    expect(precise.high).toBe(false);
  });

  it("rejects checkpoint for a high-ambiguity phase with zero assumptions", async () => {
    const root = repository(); const service = await KeepCodingService.open(root);
    try {
      await service.initialize("Build export");
      service.savePlan(
        { goal: "Deliver an export", nonGoals: [], constraints: [], deliverables: ["export"], invariants: [], doneWhen: ["tests pass"] },
        [{ id: "export", title: "Export", goal: "handle the various edge cases appropriately", dependencies: [], allowedScope: ["src/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 }]
      );
      await service.startPhase("export");
      writeFileSync(path.join(root, "src", "export.js"), "export const value = 2;\n");
      await expect(service.checkpoint("export", "ambiguous change")).rejects.toThrow(/HIGH_AMBIGUITY_WITHOUT_ASSUMPTION/);
    } finally { service.close(); }
  });
});
