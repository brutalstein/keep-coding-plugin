import { timingSafeEqual } from "node:crypto";
import { createServer as createNodeServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer as createKeepCodingServer } from "./server.js";
import { createAllowedRootResolver, parseAllowedRoots } from "./root-policy.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_ENDPOINT = "/mcp";
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export interface HttpMcpConfig {
  host: string;
  port: number;
  endpointPath: string;
  allowedRoots: string[];
  allowedHosts: string[];
  allowedCommands: string[];
  bearerToken?: string;
  maxBodyBytes: number;
}

export interface HttpMcpRuntime {
  server: Server;
  close: () => Promise<void>;
}

export function loadHttpMcpConfig(env: NodeJS.ProcessEnv = process.env): HttpMcpConfig {
  const host = env.KEEP_CODING_HTTP_HOST?.trim() || DEFAULT_HOST;
  const port = parsePort(env.KEEP_CODING_HTTP_PORT ?? env.PORT);
  const endpointPath = normalizeEndpoint(env.KEEP_CODING_HTTP_PATH);
  const allowedRoots = parseAllowedRoots(env.KEEP_CODING_ALLOWED_ROOTS);
  if (allowedRoots.length === 0) {
    throw new Error("KEEP_CODING_ALLOWED_ROOTS is required for mcp-http");
  }
  const configuredHosts = splitCommaSeparated(env.KEEP_CODING_ALLOWED_HOSTS);
  const allowedHosts = configuredHosts.length > 0 ? configuredHosts : defaultAllowedHosts(host);
  const allowedCommands = parseAllowedCommands(env.KEEP_CODING_ALLOWED_COMMANDS_JSON);
  if (allowedCommands.length === 0) {
    throw new Error("KEEP_CODING_ALLOWED_COMMANDS_JSON must contain at least one exact acceptance command");
  }
  const bearerToken = env.KEEP_CODING_BEARER_TOKEN?.trim() || undefined;
  if (!isLoopbackHost(host) && bearerToken === undefined) {
    throw new Error("KEEP_CODING_BEARER_TOKEN is required when mcp-http binds to a non-loopback host");
  }
  return {
    host,
    port,
    endpointPath,
    allowedRoots,
    allowedHosts,
    allowedCommands,
    ...(bearerToken !== undefined && { bearerToken }),
    maxBodyBytes: parsePositiveInteger(env.KEEP_CODING_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES, "KEEP_CODING_MAX_BODY_BYTES")
  };
}

export async function createHttpMcpServer(config: HttpMcpConfig): Promise<HttpMcpRuntime> {
  const resolveProjectRoot = await createAllowedRootResolver(config.allowedRoots);
  const allowedHosts = new Set(config.allowedHosts.map(normalizeHost).filter(Boolean));
  if (allowedHosts.size === 0) throw new Error("At least one allowed HTTP Host is required");

  const allowedCommands = new Set(config.allowedCommands);
  const validateAcceptanceCommand = (command: string) => {
    if (!allowedCommands.has(command)) {
      throw new Error(`acceptance command is not operator-approved: ${command}`);
    }
  };
  const handler = createMcpHandler(
    () => createKeepCodingServer({ resolveProjectRoot, validateAcceptanceCommand }),
    { onerror: (error) => process.stderr.write(`[keep-coding:mcp-http] ${error.message}\n`) }
  );

  const server = createNodeServer(async (request, response) => {
    try {
      if (!isAllowedHost(request, allowedHosts)) {
        sendJson(response, 421, { error: "Misdirected request" });
        return;
      }
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/healthz" && request.method === "GET") {
        sendJson(response, 200, { status: "ok", service: "keep-coding" });
        return;
      }
      if (pathname !== config.endpointPath) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      if (!isAuthorized(request, config.bearerToken)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }
      const body = await readBody(request, config.maxBodyBytes);
      const webRequest = toWebRequest(request, body);
      const webResponse = await handler.fetch(webRequest);
      await writeWebResponse(response, webResponse);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        sendJson(response, 413, { error: error.message });
        return;
      }
      process.stderr.write(`[keep-coding:mcp-http] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      sendJson(response, 500, { error: "Internal server error" });
    }
  });

  return {
    server,
    close: async () => {
      await closeNodeServer(server);
      await handler.close();
    }
  };
}

export async function runHttpMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadHttpMcpConfig(env);
  const runtime = await createHttpMcpServer(config);
  await new Promise<void>((resolve, reject) => {
    runtime.server.once("error", reject);
    runtime.server.listen(config.port, config.host, () => {
      runtime.server.off("error", reject);
      resolve();
    });
  });
  process.stderr.write(`Keep Coding MCP HTTP listening on http://${config.host}:${config.port}${config.endpointPath}\n`);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void runtime.close().catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function toWebRequest(request: IncomingMessage, body: string | undefined): Request {
  const method = (request.method ?? "GET").toUpperCase();
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else headers.set(name, value);
  }
  return new Request(new URL(request.url ?? "/", "http://localhost"), {
    method,
    headers,
    ...(body !== undefined && method !== "GET" && method !== "HEAD" && { body })
  });
}

async function writeWebResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, name) => { headers[name] = value; });
  response.writeHead(webResponse.status, headers);
  if (webResponse.body === null) {
    response.end();
    return;
  }
  const reader = webResponse.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!response.write(value)) await waitForDrain(response);
    }
  } finally {
    reader.releaseLock();
  }
  response.end();
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new PayloadTooLargeError(maxBytes);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new PayloadTooLargeError(maxBytes);
    chunks.push(buffer);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks).toString("utf8");
}

function isAuthorized(request: IncomingMessage, bearerToken: string | undefined): boolean {
  if (bearerToken === undefined) return true;
  const provided = request.headers.authorization ?? "";
  const expected = `Bearer ${bearerToken}`;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

function isAllowedHost(request: IncomingMessage, allowedHosts: Set<string>): boolean {
  const header = request.headers.host;
  return typeof header === "string" && allowedHosts.has(normalizeHost(header));
}

function normalizeHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    return close >= 0 ? trimmed.slice(1, close) : trimmed;
  }
  const colon = trimmed.lastIndexOf(":");
  return colon > -1 && trimmed.indexOf(":") === colon ? trimmed.slice(0, colon) : trimmed;
}

function defaultAllowedHosts(bindHost: string): string[] {
  if (bindHost === "0.0.0.0" || bindHost === "::") {
    throw new Error("KEEP_CODING_ALLOWED_HOSTS is required for wildcard HTTP bindings");
  }
  return Array.from(new Set([bindHost, "localhost", "127.0.0.1", "::1"]));
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function normalizeEndpoint(value: string | undefined): string {
  const endpoint = value?.trim() || DEFAULT_ENDPOINT;
  if (!endpoint.startsWith("/") || endpoint.includes("?") || endpoint.includes("#")) {
    throw new Error("KEEP_CODING_HTTP_PATH must be an absolute URL path");
  }
  return path.posix.normalize(endpoint);
}

function parsePort(value: string | undefined): number {
  return parsePositiveInteger(value, DEFAULT_PORT, "KEEP_CODING_HTTP_PORT", 65_535);
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${name} must be an integer between 1 and ${max}`);
  return parsed;
}

export function parseAllowedCommands(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("KEEP_CODING_ALLOWED_COMMANDS_JSON must be a JSON array of exact command strings");
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || entry.trim() === "" || entry !== entry.trim())) {
    throw new Error("KEEP_CODING_ALLOWED_COMMANDS_JSON must be a JSON array of non-empty, trimmed command strings");
  }
  return [...new Set(parsed)];
}

function splitCommaSeparated(value: string | undefined): string[] {
  return value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(payload)) });
  response.end(payload);
}

function waitForDrain(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => response.once("drain", resolve));
}

function closeNodeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

class PayloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
  }
}
