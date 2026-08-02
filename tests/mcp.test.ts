import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/mcp/server.js";

describe("MCP protocol", () => {
  it("negotiates and exposes the complete workflow", async () => {
    const server = createServer();
    const client = new Client({ name: "keep-coding-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "initialize_project", "save_plan", "get_context", "start_phase", "record_decision",
      "record_failure", "checkpoint_phase", "get_status", "complete_project"
    ]);
    await client.close();
    await server.close();
  });
});

