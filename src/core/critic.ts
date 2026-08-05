import type { CriticEvidence, PhaseRecord, ProjectContract } from "../domain/model.js";
import { ExecutionKernel, type ExecutionAttestation } from "./execution-kernel.js";

const MAX_OUTPUT = 32_000;

export interface CriticInput {
  root: string;
  phase: PhaseRecord;
  contract: ProjectContract;
  changedFiles: string[];
  diff: string;
}

export interface AttestedCriticEvidence extends CriticEvidence {
  execution?: ExecutionAttestation | undefined;
  policyViolations?: string[] | undefined;
}

export class CriticRunner {
  constructor(
    private readonly command = process.env.KEEP_CODING_CRITIC_COMMAND?.trim() ?? "",
    private readonly timeoutMs = 120_000
  ) {}

  async review(input: CriticInput, blocking: boolean): Promise<AttestedCriticEvidence> {
    if (!this.command) {
      return {
        configured: false,
        blocking,
        passed: !blocking,
        summary: blocking
          ? "Blocking critic review was requested, but KEEP_CODING_CRITIC_COMMAND is not configured."
          : "Advisory critic is not configured; deterministic gates remain authoritative.",
        findings: blocking
          ? [{
              severity: "error",
              rule: "critic-not-configured",
              message: "Configure an independent critic command or make the critic advisory."
            }]
          : [],
        rawOutput: ""
      };
    }

    const kernel = await ExecutionKernel.open(input.root);
    const result = await kernel.execute({
      command: this.command,
      cwd: input.root,
      purpose: "critic",
      writeScopes: [],
      stdin: JSON.stringify({
        contract: input.contract,
        phase: input.phase,
        changedFiles: input.changedFiles,
        diff: input.diff
      }),
      timeoutMs: this.timeoutMs
    });
    const output = `${result.stdout}${result.stderr}`.slice(-MAX_OUTPUT);
    if (!result.passed) {
      const policyDenied = result.policyViolations.length > 0;
      return {
        configured: true,
        blocking,
        passed: !blocking,
        summary: policyDenied
          ? "Critic execution was denied by the operator execution policy."
          : `Critic command failed with exit code ${result.exitCode ?? "unknown"}.`,
        findings: [{
          severity: blocking ? "error" : "warning",
          rule: policyDenied ? "critic-policy-denied" : "critic-command-failed",
          message: output.slice(-2_000)
        }],
        rawOutput: output,
        execution: result.attestation,
        policyViolations: result.policyViolations
      };
    }

    try {
      const parsed = JSON.parse(result.stdout) as { passed?: unknown; summary?: unknown; findings?: unknown };
      const passed = parsed.passed === true;
      const findings = Array.isArray(parsed.findings)
        ? parsed.findings.flatMap((finding) => normalizeFinding(finding))
        : [];
      return {
        configured: true,
        blocking,
        passed: blocking ? passed : true,
        summary: typeof parsed.summary === "string"
          ? parsed.summary
          : passed
            ? "Critic accepted the change."
            : "Critic raised advisory findings.",
        findings,
        rawOutput: result.stdout.slice(-MAX_OUTPUT),
        execution: result.attestation,
        policyViolations: result.policyViolations
      };
    } catch {
      return {
        configured: true,
        blocking,
        passed: !blocking,
        summary: "Critic output was not valid JSON.",
        findings: [{
          severity: blocking ? "error" : "warning",
          rule: "critic-invalid-output",
          message: output.slice(-2_000)
        }],
        rawOutput: output,
        execution: result.attestation,
        policyViolations: result.policyViolations
      };
    }
  }
}

function normalizeFinding(value: unknown): CriticEvidence["findings"] {
  if (typeof value !== "object" || value === null) return [];
  const item = value as Record<string, unknown>;
  const severity = item.severity === "error" || item.severity === "warning" || item.severity === "info"
    ? item.severity
    : "warning";
  if (typeof item.message !== "string") return [];
  return [{
    severity,
    rule: typeof item.rule === "string" ? item.rule : "critic",
    message: item.message,
    ...(typeof item.file === "string" ? { file: item.file } : {})
  }];
}
