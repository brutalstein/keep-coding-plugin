export type ContinuityEvent =
  | "session_start"
  | "prompt_submit"
  | "pre_compact"
  | "post_compact"
  | "stop"
  | "session_end"
  | "poll";

export type ContinuityOutput = Record<string, unknown>;

export interface ContinuityAdapter {
  readonly id: string;
  normalizeEvent(rawEvent: string): ContinuityEvent | null;
  continue(): ContinuityOutput;
  injectContext(rawEvent: string, context: string): ContinuityOutput;
  blockStop(reason: string): ContinuityOutput;
}

export class CodexContinuityAdapter implements ContinuityAdapter {
  readonly id = "codex";

  normalizeEvent(rawEvent: string): ContinuityEvent | null {
    return ({
      SessionStart: "session_start",
      UserPromptSubmit: "prompt_submit",
      PreCompact: "pre_compact",
      PostCompact: "post_compact",
      Stop: "stop",
      SessionEnd: "session_end"
    } as Record<string, ContinuityEvent>)[rawEvent] ?? null;
  }

  continue(): ContinuityOutput {
    return { continue: true };
  }

  injectContext(rawEvent: string, context: string): ContinuityOutput {
    return {
      continue: true,
      hookSpecificOutput: { hookEventName: rawEvent, additionalContext: context }
    };
  }

  blockStop(reason: string): ContinuityOutput {
    return { decision: "block", reason };
  }
}

export class ClaudeCodeContinuityAdapter implements ContinuityAdapter {
  readonly id = "claude-code";

  normalizeEvent(rawEvent: string): ContinuityEvent | null {
    const normalized = rawEvent.toLowerCase().replaceAll("-", "_");
    return ({
      session_start: "session_start",
      user_prompt_submit: "prompt_submit",
      pre_compact: "pre_compact",
      post_compact: "post_compact",
      stop: "stop",
      session_end: "session_end"
    } as Record<string, ContinuityEvent>)[normalized] ?? null;
  }

  continue(): ContinuityOutput {
    return {};
  }

  injectContext(_rawEvent: string, context: string): ContinuityOutput {
    return { additionalContext: context };
  }

  blockStop(reason: string): ContinuityOutput {
    return { continue: false, reason };
  }
}

export class PollingContinuityAdapter implements ContinuityAdapter {
  readonly id = "generic-polling";

  normalizeEvent(rawEvent: string): ContinuityEvent | null {
    return rawEvent === "poll" ? "poll" : null;
  }

  continue(): ContinuityOutput {
    return { active: false };
  }

  injectContext(_rawEvent: string, context: string): ContinuityOutput {
    return { active: true, context };
  }

  blockStop(reason: string): ContinuityOutput {
    return { active: true, reason };
  }
}

export function continuityAdapter(runtime: string): ContinuityAdapter {
  switch (runtime.toLowerCase()) {
    case "codex":
      return new CodexContinuityAdapter();
    case "claude":
    case "claude-code":
      return new ClaudeCodeContinuityAdapter();
    case "poll":
    case "generic":
      return new PollingContinuityAdapter();
    default:
      throw new Error(`unsupported continuity runtime: ${runtime}`);
  }
}
