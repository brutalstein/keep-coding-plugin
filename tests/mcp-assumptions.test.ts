import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/mcp/server.js";
import { PlatformStore } from "../src/storage/platform-store.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-mcp-assumptions-"));
  roots.push(root);
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "export.js"), "export function exportData() { return ''; }\n");
  writeFileSync(path.join(root, "package.json"), '{"type":"module","scripts":{"test":"node --check src/export.js"}}\n');
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Keep Coding Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

async function linked(): Promise<{ client: Client; close(): Promise<void> }> {
  const server = createServer({});
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

async function initialize(client: Client, root: string): Promise<void> {
  await client.callTool({ name: "initialize_project", arguments: { project_root: root, prompt: "Build export endpoint" } });
}

async function plan(client: Client, root: string): Promise<void> {
  await client.callTool({
    name: "save_plan", arguments: {
      project_root: root,
      contract: { goal: "Deliver a tested export endpoint", nonGoals: [], constraints: [], deliverables: ["export"], invariants: [], doneWhen: ["npm test passes"] },
      phases: [{ id: "export", title: "Export", goal: "Implement export", dependencies: [], allowedScope: ["src/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 }]
    }
  });
  await client.callTool({ name: "start_phase", arguments: { project_root: root, phase_id: "export" } });
}

async function record(client: Client, root: string, confidence = 0.9, phaseId: string | null = null): Promise<string> {
  const result = resultJson(await client.callTool({
    name: "record_assumption", arguments: { project_root: root, phase_id: phaseId, statement: "Export returns CSV", confidence, alternatives: [] }
  }));
  return String(result.assumption_id);
}

describe("assumption ledger MCP tools", () => {
  it("records, links, and invalidates an assumption with the correct blast radius", async () => {
    const root = repository(); const connection = await linked();
    try {
      await initialize(connection.client, root);
      const id = await record(connection.client, root);
      const linkedResult = resultJson(await connection.client.callTool({ name: "link_assumption", arguments: { project_root: root, assumption_id: id, node_ids: ["file:src/export.js"] } }));
      expect(linkedResult.linked).toBe(1);
      const invalidated = resultJson(await connection.client.callTool({ name: "invalidate_assumption", arguments: { project_root: root, assumption_id: id, root_cause: "Actual requirement was JSON" } }));
      expect((invalidated.blast_radius as { files: string[] }).files).toContain("src/export.js");
      expect(invalidated.blast_radius_size).toBeGreaterThan(0);
    } finally { await connection.close(); }
  });

  it("rejects a second invalidation", async () => {
    const root = repository(); const connection = await linked();
    try {
      await initialize(connection.client, root); const id = await record(connection.client, root);
      await connection.client.callTool({ name: "invalidate_assumption", arguments: { project_root: root, assumption_id: id, root_cause: "first" } });
      const second = await connection.client.callTool({ name: "invalidate_assumption", arguments: { project_root: root, assumption_id: id, root_cause: "second" } });
      expect(second.isError).toBe(true);
      expect(JSON.stringify(second.content)).toContain("already invalidated");
    } finally { await connection.close(); }
  });

  it("confirms an assumption and rejects later invalidation", async () => {
    const root = repository(); const connection = await linked();
    try {
      await initialize(connection.client, root); const id = await record(connection.client, root);
      const confirmed = resultJson(await connection.client.callTool({ name: "confirm_assumption", arguments: { project_root: root, assumption_id: id, evidence: "user confirmed CSV" } }));
      expect(confirmed.status).toBe("confirmed");
      const invalidated = await connection.client.callTool({ name: "invalidate_assumption", arguments: { project_root: root, assumption_id: id, root_cause: "wrong" } });
      expect(invalidated.isError).toBe(true);
    } finally { await connection.close(); }
  });

  it("auto-links changed files when exactly one open phase assumption exists", async () => {
    const root = repository(); const connection = await linked();
    try {
      await initialize(connection.client, root); await plan(connection.client, root);
      const id = await record(connection.client, root, 0.9, "export");
      writeFileSync(path.join(root, "src", "export.js"), "export function exportData() { return 'csv'; }\n");
      const checkpoint = resultJson(await connection.client.callTool({ name: "checkpoint_phase", arguments: { project_root: root, phase_id: "export", summary: "implemented export" } }));
      expect((checkpoint.evidence as { passed: boolean }).passed).toBe(true);
      const store = new PlatformStore(root);
      try { expect(store.getEdgesFrom(id, "depends_on_assumption").map((edge) => edge.targetId)).toContain("file:src/export.js"); }
      finally { store.close(); }
    } finally { await connection.close(); }
  });

  it("does not auto-link under two-assumption ambiguity", async () => {
    const root = repository(); const connection = await linked();
    try {
      await initialize(connection.client, root); await plan(connection.client, root);
      const first = await record(connection.client, root, 0.9, "export");
      const second = resultJson(await connection.client.callTool({ name: "record_assumption", arguments: { project_root: root, phase_id: "export", statement: "Export uses UTF-8", confidence: 0.9, alternatives: [] } }));
      writeFileSync(path.join(root, "src", "export.js"), "export function exportData() { return 'csv'; }\n");
      await connection.client.callTool({ name: "checkpoint_phase", arguments: { project_root: root, phase_id: "export", summary: "implemented export" } });
      const store = new PlatformStore(root);
      try {
        expect(store.getEdgesFrom(first, "depends_on_assumption")).toEqual([]);
        expect(store.getEdgesFrom(String(second.assumption_id), "depends_on_assumption")).toEqual([]);
      } finally { store.close(); }
    } finally { await connection.close(); }
  });

  it("rejects confidence outside [0,1] at the MCP boundary", async () => {
    const root = repository(); const connection = await linked();
    try {
      await initialize(connection.client, root);
      const result = await connection.client.callTool({ name: "record_assumption", arguments: { project_root: root, phase_id: null, statement: "x", confidence: 2, alternatives: [] } });
      expect(result.isError).toBe(true);
    } finally { await connection.close(); }
  });

  it("rejects an empty correction expansion justification", async () => {
    const root = repository(); const connection = await linked();
    try {
      await initialize(connection.client, root); const id = await record(connection.client, root);
      await connection.client.callTool({ name: "link_assumption", arguments: { project_root: root, assumption_id: id, node_ids: ["file:src/export.js"] } });
      const correction = resultJson(await connection.client.callTool({ name: "invalidate_assumption", arguments: { project_root: root, assumption_id: id, root_cause: "JSON required" } }));
      const result = await connection.client.callTool({ name: "expand_correction_scope", arguments: { project_root: root, correction_id: correction.correction_id, additional_node_ids: ["file:src/export.js"], justification: "" } });
      expect(result.isError).toBe(true);
    } finally { await connection.close(); }
  });
});
