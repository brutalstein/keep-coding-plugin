import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { KeepCodingService } from "../core/service.js";

export interface DashboardHandle {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startDashboard(projectRoot: string, port = 0, host = "127.0.0.1"): Promise<DashboardHandle> {
  if (!isLoopback(host)) throw new Error("dashboard is loopback-only; use 127.0.0.1, ::1, or localhost");
  const server = createServer((request, response) => {
    void handleRequest(projectRoot, request, response);
  });
  await listen(server, port, host);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("dashboard did not bind a TCP address");
  const displayHost = host === "::1" ? "[::1]" : host;
  return {
    host,
    port: address.port,
    url: `http://${displayHost}:${address.port}`,
    close: () => close(server)
  };
}

async function handleRequest(projectRoot: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'");
    if (request.method !== "GET") {
      response.writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "GET" });
      response.end(JSON.stringify({ error: "read-only dashboard" }));
      return;
    }
    if (request.url === "/api/status") {
      const service = await KeepCodingService.open(projectRoot);
      try {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(service.store.snapshot()));
      } finally {
        service.close();
      }
      return;
    }
    if (request.url === "/" || request.url === "/index.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(DASHBOARD_HTML);
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "not found" }));
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function isLoopback(host: string): boolean {
  return ["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase());
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Keep Coding Dashboard</title>
<style>
:root{font-family:ui-sans-serif,system-ui,sans-serif;color-scheme:dark;background:#0b1020;color:#e6edf7}body{margin:0;padding:24px}header{display:flex;justify-content:space-between;gap:16px;align-items:center}h1,h2{margin:.2rem 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-top:20px}.card{background:#141b2d;border:1px solid #27324d;border-radius:12px;padding:16px}.phase{padding:10px 0;border-bottom:1px solid #27324d}.phase:last-child{border:0}.muted{color:#9aa8c3}.status{font-weight:700}.bar{height:8px;background:#27324d;border-radius:8px;overflow:hidden}.bar>span{display:block;height:100%;background:#78a9ff}pre{white-space:pre-wrap;max-height:360px;overflow:auto;font-size:12px}button{background:#27324d;color:inherit;border:0;border-radius:8px;padding:8px 12px;cursor:pointer}</style>
</head>
<body>
<header><div><h1>Keep Coding</h1><div id="project" class="muted">Loading…</div></div><button id="refresh">Refresh</button></header>
<div class="grid">
<section class="card"><h2>Phase DAG</h2><div id="phases"></div></section>
<section class="card"><h2>Budget & Evidence</h2><div id="evidence"></div></section>
<section class="card"><h2>Approvals</h2><div id="approvals"></div></section>
<section class="card"><h2>Event stream</h2><pre id="events"></pre></section>
</div>
<script>
const byId=id=>document.getElementById(id);const text=(tag,value,cls)=>{const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e};
async function load(){const response=await fetch('/api/status',{cache:'no-store'});if(!response.ok)throw new Error(await response.text());const data=await response.json();byId('project').textContent=data.project.status+' · plan v'+data.project.planVersion+' · '+data.project.root;
const phases=byId('phases');phases.replaceChildren(...data.phases.map(p=>{const e=text('div','', 'phase');e.append(text('div',p.id+' — '+p.title));e.append(text('div',p.status+' · attempts '+p.attempts+'/'+p.maxAttempts,'muted status'));e.append(text('div','depends: '+(p.dependencies.join(', ')||'none'),'muted'));return e}));
const checkpoints=data.checkpoints.slice(-8).reverse();const evidence=byId('evidence');evidence.replaceChildren(...checkpoints.map(c=>{const e=text('div','', 'phase');const v=c.verification;e.append(text('div',c.phaseId+' · '+(v.passed?'passed':'failed')));e.append(text('div','files '+c.changedFiles.length+' · secrets '+(v.secretFindings?.length||0)+' · tests '+(v.impactedTests?.length||0),'muted'));if(v.budget){const limit=v.budget.limits.maxWallClockMs||1;const used=v.budget.usage.wallClockMs||0;const b=text('div','', 'bar');const span=document.createElement('span');span.style.width=Math.min(100,used/limit*100)+'%';b.append(span);e.append(b)}return e}));
const approvals=byId('approvals');approvals.replaceChildren(...data.approvals.map(a=>text('div',a.status+' · '+a.question,'phase')));byId('events').textContent=data.recentEvents.map(e=>'#'+e.sequence+' '+e.type+(e.phaseId?' ['+e.phaseId+']':'')+' '+JSON.stringify(e.payload)).join('\n');}
byId('refresh').onclick=()=>load().catch(error=>byId('project').textContent=error.message);load().catch(error=>byId('project').textContent=error.message);setInterval(()=>load().catch(()=>{}),5000);
</script>
</body></html>`;
