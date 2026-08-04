import { exec } from "node:child_process";
import { promisify } from "node:util";
import { minimatch } from "minimatch";
import type {
  BudgetEvidence, CommandEvidence, CommandFailureRecord, CommandOutputCompression, CriticEvidence,
  PhaseRecord, ProjectContract, VerificationEvidence
} from "../domain/model.js";
import type { GitRepository } from "./git.js";
import { scanChangedFiles } from "./secret-scan.js";
import { CriticRunner } from "./critic.js";

const execAsync = promisify(exec);
const MAX_OUTPUT = 8_000;
const ERROR_MARKER = /\b(?:error|fail(?:ed|ure)?|exception|fatal|panic|assertion)\b/iu;
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

export interface VerificationOptions {
  baseline?: Record<string, string>;
  selectiveCommands?: string[];
  budget: BudgetEvidence;
  contract: ProjectContract;
  impactedCompletedPhases?: string[];
  criticRunner?: CriticRunner;
  previousFailures?: CommandFailureRecord[];
  correctionAllowedFiles?: string[];
  forceBlockingCritic?: boolean;
}

export class PhaseVerifier {
  constructor(private readonly commandTimeoutMs = 120_000) {}

  async verify(git: GitRepository, phase: PhaseRecord, options: VerificationOptions): Promise<VerificationEvidence> {
    const started = performance.now();
    const changedFiles = options.baseline ? await git.changedFilesSince(options.baseline) : await git.changedFiles();
    const correctionScope = options.correctionAllowedFiles ? new Set(options.correctionAllowedFiles) : null;
    const scopeViolations = changedFiles.filter((file) => {
      const phaseAllows = phase.allowedScope.length === 0 || phase.allowedScope.some((pattern) => minimatch(file, pattern, { dot: true, matchBase: false }));
      const correctionAllows = correctionScope === null || correctionScope.has(file);
      return !phaseAllows || !correctionAllows;
    });
    const secretScan = await scanChangedFiles(git.root, changedFiles);
    const selectiveCommands: CommandEvidence[] = [];
    const commands: CommandEvidence[] = [];
    const deterministicPrerequisitesPassed = scopeViolations.length === 0 && secretScan.passed && options.budget.passed;
    if (deterministicPrerequisitesPassed) {
      await this.runSequence(options.selectiveCommands ?? [], git.root, selectiveCommands, options.previousFailures ?? []);
      if (selectiveCommands.every((command) => command.passed)) await this.runSequence(phase.acceptanceCommands, git.root, commands, options.previousFailures ?? []);
    }
    const commandGatePassed = selectiveCommands.length === (options.selectiveCommands ?? []).length && selectiveCommands.every((command) => command.passed) && commands.length === phase.acceptanceCommands.length && commands.every((command) => command.passed);
    const blocking = options.forceBlockingCritic === true || phase.criticBlocking === true || options.contract.critic?.blocking === true;
    const criticEnabled = options.forceBlockingCritic === true || phase.criticBlocking === true || options.contract.critic?.enabled === true;
    const critic: CriticEvidence = deterministicPrerequisitesPassed && commandGatePassed && criticEnabled
      ? await (options.criticRunner ?? new CriticRunner()).review({ root: git.root, phase, contract: options.contract, changedFiles, diff: await git.diff() }, blocking)
      : skippedCritic(blocking, criticEnabled);
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
    await this.runSequence(commands, cwd, evidence, []);
    return evidence;
  }

  private async runSequence(commands: string[], cwd: string, evidence: CommandEvidence[], previousFailures: CommandFailureRecord[]): Promise<void> {
    for (const command of commands) {
      const previous = previousFailures.find((failure) => failure.command === command) ?? null;
      const result = await this.runCommand(command, cwd, previous);
      evidence.push(result);
      if (!result.passed) break;
    }
  }

  private async runCommand(command: string, cwd: string, previous: CommandFailureRecord | null): Promise<CommandEvidence> {
    const started = performance.now();
    try {
      const { stdout, stderr } = await execAsync(command, { cwd, encoding: "utf8", timeout: this.commandTimeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      const compressedOut = compressCommandOutput(stdout, null);
      const compressedErr = compressCommandOutput(stderr, null);
      return {
        command, exitCode: 0, passed: true, durationMs: Math.round(performance.now() - started),
        stdout: compressedOut.output, stderr: compressedErr.output, timedOut: false,
        compression: mergeCompression(compressedOut.compression, compressedErr.compression)
      };
    } catch (error) {
      const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      const compressedOut = compressCommandOutput(failure.stdout ?? "", previous ? { output: previous.stdout, attempt: previous.attempt } : null);
      const compressedErr = compressCommandOutput(failure.stderr ?? failure.message, previous ? { output: previous.stderr, attempt: previous.attempt } : null);
      return {
        command, exitCode: typeof failure.code === "number" ? failure.code : null, passed: false,
        durationMs: Math.round(performance.now() - started), stdout: compressedOut.output, stderr: compressedErr.output,
        timedOut: Boolean(failure.killed) || failure.code === "ETIMEDOUT",
        compression: mergeCompression(compressedOut.compression, compressedErr.compression)
      };
    }
  }
}

export interface PreviousOutput { output: string; attempt: number }
export interface CompressedOutput { output: string; compression: CommandOutputCompression }

export function compressCommandOutput(value: string, previous: PreviousOutput | null, maxChars = MAX_OUTPUT): CompressedOutput {
  const cleaned = stripCommandNoise(value);
  const previousCleaned = previous ? stripCommandNoise(previous.output) : "";
  const delta = previous ? lineDelta(cleaned, previousCleaned, previous.attempt) : { text: cleaned, unchangedLines: 0 };
  const output = markerAwareTruncate(delta.text, maxChars);
  return {
    output,
    compression: {
      originalChars: value.length,
      emittedChars: output.length,
      unchangedLines: delta.unchangedLines,
      previousAttempt: previous?.attempt ?? null
    }
  };
}

export function stripCommandNoise(value: string): string {
  const lines = value.replace(ANSI_ESCAPE_PATTERN, "").replaceAll("\r\n", "\n").split("\n");
  const filtered: string[] = [];
  for (const line of lines) {
    if (/^\s*at\s+(?:node:internal|internal\/)/u.test(line)) continue;
    const normalized = line.replace(/[ \t]+$/u, "");
    if (normalized === "" && filtered.at(-1) === "") continue;
    if (normalized !== "" && normalized === filtered.at(-1)) continue;
    filtered.push(normalized);
  }
  return filtered.join("\n").trim();
}

function lineDelta(current: string, previous: string, previousAttempt: number): { text: string; unchangedLines: number } {
  const currentLines = current.split("\n");
  const previousLines = previous.split("\n");
  let prefix = 0;
  while (prefix < currentLines.length && prefix < previousLines.length && currentLines[prefix] === previousLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < currentLines.length - prefix && suffix < previousLines.length - prefix &&
    currentLines[currentLines.length - 1 - suffix] === previousLines[previousLines.length - 1 - suffix]
  ) suffix += 1;
  const unchangedLines = prefix + suffix;
  if (unchangedLines === 0) return { text: current, unchangedLines: 0 };
  const middle = currentLines.slice(prefix, currentLines.length - suffix);
  const contextBefore = currentLines.slice(Math.max(0, prefix - 2), prefix);
  const contextAfter = suffix > 0 ? currentLines.slice(currentLines.length - suffix, Math.min(currentLines.length, currentLines.length - suffix + 2)) : [];
  return {
    text: [
      ...contextBefore,
      `...[${unchangedLines} lines unchanged from attempt ${previousAttempt}]...`,
      ...middle,
      ...contextAfter
    ].join("\n"),
    unchangedLines
  };
}

function markerAwareTruncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const lines = value.split("\n");
  const markers = lines.map((line, index) => ERROR_MARKER.test(line) ? index : -1).filter((index) => index >= 0);
  if (markers.length === 0) return headTail(value, maxChars);
  const selected = new Set<number>();
  for (const marker of markers.slice(0, 8)) for (let index = Math.max(0, marker - 3); index <= Math.min(lines.length - 1, marker + 5); index += 1) selected.add(index);
  for (let index = 0; index < Math.min(8, lines.length); index += 1) selected.add(index);
  for (let index = Math.max(0, lines.length - 8); index < lines.length; index += 1) selected.add(index);
  const ordered = [...selected].sort((left, right) => left - right);
  const chunks: string[] = [];
  let previousIndex = -2;
  for (const index of ordered) {
    if (index > previousIndex + 1) chunks.push("...[non-actionable output omitted]...");
    chunks.push(lines[index] ?? "");
    previousIndex = index;
  }
  const focused = chunks.join("\n");
  return focused.length <= maxChars ? focused : headTail(focused, maxChars);
}

function headTail(value: string, maxChars: number): string {
  const half = Math.max(1, Math.floor((maxChars - 40) / 2));
  return `${value.slice(0, half)}\n...[output truncated]...\n${value.slice(-half)}`;
}
function mergeCompression(left: CommandOutputCompression, right: CommandOutputCompression): CommandOutputCompression {
  return {
    originalChars: left.originalChars + right.originalChars,
    emittedChars: left.emittedChars + right.emittedChars,
    unchangedLines: left.unchangedLines + right.unchangedLines,
    previousAttempt: left.previousAttempt ?? right.previousAttempt
  };
}
function skippedCritic(blocking: boolean, enabled = true): CriticEvidence {
  const summary = enabled ? "Critic did not run because an earlier deterministic gate failed." : "Critic review is disabled for this phase.";
  return { configured: false, blocking, passed: !blocking, summary, findings: [], rawOutput: "" };
}
