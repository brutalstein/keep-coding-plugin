import { appendFile, readFile } from "node:fs/promises";

const summary = JSON.parse(await readFile("coverage/coverage-summary.json", "utf8"));
const current = summary.total;
const baseline = { statements: 85.79, branches: 73.32, functions: 89.85, lines: 92.59 };
const requiredBranches = 75;
const values = Object.fromEntries(Object.entries(current).map(([key, value]) => [key, Number(value.pct)]));
if (values.branches < requiredBranches) throw new Error(`branch coverage ${values.branches}% is below ${requiredBranches}%`);
const markdown = [
  "## Keep Coding coverage",
  "",
  "| Metric | v0.3.0 baseline | v0.4.0 current | Delta |",
  "|---|---:|---:|---:|",
  ...["statements", "branches", "functions", "lines"].map((metric) => {
    const delta = values[metric] - baseline[metric];
    return `| ${metric} | ${baseline[metric].toFixed(2)}% | ${values[metric].toFixed(2)}% | ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} pp |`;
  })
].join("\n");
console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
