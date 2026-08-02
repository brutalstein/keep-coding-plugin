import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("plugins/keep-coding");
const manifest = JSON.parse(await readFile(path.join(root, ".codex-plugin/plugin.json"), "utf8"));
const marketplace = JSON.parse(await readFile(".agents/plugins/marketplace.json", "utf8"));
const mcp = JSON.parse(await readFile(path.join(root, ".mcp.json"), "utf8"));
const required = ["name", "version", "description", "author", "interface"];
for (const key of required) {
  if (!(key in manifest)) throw new Error(`plugin.json missing ${key}`);
}
if (manifest.name !== "keep-coding") throw new Error("plugin name mismatch");
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error("invalid semver");
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
console.log("Keep Coding plugin package is structurally valid.");
