import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import type { KeepCodingService } from "../core/service.js";
import { KeepCodingService as Service } from "../core/service.js";

const rootSchema = z.object({ project_root: z.string().min(1).describe("Absolute path inside the target Git repository") });
const phaseDefinition = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  title: z.string().min(1),
  goal: z.string().min(1),
  dependencies: z.array(z.string()),
  allowedScope: z.array(z.string()).describe("Minimatch globs for files this phase may change"),
  acceptanceCommands: z.array(z.string().min(1)).min(1),
  maxAttempts: z.number().int().min(1).max(10).default(3)
});
const contractSchema = z.object({
  goal: z.string().min(10),
  nonGoals: z.array(z.string()),
  constraints: z.array(z.string()),
  deliverables: z.array(z.string()).min(1),
  invariants: z.array(z.string()),
  doneWhen: z.array(z.string()).min(1)
});

export function createServer(): McpServer {
  const server = new McpServer({ name: "keep-coding", version: "0.1.0" });
  register(server, "initialize_project", "Initialize durable project memory and index the repository before planning.", rootSchema.extend({ prompt: z.string().min(1) }),
    async (service, input) => service.initialize(input.prompt));
  register(server, "save_plan", "Save the measurable project contract and dependency-aware phase plan.", rootSchema.extend({ contract: contractSchema, phases: z.array(phaseDefinition).min(1) }),
    async (service, input) => service.savePlan(input.contract, input.phases));
  register(server, "get_context", "Get the compact current contract, active phase, decisions, failures and relevant code graph.", rootSchema.extend({ max_chars: z.number().int().min(1_000).max(30_000).optional() }),
    async (service, input) => ({ context: service.context(input.max_chars), snapshot: service.store.snapshot() }));
  register(server, "start_phase", "Start exactly one ready phase after its dependencies are verified.", rootSchema.extend({ phase_id: z.string().min(1) }),
    async (service, input) => service.startPhase(input.phase_id));
  register(server, "record_decision", "Persist an architectural or product decision for future phases.", rootSchema.extend({ phase_id: z.string().nullable().default(null), title: z.string().min(1), rationale: z.string().min(1), alternatives: z.array(z.string()).default([]) }),
    async (service, input) => service.store.recordDecision({ phaseId: input.phase_id, title: input.title, rationale: input.rationale, alternatives: input.alternatives }));
  register(server, "record_failure", "Record and deduplicate a failed approach so later attempts do not repeat it.", rootSchema.extend({ phase_id: z.string().min(1), summary: z.string().min(1), fingerprint: z.string().optional() }),
    async (service, input) => service.store.recordFailure(input.phase_id, input.summary, input.fingerprint));
  register(server, "checkpoint_phase", "Run scope and acceptance gates, persist evidence, and unlock dependent phases only on success.", rootSchema.extend({ phase_id: z.string().min(1), summary: z.string().min(1) }),
    async (service, input) => service.checkpoint(input.phase_id, input.summary));
  register(server, "get_status", "Return the full durable project snapshot.", rootSchema,
    async (service) => service.store.snapshot());
  register(server, "complete_project", "Mark the project complete only after every phase has a passing checkpoint.", rootSchema,
    async (service) => service.store.completeProject());
  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

function register<Schema extends z.ZodObject<z.ZodRawShape>>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Schema,
  operation: (service: KeepCodingService, input: z.output<Schema>) => Promise<unknown>
): void {
  const config = {
    description,
    inputSchema,
    annotations: { readOnlyHint: ["get_context", "get_status"].includes(name), destructiveHint: false, idempotentHint: ["initialize_project", "get_context", "get_status"].includes(name) }
  };
  const handler = async (rawInput: unknown) => {
    let service: KeepCodingService | null = null;
    try {
      const input = inputSchema.parse(rawInput);
      service = await Service.open(String(input.project_root));
      const result = await operation(service, input);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
    } finally {
      service?.close();
    }
  };
  // SDK v2's generic overload cannot preserve a dynamically composed Zod object,
  // but runtime validation still occurs above before the operation is invoked.
  server.registerTool(name, config as never, handler as never);
}
