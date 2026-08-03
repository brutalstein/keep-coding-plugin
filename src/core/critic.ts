import { spawn } from "node:child_process";
import type { CriticEvidence, PhaseRecord, ProjectContract } from "../domain/model.js";

export interface CriticInput {
  contract: ProjectContract | null;
  phase: PhaseRecord;
  diff: string;
  changedFiles: string[];
}

export async function runCritic(input: CriticInput): Promise<CriticEvidence> {
  const gate = input.contract?.criticGate ?? "advisory";
  if (gate === "disabled") return { configured: false, passed: true, blocking: false, summary: "Critic gate disabled.", findings: [] };
  const command = parseCommand(process.env.KEEP_CODING_CRITIC_COMMAND_JSON);
  if (command.length === 0) {
    const blocking = gate === "blocking";
    return {
      configured: false,
      passed: !blocking,
      blocking,
      summary: blocking
        ? "Blocking critic gate requested, but no critic adapter is configured."
        : "No critic adapter configured; deterministic gates remain authoritative.",
      findings: blocking ? ["Configure KEEP_CODING_CRITIC_COMMAND_JSON or change criticGate to advisory."] : []
    };
  }
  const [executable, ...args] = command;
  if (!executable) throw new Error("critic command is empty");
  const result = await runJsonProcess(executable, args, input);
  return {
    configured: true,
    passed: result.passed,
    blocking: gate === "blocking",
    summary: result.summary,
    findings: result.findings
  };
}

function parseCommand(value: string | undefined): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("KEEP_CODING_CRITIC_COMMAND_JSON must be a non-empty JSON string array");
  const command = parsed.filter((item): item is string => typeof item === "string");
  if (command.length !== parsed.length || command.length === 0) {
    throw new Error("KEEP_CODING_CRITIC_COMMAND_JSON must be a non-empty JSON string array");
  }
  return command;
}

async function runJsonProcess(executable: string, args: string[], input: CriticInput): Promise<{ passed: boolean; summary: string; findings: string[] }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: { ...process.env, KEEP_CODING_CRITIC: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      timeout: 120_000
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolve({ passed: false, summary: error.message, findings: [] }));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ passed: false, summary: `Critic exited ${code ?? "without a code"}: ${stderr.slice(-2_000)}`, findings: [] });
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { passed?: unknown; summary?: unknown; findings?: unknown };
        resolve({
          passed: parsed.passed !== false,
          summary: typeof parsed.summary === "string" ? parsed.summary : "Critic completed.",
          findings: Array.isArray(parsed.findings) ? parsed.findings.filter((item): item is string => typeof item === "string").slice(0, 100) : []
        });
      } catch {
        resolve({ passed: false, summary: "Critic returned invalid JSON.", findings: [stdout.slice(-2_000)] });
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
