import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeepCodingService } from "../src/core/service.js";

const roots: string[] = [];
const originalCritic = process.env.KEEP_CODING_CRITIC_COMMAND;
afterEach(() => {
  if (originalCritic === undefined) delete process.env.KEEP_CODING_CRITIC_COMMAND;
  else process.env.KEEP_CODING_CRITIC_COMMAND = originalCritic;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function repository(): { root: string; marker: string } {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-critic-assumptions-")); roots.push(root);
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "export.js"), "export const format = 'unknown';\n");
  writeFileSync(path.join(root, "package.json"), '{"type":"module","scripts":{"test":"node --check src/export.js"}}\n');
  const marker = path.join(root, "critic-called.txt");
  const script = path.join(root, "critic.mjs");
  writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'called');\nprocess.stdin.resume();\nprocess.stdin.on('end', () => console.log(JSON.stringify({passed:true,summary:'accepted',findings:[]})));\n`);
  execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root }); execFileSync("git", ["config", "user.name", "Test"], { cwd: root }); execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  process.env.KEEP_CODING_CRITIC_COMMAND = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  return { root, marker };
}

async function service(root: string): Promise<KeepCodingService> {
  const instance = await KeepCodingService.open(root);
  await instance.initialize("Build export");
  instance.savePlan(
    { goal: "Deliver a precise export endpoint", nonGoals: [], constraints: [], deliverables: ["export"], invariants: [], doneWhen: ["GET /export returns CSV"] , critic: { enabled: false, blocking: false } },
    [{ id: "export", title: "Export", goal: "Add GET /export returning CSV columns id,name", dependencies: [], allowedScope: ["src/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 }]
  );
  await instance.startPhase("export"); return instance;
}

describe("confidence-weighted critic escalation", () => {
  it("forces blocking critic review for an open low-confidence assumption", async () => {
    const { root, marker } = repository(); const instance = await service(root);
    try {
      instance.recordAssumption("export", "CSV is correct", 0.3, []);
      writeFileSync(path.join(root, "src", "export.js"), "export const format = 'csv';\n");
      await expect(instance.checkpoint("export", "implemented")).rejects.toThrow(/LOW_CONFIDENCE_ASSUMPTIONS/);
      expect(existsSync(marker)).toBe(true);
    } finally { instance.close(); }
  });

  it("does not force critic review when open assumptions are above threshold", async () => {
    const { root, marker } = repository(); const instance = await service(root);
    try {
      instance.recordAssumption("export", "CSV is correct", 0.9, []);
      writeFileSync(path.join(root, "src", "export.js"), "export const format = 'csv';\n");
      const result = await instance.checkpoint("export", "implemented");
      expect(result.evidence).toMatchObject({ passed: true });
      expect(existsSync(marker)).toBe(false);
    } finally { instance.close(); }
  });
});
