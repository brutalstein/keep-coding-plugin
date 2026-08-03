import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpMcpServer, loadHttpMcpConfig, parseAllowedCommands, type HttpMcpRuntime } from "../src/mcp/http.js";

const runtimes: HttpMcpRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe("ChatGPT remote MCP transport", () => {
  it("requires secure configuration for network bindings", () => {
    const base = { KEEP_CODING_ALLOWED_ROOTS: "/workspace", KEEP_CODING_ALLOWED_COMMANDS_JSON: '["git diff --check"]' };
    expect(() => loadHttpMcpConfig({ ...base, KEEP_CODING_HTTP_HOST: "0.0.0.0", KEEP_CODING_ALLOWED_HOSTS: "mcp.example.com" }))
      .toThrow("KEEP_CODING_BEARER_TOKEN");
    expect(() => loadHttpMcpConfig({ ...base, KEEP_CODING_HTTP_HOST: "0.0.0.0", KEEP_CODING_BEARER_TOKEN: "secret" }))
      .toThrow("KEEP_CODING_ALLOWED_HOSTS");
    expect(() => loadHttpMcpConfig({ KEEP_CODING_ALLOWED_COMMANDS_JSON: '["git diff --check"]' })).toThrow("KEEP_CODING_ALLOWED_ROOTS");
    expect(() => loadHttpMcpConfig({ KEEP_CODING_ALLOWED_ROOTS: "/workspace" })).toThrow("KEEP_CODING_ALLOWED_COMMANDS_JSON");
  });

  it("parses exact operator-approved commands", () => {
    expect(parseAllowedCommands('["npm test","git diff --check","npm test"]')).toEqual(["npm test", "git diff --check"]);
    expect(() => parseAllowedCommands("npm test")).toThrow("JSON array");
    expect(() => parseAllowedCommands('[" npm test"]')).toThrow("trimmed command strings");
  });

  it("serves health, enforces bearer auth, limits bodies, and negotiates MCP", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "keep-coding-http-"));
    try {
      const runtime = await createHttpMcpServer({
        host: "127.0.0.1",
        port: 0,
        endpointPath: "/mcp",
        allowedRoots: [root],
        allowedHosts: ["127.0.0.1"],
        allowedCommands: ["git diff --check"],
        bearerToken: "test-token",
        maxBodyBytes: 512
      });
      runtimes.push(runtime);
      await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
      const port = (runtime.server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok", service: "keep-coding" });

      const wrongHost = await fetch(`${base}/healthz`, { headers: { host: "evil.example" } });
      expect(wrongHost.status).toBe(421);

      const unauthorized = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");

      const oversized = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ value: "x".repeat(600) })
      });
      expect(oversized.status).toBe(413);

      const initialized = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          accept: "application/json, text/event-stream",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "keep-coding-http-test", version: "1.0.0" }
          }
        })
      });
      expect(initialized.status).toBe(200);
      expect(await initialized.text()).toContain("keep-coding");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
