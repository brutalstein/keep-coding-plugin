import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { summarizeOutcomes, type EvaluationStatistics, type PairedOutcome } from "./statistics.js";

const execFileAsync = promisify(execFile);
const TASK_ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;
const MAX_CAPTURE = 32 * 1024 * 1024;

export type CorpusCategory = "greenfield" | "refactor" | "python" | "cpp";

export interface CorpusAssertion {
  path: string;
  exists?: boolean;
  contains?: string[];
  notContains?: string[];
  matches?: string[];
  json?: Record<string, unknown>;
}

export interface EvaluationCorpusTask {
  id: string;
  title: string;
  category: CorpusCategory;
  language: string;
  prompt: string;
  initialFiles: Record<string, string>;
  verifier: {
    assertions: CorpusAssertion[];
    commands: string[][];
  };
}

export interface EvaluationCorpusManifest {
  schemaVersion: 1;
  repetitions: number;
  tasks: EvaluationCorpusTask[];
}

export interface CorpusRunConfig {
  corpusFile: string;
  baseline: { command: string[] };
  keepCoding: { command: string[] };
  outputDirectory: string;
  repetitions?: number;
  timeoutMs?: number;
  taskIds?: string[];
}

interface CorpusRunResult {
  taskId: string;
  category: CorpusCategory;
  repetition: number;
  arm: "baseline" | "keep-coding";
  success: boolean;
  agentExitCode: number | null;
  durationMs: number;
  startingSha: string;
  promptHash: string;
  agentOutput: string;
  verifierResults: Array<{ check: string; passed: boolean; output: string }>;
}

export interface CorpusEvaluationReport {
  metadata: {
    schemaVersion: 1;
    generatedAt: string;
    corpusHash: string;
    taskCount: number;
    repetitions: number;
    pairCount: number;
  };
  aggregate: EvaluationStatistics;
  categories: Partial<Record<CorpusCategory, EvaluationStatistics>>;
  tasks: Record<string, EvaluationStatistics>;
}

export async function loadEvaluationCorpus(filePath: string): Promise<EvaluationCorpusManifest> {
  const absolute = path.resolve(filePath);
  const manifest = JSON.parse(await readFile(absolute, "utf8")) as EvaluationCorpusManifest;
  validateEvaluationCorpus(manifest);
  return manifest;
}

export function validateEvaluationCorpus(manifest: EvaluationCorpusManifest): void {
  if (manifest.schemaVersion !== 1) throw new Error("evaluation corpus schemaVersion must be 1");
  if (!Number.isInteger(manifest.repetitions) || manifest.repetitions < 3 || manifest.repetitions > 10) {
    throw new Error("evaluation corpus repetitions must be an integer between 3 and 10");
  }
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length < 20 || manifest.tasks.length > 30) {
    throw new Error("evaluation corpus must contain 20 to 30 tasks");
  }
  const ids = new Set<string>();
  const categories = new Set<CorpusCategory>();
  for (const task of manifest.tasks) {
    if (!TASK_ID.test(task.id)) throw new Error(`invalid corpus task id: ${task.id}`);
    if (ids.has(task.id)) throw new Error(`duplicate corpus task id: ${task.id}`);
    ids.add(task.id);
    categories.add(task.category);
    if (!task.title.trim() || task.prompt.trim().length < 40) throw new Error(`task ${task.id} requires a descriptive title and prompt`);
    if (!task.language.trim()) throw new Error(`task ${task.id} requires a language`);
    if (Object.keys(task.initialFiles).length === 0) throw new Error(`task ${task.id} requires initial files`);
    for (const [relative, content] of Object.entries(task.initialFiles)) {
      validateRelativePath(relative, `task ${task.id} initial file`);
      if (typeof content !== "string") throw new Error(`task ${task.id} initial file ${relative} must be text`);
    }
    if (task.verifier.assertions.length === 0 && task.verifier.commands.length === 0) {
      throw new Error(`task ${task.id} requires an independent verifier`);
    }
    for (const assertion of task.verifier.assertions) {
      validateRelativePath(assertion.path, `task ${task.id} assertion`);
      for (const expression of assertion.matches ?? []) compileSafeRegex(expression, task.id);
    }
    for (const command of task.verifier.commands) validateCommand(command, task.id);
  }
  for (const required of ["greenfield", "refactor", "python", "cpp"] as const) {
    if (!categories.has(required)) throw new Error(`evaluation corpus is missing ${required} tasks`);
  }
}

export async function runEvaluationCorpus(configPath: string): Promise<CorpusEvaluationReport & { outputDirectory: string }> {
  const absoluteConfig = path.resolve(configPath);
  const base = path.dirname(absoluteConfig);
  const config = JSON.parse(await readFile(absoluteConfig, "utf8")) as CorpusRunConfig;
  validateRunConfig(config);
  const corpusPath = path.resolve(base, config.corpusFile);
  const corpusBytes = await readFile(corpusPath);
  const corpus = JSON.parse(corpusBytes.toString("utf8")) as EvaluationCorpusManifest;
  validateEvaluationCorpus(corpus);
  const selected = selectTasks(corpus.tasks, config.taskIds);
  const repetitions = config.repetitions ?? corpus.repetitions;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error("repetitions must be between 1 and 10");
  const outputDirectory = path.resolve(base, config.outputDirectory);
  const workspace = path.join(outputDirectory, ".work");
  const timeout = config.timeoutMs ?? 1_800_000;
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  const results: CorpusRunResult[] = [];

  try {
    for (const task of selected) {
      const seed = path.join(workspace, "seeds", task.id);
      await materializeSeed(task, seed);
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: seed, encoding: "utf8" });
      const startingSha = stdout.trim();
      const promptHash = createHash("sha256").update(task.prompt).digest("hex");
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const arms = repetition % 2 === 1 ? (["baseline", "keep-coding"] as const) : (["keep-coding", "baseline"] as const);
        for (const arm of arms) {
          const target = path.join(workspace, "runs", task.id, `${repetition}-${arm}`);
          await mkdir(path.dirname(target), { recursive: true });
          await execFileAsync("git", ["worktree", "add", "--detach", target, startingSha], { cwd: seed });
          const started = performance.now();
          const command = arm === "baseline" ? config.baseline.command : config.keepCoding.command;
          const agent = await runArgv(command, target, task.prompt, timeout, {
            KEEP_CODING_EVAL: "1",
            KEEP_CODING_ASSUMPTION_LEDGER: arm === "keep-coding" ? "1" : "0",
            KEEP_CODING_EVAL_TASK_ID: task.id
          });
          const verifierResults = await verifyTask(task, target, timeout);
          results.push({
            taskId: task.id,
            category: task.category,
            repetition,
            arm,
            success: agent.code === 0 && verifierResults.every((item) => item.passed),
            agentExitCode: agent.code,
            durationMs: Math.round(performance.now() - started),
            startingSha,
            promptHash,
            agentOutput: tail(agent.output, 32_000),
            verifierResults
          });
          await execFileAsync("git", ["worktree", "remove", "--force", target], { cwd: seed });
        }
      }
    }
  } finally {
    for (const task of selected) {
      const seed = path.join(workspace, "seeds", task.id);
      await execFileAsync("git", ["worktree", "prune"], { cwd: seed }).catch(() => undefined);
    }
  }

  const report = buildCorpusReport(corpusBytes, selected, repetitions, results);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "raw.jsonl"), `${results.map((item) => JSON.stringify(item)).join("\n")}\n`);
  await writeFile(path.join(outputDirectory, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(outputDirectory, "summary.md"), corpusMarkdown(report));
  await rm(workspace, { recursive: true, force: true });
  return { ...report, outputDirectory };
}

export function buildCorpusReport(
  corpusBytes: Uint8Array,
  tasks: EvaluationCorpusTask[],
  repetitions: number,
  results: CorpusRunResult[]
): CorpusEvaluationReport {
  const pairFor = (filter: (item: CorpusRunResult) => boolean): PairedOutcome[] => {
    const matching = results.filter(filter);
    const keys = [...new Set(matching.map((item) => `${item.taskId}:${item.repetition}`))].sort();
    return keys.map((key) => {
      const [taskId, repetitionText] = key.split(":");
      const repetition = Number(repetitionText);
      return {
        baseline: Boolean(matching.find((item) => item.taskId === taskId && item.repetition === repetition && item.arm === "baseline")?.success),
        keepCoding: Boolean(matching.find((item) => item.taskId === taskId && item.repetition === repetition && item.arm === "keep-coding")?.success)
      };
    });
  };
  const aggregatePairs = pairFor(() => true);
  if (aggregatePairs.length === 0) throw new Error("corpus evaluation produced no paired outcomes");
  const categories: CorpusEvaluationReport["categories"] = {};
  for (const category of ["greenfield", "refactor", "python", "cpp"] as const) {
    const pairs = pairFor((item) => item.category === category);
    if (pairs.length > 0) categories[category] = summarizeOutcomes(pairs);
  }
  const taskReports: Record<string, EvaluationStatistics> = {};
  for (const task of tasks) taskReports[task.id] = summarizeOutcomes(pairFor((item) => item.taskId === task.id));
  return {
    metadata: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      corpusHash: createHash("sha256").update(corpusBytes).digest("hex"),
      taskCount: tasks.length,
      repetitions,
      pairCount: aggregatePairs.length
    },
    aggregate: summarizeOutcomes(aggregatePairs),
    categories,
    tasks: taskReports
  };
}

async function materializeSeed(task: EvaluationCorpusTask, root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  for (const [relative, content] of Object.entries(task.initialFiles)) {
    const target = safeJoin(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "evaluation@keep-coding.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Keep Coding Evaluation"], { cwd: root });
  await execFileAsync("git", ["add", "--all"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", `evaluation seed: ${task.id}`], { cwd: root });
}

async function verifyTask(task: EvaluationCorpusTask, root: string, timeout: number): Promise<CorpusRunResult["verifierResults"]> {
  const results: CorpusRunResult["verifierResults"] = [];
  for (const assertion of task.verifier.assertions) {
    const outcome = await verifyAssertion(assertion, root);
    results.push({ check: `assert:${assertion.path}`, ...outcome });
  }
  for (const command of task.verifier.commands) {
    const outcome = await runArgv(command.map((part) => part.replaceAll("{repo}", root)), root, "", timeout, {
      KEEP_CODING_EVAL_REPO: root,
      KEEP_CODING_EVAL_TASK_ID: task.id
    });
    results.push({ check: `exec:${command.join(" ")}`, passed: outcome.code === 0, output: tail(outcome.output, 8_000) });
  }
  return results;
}

async function verifyAssertion(assertion: CorpusAssertion, root: string): Promise<{ passed: boolean; output: string }> {
  const target = safeJoin(root, assertion.path);
  let content: string;
  try { content = await readFile(target, "utf8"); }
  catch {
    const expected = assertion.exists !== false;
    return { passed: !expected, output: expected ? `missing file: ${assertion.path}` : "file absent as expected" };
  }
  if (assertion.exists === false) return { passed: false, output: `unexpected file: ${assertion.path}` };
  const failures: string[] = [];
  for (const text of assertion.contains ?? []) if (!content.includes(text)) failures.push(`missing text: ${text}`);
  for (const text of assertion.notContains ?? []) if (content.includes(text)) failures.push(`forbidden text: ${text}`);
  for (const expression of assertion.matches ?? []) if (!compileSafeRegex(expression, "runtime").test(content)) failures.push(`regex did not match: ${expression}`);
  if (assertion.json) {
    try { compareJson(JSON.parse(content) as unknown, assertion.json, "$", failures); }
    catch (error) { failures.push(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { passed: failures.length === 0, output: failures.length === 0 ? "passed" : failures.join("\n") };
}

function compareJson(actual: unknown, expected: unknown, pointer: string, failures: string[]): void {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) { failures.push(`${pointer} is not an object`); return; }
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
      compareJson((actual as Record<string, unknown>)[key], value, `${pointer}.${key}`, failures);
    }
    return;
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${pointer} expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}

function validateRunConfig(config: CorpusRunConfig): void {
  validateCommand(config.baseline?.command, "baseline");
  validateCommand(config.keepCoding?.command, "keep-coding");
  if (!config.corpusFile?.trim() || !config.outputDirectory?.trim()) throw new Error("corpusFile and outputDirectory are required");
  if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1_000)) throw new Error("timeoutMs must be at least 1000");
}
function validateCommand(command: string[] | undefined, context: string): void {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || !part.trim())) {
    throw new Error(`${context} command must be a non-empty argv array`);
  }
}
function selectTasks(tasks: EvaluationCorpusTask[], ids?: string[]): EvaluationCorpusTask[] {
  if (!ids || ids.length === 0) return tasks;
  const requested = new Set(ids);
  const selected = tasks.filter((task) => requested.has(task.id));
  const missing = [...requested].filter((id) => !selected.some((task) => task.id === id));
  if (missing.length > 0) throw new Error(`unknown corpus tasks: ${missing.join(", ")}`);
  return selected;
}
function validateRelativePath(relative: string, context: string): void {
  if (!relative || path.isAbsolute(relative) || relative.includes("\0") || relative.split(/[\\/]/u).includes("..")) {
    throw new Error(`${context} path must stay relative: ${relative}`);
  }
}
function safeJoin(root: string, relative: string): string {
  validateRelativePath(relative, "evaluation");
  const target = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (target !== path.resolve(root) && !target.startsWith(prefix)) throw new Error(`path escapes evaluation root: ${relative}`);
  return target;
}
function compileSafeRegex(expression: string, context: string): RegExp {
  if (expression.length > 500) throw new Error(`regex too long in ${context}`);
  if (/\([^)]*[+*][^)]*\)[+*]/u.test(expression)) throw new Error(`nested quantified regex rejected in ${context}`);
  return new RegExp(expression, "mu");
}
function runArgv(
  command: string[], cwd: string, input: string, timeout: number, additions: NodeJS.ProcessEnv
): Promise<{ code: number | null; output: string }> {
  const [executable, ...args] = command;
  if (!executable) throw new Error("empty command");
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, ...additions },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeout);
    const finish = (code: number | null, suffix = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output: `${output}${suffix}` });
    };
    const collect = (chunk: Buffer | string): void => {
      output += String(chunk);
      if (output.length > MAX_CAPTURE) output = output.slice(-MAX_CAPTURE);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => finish(null, `\n${error.message}`));
    child.on("close", (code) => finish(code));
    child.stdin.end(input);
  });
}
function buildCategoryRows(categories: CorpusEvaluationReport["categories"]): string {
  return Object.entries(categories).map(([category, value]) =>
    `| ${category} | ${value.baselineSuccesses}/${value.runs} | ${value.keepCodingSuccesses}/${value.runs} | ${formatPercent(value.absoluteDelta)} |`
  ).join("\n");
}
function corpusMarkdown(report: CorpusEvaluationReport): string {
  const value = report.aggregate;
  return `# Keep Coding corpus evaluation\n\nCorpus SHA-256: \`${report.metadata.corpusHash}\`  \nTasks: **${report.metadata.taskCount}**  \nRepetitions per task: **${report.metadata.repetitions}**  \nPaired outcomes: **${report.metadata.pairCount}**\n\n| Metric | Baseline | Keep Coding |\n|---|---:|---:|\n| Successful runs | ${value.baselineSuccesses}/${value.runs} | ${value.keepCodingSuccesses}/${value.runs} |\n| Success rate | ${formatPercent(value.baselineRate)} | ${formatPercent(value.keepCodingRate)} |\n| Wilson 95% CI | ${formatPercent(value.baselineWilson95[0])}–${formatPercent(value.baselineWilson95[1])} | ${formatPercent(value.keepCodingWilson95[0])}–${formatPercent(value.keepCodingWilson95[1])} |\n\nAbsolute paired delta: **${formatPercent(value.absoluteDelta)}**  \nExact McNemar p-value: **${value.mcnemarExactP.toFixed(4)}**\n\n## Category breakdown\n\n| Category | Baseline | Keep Coding | Paired delta |\n|---|---:|---:|---:|\n${buildCategoryRows(report.categories)}\n\nThe raw JSONL is the source of truth. This summary is generated, not hand-edited.\n`;
}
function formatPercent(value: number): string { return `${(value * 100).toFixed(1)}%`; }
function tail(value: string, max: number): string { return value.length <= max ? value : value.slice(-max); }
