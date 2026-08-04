import type { KeepCodingService } from "../core/service.js";

export interface RuntimeEvent {
  name: string;
  cwd: string;
  prompt?: string;
  stopGuardActive?: boolean;
  sinceSequence?: number;
}
export interface RuntimeDirective { continue: boolean; context?: string; sequence?: number; blockReason?: string }
export interface ContinuityAdapter { readonly id: string; translate(event: RuntimeEvent, service: KeepCodingService | null): Promise<RuntimeDirective> }

export class CodexContinuityAdapter implements ContinuityAdapter {
  readonly id = "codex";
  async translate(event: RuntimeEvent, service: KeepCodingService | null): Promise<RuntimeDirective> {
    if (!service) return { continue: true };
    if (["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact"].includes(event.name)) return contextDirective(service, event.sinceSequence);
    if (event.name === "Stop") {
      const project = service.store.getProject();
      if (!project || ["COMPLETED", "BLOCKED", "BLOCKED_BUDGET"].includes(project.status)) return { continue: true };
      return { continue: false, blockReason: service.context(7_000) };
    }
    return { continue: true };
  }
}

export class ClaudeHooksAdapter implements ContinuityAdapter {
  readonly id = "claude-hooks";
  async translate(event: RuntimeEvent, service: KeepCodingService | null): Promise<RuntimeDirective> {
    if (!service) return { continue: true };
    if (["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact"].includes(event.name)) return contextDirective(service, event.sinceSequence);
    if (event.name === "Stop") {
      const project = service.store.getProject();
      return project && !["COMPLETED", "BLOCKED", "BLOCKED_BUDGET"].includes(project.status)
        ? { continue: false, blockReason: service.context(7_000) }
        : { continue: true };
    }
    return { continue: true };
  }
}

export class PollingCliAdapter implements ContinuityAdapter {
  readonly id = "polling-cli";
  async translate(event: RuntimeEvent, service: KeepCodingService | null): Promise<RuntimeDirective> {
    return service ? contextDirective(service, event.sinceSequence) : { continue: true };
  }
}

export function adapterById(id: string): ContinuityAdapter {
  if (id === "claude" || id === "claude-hooks") return new ClaudeHooksAdapter();
  if (id === "poll" || id === "polling-cli") return new PollingCliAdapter();
  return new CodexContinuityAdapter();
}

function contextDirective(service: KeepCodingService, sinceSequence?: number): RuntimeDirective {
  const envelope = service.contextEnvelope(sinceSequence);
  return envelope.unchanged || !envelope.context
    ? { continue: true, sequence: envelope.sequence }
    : { continue: true, context: envelope.context, sequence: envelope.sequence };
}
