import { handleHook } from "./hooks/handler.js";
import { runHttpMcpServer } from "./mcp/http.js";
import { runMcpServer } from "./mcp/server.js";
import { KeepCodingService } from "./core/service.js";
import { indexRepository } from "./core/indexer.js";
import { detectLargeProject } from "./core/detector.js";
import { runEvaluation } from "./eval/runner.js";
import { startDashboard } from "./dashboard/server.js";
import { generatePullRequestDescription } from "./integrations/github.js";

const VERSION = "0.2.1";
const [command = "help", argument] = process.argv.slice(2);

try {
  switch (command) {
    case "mcp": await runMcpServer(); break;
    case "mcp-http": await runHttpMcpServer(); break;
    case "hook": {
      const input = JSON.parse(await readStdin() || "{}") as Record<string, unknown>;
      process.stdout.write(`${JSON.stringify(await handleHook(argument ?? "", input))}\n`);
      break;
    }
    case "init": await withService(argument ?? process.cwd(), async (service) => service.initialize(await readStdin())); break;
    case "status": await withService(argument ?? process.cwd(), async (service) => service.store.snapshot()); break;
    case "context": await withService(argument ?? process.cwd(), async (service) => service.contextEnvelope()); break;
    case "index": await withService(argument ?? process.cwd(), async (service) => indexRepository(service.store, service.git)); break;
    case "impact": await withService(argument ?? process.cwd(), async (service) => service.impact(process.argv[4] ?? "")); break;
    case "detect": print(detectLargeProject(await readStdin(), { force: argument === "--force" })); break;
    case "pr-description": await withService(argument ?? process.cwd(), async (service) => ({ markdown: generatePullRequestDescription(service.store.snapshot()) })); break;
    case "dashboard": await dashboard(argument ?? process.cwd()); break;
    case "eval": print(await runEvaluation(argument ?? "keep-coding.eval.json")); break;
    case "--version":
    case "version": process.stdout.write(`${VERSION}\n`); break;
    default:
      process.stdout.write(`Keep Coding v${VERSION}\nUsage: keep-coding <mcp|mcp-http|hook|init|status|context|index|impact|detect|dashboard|pr-description|eval|version> [path]\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function dashboard(root: string): Promise<void> {
  const service = await KeepCodingService.open(root);
  const handle = await startDashboard(
    service.store,
    process.env.KEEP_CODING_DASHBOARD_HOST ?? "127.0.0.1",
    Number(process.env.KEEP_CODING_DASHBOARD_PORT ?? "0")
  );
  process.stdout.write(`${handle.url}\n`);
  const stop = async (): Promise<void> => { await handle.close(); service.close(); };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}

async function withService(root: string, operation: (service: KeepCodingService) => Promise<unknown>): Promise<void> {
  const service = await KeepCodingService.open(root);
  try { print(await operation(service)); }
  finally { service.close(); }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) value += chunk as string;
  return value;
}
function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
