import { readFile } from "node:fs/promises";

const packageData = JSON.parse(await readFile("package.json", "utf8"));
const pluginData = JSON.parse(await readFile("plugins/keep-coding/.codex-plugin/plugin.json", "utf8"));
const readme = await readFile("README.md", "utf8");
const turkishReadme = await readFile("docs/README.tr.md", "utf8");
const changelog = await readFile("CHANGELOG.md", "utf8");
const version = String(packageData.version);

if (String(pluginData.version) !== version) throw new Error("Package and plugin versions differ.");
if (!readme.includes(`v${version}`)) throw new Error("README version is stale.");
if (!turkishReadme.includes(`v${version}`)) throw new Error("Turkish README version is stale.");
if (!changelog.includes(`## ${version} —`)) throw new Error("Changelog release is missing.");

const english = /Verified source suite: ([0-9]+) tests across ([0-9]+) files\./u.exec(readme);
const turkish = /Doğrulanmış source suite: ([0-9]+) test, ([0-9]+) dosya\./u.exec(turkishReadme);
if ((english === null) !== (turkish === null)) throw new Error("README test-count markers differ.");
if (english && turkish && (english[1] !== turkish[1] || english[2] !== turkish[2])) throw new Error("README test counts differ.");

console.log(`Documentation versions are synchronized at ${version}.`);
