import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KeepCodingService } from "../src/core/service.js";
import type { ApprovalRecord, ImpactResult } from "../src/domain/model.js";

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-service-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  writeFileSync(path.join(root, "package.json"), "{\"type\":\"module\",\"scripts\":{\"test\":\"node --check src/value.ts\"}}\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

describe("durable service capabilities", () => {
  it("coordinates amendments, approvals, impact, failures and playbook suggestions", async () => {
    const root = repository();
    const service = await KeepCodingService.open(root);
    try {
      await service.initialize("Build an approval-aware durable project");
      service.savePlan(
        {
          goal: "Deliver an approval-aware durable project",
          nonGoals: [],
          constraints: [],
          deliverables: ["approved implementation"],
          invariants: ["evidence is preserved"],
          doneWhen: ["tests pass"]
        },
        [
          {
            id: "decision",
            title: "Decision",
            goal: "Obtain product authority",
            dependencies: [],
            allowedScope: ["src/**"],
            acceptanceCommands: ["npm test"],
            maxAttempts: 2,
            requiresApproval: true
          },
          {
            id: "legacy",
            title: "Legacy",
            goal: "Use the original implementation path",
            dependencies: [],
            allowedScope: ["legacy/**"],
            acceptanceCommands: ["npm test"],
            maxAttempts: 2
          }
        ]
      );

      const amended = service.amendPlan({
        reason: "Repository inspection showed the legacy phase should be replaced.",
        supersedePhaseIds: ["legacy"],
        addPhases: [{
          id: "replacement",
          title: "Replacement",
          goal: "Use the repository-native implementation path",
          dependencies: [],
          allowedScope: ["replacement/**"],
          acceptanceCommands: ["npm test"],
          maxAttempts: 2
        }]
      });
      expect(amended.project).toMatchObject({ planVersion: 2 });
      expect(service.store.getPhase("legacy")?.status).toBe("SUPERSEDED");

      const pending = await service.startPhase("decision");
      const approval = pending.approval as ApprovalRecord;
      expect(approval.status).toBe("pending");
      const repeatedStart = await service.startPhase("decision");
      expect((repeatedStart.approval as ApprovalRecord).id).toBe(approval.id);
      const resolved = service.resolveApproval(approval.id, true, "Approved for implementation");
      expect((resolved.approval as ApprovalRecord).status).toBe("approved");
      const started = await service.startPhase("decision");
      expect(started.phase).toMatchObject({ status: "IN_PROGRESS" });

      const firstFailure = service.recordFailure("decision", "Compiler failed with code 17");
      expect(firstFailure.repeated).toBe(false);
      const repeatedFailure = service.recordFailure("decision", "Compiler failed with code 42");
      expect(repeatedFailure.repeated).toBe(true);

      const impact = service.getImpact("src/value.ts").impact as ImpactResult;
      expect(impact.files).toContain("src/value.ts");
      expect(service.suggestPhases("approval durable")).toEqual({ enabled: false, suggestions: [] });
    } finally {
      service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
