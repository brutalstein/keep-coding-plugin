import { existsSync } from "node:fs";
import path from "node:path";
import { adapterById } from "../adapters/continuity.js";
import { detectLargeProject } from "../core/detector.js";
import { GitRepository } from "../core/git.js";
import { KeepCodingService } from "../core/service.js";

export interface HookInput {
  cwd?: string;
  prompt?: string;
  stop_hook_active?: boolean;
  runtime?: string;
  [key: string]: unknown;
}
export type HookOutput = Record<string, unknown>;

export async function handleHook(event: string, input: HookInput): Promise<HookOutput> {
  const candidate = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const git = await GitRepository.open(candidate).catch(() => null);
  if (!git) return { continue: true };
  const stateExists = existsSync(path.join(git.root, ".keep-coding", "state.db"));

  if (event === "UserPromptSubmit" && !stateExists) {
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    const detection = detectLargeProject(prompt, { force: /(?:@keep coding|keep-coding:activate)/iu.test(prompt) });
    if (!detection.activate) return { continue: true, detection };
    return withService(git.root, async (service) => {
      await service.initialize(prompt);
      return contextOutput(event, `${service.context()}\n\nActivation confidence ${(detection.confidence * 100).toFixed(0)}%: ${detection.reasons.join("; ")}.`);
    });
  }

  if (!stateExists) return { continue: true };
  return withService(git.root, async (service) => {
    const project = service.store.getProject();
    if (!project) return { continue: true };
    if (event === "PreCompact" || event === "SessionEnd") {
      service.store.appendEvent(event === "PreCompact" ? "context_compacting" : "session_ended", project.currentPhaseId, { runtime: input.runtime ?? "codex" });
      return { continue: true };
    }
    const directive = await adapterById(typeof input.runtime === "string" ? input.runtime : "codex").translate({
      name: event,
      cwd: git.root,
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.stop_hook_active !== undefined ? { stopGuardActive: input.stop_hook_active } : {})
    }, service);
    if (event === "Stop" && !directive.continue) {
      const sequence = service.store.latestEventSequence();
      if (input.stop_hook_active && sequence <= service.store.lastStopProgressSequence()) {
        return { continue: true, systemMessage: "Keep Coding released the stop guard because no new durable progress was recorded." };
      }
      service.store.setLastStopProgressSequence(sequence);
      return {
        decision: "block",
        reason: `Keep Coding project is ${project.status}. Resume from durable state:\n\n${directive.blockReason ?? service.context(7_000)}`
      };
    }
    return directive.context ? contextOutput(event, directive.context) : { continue: true };
  });
}

function contextOutput(event: string, additionalContext: string): HookOutput {
  return { continue: true, hookSpecificOutput: { hookEventName: event, additionalContext } };
}

async function withService<T>(root: string, operation: (service: KeepCodingService) => Promise<T>): Promise<T> {
  const service = await KeepCodingService.open(root);
  try { return await operation(service); }
  finally { service.close(); }
}
