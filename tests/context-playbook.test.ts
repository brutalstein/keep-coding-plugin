import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileContextEnvelope } from "../src/core/context.js";
import type { PlaybookPattern } from "../src/domain/model.js";
import { PlatformStore } from "../src/storage/platform-store.js";

describe("playbook context projection", () => {
  it("renders only the top three supplied relevant patterns", () => {
    const root = mkdtempSync(path.join(tmpdir(), "keep-coding-context-playbook-"));
    const store = new PlatformStore(root);
    try {
      store.initialize("Build authentication safely.");
      store.savePlan(
        { goal: "Build authentication safely", nonGoals: [], constraints: [], deliverables: ["auth"], invariants: [], doneWhen: ["tests pass"] },
        [{ id: "auth", title: "Authentication", goal: "Validate tokens", dependencies: [], allowedScope: ["src/auth/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 }]
      );
      const patterns: PlaybookPattern[] = Array.from({ length: 5 }, (_, index) => ({
        id: `p${index}`, pattern: `Auth pattern ${index}`, triggerConditions: ["auth"],
        resolution: [`resolution ${index}`], applicabilityScope: ["src/auth/**"], score: 1 - index / 10,
        successCount: 5 - index, sourceProjects: ["project"]
      }));
      const envelope = compileContextEnvelope(store, { playbook: patterns });
      expect(envelope.unchanged).toBe(false);
      if (envelope.unchanged) throw new Error("expected playbook context");
      const context = envelope.context;
      expect(context).toContain("Auth pattern 0");
      expect(context).toContain("Auth pattern 2");
      expect(context).not.toContain("Auth pattern 3");
      expect(context).not.toContain("Auth pattern 4");
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
