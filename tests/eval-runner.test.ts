import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runEvaluation } from "../src/eval/runner.js";

function fixture(): { root: string; repository: string; base: Record<string, unknown> } {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-eval-"));
  const repository = path.join(root, "repo");
  mkdirSync(repository);
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repository });
  writeFileSync(path.join(repository, "agent.mjs"), "import { writeFileSync } from 'node:fs'; process.stdin.resume(); process.stdin.on('end', () => writeFileSync('result.txt', process.env.KEEP_CODING_ASSUMPTION_LEDGER ?? 'missing'));\n");
  execFileSync("git", ["add", "."], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repository });
  writeFileSync(path.join(root, "prompt.txt"), "Create the result");
  return {
    root, repository,
    base: {
      repository: "./repo", promptFile: "./prompt.txt", runs: 1,
      baseline: { command: [process.execPath, "agent.mjs"] },
      keepCoding: { command: [process.execPath, "agent.mjs"] },
      verifierCommands: ["test -f result.txt"], outputDirectory: "./results", timeoutMs: 5_000
    }
  };
}

describe("A/B evaluation runner", () => {
  it("runs paired clean worktrees and writes reproducible reports", async () => {
    const { root, base } = fixture();
    try {
      writeFileSync(path.join(root, "eval.json"), JSON.stringify(base));
      const result = await runEvaluation(path.join(root, "eval.json"));
      expect(result.statistics).toMatchObject({ baselineSuccesses: 1, keepCodingSuccesses: 1 });
      expect(readFileSync(path.join(root, "results", "summary.md"), "utf8")).toContain("Exact McNemar");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports enabled-vs-disabled assumption metrics with McNemar comparison", async () => {
    const { root, base } = fixture();
    try {
      writeFileSync(path.join(root, "eval.json"), JSON.stringify({
        ...base, assumptionLedger: {
          enabled: true,
          corrections: [
            { outcome: "contained", tokenStart: 10, tokenEnd: 30 },
            { outcome: "expanded", tokenStart: 100, tokenEnd: 140 }
          ],
          antiPatternHits: 3, matchingSituations: 4,
          pairedOutcomes: [
            { disabled: false, enabled: true },
            { disabled: false, enabled: true },
            { disabled: true, enabled: true },
            { disabled: false, enabled: false }
          ]
        }
      }));
      const result = await runEvaluation(path.join(root, "eval.json"));
      expect(result.assumptionLedger).toMatchObject({
        metrics: { containmentRate: 0.5, tokensPerCorrection: 30, antiPatternHitRate: 0.75 },
        enabledVsDisabled: { baselineRate: 0.25, keepCodingRate: 0.75, mcnemarExactP: 0.5 }
      });
      const summary = readFileSync(path.join(root, "results", "summary.md"), "utf8");
      expect(summary).toContain("Assumption ledger");
      expect(summary).toContain("Enabled-vs-disabled exact McNemar");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("omits all subsystem metrics and persistence when disabled", async () => {
    const { root, repository, base } = fixture();
    try {
      writeFileSync(path.join(root, "eval.json"), JSON.stringify({ ...base, assumptionLedger: { enabled: false } }));
      const result = await runEvaluation(path.join(root, "eval.json"));
      expect("assumptionLedger" in result).toBe(false);
      expect(readFileSync(path.join(root, "results", "summary.md"), "utf8")).not.toContain("Assumption ledger");
      expect(JSON.parse(readFileSync(path.join(root, "results", "summary.json"), "utf8"))).not.toHaveProperty("assumptionLedger");
      expect(existsSync(path.join(repository, ".keep-coding"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
