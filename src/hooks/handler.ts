import { existsSync } from "node:fs";
import path from "node:path";
import { detectLargeProject } from "../core/detector.js";
import { GitRepository } from "../core/git.js";
import { KeepCodingService } from "../core/service.js";

export interface HookInput {
  cwd?: string;
  prompt?: string;
  stop_hook_active?: boolean;
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
    const detection = detectLargeProject(prompt);
    if (!detection.activate) return { continue: true };
    return withService(git.root, async (service) => {
      await service.initialize(prompt);
      return contextOutput(event, `${service.context()}\n\nActivation: ${detection.reasons.join("; ")}. Begin by inspecting the repository and calling initialize_project, then save_plan before implementation.`);
    });
  }

  if (!stateExists) return { continue: true };
  return withService(git.root, async (service) => {
    const project = service.store.getProject();
    if (!project) return { continue: true };
    switch (event) {
      case "SessionStart":
      case "PostCompact":
      case "UserPromptSubmit":
        return contextOutput(event, service.context());
      case "PreCompact":
      case "SessionEnd":
        service.store.appendEvent(event === "PreCompact" ? "context_compacting" : "session_ended", project.currentPhaseId, {});
        return { continue: true };
      case "Stop": {
        if (["COMPLETED", "BLOCKED"].includes(project.status)) return { continue: true };
        const sequence = service.store.latestEventSequence();
        if (input.stop_hook_active && sequence <= service.store.lastStopProgressSequence()) {
          return { continue: true, systemMessage: "Keep Coding released the stop guard because no new durable progress was recorded." };
        }
        service.store.setLastStopProgressSequence(sequence);
        return {
          decision: "block",
          reason: `Keep Coding project is ${project.status}. Resume from durable state:\n\n${service.context(7_000)}`
        };
      }
      default:
        return { continue: true };
    }
  });
}

function contextOutput(event: string, additionalContext: string): HookOutput {
  return {
    continue: true,
    hookSpecificOutput: { hookEventName: event, additionalContext }
  };
}

async function withService<T>(root: string, operation: (service: KeepCodingService) => Promise<T>): Promise<T> {
  const service = await KeepCodingService.open(root);
  try {
    return await operation(service);
  } finally {
    service.close();
  }
}
