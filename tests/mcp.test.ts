import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/mcp/server.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-mcp-"));
  roots.push(root);
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "feature.ts"), "export function feature(): number { return 1; }\n");
  writeFileSync(path.join(root, "README.md"), "test\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Keep Coding Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

async function linked(options: Parameters<typeof createServer>[0] = {}): Promise<{ client: Client; close(): Promise<void> }> {
  const server = createServer(options);
  const client = new Client({ name: "keep-coding-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close().catch(() => undefined); await server.close().catch(() => undefined); } };
}

function resultJson(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const text = result.content.find((item) => item.type === "text");
  if (!text || text.type !== "text") throw new Error("missing text result");
  return JSON.parse(text.text) as Record<string, unknown>;
}

const contract = {
  goal: "Create a verified plan for the repository.", nonGoals: [], constraints: [],
  deliverables: ["Plan"], invariants: [], doneWhen: ["Checks pass"]
};

describe("MCP protocol", () => {
  it("negotiates and exposes the complete efficient workflow", async () => {
    const connection = await linked();
    try {
      const tools = await connection.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "initialize_project", "save_plan", "amend_plan", "get_context", "get_impact", "expand_graph",
        "get_file_digest", "start_phase", "prepare_parallel_phases", "checkpoint_parallel_phase",
        "request_approval", "resolve_approval", "record_budget_usage", "restore_phase_baseline",
        "suggest_phases", "remember_phase_template", "list_files", "read_file", "search_code", "get_diff",
        "apply_patch", "record_assumption", "link_assumption", "confirm_assumption", "invalidate_assumption", "expand_correction_scope", "record_decision", "record_failure", "checkpoint_phase", "get_status", "complete_project"
      ]);
    } finally { await connection.close(); }
  });

  it("returns command-quality warnings without weakening the operator allowlist", async () => {
    const root = repository();
    const connection = await linked({
      validateAcceptanceCommand: (command) => {
        if (command === "rm -rf /") throw new Error(`not approved: ${command}`);
      }
    });
    try {
      await connection.client.callTool({ name: "initialize_project", arguments: { project_root: root, prompt: "Create a verified plan for this repository." } });
      const warned = resultJson(await connection.client.callTool({
        name: "save_plan",
        arguments: {
          project_root: root, contract,
          phases: [{ id: "weak-phase", title: "Weak", goal: "Demonstrate command quality", dependencies: [], allowedScope: ["**"], acceptanceCommands: ["node -e \"process.exit(0)\""], maxAttempts: 1 }]
        }
      }));
      const warnings = warned.commandQualityWarnings as Array<{ code: string }>;
      expect(warnings.map((warning) => warning.code)).toContain("weak-verification-category");
    } finally { await connection.close(); }

    const rejected = await linked({ validateAcceptanceCommand: (command) => { if (command !== "git diff --check") throw new Error(`not approved: ${command}`); } });
    try {
      const otherRoot = repository();
      await rejected.client.callTool({ name: "initialize_project", arguments: { project_root: otherRoot, prompt: "Create a verified plan." } });
      const result = await rejected.client.callTool({
        name: "save_plan",
        arguments: { project_root: otherRoot, contract, phases: [{ id: "unsafe-phase", title: "Unsafe", goal: "Demonstrate policy", dependencies: [], allowedScope: ["**"], acceptanceCommands: ["rm -rf /"], maxAttempts: 1 }] }
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("not approved");
    } finally { await rejected.close(); }
  });

  it("omits duplicate snapshots and expands graph or file detail only on demand", async () => {
    const root = repository();
    const connection = await linked();
    try {
      await connection.client.callTool({ name: "initialize_project", arguments: { project_root: root, prompt: "Build a tested feature and compact context." } });
      await connection.client.callTool({
        name: "save_plan",
        arguments: {
          project_root: root, contract,
          phases: [{ id: "feature", title: "Feature", goal: "Implement feature", dependencies: [], allowedScope: ["src/**"], acceptanceCommands: ["npx tsc --noEmit"], maxAttempts: 2 }]
        }
      });
      const first = resultJson(await connection.client.callTool({ name: "get_context", arguments: { project_root: root } }));
      expect(first.context).toEqual(expect.any(String));
      expect(first.snapshot).toBeUndefined();
      const unchanged = resultJson(await connection.client.callTool({ name: "get_context", arguments: { project_root: root, since_sequence: first.sequence } }));
      expect(unchanged).toMatchObject({ unchanged: true });
      expect(unchanged.context).toBeUndefined();
      const withSnapshot = resultJson(await connection.client.callTool({ name: "get_context", arguments: { project_root: root, include_snapshot: true } }));
      expect(withSnapshot.snapshot).toBeDefined();

      const graph = resultJson(await connection.client.callTool({ name: "expand_graph", arguments: { project_root: root, terms: ["feature"], limit: 20 } }));
      expect(graph.tier).toBe(1);
      expect((graph.nodes as unknown[]).length).toBeGreaterThan(0);
      const digest = resultJson(await connection.client.callTool({ name: "get_file_digest", arguments: { project_root: root, file_path: "src/feature.ts" } }));
      expect(digest.path).toBe("src/feature.ts");
      expect(digest.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: "feature", kind: "function" })]));
    } finally { await connection.close(); }
  });

  it("exercises resolver failures, annotations, workspace reads, budgets, approvals, and status branches", async () => {
    const root = repository();
    const connection = await linked({
      resolveProjectRoot: async (candidate) => {
        if (candidate.endsWith("blocked")) throw new Error("root blocked");
        return candidate;
      }
    });
    try {
      const tools = await connection.client.listTools();
      const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
      expect(byName.get("get_status")?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false });
      expect(byName.get("apply_patch")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });

      const blocked = await connection.client.callTool({ name: "get_status", arguments: { project_root: path.join(root, "blocked") } });
      expect(blocked.isError).toBe(true);
      expect(JSON.stringify(blocked.content)).toContain("root blocked");

      await connection.client.callTool({ name: "initialize_project", arguments: { project_root: root, prompt: "Create a verified plan and exercise MCP boundaries." } });
      await connection.client.callTool({
        name: "save_plan",
        arguments: {
          project_root: root,
          contract: { ...contract, budget: { maxTokens: 1000, maxCostUsd: 10, maxWallClockMs: 10000 }, playbookOptIn: false },
          phases: [{
            id: "feature", title: "Feature", goal: "Implement feature", dependencies: [], allowedScope: ["src/**"],
            acceptanceCommands: ["node --check src/feature.ts"], maxAttempts: 2, requiresApproval: true, approvalPrompt: "Proceed?"
          }]
        }
      });

      const files = resultJson(await connection.client.callTool({ name: "list_files", arguments: { project_root: root, max_files: 10 } }));
      expect(files.files).toEqual(expect.arrayContaining(["README.md", "src/feature.ts"]));
      const read = resultJson(await connection.client.callTool({ name: "read_file", arguments: { project_root: root, file_path: "src/feature.ts", start_line: 1, end_line: 2 } }));
      expect(read.content).toContain("feature");
      const search = resultJson(await connection.client.callTool({ name: "search_code", arguments: { project_root: root, query: "feature", max_results: 10 } }));
      expect((search.matches as unknown[]).length).toBeGreaterThan(0);
      const diff = resultJson(await connection.client.callTool({ name: "get_diff", arguments: { project_root: root, max_chars: 2000 } }));
      expect(diff.diff).toBe("");

      await connection.client.callTool({
        name: "record_budget_usage", arguments: {
          project_root: root, scope: "project", scope_id: "project", tokens: 10, estimated_tokens: 3, cost_usd: 0.25, wall_clock_ms: 50
        }
      });
      await connection.client.callTool({
        name: "record_budget_usage", arguments: { project_root: root, scope: "phase", scope_id: "feature" }
      });
      const approval = resultJson(await connection.client.callTool({
        name: "request_approval", arguments: { project_root: root, phase_id: "feature", prompt: "Proceed with feature?" }
      }));
      expect(approval.status).toBe("pending");
      const resolved = resultJson(await connection.client.callTool({
        name: "resolve_approval", arguments: { project_root: root, approval_id: approval.id, approved: true }
      }));
      expect(resolved.status).toBe("approved");

      const suggested = resultJson(await connection.client.callTool({ name: "suggest_phases", arguments: { project_root: root, query: "feature" } }));
      expect(suggested.enabled).toBe(false);
      const status = resultJson(await connection.client.callTool({ name: "get_status", arguments: { project_root: root } }));
      expect(status.project).toBeDefined();

      const invalidExpand = await connection.client.callTool({ name: "expand_graph", arguments: { project_root: root, terms: [], node_ids: [] } });
      expect(invalidExpand.isError).toBe(true);
      const unknownCheckpoint = await connection.client.callTool({ name: "checkpoint_phase", arguments: { project_root: root, phase_id: "missing", summary: "none" } });
      expect(unknownCheckpoint.isError).toBe(true);
      expect(JSON.stringify(unknownCheckpoint.content)).toContain("unknown phase");
    } finally { await connection.close(); }
  });

});
