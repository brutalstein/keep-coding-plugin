import { createHash } from "node:crypto";

export type ExecutionPurpose = "acceptance" | "selective-test" | "full-suite" | "critic";
export type NetworkAccess = "inherit" | "deny";

export interface CommandSpec {
  executable: string;
  argv: string[];
  display: string;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/**
 * Parses the retained string command format into an argv-only specification.
 * It deliberately implements a small cross-platform quoting grammar rather
 * than delegating interpretation to a shell.
 */
export function parseCommandSpec(command: string): CommandSpec {
  if (command !== command.trim() || command.length === 0) {
    throw new Error("COMMAND_SPEC_INVALID: command must be non-empty and trimmed");
  }
  if (hasForbiddenControl(command)) {
    throw new Error("COMMAND_SPEC_SHELL_SYNTAX: control characters and newlines are forbidden");
  }

  const tokens: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let escaping = false;
  let tokenStarted = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (escaping) {
      current += character;
      escaping = false;
      tokenStarted = true;
      continue;
    }
    if (character === "\\" && quote !== "single") {
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? null : "single";
      tokenStarted = true;
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? null : "double";
      tokenStarted = true;
      continue;
    }
    if (quote === null && isShellSyntax(command, index)) {
      throw new Error("COMMAND_SPEC_SHELL_SYNTAX: unquoted shell syntax is forbidden");
    }
    if (/\s/u.test(character) && quote === null) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += character;
    tokenStarted = true;
  }

  if (escaping) throw new Error("COMMAND_SPEC_INVALID_ESCAPE: command ends with an incomplete escape");
  if (quote !== null) throw new Error("COMMAND_SPEC_UNTERMINATED_QUOTE: command contains an unterminated quote");
  if (tokenStarted) tokens.push(current);
  if (tokens.length === 0 || !tokens[0]) throw new Error("COMMAND_SPEC_INVALID: executable is missing");
  if (ENV_ASSIGNMENT.test(tokens[0])) {
    throw new Error("COMMAND_SPEC_ENV_ASSIGNMENT: inline environment assignments are forbidden");
  }

  return { executable: tokens[0], argv: tokens.slice(1), display: command };
}

export function commandSpecHash(spec: CommandSpec): string {
  return createHash("sha256")
    .update(JSON.stringify({ executable: spec.executable, argv: spec.argv }))
    .digest("hex");
}

export function formatCommandSpec(executable: string, argv: string[]): string {
  return [executable, ...argv].map(quoteArgument).join(" ");
}

function quoteArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function hasForbiddenControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) return true;
  }
  return value.includes("\r") || value.includes("\n");
}

function isShellSyntax(value: string, index: number): boolean {
  const character = value[index] ?? "";
  const code = character.charCodeAt(0);
  if ([38, 59, 60, 62, 96, 124].includes(code)) return true;
  return character === "$" && (value[index + 1] === "(" || value[index + 1] === "{");
}
