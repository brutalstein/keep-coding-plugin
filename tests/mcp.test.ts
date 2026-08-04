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
        "apply_patch", "record_decision", "record_failure", "checkpoint_phase", "get_status", "complete_project"
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
});
