import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runEvaluation } from "../src/eval/runner.js";

describe("A/B evaluation runner", () => {
  it("runs paired clean worktrees and writes reproducible reports", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "keep-coding-eval-"));
    const repository = path.join(root, "repo");
    mkdirSync(repository);
    execFileSync("git", ["init", "-q"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repository });
    writeFileSync(path.join(repository, "agent.mjs"), "import { writeFileSync } from 'node:fs'; process.stdin.resume(); process.stdin.on('end', () => writeFileSync('result.txt', 'ok'));\n");
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repository });
    writeFileSync(path.join(root, "prompt.txt"), "Create the result");
    writeFileSync(path.join(root, "eval.json"), JSON.stringify({
      repository: "./repo", promptFile: "./prompt.txt", runs: 1,
      baseline: { command: [process.execPath, "agent.mjs"] },
      keepCoding: { command: [process.execPath, "agent.mjs"] },
      verifierCommands: ["test -f result.txt"], outputDirectory: "./results", timeoutMs: 5_000
    }));
    const result = await runEvaluation(path.join(root, "eval.json"));
    expect(result.statistics).toMatchObject({ baselineSuccesses: 1, keepCodingSuccesses: 1 });
    expect(readFileSync(path.join(root, "results", "summary.md"), "utf8")).toContain("Exact McNemar");
    rmSync(root, { recursive: true, force: true });
  });
});

