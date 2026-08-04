import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

const DIST = path.resolve("plugins/keep-coding/dist/keep-coding.mjs");
const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function repository(prefix = "keep-coding-dist-"): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "dist-test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Keep Coding Dist Test"], { cwd: root });
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "value.js"), "export const value = 1;\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

function run(args: string[], input = "", cwd = process.cwd()): { stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [DIST, ...args], { cwd, input, encoding: "utf8", timeout: 60_000 });
  if (result.error) throw result.error;
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return { stdout: result.stdout, stderr: result.stderr };
}

function jsonRun(args: string[], input: unknown, cwd = process.cwd()): Record<string, unknown> {
  const result = run(args, JSON.stringify(input), cwd);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function textResult(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const text = result.content.find((item) => item.type === "text");
  if (!text || text.type !== "text") throw new Error("MCP result did not contain text");
  return JSON.parse(text.text) as Record<string, unknown>;
}

describe("compiled Keep Coding artifact", () => {
  it("runs version and detection without evaluating the graph parser", () => {
    expect(run(["version"]).stdout.trim()).toBe("0.4.0");
    const detection = JSON.parse(run(["detect"], "Build a production-ready complete project with architecture, tests, CI, deployment and phases.").stdout) as { activate: boolean };
    expect(detection.activate).toBe(true);
    expect(statSync(DIST).size).toBeLessThan(3_000_000);
  });

  it("executes the complete compiled hook lifecycle against a real Git repository", () => {
    const root = repository("keep-coding-dist-hooks-");
    const prompt = "Build a production-ready complete modular project with architecture, integrations, tests, documentation, CI, deployment and multiple phases. ".repeat(5);
    const activation = jsonRun(["hook", "UserPromptSubmit"], { cwd: root, prompt, runtime: "codex", session_id: "dist-hooks" });
    expect(activation.continue).toBe(true);
    expect(existsSync(path.join(root, ".keep-coding", "state.db"))).toBe(true);
    for (const event of ["SessionStart", "PreCompact", "PostCompact"]) {
      expect(jsonRun(["hook", event], { cwd: root, runtime: "codex", session_id: "dist-hooks" }).continue).toBe(true);
    }
    const stop = jsonRun(["hook", "Stop"], { cwd: root, runtime: "codex", session_id: "dist-hooks" });
    expect(stop.decision).toBe("block");
    const release = jsonRun(["hook", "Stop"], { cwd: root, runtime: "codex", session_id: "dist-hooks", stop_hook_active: true });
    expect(release.continue).toBe(true);
    expect(jsonRun(["hook", "SessionEnd"], { cwd: root, runtime: "codex", session_id: "dist-hooks" }).continue).toBe(true);
  });

  it("completes the full stdio MCP workflow through the compiled artifact", async () => {
    const root = repository("keep-coding-dist-mcp-");
    const transport = new StdioClientTransport({ command: process.execPath, args: [DIST, "mcp"], cwd: process.cwd(), stderr: "pipe" });
    const client = new Client({ name: "keep-coding-dist-smoke", version: "1.0.0" });
    try {
      await client.connect(transport);
      const initialized = textResult(await client.callTool({ name: "initialize_project", arguments: { project_root: root, prompt: "Deliver a verified compiled MCP workflow." } }));
      expect(initialized.nextAction).toBe("save_plan");
      const plan = textResult(await client.callTool({
        name: "save_plan",
        arguments: {
          project_root: root,
          contract: {
            goal: "Deliver a verified compiled MCP workflow.", nonGoals: [], constraints: [],
            deliverables: ["Updated value module"], invariants: ["Compiled artifact remains executable"],
            doneWhen: ["node syntax check passes"], selectiveTests: { commandTemplate: "node --check {tests}", fullSuiteCommands: ["node --check src/value.js"] }
          },
          phases: [{
            id: "compiled-flow", title: "Compiled flow", goal: "Update the value module through compiled MCP",
            dependencies: [], allowedScope: ["src/**"], acceptanceCommands: ["node --check src/value.js"],
            verificationKind: "code", maxAttempts: 2
          }]
        }
      }));
      expect(plan.nextAction).toBe("start_phase");
      await client.callTool({ name: "start_phase", arguments: { project_root: root, phase_id: "compiled-flow" } });
      writeFileSync(path.join(root, "src", "value.js"), "export const value = 2;\n");
      const checkpoint = textResult(await client.callTool({ name: "checkpoint_phase", arguments: { project_root: root, phase_id: "compiled-flow", summary: "updated value" } }));
      expect((checkpoint.evidence as { passed?: boolean }).passed).toBe(true);
      const completed = textResult(await client.callTool({ name: "complete_project", arguments: { project_root: root } }));
      expect((completed.project as { status?: string }).status).toBe("COMPLETED");
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("executes the compiled assumption and bounded-correction lifecycle", async () => {
    const root = repository("keep-coding-dist-assumptions-");
    const transport = new StdioClientTransport({ command: process.execPath, args: [DIST, "mcp"], cwd: process.cwd(), stderr: "pipe" });
    const client = new Client({ name: "keep-coding-dist-assumptions", version: "1.0.0" });
    try {
      await client.connect(transport);
      await client.callTool({ name: "initialize_project", arguments: { project_root: root, prompt: "Update src/value.js to export the exact numeric value 2 and verify it with node syntax checking." } });
      await client.callTool({
        name: "save_plan",
        arguments: {
          project_root: root,
          contract: {
            goal: "Update src/value.js to export the exact numeric value 2.", nonGoals: [], constraints: [],
            deliverables: ["Updated value module"], invariants: ["Only src/value.js changes"],
            doneWhen: ["node --check src/value.js exits zero"], assumptionConfidenceThreshold: 0.6
          },
          phases: [{
            id: "correct-value", title: "Correct value", goal: "Set src/value.js export to numeric value 2 and run node syntax validation.",
            dependencies: [], allowedScope: ["src/value.js"], acceptanceCommands: ["node --check src/value.js"],
            verificationKind: "code", maxAttempts: 2
          }]
        }
      });
      await client.callTool({ name: "start_phase", arguments: { project_root: root, phase_id: "correct-value" } });
      const recorded = textResult(await client.callTool({
        name: "record_assumption",
        arguments: {
          project_root: root, phase_id: "correct-value", statement: "The requested value should be represented as the number 2",
          confidence: 0.8, alternatives: [{ interpretation: "String value '2'", whyRejected: "The requirement explicitly says numeric" }]
        }
      }));
      const assumptionId = String(recorded.assumption_id);
      await client.callTool({ name: "link_assumption", arguments: { project_root: root, assumption_id: assumptionId, node_ids: ["file:src/value.js"] } });
      const invalidated = textResult(await client.callTool({
        name: "invalidate_assumption",
        arguments: { project_root: root, assumption_id: assumptionId, root_cause: "The correct numeric value is 3, not 2", max_hops: 1 }
      }));
      expect((invalidated.blast_radius as { files?: string[] }).files).toEqual(["src/value.js"]);
      writeFileSync(path.join(root, "src", "value.js"), "export const value = 3;\n");
      const checkpoint = textResult(await client.callTool({
        name: "checkpoint_phase", arguments: { project_root: root, phase_id: "correct-value", summary: "corrected bounded value" }
      }));
      expect((checkpoint.evidence as { passed?: boolean }).passed).toBe(true);
      expect((checkpoint.correction as { outcome?: string }).outcome).toBe("contained");
    } finally {
      await client.close().catch(() => undefined);
    }
  });


  it("indexes Python and C++ through verified compiled sidecar grammars", async () => {
    const root = repository("keep-coding-dist-native-graph-");
    writeFileSync(path.join(root, "src", "worker.py"), "def outer():\n    def inner():\n        return helper()\n    return inner()\n");
    writeFileSync(path.join(root, "src", "worker.cpp"), "namespace demo { int helper(); int run() { return helper(); } }\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "add native sources"], { cwd: root });
    const transport = new StdioClientTransport({ command: process.execPath, args: [DIST, "mcp"], cwd: process.cwd(), stderr: "pipe" });
    const client = new Client({ name: "keep-coding-dist-native", version: "1.0.0" });
    try {
      await client.connect(transport);
      await client.callTool({ name: "initialize_project", arguments: { project_root: root, prompt: "Index Python and C++ sources with verified syntax-tree grammars." } });
      const python = textResult(await client.callTool({ name: "expand_graph", arguments: { project_root: root, terms: ["outer", "inner"], limit: 50 } }));
      const cpp = textResult(await client.callTool({ name: "expand_graph", arguments: { project_root: root, terms: ["demo", "run"], limit: 50 } }));
      expect(JSON.stringify(python.nodes)).toContain("outer.inner");
      expect(JSON.stringify(cpp.nodes)).toContain("demo::run");
      expect(existsSync(path.resolve("plugins/keep-coding/dist/grammars/manifest.json"))).toBe(true);
    } finally { await client.close().catch(() => undefined); }
  });

});
