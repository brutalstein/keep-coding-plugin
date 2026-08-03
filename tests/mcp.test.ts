import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/mcp/server.js";

describe("MCP protocol", () => {
  it("negotiates and exposes the complete local and remote workflow", async () => {
    const server = createServer();
    const client = new Client({ name: "keep-coding-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "initialize_project", "save_plan", "amend_plan", "get_context", "start_phase", "list_files", "read_file",
      "search_code", "get_diff", "get_impact", "apply_patch", "record_decision", "record_failure",
      "request_approval", "resolve_approval", "checkpoint_phase", "restore_phase", "prepare_parallel_phases",
      "merge_parallel_phase", "discard_parallel_phase", "suggest_phases", "get_status", "complete_project"
    ]);
    await client.close();
    await server.close();
  });

  it("enforces the operator acceptance-command allowlist", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "keep-coding-mcp-command-"));
    writeFileSync(path.join(root, "README.md"), "test\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Keep Coding Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });

    const server = createServer({
      validateAcceptanceCommand: (command) => {
        if (command !== "git diff --check") throw new Error(`not approved: ${command}`);
      }
    });
    const client = new Client({ name: "keep-coding-command-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      await client.callTool({ name: "initialize_project", arguments: { project_root: root, prompt: "Create a verified plan for this repository." } });
      const result = await client.callTool({
        name: "save_plan",
        arguments: {
          project_root: root,
          contract: {
            goal: "Create a verified plan for the repository.",
            nonGoals: [], constraints: [], deliverables: ["Plan"], invariants: [], doneWhen: ["Checks pass"]
          },
          phases: [{
            id: "unsafe-phase", title: "Unsafe", goal: "Demonstrate command policy", dependencies: [],
            allowedScope: ["**"], acceptanceCommands: ["rm -rf /"], maxAttempts: 1
          }]
        }
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("not approved");
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
