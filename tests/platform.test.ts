import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectLargeProject } from "../src/core/detector.js";
import { parseSemanticFile } from "../src/core/graph/parser.js";
import { CriticRunner } from "../src/core/critic.js";
import { renderDashboard } from "../src/dashboard/server.js";
import { CodexContinuityAdapter, ClaudeHooksAdapter, PollingCliAdapter } from "../src/adapters/continuity.js";
import { generateCommitMessage, generatePullRequestDescription } from "../src/integrations/github.js";
import { PlaybookStore } from "../src/storage/playbook.js";
import type { ProjectSnapshot } from "../src/domain/model.js";

describe("next generation platform", () => {
  it("scores activation with explainable override", () => {
    expect(detectLargeProject("Rename x").activate).toBe(false);
    const result = detectLargeProject("Build an end-to-end production-ready architecture with tests, CI and phases.");
    expect(result.activate).toBe(true);
    expect(result.signals.length).toBeGreaterThan(2);
    expect(detectLargeProject("small", { force: true }).manualOverride).toBe(true);
  });

  it("builds AST symbols, imports and calls lazily", async () => {
    const parsed = await parseSemanticFile("import { b } from './b.js'; export function a(){ return b(); }", ".ts");
    expect(parsed.symbols.some((item) => item.name === "a")).toBe(true);
    expect(parsed.imports).toContain("./b.js");
    expect(parsed.references.some((item) => item.target === "b" && item.kind === "calls")).toBe(true);
  });

  it("keeps critic advisory when unconfigured", async () => {
    const evidence = await new CriticRunner("", 10).review({ root: process.cwd(), phase: {} as never, contract: {} as never, changedFiles: [], diff: "" }, false);
    expect(evidence.passed).toBe(true);
  });

  it("renders dashboard, adapters and decision-sourced PR copy", async () => {
    const snapshot = {
      project: { id: "p", root: "/r", originalPrompt: "build", status: "ACTIVE", contract: { goal: "Build system", nonGoals: [], constraints: [], deliverables: ["system"], invariants: [], doneWhen: ["done"] }, planVersion: 2, currentPhaseId: null, createdAt: "", updatedAt: "" },
      phases: [], decisions: [], failures: [], approvals: [], checkpoints: [], planRevisions: [], worktrees: [], budgetUsage: {}, recentEvents: []
    } as ProjectSnapshot;
    expect(renderDashboard(snapshot)).toContain("Phase DAG");
    expect(generatePullRequestDescription(snapshot)).toContain("Build system");
    expect(generateCommitMessage("phase", "a long summary")).toContain("phase");
    expect(new CodexContinuityAdapter().id).toBe("codex");
    expect(new ClaudeHooksAdapter().id).toContain("claude");
    expect((await new PollingCliAdapter().translate({ name: "poll", cwd: "/r" }, null)).continue).toBe(true);
  });

  it("stores opt-in playbook patterns outside a project", () => {
    const root = mkdtempSync(path.join(tmpdir(), "playbook-"));
    const database = path.join(root, "playbook.db");
    const playbook = new PlaybookStore(database);
    playbook.rememberPhase("project", {
      id: "test", title: "Test API", goal: "Add API tests", dependencies: [], allowedScope: ["tests/**"], acceptanceCommands: ["npm test"], maxAttempts: 2
    }, ["api"]);
    expect(playbook.suggest("api test")).toHaveLength(1);
    playbook.close();
    rmSync(root, { recursive: true, force: true });
  });
});
