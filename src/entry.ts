import { handleHook } from "./hooks/handler.js";
import { runHttpMcpServer } from "./mcp/http.js";
import { runMcpServer } from "./mcp/server.js";
import { KeepCodingService } from "./core/service.js";
import { indexRepository } from "./core/indexer.js";
import { runEvaluation } from "./eval/runner.js";

const [command = "help", argument] = process.argv.slice(2);

try {
  switch (command) {
    case "mcp":
      await runMcpServer();
      break;
    case "mcp-http":
      await runHttpMcpServer();
      break;
    case "hook": {
      const input = JSON.parse(await readStdin() || "{}") as Record<string, unknown>;
      process.stdout.write(`${JSON.stringify(await handleHook(argument ?? "", input))}\n`);
      break;
    }
    case "init":
      await withService(argument ?? process.cwd(), async (service) => service.initialize(await readStdin()));
      break;
    case "status":
      await withService(argument ?? process.cwd(), async (service) => service.store.snapshot());
      break;
    case "context":
      await withService(argument ?? process.cwd(), async (service) => ({ context: service.context() }));
      break;
    case "index":
      await withService(argument ?? process.cwd(), async (service) => indexRepository(service.store, service.git));
      break;
    case "eval":
      print(await runEvaluation(argument ?? "keep-coding.eval.json"));
      break;
    case "--version":
    case "version":
      process.stdout.write("0.1.0\n");
      break;
    default:
      process.stdout.write("Keep Coding v0.1.0\nUsage: keep-coding <mcp|mcp-http|hook|init|status|context|index|eval|version> [path]\n");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function withService(root: string, operation: (service: KeepCodingService) => Promise<unknown>): Promise<void> {
  const service = await KeepCodingService.open(root);
  try {
    print(await operation(service));
  } finally {
    service.close();
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) value += chunk as string;
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
