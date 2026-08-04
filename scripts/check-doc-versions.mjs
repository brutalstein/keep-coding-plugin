import { readFile } from "node:fs/promises";

const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const packageData = await json("package.json");
const codexPlugin = await json("plugins/keep-coding/.codex-plugin/plugin.json");
const claudePlugin = await json("plugins/keep-coding/.claude-plugin/plugin.json");
const claudeMarketplace = await json(".claude-plugin/marketplace.json");
const readme = await readFile("README.md", "utf8");
const turkishReadme = await readFile("docs/README.tr.md", "utf8");
const changelog = await readFile("CHANGELOG.md", "utf8");
const canonicalSkill = await readFile("skills/keep-coding/SKILL.md", "utf8");
const version = String(packageData.version);

for (const [label, value] of [
  ["Codex plugin", codexPlugin.version], ["Claude plugin", claudePlugin.version],
  ["Claude marketplace", claudeMarketplace.version], ["Claude marketplace entry", claudeMarketplace.plugins?.[0]?.version]
]) if (String(value) !== version) throw new Error(`${label} version differs from package version.`);
if (!canonicalSkill.includes(`version: "${version}"`)) throw new Error("Canonical Agent Skill version is stale.");
if (!readme.includes(`v${version}`)) throw new Error("README version is stale.");
if (!turkishReadme.includes(`v${version}`)) throw new Error("Turkish README version is stale.");
if (!changelog.includes(`## ${version} —`)) throw new Error("Changelog release is missing.");
const english = /Verified source suite: ([0-9]+) tests across ([0-9]+) files\./u.exec(readme);
const turkish = /Doğrulanmış source suite: ([0-9]+) test, ([0-9]+) dosya\./u.exec(turkishReadme);
if (!english || !turkish || english[1] !== turkish[1] || english[2] !== turkish[2]) throw new Error("README test counts differ.");
console.log(`Documentation and distribution versions are synchronized at ${version}.`);
