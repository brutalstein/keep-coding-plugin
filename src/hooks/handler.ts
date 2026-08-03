import { existsSync } from "node:fs";
import path from "node:path";
import { continuityAdapter } from "../adapters/continuity.js";
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
  const adapter = continuityAdapter(typeof input.runtime === "string" ? input.runtime : "codex");
  const normalizedEvent = adapter.normalizeEvent(event);
  if (!normalizedEvent) return adapter.continue();
  const candidate = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const git = await GitRepository.open(candidate).catch(() => null);
  if (!git) return adapter.continue();
  const stateExists = existsSync(path.join(git.root, ".keep-coding", "state.db"));

  if (normalizedEvent === "prompt_submit" && !stateExists) {
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    const detection = detectLargeProject(prompt);
    if (!detection.activate) return adapter.continue();
    return withService(git.root, async (service) => {
      await service.initialize(prompt);
      const activation = `Activation confidence ${(detection.confidence * 100).toFixed(0)}%: ${detection.reasons.join("; ")}.`;
      return adapter.injectContext(event, `${service.context()}\n\n${activation} Inspect the repository, call initialize_project, and save_plan before implementation.`);
    });
  }

  if (!stateExists) return adapter.continue();
  return withService(git.root, async (service) => {
    const project = service.store.getProject();
    if (!project) return adapter.continue();
    switch (normalizedEvent) {
      case "session_start":
      case "post_compact":
      case "prompt_submit":
      case "poll":
        return adapter.injectContext(event, service.context());
      case "pre_compact":
      case "session_end":
        service.store.appendEvent(normalizedEvent === "pre_compact" ? "context_compacting" : "session_ended", project.currentPhaseId, { runtime: adapter.id });
        return adapter.continue();
      case "stop": {
        if (["COMPLETED", "BLOCKED"].includes(project.status)) return adapter.continue();
        const current = service.store.currentPhase();
        if (current?.status === "AWAITING_APPROVAL") {
          return { ...adapter.continue(), systemMessage: "Keep Coding is awaiting an explicit human approval and released the stop guard." };
        }
        const sequence = service.store.latestEventSequence();
        if (input.stop_hook_active && sequence <= service.store.lastStopProgressSequence()) {
          return { ...adapter.continue(), systemMessage: "Keep Coding released the stop guard because no new durable progress was recorded." };
        }
        service.store.setLastStopProgressSequence(sequence);
        return adapter.blockStop(`Keep Coding project is ${project.status}. Resume from durable state:\n\n${service.context(7_000)}`);
      }
    }
  });
}

async function withService<T>(root: string, operation: (service: KeepCodingService) => Promise<T>): Promise<T> {
  const service = await KeepCodingService.open(root);
  try {
    return await operation(service);
  } finally {
    service.close();
  }
}
