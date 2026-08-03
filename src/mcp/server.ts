import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import type { KeepCodingService } from "../core/service.js";
import { KeepCodingService as Service } from "../core/service.js";
import type { ProjectRootResolver } from "./root-policy.js";

const rootSchema = z.object({
  project_root: z.string().min(1).refine(path.isAbsolute, "project_root must be an absolute path")
    .describe("Absolute path inside the target Git repository on the MCP server")
});
const phaseDefinition = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  title: z.string().min(1),
  goal: z.string().min(1),
  dependencies: z.array(z.string()),
  allowedScope: z.array(z.string()).min(1).describe("Minimatch globs for files this phase may change"),
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

export type AcceptanceCommandValidator = (command: string) => void;

export interface CreateServerOptions {
  resolveProjectRoot?: ProjectRootResolver;
  validateAcceptanceCommand?: AcceptanceCommandValidator;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "keep-coding", version: "0.1.0" },
    {
      instructions: [
        "Use one evidence-gated workflow: initialize_project, save_plan, start_phase, implement, checkpoint_phase, then complete_project.",
        "In a remote ChatGPT app, inspect only through list_files, read_file, search_code, and get_diff.",
        "Apply edits only with apply_patch after start_phase; patches are rejected outside the active phase allowedScope.",
        "Never claim completion while a phase is unfinished, FAILED, or BLOCKED."
      ].join(" ")
    }
  );
  register(server, options, "initialize_project", "Initialize durable project memory and index the repository before planning.", rootSchema.extend({ prompt: z.string().min(1) }),
    async (service, input) => service.initialize(input.prompt));
  register(server, options, "save_plan", "Save the measurable project contract and dependency-aware phase plan.", rootSchema.extend({ contract: contractSchema, phases: z.array(phaseDefinition).min(1) }),
    async (service, input) => {
      for (const phase of input.phases) {
        for (const command of phase.acceptanceCommands) options.validateAcceptanceCommand?.(command);
      }
      return service.savePlan(input.contract, input.phases);
    });
  register(server, options, "get_context", "Get the compact current contract, active phase, decisions, failures and relevant code graph.", rootSchema.extend({ max_chars: z.number().int().min(1_000).max(30_000).optional() }),
    async (service, input) => ({ context: service.context(input.max_chars), snapshot: service.store.snapshot() }));
  register(server, options, "start_phase", "Start exactly one ready phase after its dependencies are verified.", rootSchema.extend({ phase_id: z.string().min(1) }),
    async (service, input) => service.startPhase(input.phase_id));
  register(server, options, "list_files", "List repository files available to this server without returning file contents.", rootSchema.extend({ max_files: z.number().int().min(1).max(2_000).default(500) }),
    async (service, input) => service.workspace.listFiles(input.max_files));
  register(server, options, "read_file", "Read a bounded line range from one text file inside the repository.", rootSchema.extend({
    file_path: z.string().min(1),
    start_line: z.number().int().min(1).default(1),
    end_line: z.number().int().min(1).max(5_000).default(400)
  }), async (service, input) => service.workspace.readTextFile(input.file_path, input.start_line, input.end_line));
  register(server, options, "search_code", "Search text across bounded repository files and return matching lines.", rootSchema.extend({
    query: z.string().min(2).max(500),
    max_results: z.number().int().min(1).max(500).default(100)
  }), async (service, input) => service.workspace.searchCode(input.query, input.max_results));
  register(server, options, "get_diff", "Return the current bounded Git diff and changed-file list.", rootSchema.extend({
    max_chars: z.number().int().min(1_000).max(100_000).default(30_000)
  }), async (service, input) => service.workspace.diff(input.max_chars));
  register(server, options, "apply_patch", "Apply one unified Git patch only within an IN_PROGRESS phase and its declared allowedScope.", rootSchema.extend({
    phase_id: z.string().min(1),
    patch: z.string().min(1).max(262_144)
  }), async (service, input) => service.workspace.applyPatch(input.phase_id, input.patch));
  register(server, options, "record_decision", "Persist an architectural or product decision for future phases.", rootSchema.extend({ phase_id: z.string().nullable().default(null), title: z.string().min(1), rationale: z.string().min(1), alternatives: z.array(z.string()).default([]) }),
    async (service, input) => service.store.recordDecision({ phaseId: input.phase_id, title: input.title, rationale: input.rationale, alternatives: input.alternatives }));
  register(server, options, "record_failure", "Record and deduplicate a failed approach so later attempts do not repeat it.", rootSchema.extend({ phase_id: z.string().min(1), summary: z.string().min(1), fingerprint: z.string().optional() }),
    async (service, input) => service.store.recordFailure(input.phase_id, input.summary, input.fingerprint));
  register(server, options, "checkpoint_phase", "Run scope and acceptance gates, persist evidence, and unlock dependent phases only on success.", rootSchema.extend({ phase_id: z.string().min(1), summary: z.string().min(1) }),
    async (service, input) => {
      const phase = service.store.getPhase(input.phase_id);
      if (!phase) throw new Error(`unknown phase: ${input.phase_id}`);
      for (const command of phase.acceptanceCommands) options.validateAcceptanceCommand?.(command);
      return service.checkpoint(input.phase_id, input.summary);
    });
  register(server, options, "get_status", "Return the full durable project snapshot.", rootSchema,
    async (service) => service.store.snapshot());
  register(server, options, "complete_project", "Mark the project complete only after every phase has a passing checkpoint.", rootSchema,
    async (service) => service.store.completeProject());
  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

function register<Schema extends z.ZodObject<z.ZodRawShape>>(
  server: McpServer,
  options: CreateServerOptions,
  name: string,
  description: string,
  inputSchema: Schema,
  operation: (service: KeepCodingService, input: z.output<Schema>) => Promise<unknown>
): void {
  const readOnlyTools = ["get_context", "list_files", "read_file", "search_code", "get_diff", "get_status"];
  const idempotentTools = ["initialize_project", ...readOnlyTools];
  const config = {
    description,
    inputSchema,
    annotations: {
      readOnlyHint: readOnlyTools.includes(name),
      destructiveHint: name === "apply_patch",
      idempotentHint: idempotentTools.includes(name)
    }
  };
  const handler = async (rawInput: unknown) => {
    let service: KeepCodingService | null = null;
    try {
      const parsed = inputSchema.parse(rawInput);
      const projectRoot = options.resolveProjectRoot === undefined
        ? String(parsed.project_root)
        : await options.resolveProjectRoot(String(parsed.project_root));
      const input = { ...parsed, project_root: projectRoot } as z.output<Schema>;
      service = await Service.open(projectRoot);
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
