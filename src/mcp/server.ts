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
const budgetSchema = z.object({
  maxTokens: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
  maxWallClockMs: z.number().int().positive().optional()
});
const phaseDefinition = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  title: z.string().min(1),
  goal: z.string().min(1),
  dependencies: z.array(z.string()),
  allowedScope: z.array(z.string()).min(1),
  acceptanceCommands: z.array(z.string().min(1)).min(1),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  budget: budgetSchema.optional(),
  criticBlocking: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  approvalPrompt: z.string().optional(),
  parallelSafe: z.boolean().optional()
});
const contractSchema = z.object({
  goal: z.string().min(10),
  nonGoals: z.array(z.string()),
  constraints: z.array(z.string()),
  deliverables: z.array(z.string()).min(1),
  invariants: z.array(z.string()),
  doneWhen: z.array(z.string()).min(1),
  budget: budgetSchema.optional(),
  critic: z.object({ enabled: z.boolean(), blocking: z.boolean() }).optional(),
  selectiveTests: z.object({ commandTemplate: z.string().min(1), fullSuiteCommands: z.array(z.string().min(1)) }).optional(),
  playbookOptIn: z.boolean().optional()
});

export type AcceptanceCommandValidator = (command: string) => void;
export interface CreateServerOptions {
  resolveProjectRoot?: ProjectRootResolver;
  validateAcceptanceCommand?: AcceptanceCommandValidator;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "keep-coding", version: "0.2.0" },
    {
      instructions: [
        "Use one evidence-gated workflow; amend plans only through amend_plan.",
        "Deterministic commands, secret scanning, budget checks, impact-aware reverification, and pending approvals are authoritative.",
        "Remote edits remain bounded by the active phase allowedScope."
      ].join(" ")
    }
  );
  register(server, options, "initialize_project", "Initialize durable memory and index the repository.", rootSchema.extend({ prompt: z.string().min(1) }),
    (service, input) => service.initialize(input.prompt));
  register(server, options, "save_plan", "Save the initial measurable contract and acyclic phase DAG.", rootSchema.extend({ contract: contractSchema, phases: z.array(phaseDefinition).min(1) }),
    async (service, input) => { validateCommands(options, input.phases); return service.savePlan(input.contract, input.phases); });
  register(server, options, "amend_plan", "Version an auditable plan amendment without destroying completed evidence.", rootSchema.extend({
    reason: z.string().min(10), add_phases: z.array(phaseDefinition), supersede_phase_ids: z.array(z.string()), contract_patch: contractSchema.partial().optional()
  }), async (service, input) => {
    validateCommands(options, input.add_phases);
    return service.amendPlan({
      reason: input.reason,
      addPhases: input.add_phases,
      supersedePhaseIds: input.supersede_phase_ids,
      ...(input.contract_patch ? { contractPatch: input.contract_patch } : {})
    });
  });
  register(server, options, "get_context", "Get compact durable context and snapshot.", rootSchema.extend({ max_chars: z.number().int().min(1_000).max(30_000).optional() }),
    async (service, input) => ({ context: service.context(input.max_chars), snapshot: service.store.snapshot() }));
  register(server, options, "get_impact", "Compute explainable file or symbol blast radius and impacted tests.", rootSchema.extend({ target: z.string().min(1), max_depth: z.number().int().min(1).max(8).default(4) }),
    async (service, input) => service.impact(input.target, input.max_depth));
  register(server, options, "start_phase", "Start one dependency-ready phase.", rootSchema.extend({ phase_id: z.string().min(1) }),
    (service, input) => service.startPhase(input.phase_id));
  register(server, options, "prepare_parallel_phases", "Create isolated Git worktrees for independent parallel-safe READY phases.", rootSchema.extend({ phase_ids: z.array(z.string()).optional() }),
    (service, input) => service.parallel().prepare(input.phase_ids));
  register(server, options, "checkpoint_parallel_phase", "Verify, commit, merge, and remove one isolated phase worktree.", rootSchema.extend({ phase_id: z.string().min(1), summary: z.string().min(1) }),
    (service, input) => service.parallel().checkpoint(input.phase_id, input.summary));
  register(server, options, "request_approval", "Pause a phase for an explicit human decision.", rootSchema.extend({ phase_id: z.string().min(1), prompt: z.string().min(1) }),
    async (service, input) => service.store.requestApproval(input.phase_id, input.prompt));
  register(server, options, "resolve_approval", "Resolve a pending human approval.", rootSchema.extend({ approval_id: z.string().min(1), approved: z.boolean(), note: z.string().default("") }),
    async (service, input) => service.store.resolveApproval(input.approval_id, input.approved, input.note));
  register(server, options, "record_budget_usage", "Record token, cost, and wall-clock usage for enforceable budgets.", rootSchema.extend({
    scope: z.enum(["project", "phase"]), scope_id: z.string().min(1), tokens: z.number().int().nonnegative().optional(),
    cost_usd: z.number().nonnegative().optional(), wall_clock_ms: z.number().int().nonnegative().optional()
  }), async (service, input) => service.store.recordBudgetUsage(input.scope, input.scope_id, {
    ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
    ...(input.cost_usd !== undefined ? { costUsd: input.cost_usd } : {}),
    ...(input.wall_clock_ms !== undefined ? { wallClockMs: input.wall_clock_ms } : {})
  }));
  register(server, options, "restore_phase_baseline", "Restore only files changed since a phase baseline.", rootSchema.extend({ phase_id: z.string().min(1) }),
    (service, input) => service.restorePhaseBaseline(input.phase_id));
  register(server, options, "suggest_phases", "Consult the opt-in cross-project playbook.", rootSchema.extend({ query: z.string().min(1) }),
    async (service, input) => service.suggestPhases(input.query));
  register(server, options, "remember_phase_template", "Persist a successful phase into the opt-in playbook.", rootSchema.extend({ phase_id: z.string().min(1) }),
    async (service, input) => service.rememberPhaseTemplate(input.phase_id));
  register(server, options, "list_files", "List bounded repository paths.", rootSchema.extend({ max_files: z.number().int().min(1).max(2_000).default(500) }),
    (service, input) => service.workspace.listFiles(input.max_files));
  register(server, options, "read_file", "Read a bounded text range.", rootSchema.extend({ file_path: z.string().min(1), start_line: z.number().int().min(1).default(1), end_line: z.number().int().min(1).max(5_000).default(400) }),
    (service, input) => service.workspace.readTextFile(input.file_path, input.start_line, input.end_line));
  register(server, options, "search_code", "Search bounded repository text.", rootSchema.extend({ query: z.string().min(2).max(500), max_results: z.number().int().min(1).max(500).default(100) }),
    (service, input) => service.workspace.searchCode(input.query, input.max_results));
  register(server, options, "get_diff", "Return current bounded Git diff.", rootSchema.extend({ max_chars: z.number().int().min(1_000).max(100_000).default(30_000) }),
    (service, input) => service.workspace.diff(input.max_chars));
  register(server, options, "apply_patch", "Apply a phase-scoped unified patch.", rootSchema.extend({ phase_id: z.string().min(1), patch: z.string().min(1).max(262_144) }),
    (service, input) => service.workspace.applyPatch(input.phase_id, input.patch));
  register(server, options, "record_decision", "Persist architectural rationale.", rootSchema.extend({
    phase_id: z.string().nullable().default(null), title: z.string().min(1), rationale: z.string().min(1), alternatives: z.array(z.string()).default([])
  }), async (service, input) => service.store.recordDecision({ phaseId: input.phase_id, title: input.title, rationale: input.rationale, alternatives: input.alternatives }));
  register(server, options, "record_failure", "Deduplicate a failed approach and compound opt-in playbook memory.", rootSchema.extend({ phase_id: z.string().min(1), summary: z.string().min(1), fingerprint: z.string().optional() }),
    async (service, input) => service.recordFailure(input.phase_id, input.summary, input.fingerprint));
  register(server, options, "checkpoint_phase", "Run scope, secret, budget, selective-test, command, and critic gates.", rootSchema.extend({ phase_id: z.string().min(1), summary: z.string().min(1) }),
    async (service, input) => {
      const phase = service.store.getPhase(input.phase_id);
      if (!phase) throw new Error(`unknown phase: ${input.phase_id}`);
      validateCommands(options, [phase]);
      return service.checkpoint(input.phase_id, input.summary);
    });
  register(server, options, "get_status", "Return the full durable snapshot.", rootSchema,
    async (service) => service.store.snapshot());
  register(server, options, "complete_project", "Run the full-suite gate and complete only after all phases and reverifications pass.", rootSchema,
    (service) => service.complete());
  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

function validateCommands(options: CreateServerOptions, phases: Array<{ acceptanceCommands: string[] }>): void {
  for (const phase of phases) for (const command of phase.acceptanceCommands) options.validateAcceptanceCommand?.(command);
}

function register<Schema extends z.ZodObject<z.ZodRawShape>>(
  server: McpServer,
  options: CreateServerOptions,
  name: string,
  description: string,
  inputSchema: Schema,
  operation: (service: KeepCodingService, input: z.output<Schema>) => Promise<unknown>
): void {
  const readOnlyTools = ["get_context", "get_impact", "suggest_phases", "list_files", "read_file", "search_code", "get_diff", "get_status"];
  const config = {
    description,
    inputSchema,
    annotations: {
      readOnlyHint: readOnlyTools.includes(name),
      destructiveHint: ["apply_patch", "restore_phase_baseline", "checkpoint_parallel_phase"].includes(name),
      idempotentHint: ["initialize_project", ...readOnlyTools].includes(name)
    }
  };
  const handler = async (rawInput: unknown) => {
    let service: KeepCodingService | null = null;
    try {
      const parsed = inputSchema.parse(rawInput);
      const projectRoot = options.resolveProjectRoot
        ? await options.resolveProjectRoot(String(parsed.project_root))
        : String(parsed.project_root);
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
  server.registerTool(name, config as never, handler as never);
}
