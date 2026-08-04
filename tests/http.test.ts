import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
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

  it("normalizes loopback defaults and rejects malformed numeric or path settings", () => {
    const base = { KEEP_CODING_ALLOWED_ROOTS: "/workspace", KEEP_CODING_ALLOWED_COMMANDS_JSON: '["git diff --check"]' };
    const defaults = loadHttpMcpConfig(base);
    expect(defaults).toMatchObject({ host: "127.0.0.1", port: 8787, endpointPath: "/mcp", maxBodyBytes: 1_048_576 });
    expect(defaults.allowedHosts).toEqual(expect.arrayContaining(["localhost", "127.0.0.1", "::1"]));
    expect(loadHttpMcpConfig({ ...base, KEEP_CODING_HTTP_HOST: "::1", KEEP_CODING_HTTP_PATH: "/custom/../mcp", KEEP_CODING_HTTP_PORT: "4321", KEEP_CODING_MAX_BODY_BYTES: "2048" }))
      .toMatchObject({ host: "::1", endpointPath: "/mcp", port: 4321, maxBodyBytes: 2048 });
    expect(() => loadHttpMcpConfig({ ...base, KEEP_CODING_HTTP_PATH: "mcp" })).toThrow("absolute URL path");
    expect(() => loadHttpMcpConfig({ ...base, KEEP_CODING_HTTP_PATH: "/mcp?x=1" })).toThrow("absolute URL path");
    expect(() => loadHttpMcpConfig({ ...base, KEEP_CODING_HTTP_PORT: "0" })).toThrow("between 1 and 65535");
    expect(() => loadHttpMcpConfig({ ...base, KEEP_CODING_HTTP_PORT: "70000" })).toThrow("between 1 and 65535");
    expect(() => loadHttpMcpConfig({ ...base, KEEP_CODING_MAX_BODY_BYTES: "1.5" })).toThrow("must be an integer");
    expect(parseAllowedCommands(undefined)).toEqual([]);
    expect(parseAllowedCommands("   ")).toEqual([]);
    expect(() => parseAllowedCommands('["", "npm test"]')).toThrow("trimmed command strings");
  });

  it("rejects empty host policy and closes cleanly before listening", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "keep-coding-http-empty-host-"));
    try {
      await expect(createHttpMcpServer({
        host: "127.0.0.1", port: 0, endpointPath: "/mcp", allowedRoots: [root], allowedHosts: ["  "],
        allowedCommands: ["git diff --check"], maxBodyBytes: 512
      })).rejects.toThrow("At least one allowed HTTP Host");
      const runtime = await createHttpMcpServer({
        host: "127.0.0.1", port: 0, endpointPath: "/mcp", allowedRoots: [root], allowedHosts: ["localhost"],
        allowedCommands: ["git diff --check"], maxBodyBytes: 512
      });
      await runtime.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
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

      await expect(requestStatus(port, "/healthz", "evil.example")).resolves.toBe(421);
      await expect(requestStatus(port, "/missing", "127.0.0.1")).resolves.toBe(404);
      await expect(requestStatusWithoutHost(port, "/healthz")).resolves.toBe(400);

      const wrongLengthAuth = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer x" }, body: "{}" });
      expect(wrongLengthAuth.status).toBe(401);
      const sameLengthWrongAuth = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer test-tokem" }, body: "{}" });
      expect(sameLengthWrongAuth.status).toBe(401);

      const unauthorized = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");

      const oversized = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ value: "x".repeat(600) })
      });
      expect(oversized.status).toBe(413);
      const chunkedOversized = await chunkedStatus(port, "/mcp", "127.0.0.1", "Bearer test-token", ["x".repeat(300), "y".repeat(300)]);
      expect(chunkedOversized).toBe(413);
      const getEndpoint = await fetch(`${base}/mcp`, { headers: { authorization: "Bearer test-token", accept: "application/json, text/event-stream" } });
      expect(getEndpoint.status).toBeGreaterThanOrEqual(400);

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

function requestStatus(port: number, pathname: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path: pathname, method: "GET", headers: { host } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

function requestStatusWithoutHost(port: number, pathname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path: pathname, method: "GET", setHost: false }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

function chunkedStatus(port: number, pathname: string, host: string, authorization: string, chunks: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1", port, path: pathname, method: "POST",
      headers: { host, authorization, "content-type": "application/json", "transfer-encoding": "chunked" }
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}
