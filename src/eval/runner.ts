import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { summarizeOutcomes } from "./statistics.js";

const execFileAsync = promisify(execFile);

export interface EvalConfig {
  repository: string;
  promptFile: string;
  runs: number;
  baseline: { command: string[] };
  keepCoding: { command: string[] };
  verifierCommands: string[];
  outputDirectory: string;
  timeoutMs?: number;
}

interface RunResult {
  pair: number;
  arm: "baseline" | "keep-coding";
  success: boolean;
  agentExitCode: number | null;
  durationMs: number;
  startingSha: string;
  promptHash: string;
  agentOutput: string;
  verifierResults: Array<{ command: string; passed: boolean; output: string }>;
}

export async function runEvaluation(configPath: string): Promise<Record<string, unknown>> {
  const absoluteConfig = path.resolve(configPath);
  const base = path.dirname(absoluteConfig);
  const config = JSON.parse(await readFile(absoluteConfig, "utf8")) as EvalConfig;
  validateConfig(config);
  const repository = path.resolve(base, config.repository);
  const prompt = await readFile(path.resolve(base, config.promptFile), "utf8");
  const outputDirectory = path.resolve(base, config.outputDirectory);
  const { stdout: startingShaOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" });
  const startingSha = startingShaOutput.trim();
  const promptHash = createHash("sha256").update(prompt).digest("hex");
  const workspace = path.join(outputDirectory, "worktrees");
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  const results: RunResult[] = [];
  try {
    for (let pair = 1; pair <= config.runs; pair += 1) {
      const arms = pair % 2 === 1 ? (["baseline", "keep-coding"] as const) : (["keep-coding", "baseline"] as const);
      for (const arm of arms) {
        const target = path.join(workspace, `${pair}-${arm}`);
        await execFileAsync("git", ["worktree", "add", "--detach", target, "HEAD"], { cwd: repository });
        const started = performance.now();
        const command = (arm === "baseline" ? config.baseline : config.keepCoding).command;
        const agent = await run(command, target, prompt, config.timeoutMs ?? 1_800_000);
        const verifierResults = [];
        for (const verifier of config.verifierCommands) {
          const checked = await runShell(verifier, target, config.timeoutMs ?? 1_800_000);
          verifierResults.push({ command: verifier, passed: checked.code === 0, output: checked.output.slice(-8_000) });
        }
        results.push({
          pair, arm, success: agent.code === 0 && verifierResults.every((item) => item.passed), agentExitCode: agent.code,
          durationMs: Math.round(performance.now() - started), startingSha, promptHash,
          agentOutput: agent.output.slice(-32_000), verifierResults
        });
        await execFileAsync("git", ["worktree", "remove", "--force", target], { cwd: repository });
      }
    }
  } finally {
    await execFileAsync("git", ["worktree", "prune"], { cwd: repository }).catch(() => undefined);
  }
  const pairs = Array.from({ length: config.runs }, (_, index) => ({
    baseline: Boolean(results.find((item) => item.pair === index + 1 && item.arm === "baseline")?.success),
    keepCoding: Boolean(results.find((item) => item.pair === index + 1 && item.arm === "keep-coding")?.success)
  }));
  const statistics = summarizeOutcomes(pairs);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "raw.jsonl"), `${results.map((item) => JSON.stringify(item)).join("\n")}\n`);
  await writeFile(path.join(outputDirectory, "summary.json"), `${JSON.stringify({ metadata: { startingSha, promptHash, generatedAt: new Date().toISOString() }, statistics }, null, 2)}\n`);
  await writeFile(path.join(outputDirectory, "summary.md"), markdownSummary(statistics));
  return { statistics, outputDirectory };
}

function validateConfig(config: EvalConfig): void {
  if (!Number.isInteger(config.runs) || config.runs < 1) throw new Error("runs must be a positive integer");
  if (config.baseline.command.length === 0 || config.keepCoding.command.length === 0) throw new Error("both commands are required");
  if (config.verifierCommands.length === 0) throw new Error("at least one independent verifier command is required");
}

async function run(command: string[], cwd: string, input: string, timeout: number): Promise<{ code: number | null; output: string }> {
  const [executable, ...args] = command;
  if (!executable) throw new Error("empty command");
  return new Promise((resolve) => {
    const child = import("node:child_process").then(({ spawn }) => {
      const process = spawn(executable, args, { cwd, env: processEnv(), stdio: ["pipe", "pipe", "pipe"], timeout });
      let output = "";
      process.stdout.on("data", (chunk) => { output += String(chunk); });
      process.stderr.on("data", (chunk) => { output += String(chunk); });
      process.on("error", (error) => resolve({ code: null, output: `${output}\n${error.message}` }));
      process.on("close", (code) => resolve({ code, output }));
      process.stdin.end(input);
    });
    void child;
  });
}

async function runShell(command: string, cwd: string, timeout: number): Promise<{ code: number | null; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.platform === "win32" ? "cmd.exe" : "/bin/sh", process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command], { cwd, timeout, maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : null, output: `${failure.stdout ?? ""}${failure.stderr ?? failure.message}` };
  }
}

function processEnv(): NodeJS.ProcessEnv {
  return { ...process.env, KEEP_CODING_EVAL: "1" };
}

function markdownSummary(value: ReturnType<typeof summarizeOutcomes>): string {
  const percent = (input: number): string => `${(input * 100).toFixed(1)}%`;
  return `# Keep Coding evaluation\n\n| Metric | Baseline | Keep Coding |\n|---|---:|---:|\n| Successful runs | ${value.baselineSuccesses}/${value.runs} | ${value.keepCodingSuccesses}/${value.runs} |\n| Success rate | ${percent(value.baselineRate)} | ${percent(value.keepCodingRate)} |\n| Wilson 95% CI | ${percent(value.baselineWilson95[0])}–${percent(value.baselineWilson95[1])} | ${percent(value.keepCodingWilson95[0])}–${percent(value.keepCodingWilson95[1])} |\n\nAbsolute paired delta: **${percent(value.absoluteDelta)}**  \nExact McNemar p-value: **${value.mcnemarExactP.toFixed(4)}**\n`;
}
