import { existsSync } from "node:fs";
import path from "node:path";
import { adapterById } from "../adapters/continuity.js";
import { detectLargeProject } from "../core/detector.js";
import { GitRepository } from "../core/git.js";
import { KeepCodingService } from "../core/service.js";

const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact"]);

export interface HookInput {
  cwd?: string;
  prompt?: string;
  stop_hook_active?: boolean;
  runtime?: string;
  session_id?: string;
  usage?: unknown;
  token_usage?: unknown;
  [key: string]: unknown;
}
export type HookOutput = Record<string, unknown>;

export async function handleHook(event: string, input: HookInput): Promise<HookOutput> {
  const candidate = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const git = await GitRepository.open(candidate).catch(() => null);
  if (!git) return { continue: true };
  const stateExists = existsSync(path.join(git.root, ".keep-coding", "state.db"));
  const runtime = typeof input.runtime === "string" ? input.runtime : "codex";
  const session = typeof input.session_id === "string" && input.session_id.trim() ? input.session_id.trim() : "default";

  if (event === "UserPromptSubmit" && !stateExists) {
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    const detection = detectLargeProject(prompt, { force: /(?:@keep coding|keep-coding:activate)/iu.test(prompt) });
    if (!detection.activate) return { continue: true, detection };
    return withService(git.root, async (service) => {
      await service.initialize(prompt);
      service.recordHostTokenUsage(extractUsageTokens(input));
      const envelope = service.contextEnvelope();
      service.store.setLastDeliveredSequence(cursorKey(runtime, session, event), envelope.sequence);
      const activationContext = envelope.unchanged ? "" : envelope.context;
      return contextOutput(event, `${activationContext}\n\nActivation confidence ${(detection.confidence * 100).toFixed(0)}%: ${detection.reasons.join("; ")}.`);
    });
  }

  if (!stateExists) return { continue: true };
  return withService(git.root, async (service) => {
    const project = service.store.getProject();
    if (!project) return { continue: true };
    service.recordHostTokenUsage(extractUsageTokens(input));
    if (event === "SessionEnd") {
      service.store.appendEvent("session_ended", project.currentPhaseId, { runtime, session });
      return { continue: true };
    }

    const progressSequence = service.store.latestEventSequence();
    if (event === "Stop" && input.stop_hook_active && progressSequence <= service.store.lastStopProgressSequence()) {
      return { continue: true, systemMessage: "Keep Coding released the stop guard because no new durable progress was recorded." };
    }

    const cursor = cursorKey(runtime, session, event);
    const lastDelivered = CONTEXT_EVENTS.has(event) ? service.store.getLastDeliveredSequence(cursor) : undefined;
    if (lastDelivered !== undefined && progressSequence <= lastDelivered) return { continue: true };

    const directive = await adapterById(runtime).translate({
      name: event,
      cwd: git.root,
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.stop_hook_active !== undefined ? { stopGuardActive: input.stop_hook_active } : {}),
      ...(lastDelivered !== undefined ? { sinceSequence: lastDelivered } : {})
    }, service);
    if (event === "Stop" && !directive.continue) {
      service.store.setLastStopProgressSequence(service.store.latestEventSequence());
      return {
        decision: "block",
        reason: `Keep Coding project is ${project.status}. Resume from durable state:\n\n${directive.blockReason ?? service.context(7_000)}`
      };
    }
    if (lastDelivered !== undefined) service.store.setLastDeliveredSequence(cursor, directive.sequence ?? service.store.latestEventSequence());
    return directive.context ? contextOutput(event, directive.context) : { continue: true };
  });
}

function contextOutput(event: string, additionalContext: string): HookOutput {
  return { continue: true, hookSpecificOutput: { hookEventName: event, additionalContext } };
}

function cursorKey(runtime: string, session: string, event: string): string {
  return `${runtime}:${session}:${event}`.replace(/[^a-z0-9:._-]/giu, "-").slice(0, 240);
}

function extractUsageTokens(input: HookInput): number {
  const candidates = [input.token_usage, input.usage];
  for (const candidate of candidates) {
    if (typeof candidate === "number") return candidate;
    if (!candidate || typeof candidate !== "object") continue;
    const usage = candidate as Record<string, unknown>;
    const total = numberValue(usage.total_tokens ?? usage.totalTokens ?? usage.tokens);
    if (total > 0) return total;
    const inputTokens = numberValue(usage.input_tokens ?? usage.inputTokens);
    const outputTokens = numberValue(usage.output_tokens ?? usage.outputTokens);
    if (inputTokens + outputTokens > 0) return inputTokens + outputTokens;
  }
  return 0;
}
function numberValue(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0; }

async function withService<T>(root: string, operation: (service: KeepCodingService) => Promise<T>): Promise<T> {
  const service = await KeepCodingService.open(root);
  try { return await operation(service); }
  finally { service.close(); }
}
