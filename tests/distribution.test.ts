import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface ClaudeManifest { name: string; version: string; hooks: string; mcpServers: string }
interface ClaudeHooks { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
interface ClaudeMcp { mcpServers: { keep_coding: { args: string[] } } }
interface Marketplace { name: string; version: string; plugins: Array<{ name: string; source: string; version: string }> }
const parse = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const canonical = readFileSync("skills/keep-coding/SKILL.md", "utf8");
const packaged = readFileSync("plugins/keep-coding/skills/keep-coding/SKILL.md", "utf8");

describe("cross-agent distribution", () => {
  it("keeps one Agent Skills protocol across canonical and packaged locations", () => {
    expect(packaged).toBe(canonical);
    expect(canonical).toMatch(/^---\nname: keep-coding\n/u);
    expect(canonical).toContain('version: "0.4.0"');
    expect(canonical).toContain("Use when");
    expect(canonical.split("\n").length).toBeLessThan(500);
  });

  it("ships explicit Claude plugin, hook, and MCP manifests", () => {
    const manifest = parse<ClaudeManifest>("plugins/keep-coding/.claude-plugin/plugin.json");
    const hooks = parse<ClaudeHooks>("plugins/keep-coding/hooks/claude-hooks.json");
    const mcp = parse<ClaudeMcp>("plugins/keep-coding/.mcp.claude.json");
    expect(manifest).toMatchObject({ name: "keep-coding", version: "0.4.0", hooks: "./hooks/claude-hooks.json", mcpServers: "./.mcp.claude.json" });
    expect(Object.keys(hooks.hooks)).toEqual(expect.arrayContaining(["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact", "Stop", "SessionEnd"]));
    expect(hooks.hooks.Stop?.[0]?.hooks[0]?.command).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(mcp.mcpServers.keep_coding.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/dist/keep-coding.mjs", "mcp"]);
  });

  it("publishes a valid local Claude marketplace entry", () => {
    const marketplace = parse<Marketplace>(".claude-plugin/marketplace.json");
    expect(marketplace).toMatchObject({ name: "keep-coding-marketplace", version: "0.4.0" });
    expect(marketplace.plugins).toContainEqual(expect.objectContaining({ name: "keep-coding", source: "./plugins/keep-coding", version: "0.4.0" }));
  });
});
