import { createServer, type Server } from "node:http";
import type { ProjectSnapshot } from "../domain/model.js";
import type { ProjectStore } from "../storage/store.js";

export interface DashboardHandle { url: string; close(): Promise<void> }

export function renderDashboard(snapshot: ProjectSnapshot): string {
  const phaseRows = snapshot.phases.map((phase) => `<tr><td>${escapeHtml(phase.id)}</td><td>${escapeHtml(phase.status)}</td><td>${escapeHtml(phase.title)}</td><td>${phase.attempts}/${phase.maxAttempts}</td></tr>`).join("");
  const events = snapshot.recentEvents.slice(-50).reverse().map((event) => `<li><code>#${event.sequence}</code> ${escapeHtml(event.type)} ${event.phaseId ? `(${escapeHtml(event.phaseId)})` : ""}</li>`).join("");
  const budget = Object.entries(snapshot.budgetUsage).map(([scope, usage]) => `<li>${escapeHtml(scope)}: ${usage.tokens} tokens, $${usage.costUsd.toFixed(4)}, ${usage.wallClockMs} ms</li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Keep Coding</title><style>body{font:14px system-ui;margin:32px;max-width:1200px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:8px;text-align:left}code{background:#eee;padding:2px 4px}</style></head><body><h1>Keep Coding</h1><p><b>${escapeHtml(snapshot.project.status)}</b> · plan v${snapshot.project.planVersion}</p><h2>Phase DAG</h2><table><thead><tr><th>ID</th><th>Status</th><th>Goal</th><th>Attempts</th></tr></thead><tbody>${phaseRows}</tbody></table><h2>Budget burn</h2><ul>${budget || "<li>No usage recorded</li>"}</ul><h2>Event stream</h2><ol>${events}</ol></body></html>`;
}

export async function startDashboard(store: ProjectStore, host = "127.0.0.1", port = 0): Promise<DashboardHandle> {
  if (!isLoopback(host)) throw new Error("dashboard must bind to a loopback address");
  const server = createServer((request, response) => {
    if (request.method !== "GET" || (request.url !== "/" && request.url !== "/snapshot.json")) { response.writeHead(404).end("Not found"); return; }
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/snapshot.json") {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify(store.snapshot()));
    } else {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(renderDashboard(store.snapshot()));
    }
  });
  await listen(server, host, port);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("dashboard address unavailable");
  return { url: `http://${host}:${address.port}/`, close: () => close(server) };
}

function isLoopback(host: string): boolean { return host === "127.0.0.1" || host === "::1" || host === "localhost"; }
function listen(server: Server, host: string, port: number): Promise<void> { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => resolve()); }); }
function close(server: Server): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character); }
