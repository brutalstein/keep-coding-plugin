import { spawn } from "node:child_process";
import type { CriticEvidence, PhaseRecord, ProjectContract } from "../domain/model.js";

const MAX_OUTPUT = 32_000;

export interface CriticInput {
  root: string;
  phase: PhaseRecord;
  contract: ProjectContract;
  changedFiles: string[];
  diff: string;
}

export class CriticRunner {
  constructor(
    private readonly command = process.env.KEEP_CODING_CRITIC_COMMAND?.trim() ?? "",
    private readonly timeoutMs = 120_000
  ) {}

  async review(input: CriticInput, blocking: boolean): Promise<CriticEvidence> {
    if (!this.command) {
      return {
        configured: false,
        blocking,
        passed: !blocking,
        summary: blocking
          ? "Blocking critic review was requested, but KEEP_CODING_CRITIC_COMMAND is not configured."
          : "Advisory critic is not configured; deterministic gates remain authoritative.",
        findings: blocking ? [{ severity: "error", rule: "critic-not-configured", message: "Configure an independent critic command or make the critic advisory." }] : [],
        rawOutput: ""
      };
    }
    const result = await runCommand(this.command, input.root, JSON.stringify({ contract: input.contract, phase: input.phase, changedFiles: input.changedFiles, diff: input.diff }), this.timeoutMs);
    if (result.code !== 0) {
      return {
        configured: true,
        blocking,
        passed: !blocking,
        summary: `Critic command failed with exit code ${result.code ?? "unknown"}.`,
        findings: [{ severity: blocking ? "error" : "warning", rule: "critic-command-failed", message: result.output.slice(-2_000) }],
        rawOutput: result.output.slice(-MAX_OUTPUT)
      };
    }
    try {
      const parsed = JSON.parse(result.output) as { passed?: unknown; summary?: unknown; findings?: unknown };
      const passed = parsed.passed === true;
      const findings = Array.isArray(parsed.findings) ? parsed.findings.flatMap((finding) => normalizeFinding(finding)) : [];
      return {
        configured: true,
        blocking,
        passed: blocking ? passed : true,
        summary: typeof parsed.summary === "string" ? parsed.summary : passed ? "Critic accepted the change." : "Critic raised advisory findings.",
        findings,
        rawOutput: result.output.slice(-MAX_OUTPUT)
      };
    } catch {
      return {
        configured: true,
        blocking,
        passed: !blocking,
        summary: "Critic output was not valid JSON.",
        findings: [{ severity: blocking ? "error" : "warning", rule: "critic-invalid-output", message: result.output.slice(-2_000) }],
        rawOutput: result.output.slice(-MAX_OUTPUT)
      };
    }
  }
}

function normalizeFinding(value: unknown): CriticEvidence["findings"] {
  if (typeof value !== "object" || value === null) return [];
  const item = value as Record<string, unknown>;
  const severity = item.severity === "error" || item.severity === "warning" || item.severity === "info" ? item.severity : "warning";
  if (typeof item.message !== "string") return [];
  return [{ severity, rule: typeof item.rule === "string" ? item.rule : "critic", message: item.message, ...(typeof item.file === "string" ? { file: item.file } : {}) }];
}

async function runCommand(command: string, cwd: string, input: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  return new Promise((resolve) => {
    const child = spawn(shell, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const finish = (code: number | null): void => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, output }); };
    child.stdout.on("data", (chunk) => { output = appendBounded(output, String(chunk)); });
    child.stderr.on("data", (chunk) => { output = appendBounded(output, String(chunk)); });
    child.on("error", (error) => { output = appendBounded(output, error.message); finish(null); });
    child.on("close", finish);
    child.stdin.end(input);
  });
}

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= MAX_OUTPUT ? combined : combined.slice(-MAX_OUTPUT);
}
