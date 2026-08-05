import { minimatch } from "minimatch";
import type {
  BudgetEvidence, CommandEvidence, CommandFailureRecord, CommandOutputCompression, CriticEvidence,
  PhaseRecord, ProjectContract, VerificationEvidence
} from "../domain/model.js";
import { ExecutionKernel, type KernelCommandEvidence } from "./execution-kernel.js";
import { operatorAllowsWrite } from "./execution-policy.js";
import type { GitRepository } from "./git.js";
import { scanChangedFiles } from "./secret-scan.js";
import { CriticRunner } from "./critic.js";

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
  executionKernel?: ExecutionKernel;
}

export class PhaseVerifier {
  constructor(private readonly commandTimeoutMs = 120_000) {}

  async verify(git: GitRepository, phase: PhaseRecord, options: VerificationOptions): Promise<VerificationEvidence> {
    const started = performance.now();
    const initialChangedFiles = options.baseline ? await git.changedFilesSince(options.baseline) : await git.changedFiles();
    const correctionScope = options.correctionAllowedFiles ? new Set(options.correctionAllowedFiles) : null;
    const initialScopeViolations = scopeViolations(initialChangedFiles, phase.allowedScope, correctionScope);
    const initialSecretScan = await scanChangedFiles(git.root, initialChangedFiles);
    const selectiveCommands: CommandEvidence[] = [];
    const commands: CommandEvidence[] = [];
    const deterministicPrerequisitesPassed = initialScopeViolations.length === 0
      && initialSecretScan.passed
      && options.budget.passed;

    if (deterministicPrerequisitesPassed) {
      const kernel = options.executionKernel ?? await ExecutionKernel.open(git.root);
      await this.runSequence(
        options.selectiveCommands ?? [],
        git,
        kernel,
        "selective-test",
        phase.allowedScope,
        correctionScope,
        selectiveCommands,
        options.previousFailures ?? []
      );
      if (selectiveCommands.every((command) => command.passed)) {
        await this.runSequence(
          phase.acceptanceCommands,
          git,
          kernel,
          "acceptance",
          phase.allowedScope,
          correctionScope,
          commands,
          options.previousFailures ?? []
        );
      }
    }

    const preCriticChangedFiles = options.baseline ? await git.changedFilesSince(options.baseline) : await git.changedFiles();
    const preCriticScopeViolations = scopeViolations(preCriticChangedFiles, phase.allowedScope, correctionScope);
    const preCriticSecretScan = await scanChangedFiles(git.root, preCriticChangedFiles);
    const commandGatePassed = selectiveCommands.length === (options.selectiveCommands ?? []).length
      && selectiveCommands.every((command) => command.passed)
      && commands.length === phase.acceptanceCommands.length
      && commands.every((command) => command.passed);
    const blocking = options.forceBlockingCritic === true
      || phase.criticBlocking === true
      || options.contract.critic?.blocking === true;
    const criticEnabled = options.forceBlockingCritic === true
      || phase.criticBlocking === true
      || options.contract.critic?.enabled === true;
    const deterministicFinalPassed = [...initialScopeViolations, ...preCriticScopeViolations].length === 0
      && preCriticSecretScan.passed
      && options.budget.passed
      && commandGatePassed;
    const critic: CriticEvidence = deterministicFinalPassed && criticEnabled
      ? await (options.criticRunner ?? new CriticRunner()).review({
          root: git.root,
          phase,
          contract: options.contract,
          changedFiles: preCriticChangedFiles,
          diff: await git.diff()
        }, blocking)
      : skippedCritic(blocking, criticEnabled);

    const changedFiles = options.baseline ? await git.changedFilesSince(options.baseline) : await git.changedFiles();
    const postCriticScopeViolations = scopeViolations(changedFiles, phase.allowedScope, correctionScope);
    const allScopeViolations = [...new Set([
      ...initialScopeViolations,
      ...preCriticScopeViolations,
      ...postCriticScopeViolations
    ])].sort();
    const secretScan = await scanChangedFiles(git.root, changedFiles);
    const scopePassed = allScopeViolations.length === 0;
    return {
      passed: scopePassed && secretScan.passed && options.budget.passed && commandGatePassed && critic.passed,
      scopePassed,
      scopeViolations: allScopeViolations,
      changedFiles,
      secretScan,
      budget: {
        ...options.budget,
        usage: {
          ...options.budget.usage,
          wallClockMs: options.budget.usage.wallClockMs + Math.round(performance.now() - started)
        }
      },
      selectiveCommands,
      commands,
      critic,
      impactedCompletedPhases: options.impactedCompletedPhases ?? [],
      diffHash: await git.diffHash(),
      gitSha: await git.headSha()
    };
  }

  async runCommands(commands: string[], cwd: string): Promise<CommandEvidence[]> {
    const git = await import("./git.js").then(({ GitRepository }) => GitRepository.open(cwd));
    const kernel = await ExecutionKernel.open(git.root);
    const evidence: CommandEvidence[] = [];
    await this.runSequence(commands, git, kernel, "full-suite", ["**"], null, evidence, []);
    return evidence;
  }

  private async runSequence(
    commands: string[],
    git: GitRepository,
    kernel: ExecutionKernel,
    purpose: "acceptance" | "selective-test" | "full-suite",
    allowedScope: string[],
    correctionScope: Set<string> | null,
    evidence: CommandEvidence[],
    previousFailures: CommandFailureRecord[]
  ): Promise<void> {
    for (const command of commands) {
      const previous = previousFailures.find((failure) => failure.command === command) ?? null;
      const result = await this.runCommand(
        command,
        git,
        kernel,
        purpose,
        allowedScope,
        correctionScope,
        previous
      );
      evidence.push(result);
      if (!result.passed) break;
    }
  }

  private async runCommand(
    command: string,
    git: GitRepository,
    kernel: ExecutionKernel,
    purpose: "acceptance" | "selective-test" | "full-suite",
    allowedScope: string[],
    correctionScope: Set<string> | null,
    previous: CommandFailureRecord | null
  ): Promise<KernelCommandEvidence> {
    const before = await git.workingTreeSnapshot();
    const raw = await kernel.execute({
      command,
      cwd: git.root,
      purpose,
      writeScopes: allowedScope,
      timeoutMs: this.commandTimeoutMs,
      inputTreeHash: await git.diffHash()
    });
    const producedFiles = await git.changedFilesSince(before);
    raw.attestation.producedFiles = producedFiles;
    const phaseViolations = scopeViolations(producedFiles, allowedScope, correctionScope);
    const operatorViolations = producedFiles.filter((file) => !operatorAllowsWrite(kernel.policy, file));
    const writeViolations = [...new Set([...phaseViolations, ...operatorViolations])].sort();
    if (writeViolations.length > 0) {
      const message = `EXECUTION_WRITE_SCOPE_VIOLATION: ${writeViolations.join(", ")}`;
      raw.policyViolations.push(message);
      raw.stderr = raw.stderr ? `${raw.stderr}\n${message}` : message;
      raw.passed = false;
    }

    const compressedOut = compressCommandOutput(
      raw.stdout,
      previous ? { output: previous.stdout, attempt: previous.attempt } : null
    );
    const compressedErr = compressCommandOutput(
      raw.stderr,
      previous ? { output: previous.stderr, attempt: previous.attempt } : null
    );
    return {
      ...raw,
      stdout: compressedOut.output,
      stderr: compressedErr.output,
      compression: mergeCompression(compressedOut.compression, compressedErr.compression)
    };
  }
}

function scopeViolations(
  changedFiles: string[],
  allowedScope: string[],
  correctionScope: Set<string> | null
): string[] {
  return changedFiles.filter((file) => {
    const phaseAllows = allowedScope.length === 0
      || allowedScope.some((pattern) => minimatch(file, pattern, { dot: true, matchBase: false }));
    const correctionAllows = correctionScope === null || correctionScope.has(file);
    return !phaseAllows || !correctionAllows;
  });
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
    suffix < currentLines.length - prefix && suffix < previousLines.length - prefix
    && currentLines[currentLines.length - 1 - suffix] === previousLines[previousLines.length - 1 - suffix]
  ) suffix += 1;
  const unchangedLines = prefix + suffix;
  if (unchangedLines === 0) return { text: current, unchangedLines: 0 };
  const middle = currentLines.slice(prefix, currentLines.length - suffix);
  const contextBefore = currentLines.slice(Math.max(0, prefix - 2), prefix);
  const contextAfter = suffix > 0
    ? currentLines.slice(currentLines.length - suffix, Math.min(currentLines.length, currentLines.length - suffix + 2))
    : [];
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
  for (const marker of markers.slice(0, 8)) {
    for (let index = Math.max(0, marker - 3); index <= Math.min(lines.length - 1, marker + 5); index += 1) {
      selected.add(index);
    }
  }
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
  const summary = enabled
    ? "Critic did not run because an earlier deterministic gate failed."
    : "Critic review is disabled for this phase.";
  return { configured: false, blocking, passed: !blocking, summary, findings: [], rawOutput: "" };
}
