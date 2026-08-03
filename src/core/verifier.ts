import { exec, execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { minimatch } from "minimatch";
import type {
  BudgetEvidence,
  BudgetLimits,
  BudgetUsage,
  CommandEvidence,
  PhaseRecord,
  ProjectContract,
  VerificationEvidence
} from "../domain/model.js";
import { runCritic } from "./critic.js";
import type { GitRepository } from "./git.js";
import { scanUnifiedDiff } from "./secret-scan.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 8_000;

export interface VerificationOptions {
  contract?: ProjectContract | null | undefined;
  usage?: BudgetUsage | undefined;
  impactedTests?: string[] | undefined;
}

export class PhaseVerifier {
  constructor(private readonly commandTimeoutMs = 120_000) {}

  async verify(
    git: GitRepository,
    phase: PhaseRecord,
    baseline?: Record<string, string>,
    options: VerificationOptions = {}
  ): Promise<VerificationEvidence> {
    const changedFiles = baseline ? await git.changedFilesSince(baseline) : await git.changedFiles();
    const scopeViolations = phase.allowedScope.length === 0
      ? []
      : changedFiles.filter((file) => !phase.allowedScope.some((pattern) => minimatch(file, pattern, { dot: true, matchBase: false })));
    const scopePassed = scopeViolations.length === 0;
    const diff = await git.diffText();
    const secretScan = scanUnifiedDiff(diff);
    const budget = evaluateBudget(mergeBudgets(options.contract?.budget, phase.budget), options.usage ?? {});
    const impactedTests = [...new Set(options.impactedTests ?? [])].sort();
    const selectiveCommands: CommandEvidence[] = [];
    const commands: CommandEvidence[] = [];

    if (scopePassed && secretScan.passed && (budget?.passed ?? true)) {
      const selective = await this.selectiveCommand(git.root, impactedTests);
      if (selective) selectiveCommands.push(await this.runExecutable(selective.executable, selective.args, git.root, selective.label));
      if (selectiveCommands.every((command) => command.passed)) {
        for (const command of phase.acceptanceCommands) {
          const evidence = await this.runShellCommand(command, git.root);
          commands.push(evidence);
          if (!evidence.passed) break;
        }
      }
    }

    const critic = await runCritic({
      contract: options.contract ?? null,
      phase,
      diff,
      changedFiles
    });
    const deterministicPassed =
      scopePassed &&
      secretScan.passed &&
      (budget?.passed ?? true) &&
      selectiveCommands.every((command) => command.passed) &&
      commands.length === phase.acceptanceCommands.length &&
      commands.every((command) => command.passed);
    const criticPassed = !critic.blocking || critic.passed;

    return {
      passed: deterministicPassed && criticPassed,
      scopePassed,
      scopeViolations,
      changedFiles,
      commands,
      selectiveCommands,
      impactedTests,
      secretScanPassed: secretScan.passed,
      secretFindings: secretScan.findings,
      budget,
      critic,
      diffHash: await git.diffHash(),
      gitSha: await git.headSha(),
      checkpointCommitSha: null
    };
  }

  private async selectiveCommand(root: string, tests: string[]): Promise<{ executable: string; args: string[]; label: string } | null> {
    if (tests.length === 0) return null;
    const packageJson = await readJson(path.join(root, "package.json"));
    const scripts = isRecord(packageJson?.scripts) ? packageJson.scripts : {};
    const dependencies = { ...(isRecord(packageJson?.dependencies) ? packageJson.dependencies : {}), ...(isRecord(packageJson?.devDependencies) ? packageJson.devDependencies : {}) };
    if (typeof scripts.test === "string" && ("vitest" in dependencies || scripts.test.includes("vitest"))) {
      return { executable: npmExecutable(), args: ["test", "--", ...tests], label: `npm test -- ${tests.join(" ")}` };
    }
    if (tests.every((file) => file.endsWith(".py")) && await hasAny(root, ["pyproject.toml", "pytest.ini", "setup.cfg"])) {
      return { executable: pythonExecutable(), args: ["-m", "pytest", ...tests], label: `python -m pytest ${tests.join(" ")}` };
    }
    return null;
  }

  private async runShellCommand(command: string, cwd: string): Promise<CommandEvidence> {
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
      return commandFailure(command, started, error);
    }
  }

  private async runExecutable(executable: string, args: string[], cwd: string, label: string): Promise<CommandEvidence> {
    const started = performance.now();
    try {
      const { stdout, stderr } = await execFileAsync(executable, args, {
        cwd,
        encoding: "utf8",
        timeout: this.commandTimeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true
      });
      return {
        command: label, exitCode: 0, passed: true, durationMs: Math.round(performance.now() - started),
        stdout: truncate(stdout), stderr: truncate(stderr), timedOut: false
      };
    } catch (error) {
      return commandFailure(label, started, error);
    }
  }
}

function evaluateBudget(limits: BudgetLimits | undefined, usage: BudgetUsage): BudgetEvidence | null {
  if (!limits) return null;
  const violations: string[] = [];
  if (limits.maxTokens !== undefined && (usage.tokens ?? 0) > limits.maxTokens) violations.push(`tokens ${usage.tokens ?? 0} exceed ${limits.maxTokens}`);
  if (limits.maxCostUsd !== undefined && (usage.costUsd ?? 0) > limits.maxCostUsd) violations.push(`cost ${usage.costUsd ?? 0} exceeds ${limits.maxCostUsd}`);
  if (limits.maxWallClockMs !== undefined && (usage.wallClockMs ?? 0) > limits.maxWallClockMs) violations.push(`wall clock ${usage.wallClockMs ?? 0}ms exceeds ${limits.maxWallClockMs}ms`);
  return { limits, usage, passed: violations.length === 0, violations };
}

function mergeBudgets(project: BudgetLimits | undefined, phase: BudgetLimits | undefined): BudgetLimits | undefined {
  if (!project && !phase) return undefined;
  return {
    maxTokens: minimum(project?.maxTokens, phase?.maxTokens),
    maxCostUsd: minimum(project?.maxCostUsd, phase?.maxCostUsd),
    maxWallClockMs: minimum(project?.maxWallClockMs, phase?.maxWallClockMs)
  };
}

function minimum(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function commandFailure(command: string, started: number, error: unknown): CommandEvidence {
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

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function hasAny(root: string, files: string[]): Promise<boolean> {
  for (const file of files) {
    if (await readFile(path.join(root, file)).then(() => true).catch(() => false)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function npmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function pythonExecutable(): string {
  return process.platform === "win32" ? "python.exe" : "python3";
}

function truncate(value: string): string {
  if (value.length <= MAX_OUTPUT) return value;
  const half = Math.floor((MAX_OUTPUT - 40) / 2);
  return `${value.slice(0, half)}\n...[output truncated]...\n${value.slice(-half)}`;
}
