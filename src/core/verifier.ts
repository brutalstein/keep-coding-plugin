import { exec } from "node:child_process";
import { promisify } from "node:util";
import { minimatch } from "minimatch";
import type { CommandEvidence, PhaseRecord, VerificationEvidence } from "../domain/model.js";
import type { GitRepository } from "./git.js";

const execAsync = promisify(exec);
const MAX_OUTPUT = 8_000;

export class PhaseVerifier {
  constructor(private readonly commandTimeoutMs = 120_000) {}

  async verify(git: GitRepository, phase: PhaseRecord, baseline?: Record<string, string>): Promise<VerificationEvidence> {
    const changedFiles = baseline ? await git.changedFilesSince(baseline) : await git.changedFiles();
    const scopeViolations = phase.allowedScope.length === 0
      ? []
      : changedFiles.filter((file) => !phase.allowedScope.some((pattern) => minimatch(file, pattern, { dot: true, matchBase: false })));
    const commands: CommandEvidence[] = [];
    if (scopeViolations.length === 0) {
      for (const command of phase.acceptanceCommands) {
        const evidence = await this.runCommand(command, git.root);
        commands.push(evidence);
        if (!evidence.passed) break;
      }
    }
    const scopePassed = scopeViolations.length === 0;
    return {
      passed: scopePassed && commands.length === phase.acceptanceCommands.length && commands.every((command) => command.passed),
      scopePassed,
      scopeViolations,
      changedFiles,
      commands,
      diffHash: await git.diffHash(),
      gitSha: await git.headSha()
    };
  }

  private async runCommand(command: string, cwd: string): Promise<CommandEvidence> {
    const started = performance.now();
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        encoding: "utf8",
        timeout: this.commandTimeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true
      });
      return {
        command, exitCode: 0, passed: true, durationMs: Math.round(performance.now() - started),
        stdout: truncate(stdout), stderr: truncate(stderr), timedOut: false
      };
    } catch (error) {
      const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      return {
        command,
        exitCode: typeof failure.code === "number" ? failure.code : null,
        passed: false,
        durationMs: Math.round(performance.now() - started),
        stdout: truncate(failure.stdout ?? ""),
        stderr: truncate(failure.stderr ?? failure.message),
        timedOut: Boolean(failure.killed) || failure.code === "ETIMEDOUT"
      };
    }
  }
}

function truncate(value: string): string {
  if (value.length <= MAX_OUTPUT) return value;
  const half = Math.floor((MAX_OUTPUT - 40) / 2);
  return `${value.slice(0, half)}\n...[output truncated]...\n${value.slice(-half)}`;
}
