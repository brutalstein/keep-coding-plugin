import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve("plugins/keep-coding");
const dist = path.join(root, "dist/keep-coding.mjs");
const manifest = JSON.parse(await readFile(path.join(root, ".codex-plugin/plugin.json"), "utf8"));
const marketplace = JSON.parse(await readFile(".agents/plugins/marketplace.json", "utf8"));
const mcp = JSON.parse(await readFile(path.join(root, ".mcp.json"), "utf8"));
const required = ["name", "version", "description", "author", "interface"];
for (const key of required) {
  if (!(key in manifest)) throw new Error(`plugin.json missing ${key}`);
}
if (manifest.name !== "keep-coding") throw new Error("plugin name mismatch");
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error("invalid semver");
if (manifest.version !== "0.2.1") throw new Error(`plugin manifest version drift: ${manifest.version}`);
if (manifest.mcpServers !== "./.mcp.json") throw new Error("MCP manifest is not declared");
if (!("keep_coding" in mcp.mcpServers)) throw new Error("keep_coding MCP server is missing");
if (mcp.mcpServers.keep_coding.cwd !== ".") throw new Error("MCP cwd must resolve from plugin root");
if (!marketplace.plugins.some((entry) => entry.name === "keep-coding")) throw new Error("marketplace entry missing");
for (const relative of [
  "hooks/hooks.json",
  "skills/keep-coding/SKILL.md",
  "skills/keep-coding/agents/openai.yaml",
  "dist/keep-coding.mjs"
]) {
  await access(path.join(root, relative));
}

const version = spawnSync(process.execPath, [dist, "version"], { encoding: "utf8", timeout: 15_000 });
assertProcess(version, "production CLI version");
if (version.stdout.trim() !== "0.2.1") throw new Error(`production CLI version mismatch: ${version.stdout.trim()}`);

const nonGit = await mkdtemp(path.join(tmpdir(), "keep-coding-validate-"));
try {
  const hook = spawnSync(process.execPath, [dist, "hook", "SessionStart"], {
    input: JSON.stringify({ cwd: nonGit, session_id: "plugin-validation" }),
    encoding: "utf8",
    timeout: 15_000
  });
  assertProcess(hook, "production CLI hook");
  const output = JSON.parse(hook.stdout);
  if (output.continue !== true) throw new Error("production hook did not continue gracefully outside Git");
} finally {
  await rm(nonGit, { recursive: true, force: true });
}

const size = (await stat(dist)).size;
if (size > 3_000_000) throw new Error(`production bundle unexpectedly large (${size} bytes); TypeScript may have been inlined`);
console.log(`Keep Coding plugin package is structurally and operationally valid (${size} byte bundle).`);

function assertProcess(result, label) {
  if (result.error) throw new Error(`${label} failed to spawn: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} exited ${result.status}: ${result.stderr || result.stdout}`);
}
