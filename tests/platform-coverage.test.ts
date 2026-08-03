import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexContinuityAdapter, ClaudeHooksAdapter, PollingCliAdapter, adapterById } from "../src/adapters/continuity.js";
import { CriticRunner } from "../src/core/critic.js";
import { parseSemanticFile } from "../src/core/graph/parser.js";
import { KeepCodingService } from "../src/core/service.js";
import { startDashboard } from "../src/dashboard/server.js";
import { generateCommitMessage, generatePullRequestDescription } from "../src/integrations/github.js";
import type { ProjectSnapshot } from "../src/domain/model.js";
import type { ProjectStore } from "../src/storage/store.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-platform-"));
  roots.push(root);
  mkdirSync(path.join(root, "src", "a"), { recursive: true });
  mkdirSync(path.join(root, "src", "b"), { recursive: true });
  writeFileSync(path.join(root, "src", "a", "index.js"), "export const a = 1;\n");
  writeFileSync(path.join(root, "src", "b", "index.js"), "export const b = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

function snapshot(status: ProjectSnapshot["project"]["status"] = "ACTIVE"): ProjectSnapshot {
  return {
    project: {
      id: "project", root: "/repo", originalPrompt: "Build", status,
      contract: {
        goal: "Build the platform", nonGoals: [], constraints: [], deliverables: ["platform"],
        invariants: ["verified"], doneWhen: ["tests pass"]
      },
      planVersion: 2, currentPhaseId: "phase", createdAt: "now", updatedAt: "now"
    },
    phases: [{
      id: "phase", ordinal: 0, title: "Phase", goal: "Ship", dependencies: [], allowedScope: ["src/**"],
      acceptanceCommands: ["npm test"], maxAttempts: 2, status: "COMPLETED", attempts: 1,
      startedAt: "now", completedAt: "now", baseSha: "base", headSha: "head", summary: "shipped"
    }],
    decisions: [{ id: "d", phaseId: "phase", title: "Use SQLite", rationale: "Durability", alternatives: [], status: "active", createdAt: "now" }],
    failures: [], approvals: [], planRevisions: [], worktrees: [], budgetUsage: {},
    checkpoints: [{
      id: "c", phaseId: "phase", gitSha: "abcdef123456", summary: "verified", changedFiles: ["src/a.ts"], createdAt: "now",
      verification: {
        passed: true, scopePassed: true, scopeViolations: [], changedFiles: ["src/a.ts"],
        secretScan: { passed: true, scannedFiles: ["src/a.ts"], findings: [] },
        budget: { passed: true, limits: {}, usage: { tokens: 1, costUsd: 0, wallClockMs: 1, updatedAt: "now" }, violations: [] },
        selectiveCommands: [{ command: "npm test -- a", exitCode: 0, passed: true, durationMs: 1, stdout: "", stderr: "", timedOut: false }],
        commands: [{ command: "npm test", exitCode: 0, passed: true, durationMs: 1, stdout: "", stderr: "", timedOut: false }],
        critic: { configured: false, blocking: false, passed: true, summary: "advisory", findings: [], rawOutput: "" },
        impactedCompletedPhases: [], diffHash: "hash", gitSha: "abcdef123456"
      }
    }],
    recentEvents: [{ sequence: 1, timestamp: "now", type: "phase_completed", phaseId: "phase", payload: {} }]
  };
}

function command(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

describe("platform coverage", () => {
  it("runs configured critic success, failure and invalid-output paths", async () => {
    const input = {
      root: process.cwd(),
      phase: snapshot().phases[0]!,
      contract: snapshot().project.contract!,
      changedFiles: ["src/a.ts"],
      diff: "+change"
    };
    const success = await new CriticRunner(command(
      "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({passed:true,summary:'ok',findings:[{severity:'info',rule:'architecture',message:'clean',file:'src/a.ts'},{message:'fallback'}]})))"
    ), 5_000).review(input, true);
    expect(success.passed).toBe(true);
    expect(success.findings).toHaveLength(2);

    const advisoryFailure = await new CriticRunner(command("console.error('critic failed');process.exit(2)"), 5_000).review(input, false);
    expect(advisoryFailure.passed).toBe(true);
    expect(advisoryFailure.findings[0]?.rule).toBe("critic-command-failed");

    const invalid = await new CriticRunner(command("console.log('not-json')"), 5_000).review(input, true);
    expect(invalid.passed).toBe(false);
    expect(invalid.findings[0]?.rule).toBe("critic-invalid-output");

    const missing = await new CriticRunner("", 5_000).review(input, true);
    expect(missing.passed).toBe(false);
  });

  it("serves a loopback dashboard and rejects mutation or public binding", async () => {
    const store = { snapshot: () => snapshot() } as unknown as ProjectStore;
    const dashboard = await startDashboard(store);
    try {
      const html = await fetch(dashboard.url).then((response) => response.text());
      expect(html).toContain("Keep Coding");
      expect(html).toContain("Budget burn");
      const json = await fetch(new URL("snapshot.json", dashboard.url)).then((response) => response.json()) as ProjectSnapshot;
      expect(json.project.id).toBe("project");
      expect((await fetch(new URL("missing", dashboard.url))).status).toBe(404);
      expect((await fetch(dashboard.url, { method: "POST" })).status).toBe(404);
    } finally {
      await dashboard.close();
    }
    await expect(startDashboard(store, "0.0.0.0")).rejects.toThrow(/loopback/);
  });

  it("translates runtime lifecycle events and generates evidence prose", async () => {
    const active = {
      store: { getProject: () => snapshot().project },
      context: () => "durable context"
    } as unknown as KeepCodingService;
    const completed = {
      store: { getProject: () => snapshot("COMPLETED").project },
      context: () => "done"
    } as unknown as KeepCodingService;

    expect((await new CodexContinuityAdapter().translate({ name: "SessionStart", cwd: "/repo" }, active)).context).toBe("durable context");
    expect((await new CodexContinuityAdapter().translate({ name: "Stop", cwd: "/repo" }, active)).continue).toBe(false);
    expect((await new CodexContinuityAdapter().translate({ name: "Stop", cwd: "/repo" }, completed)).continue).toBe(true);
    expect((await new ClaudeHooksAdapter().translate({ name: "PreCompact", cwd: "/repo" }, active)).context).toBe("durable context");
    expect((await new ClaudeHooksAdapter().translate({ name: "Stop", cwd: "/repo" }, active)).continue).toBe(false);
    expect((await new PollingCliAdapter().translate({ name: "poll", cwd: "/repo" }, active)).context).toBe("durable context");
    expect(adapterById("claude").id).toBe("claude-hooks");
    expect(adapterById("poll").id).toBe("polling-cli");
    expect(adapterById("other").id).toBe("codex");

    const description = generatePullRequestDescription(snapshot());
    expect(description).toContain("Use SQLite");
    expect(description).toContain("npm test");
    expect(generateCommitMessage("phase", "  a   concise summary  ")).toBe("keep-coding(phase): a concise summary");
  });

  it("parses TypeScript, Python, C-style and unsupported files", () => {
    const typescript = parseSemanticFile(`
      import { helper } from './helper.js';
      export interface Contract { value: string }
      export type Name = string;
      export enum State { Ready }
      export class Runner { run(){ return helper(); } }
      export const task = () => require('./legacy.js');
      void import('./dynamic.js');
    `, ".ts");
    expect(typescript.symbols.map((item) => item.kind)).toEqual(expect.arrayContaining(["interface", "type", "enum", "class", "method", "function"]));
    expect(typescript.imports).toEqual(expect.arrayContaining(["./helper.js", "./legacy.js", "./dynamic.js"]));
    expect(typescript.references.some((item) => item.kind === "calls")).toBe(true);

    const python = parseSemanticFile("from pkg.mod import x\nimport other\nclass A:\n    def run(self):\n        return call()\n", ".py");
    expect(python.imports).toEqual(expect.arrayContaining(["pkg.mod", "other"]));
    expect(python.symbols.map((item) => item.name)).toEqual(expect.arrayContaining(["A", "run"]));

    const cstyle = parseSemanticFile("#include <stdio.h>\nstruct Item { int x; };\nfn execute() { helper(); }\n", ".rs");
    expect(cstyle.imports).toContain("stdio.h");
    expect(cstyle.symbols.some((item) => item.name === "Item")).toBe(true);
    expect(cstyle.references.some((item) => item.target === "helper")).toBe(true);
    expect(parseSemanticFile("binary", ".bin")).toEqual({ symbols: [], imports: [], references: [] });
  });

  it("prepares, verifies and merges independent worktree phases", async () => {
    const root = repository();
    const service = await KeepCodingService.open(root);
    try {
      await service.initialize("Build two independent verified components end to end.");
      service.savePlan({
        goal: "Build two independent components", nonGoals: [], constraints: [], deliverables: ["a", "b"],
        invariants: ["verified"], doneWhen: ["both phases pass"]
      }, [
        {
          id: "phase-a", title: "Component A", goal: "Update A", dependencies: [], allowedScope: ["src/a/**"],
          acceptanceCommands: ["node --check src/a/index.js"], maxAttempts: 2, parallelSafe: true
        },
        {
          id: "phase-b", title: "Component B", goal: "Update B", dependencies: [], allowedScope: ["src/b/**"],
          acceptanceCommands: ["node --check src/b/index.js"], maxAttempts: 2, parallelSafe: true
        }
      ]);
      const orchestrator = service.parallel();
      expect(orchestrator.eligiblePhases()).toHaveLength(2);
      await expect(orchestrator.prepare(["phase-a"])).rejects.toThrow(/at least two/);
      const prepared = await orchestrator.prepare(["phase-a", "phase-b"]) as {
        worktrees: Array<{ phaseId: string; path: string }>;
      };
      for (const worktree of prepared.worktrees) {
        const component = worktree.phaseId === "phase-a" ? "a" : "b";
        writeFileSync(path.join(worktree.path, "src", component, "index.js"), `export const ${component} = 2;\n`);
      }
      expect((await orchestrator.checkpoint("phase-a", "Update A")).evidence.passed).toBe(true);
      expect((await orchestrator.checkpoint("phase-b", "Update B")).evidence.passed).toBe(true);
      expect(readFileSync(path.join(root, "src", "a", "index.js"), "utf8")).toContain("2");
      expect(readFileSync(path.join(root, "src", "b", "index.js"), "utf8")).toContain("2");
      expect(service.store.listWorktrees().every((item) => item.status === "merged")).toBe(true);
    } finally {
      service.close();
    }
  });

  it("uses service amendment, impact, failure memory and baseline restore paths", async () => {
    const root = repository();
    const oldHome = process.env.HOME;
    process.env.HOME = root;
    const service = await KeepCodingService.open(root);
    try {
      await service.initialize("Build a durable component with reusable failure memory.");
      service.savePlan({
        goal: "Build a durable component", nonGoals: [], constraints: [], deliverables: ["component"], invariants: [],
        doneWhen: ["phase passes"], playbookOptIn: true
      }, [{
        id: "phase-a", title: "Component A", goal: "Update A", dependencies: [], allowedScope: ["src/a/**"],
        acceptanceCommands: ["node --check src/a/index.js"], maxAttempts: 2
      }]);
      expect(service.recordFailure("phase-a", "A repeated parser failure").count).toBe(1);
      expect(service.rememberPhaseTemplate("phase-a")).toHaveProperty("template");
      expect((service.suggestPhases("component update") as { enabled: boolean }).enabled).toBe(true);
      expect((service.impact("src/a/index.js") as { nodes: unknown[] }).nodes.length).toBeGreaterThan(0);
      service.amendPlan({
        reason: "Add final documentation discovered during implementation",
        addPhases: [{
          id: "docs", title: "Documentation", goal: "Document A", dependencies: ["phase-a"],
          allowedScope: ["docs/**"], acceptanceCommands: ["git diff --check"], maxAttempts: 1
        }],
        supersedePhaseIds: []
      });
      await service.startPhase("phase-a");
      writeFileSync(path.join(root, "src", "a", "index.js"), "export const a = 99;\n");
      expect((await service.restorePhaseBaseline("phase-a") as { restored: string[] }).restored).toContain("src/a/index.js");
      expect(readFileSync(path.join(root, "src", "a", "index.js"), "utf8")).toContain("1");
    } finally {
      service.close();
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
});
