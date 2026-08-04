import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadEvaluationCorpus, runEvaluationCorpus, validateEvaluationCorpus,
  type EvaluationCorpusManifest, type EvaluationCorpusTask
} from "../src/eval/corpus.js";

function task(index: number): EvaluationCorpusTask {
  const category = (["greenfield", "refactor", "python", "cpp"] as const)[index % 4] ?? "greenfield";
  return {
    id: `task-${String(index).padStart(2, "0")}`,
    title: `Task ${index}`,
    category,
    language: category === "python" ? "python" : category === "cpp" ? "cpp" : "javascript",
    prompt: `Create result.txt containing the exact durable result marker for independent evaluation task ${index}.`,
    initialFiles: { "README.md": `# Task ${index}\n` },
    verifier: { assertions: [{ path: "result.txt", contains: ["durable-result"] }], commands: [] }
  };
}
function manifest(): EvaluationCorpusManifest {
  return { schemaVersion: 1, repetitions: 3, tasks: Array.from({ length: 20 }, (_, index) => task(index + 1)) };
}

describe("evaluation corpus", () => {
  it("validates a diverse frozen 20-task manifest and rejects path escapes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "keep-coding-corpus-"));
    try {
      const valid = manifest();
      const file = path.join(root, "corpus.json");
      writeFileSync(file, JSON.stringify(valid));
      await expect(loadEvaluationCorpus(file)).resolves.toMatchObject({ tasks: { length: 20 } });
      const unsafe = manifest();
      unsafe.tasks[0]!.initialFiles = { "../escape": "x" };
      expect(() => validateEvaluationCorpus(unsafe)).toThrow(/stay relative/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("runs selected tasks in clean paired worktrees and keeps verification external", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "keep-coding-corpus-run-"));
    try {
      const corpusFile = path.join(root, "corpus.json");
      writeFileSync(corpusFile, JSON.stringify(manifest()));
      const agent = path.join(root, "agent.mjs");
      writeFileSync(agent, "import {writeFileSync} from 'node:fs';process.stdin.resume();process.stdin.on('end',()=>writeFileSync('result.txt','durable-result'));\n");
      const config = path.join(root, "run.json");
      writeFileSync(config, JSON.stringify({
        corpusFile: "./corpus.json",
        baseline: { command: [process.execPath, agent] },
        keepCoding: { command: [process.execPath, agent] },
        outputDirectory: "./results",
        repetitions: 1,
        taskIds: ["task-01"],
        timeoutMs: 5_000
      }));
      const report = await runEvaluationCorpus(config);
      expect(report.aggregate).toMatchObject({ runs: 1, baselineSuccesses: 1, keepCodingSuccesses: 1 });
      expect(report.metadata).toMatchObject({ taskCount: 1, repetitions: 1, pairCount: 1 });
      expect(readFileSync(path.join(root, "results", "summary.md"), "utf8")).toContain("Corpus SHA-256");
      const raw = readFileSync(path.join(root, "results", "raw.jsonl"), "utf8").trim().split("\n");
      expect(raw).toHaveLength(2);
      expect(existsSync(path.join(root, "results", ".work"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects catastrophic regular expressions in verifier contracts", () => {
    const invalid = manifest();
    invalid.tasks[0]!.verifier.assertions = [{ path: "x", matches: ["(a+)+$"] }];
    expect(() => validateEvaluationCorpus(invalid)).toThrow(/nested quantified regex/u);
  });
});
