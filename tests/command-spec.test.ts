import { describe, expect, it } from "vitest";
import { commandSpecHash, formatCommandSpec, parseCommandSpec } from "../src/core/command-spec.js";

describe("shell-free command specification", () => {
  it("parses quoted argv without invoking shell semantics", () => {
    const spec = parseCommandSpec('node -e "console.log(\'ok\');" "file with spaces.js"');
    expect(spec).toEqual({
      executable: "node",
      argv: ["-e", "console.log('ok');", "file with spaces.js"],
      display: 'node -e "console.log(\'ok\');" "file with spaces.js"'
    });
    expect(commandSpecHash(spec)).toHaveLength(64);
    expect(commandSpecHash(spec)).toBe(commandSpecHash(parseCommandSpec(spec.display)));
  });

  it("preserves Windows-style path separators", () => {
    expect(parseCommandSpec("node C:\\repo\\src\\main.js")).toMatchObject({
      executable: "node",
      argv: ["C:\\repo\\src\\main.js"]
    });
  });

  it("formats argv into a parseable display string", () => {
    const display = formatCommandSpec("node", ["--check", "src/file with spaces.js"]);
    expect(parseCommandSpec(display)).toMatchObject({
      executable: "node",
      argv: ["--check", "src/file with spaces.js"]
    });
  });

  it.each([
    "node --version && node --version",
    "node --version | node --version",
    "node --version > output.txt",
    "node $(node --version)",
    "VALUE=1 node --version",
    "node --version\nnode --version",
    'node "unterminated'
  ])("rejects shell authority or malformed syntax: %s", (command) => {
    expect(() => parseCommandSpec(command)).toThrow(/COMMAND_SPEC_/u);
  });

  it("rejects hidden control characters", () => {
    expect(() => parseCommandSpec(`node --version${String.fromCharCode(0)}`)).toThrow(/COMMAND_SPEC_SHELL_SYNTAX/u);
  });
});
