import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PlaybookStore } from "../src/storage/playbook.js";

describe("opt-in playbook memory", () => {
  it("is inert by default", () => {
    const playbook = new PlaybookStore(false);
    expect(playbook.enabled).toBe(false);
    expect(playbook.suggest("anything")).toEqual([]);
    playbook.close();
  });

  it("reuses phase templates and failure fingerprints when enabled", () => {
    const root = mkdtempSync(path.join(tmpdir(), "keep-coding-playbook-"));
    const playbook = new PlaybookStore(true, path.join(root, "playbook.db"));
    playbook.rememberPhase(
      { id: "security", title: "Secret scanning", goal: "Scan checkpoint diffs for credentials", dependencies: [], allowedScope: ["src/security/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 },
      { goal: "Build a secure durable agent platform", nonGoals: [], constraints: [], deliverables: ["secret scan"], invariants: [], doneWhen: ["tests pass"] }
    );
    playbook.rememberFailure({
      id: "failure", phaseId: "security", fingerprint: "secret-regression", summary: "secret scanner missed a token", count: 1,
      lastSeenAt: "2026-01-01T00:00:00.000Z", resolution: "scan added diff lines before commands"
    });
    const suggestions = playbook.suggest("secure secret scanner");
    expect(suggestions.some((item) => item.source === "phase-template" && item.title === "Secret scanning")).toBe(true);
    expect(suggestions.some((item) => item.source === "failure-pattern")).toBe(true);
    playbook.close();
    rmSync(root, { recursive: true, force: true });
  });
});
