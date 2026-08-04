import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const file = "evaluation/corpus/manifest.json";
const bytes = await readFile(file);
const manifest = JSON.parse(bytes);
if (manifest.schemaVersion !== 1) throw new Error("corpus schemaVersion must be 1");
if (!Number.isInteger(manifest.repetitions) || manifest.repetitions < 3 || manifest.repetitions > 10) throw new Error("corpus repetitions must be 3..10");
if (!Array.isArray(manifest.tasks) || manifest.tasks.length < 20 || manifest.tasks.length > 30) throw new Error("corpus must contain 20..30 tasks");
const ids = new Set();
const categories = new Set();
for (const task of manifest.tasks) {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(task.id)) throw new Error(`invalid task id: ${task.id}`);
  if (ids.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
  ids.add(task.id); categories.add(task.category);
  if (typeof task.prompt !== "string" || task.prompt.trim().length < 40) throw new Error(`weak task prompt: ${task.id}`);
  if (!task.initialFiles || Object.keys(task.initialFiles).length === 0) throw new Error(`missing initial files: ${task.id}`);
  const checks = (task.verifier?.assertions?.length ?? 0) + (task.verifier?.commands?.length ?? 0);
  if (checks === 0) throw new Error(`missing independent verifier: ${task.id}`);
}
for (const category of ["greenfield", "refactor", "python", "cpp"]) if (!categories.has(category)) throw new Error(`missing category: ${category}`);
const hash = createHash("sha256").update(bytes).digest("hex");
const summary = `Evaluation corpus valid: ${manifest.tasks.length} tasks, ${manifest.repetitions} repetitions, SHA-256 ${hash}.`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await import("node:fs/promises").then(({ appendFile }) => appendFile(process.env.GITHUB_STEP_SUMMARY, `\n### Evaluation corpus\n\n${summary}\n`));
