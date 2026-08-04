import { exec } from "node:child_process";
import { promisify } from "node:util";
import { minimatch } from "minimatch";
import type { BudgetEvidence, CommandEvidence, CriticEvidence, PhaseRecord, ProjectContract, VerificationEvidence } from "../domain/model.js";
import type { GitRepository } from "./git.js";
import { scanChangedFiles } from "./secret-scan.js";
import { CriticRunner } from "./critic.js";

const execAsync = promisify(exec);
const MAX_OUTPUT = 8_000;

export interface VerificationOptions {
  baseline?: Record<string, string>;
  selectiveCommands?: string[];
  budget: BudgetEvidence;
  contract: ProjectContract;
  impactedCompletedPhases?: string[];
  criticRunner?: CriticRunner;
}

export class PhaseVerifier {
  constructor(private readonly commandTimeoutMs = 120_000) {}

  async verify(git: GitRepository, phase: PhaseRecord, options: VerificationOptions): Promise<VerificationEvidence> {
    const started = performance.now();
    const changedFiles = options.baseline ? await git.changedFilesSince(options.baseline) : await git.changedFiles();
    const scopeViolations = phase.allowedScope.length === 0 ? [] : changedFiles.filter((file) => !phase.allowedScope.some((pattern) => minimatch(file, pattern, { dot: true, matchBase: false })));
    const secretScan = await scanChangedFiles(git.root, changedFiles);
    const selectiveCommands: CommandEvidence[] = [];
    const commands: CommandEvidence[] = [];
    const deterministicPrerequisitesPassed = scopeViolations.length === 0 && secretScan.passed && options.budget.passed;
    if (deterministicPrerequisitesPassed) {
      await this.runSequence(options.selectiveCommands ?? [], git.root, selectiveCommands);
      if (selectiveCommands.every((command) => command.passed)) await this.runSequence(phase.acceptanceCommands, git.root, commands);
    }
    const commandGatePassed = selectiveCommands.length === (options.selectiveCommands ?? []).length && selectiveCommands.every((command) => command.passed) && commands.length === phase.acceptanceCommands.length && commands.every((command) => command.passed);
    const blocking = phase.criticBlocking === true || options.contract.critic?.blocking === true;
    const critic: CriticEvidence = deterministicPrerequisitesPassed && commandGatePassed
      ? await (options.criticRunner ?? new CriticRunner()).review({ root: git.root, phase, contract: options.contract, changedFiles, diff: await git.diff() }, blocking)
      : skippedCritic(blocking);
    const scopePassed = scopeViolations.length === 0;
    return {
      passed: scopePassed && secretScan.passed && options.budget.passed && commandGatePassed && critic.passed,
      scopePassed,
      scopeViolations,
      changedFiles,
      secretScan,
      budget: { ...options.budget, usage: { ...options.budget.usage, wallClockMs: options.budget.usage.wallClockMs + Math.round(performance.now() - started) } },
      selectiveCommands,
      commands,
      critic,
      impactedCompletedPhases: options.impactedCompletedPhases ?? [],
      diffHash: await git.diffHash(),
      gitSha: await git.headSha()
    };
  }

  async runCommands(commands: string[], cwd: string): Promise<CommandEvidence[]> {
    const evidence: CommandEvidence[] = [];
    await this.runSequence(commands, cwd, evidence);
    return evidence;
  }

  private async runSequence(commands: string[], cwd: string, evidence: CommandEvidence[]): Promise<void> {
    for (const command of commands) {
      const result = await this.runCommand(command, cwd);
      evidence.push(result);
      if (!result.passed) break;
    }
  }

  private async runCommand(command: string, cwd: string): Promise<CommandEvidence> {
    const started = performance.now();
    try {
      const { stdout, stderr } = await execAsync(command, { cwd, encoding: "utf8", timeout: this.commandTimeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      return { command, exitCode: 0, passed: true, durationMs: Math.round(performance.now() - started), stdout: truncate(stdout), stderr: truncate(stderr), timedOut: false };
    } catch (error) {
      const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      return { command, exitCode: typeof failure.code === "number" ? failure.code : null, passed: false, durationMs: Math.round(performance.now() - started), stdout: truncate(failure.stdout ?? ""), stderr: truncate(failure.stderr ?? failure.message), timedOut: Boolean(failure.killed) || failure.code === "ETIMEDOUT" };
    }
  }
}

function skippedCritic(blocking: boolean): CriticEvidence {
  return { configured: false, blocking, passed: !blocking, summary: "Critic did not run because an earlier deterministic gate failed.", findings: [], rawOutput: "" };
}
function truncate(value: string): string { if (value.length <= MAX_OUTPUT) return value; const half = Math.floor((MAX_OUTPUT - 40) / 2); return `${value.slice(0, half)}\n...[output truncated]...\n${value.slice(-half)}`; }
