import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const version = JSON.parse(await readFile("package.json", "utf8")).version;
const canonical = await readFile("skills/keep-coding/SKILL.md", "utf8");
const pluginSkill = await readFile("plugins/keep-coding/skills/keep-coding/SKILL.md", "utf8");
if (canonical !== pluginSkill) throw new Error("canonical and plugin SKILL.md copies differ");
for (const reference of ["MCP_TOOLS.md", "HOST_INTEGRATION.md"]) {
  const left = await readFile(`skills/keep-coding/references/${reference}`, "utf8");
  const right = await readFile(`plugins/keep-coding/skills/keep-coding/references/${reference}`, "utf8");
  if (left !== right) throw new Error(`skill reference drift: ${reference}`);
}
const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(canonical)?.[1] ?? "";
const name = /^name:\s*(.+)$/mu.exec(frontmatter)?.[1]?.trim();
const description = /^description:\s*(.+)$/mu.exec(frontmatter)?.[1]?.trim();
const skillVersion = /^\s*version:\s*"?([^"\n]+)"?$/mu.exec(frontmatter)?.[1]?.trim();
if (name !== "keep-coding") throw new Error("Agent Skill name must match its directory");
if (!description || description.length > 1024 || !/Use when/iu.test(description)) throw new Error("Agent Skill description must state what it does and when to use it");
if (canonical.split("\n").length > 500) throw new Error("SKILL.md exceeds the progressive-disclosure limit");
if (skillVersion !== version) throw new Error(`Agent Skill version drift: ${skillVersion}`);

const codex = JSON.parse(await readFile("plugins/keep-coding/.codex-plugin/plugin.json", "utf8"));
const claude = JSON.parse(await readFile("plugins/keep-coding/.claude-plugin/plugin.json", "utf8"));
const marketplace = JSON.parse(await readFile(".claude-plugin/marketplace.json", "utf8"));
if (codex.version !== version || claude.version !== version || marketplace.version !== version) throw new Error("cross-agent manifest version drift");
if (claude.hooks !== "./hooks/claude-hooks.json" || claude.mcpServers !== "./.mcp.claude.json") throw new Error("Claude component paths are not explicit");
if (!marketplace.plugins.some((entry) => entry.name === "keep-coding" && entry.source === "./plugins/keep-coding")) throw new Error("Claude marketplace entry missing");

const hooks = JSON.parse(await readFile("plugins/keep-coding/hooks/claude-hooks.json", "utf8"));
for (const event of ["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact", "Stop", "SessionEnd"]) {
  const command = hooks.hooks?.[event]?.[0]?.hooks?.[0]?.command;
  if (typeof command !== "string" || !command.includes("${CLAUDE_PLUGIN_ROOT}") || !command.includes("KEEP_CODING_RUNTIME=claude-hooks")) {
    throw new Error(`Claude hook is not portable: ${event}`);
  }
}
const mcp = JSON.parse(await readFile("plugins/keep-coding/.mcp.claude.json", "utf8"));
const args = mcp.mcpServers?.keep_coding?.args;
if (!Array.isArray(args) || args[0] !== "${CLAUDE_PLUGIN_ROOT}/dist/keep-coding.mjs" || args[1] !== "mcp") throw new Error("Claude MCP manifest is invalid");

const digest = createHash("sha256").update(canonical).digest("hex");
console.log(`Cross-agent distribution valid at ${version}; canonical skill SHA-256 ${digest}.`);
