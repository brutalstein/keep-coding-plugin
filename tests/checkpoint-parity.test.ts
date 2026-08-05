import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeepCodingService } from "../src/core/service.js";

interface PreparedWorktree {
  phaseId: string;
  path: string;
  branch: string;
}

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-checkpoint-parity-"));
  roots.push(root);
  mkdirSync(path.join(root, "src", "a"), { recursive: true });
  mkdirSync(path.join(root, "src", "b"), { recursive: true });
  writeFileSync(path.join(root, "src", "a", "main.js"), "export const format = 'unknown';\n");
  writeFileSync(path.join(root, "src", "a", "extra.js"), "export const extra = false;\n");
  writeFileSync(path.join(root, "src", "b", "main.js"), "export const enabled = false;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

async function active(root: string): Promise<{ service: KeepCodingService; worktrees: PreparedWorktree[] }> {
  const service = await KeepCodingService.open(root);
  await service.initialize("Implement two independently verifiable modules in parallel");
  service.savePlan(
    {
      goal: "Deliver two verified independent modules",
      nonGoals: [],
      constraints: [],
      deliverables: ["alpha module", "beta module"],
      invariants: [],
      doneWhen: ["The declared node syntax checks complete successfully"]
    },
    [
      {
        id: "alpha",
        title: "Alpha",
        goal: "Set the alpha export format to JSON",
        dependencies: [],
        allowedScope: ["src/a/**"],
        acceptanceCommands: ["node --check src/a/main.js && node --check src/a/extra.js"],
        maxAttempts: 3,
        parallelSafe: true
      },
      {
        id: "beta",
        title: "Beta",
        goal: "Enable the beta module flag",
        dependencies: [],
        allowedScope: ["src/b/**"],
        acceptanceCommands: ["node --check src/b/main.js"],
        maxAttempts: 3,
        parallelSafe: true
      }
    ]
  );
  const prepared = await service.parallel().prepare(["alpha", "beta"]) as { worktrees: PreparedWorktree[] };
  roots.push(...prepared.worktrees.map((item) => item.path));
  return { service, worktrees: prepared.worktrees };
}

function worktree(items: PreparedWorktree[], phaseId: string): string {
  const item = items.find((candidate) => candidate.phaseId === phaseId);
  if (!item) throw new Error(`missing worktree: ${phaseId}`);
  return item.path;
}

describe("serial and parallel checkpoint policy parity", () => {
  it("keeps a parallel phase active until a low-confidence assumption is resolved", async () => {
    const root = repository();
    const { service, worktrees } = await active(root);
    try {
      const assumptionId = service.recordAssumption(
        "alpha",
        "The alpha format should be JSON",
        0.4,
        [{ interpretation: "CSV", whyRejected: "JSON appears more likely" }]
      ).assumption_id;
      writeFileSync(path.join(worktree(worktrees, "alpha"), "src", "a", "main.js"), "export const format = 'json';\n");

      await expect(service.parallel().checkpoint("alpha", "implemented assumed format"))
        .rejects.toThrow(new RegExp(`${assumptionId}.*alpha format should be JSON`, "i"));
      expect(service.store.getPhase("alpha")?.status).toBe("IN_PROGRESS");
      expect(service.store.getWorktree("alpha")?.status).toBe("active");

      service.confirmAssumption(assumptionId, "The product contract explicitly requires JSON");
      const result = await service.parallel().checkpoint("alpha", "implemented confirmed format");
      expect(result.evidence).toMatchObject({ passed: true });
      expect(service.store.getPhase("alpha")?.status).toBe("COMPLETED");
    } finally {
      service.close();
    }
  });

  it("enforces a correction radius inside an otherwise valid parallel phase scope", async () => {
    const root = repository();
    const { service, worktrees } = await active(root);
    try {
      const assumptionId = service.recordAssumption(
        "alpha",
        "Only the alpha main module needs to change",
        0.8,
        [{ interpretation: "Main and extra modules", whyRejected: "The initial requirement named only main" }]
      ).assumption_id;
      service.linkAssumption(assumptionId, ["file:src/a/main.js"]);
      const correction = service.invalidateAssumption(assumptionId, "The extra module was changed without justification");
      const alpha = worktree(worktrees, "alpha");
      writeFileSync(path.join(alpha, "src", "a", "main.js"), "export const format = 'json';\n");
      writeFileSync(path.join(alpha, "src", "a", "extra.js"), "export const extra = true;\n");

      await expect(service.parallel().checkpoint("alpha", "attempted broad correction"))
        .rejects.toThrow(/failed verification/);
      expect(service.store.getPhase("alpha")?.status).toBe("FAILED");
      expect(service.store.getWorktree("alpha")?.status).toBe("failed");
      expect(service.store.getCorrection(correction.correction_id)).toMatchObject({
        outcome: "expanded",
        completedAt: null
      });
    } finally {
      service.close();
    }
  });

  it("persists parallel command failures and their output telemetry", async () => {
    const root = repository();
    const { service, worktrees } = await active(root);
    try {
      writeFileSync(
        path.join(worktree(worktrees, "alpha"), "src", "a", "main.js"),
        "export const format = ;\n"
      );

      await expect(service.parallel().checkpoint("alpha", "introduced invalid syntax"))
        .rejects.toThrow(/failed verification/);
      const command = "node --check src/a/main.js && node --check src/a/extra.js";
      const failure = service.store.latestCommandFailure("alpha", command);
      expect(failure).not.toBeNull();
      expect(failure?.fingerprint).toHaveLength(24);
      expect(failure?.stderr).toMatch(/syntaxerror|unexpected token/iu);
      expect(service.store.listBudgetUsage()["phase:alpha"]?.estimatedTokens).toBeGreaterThan(0);
    } finally {
      service.close();
    }
  });
});
