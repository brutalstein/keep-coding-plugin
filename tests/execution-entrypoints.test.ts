import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lintAcceptanceCommands } from "../src/core/command-quality.js";
import { KeepCodingService } from "../src/core/service.js";
import { parseAllowedCommands } from "../src/mcp/http.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-execution-entrypoint-"));
  roots.push(root);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "main.js"), "export const ready = true;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

describe("execution policy entry points", () => {
  it("validates HTTP exact-command configuration before server startup", () => {
    expect(parseAllowedCommands(JSON.stringify(["node --version", "npm test", "node --version"])))
      .toEqual(["node --version", "npm test"]);
    expect(() => parseAllowedCommands(JSON.stringify(["node --version && node --version"])))
      .toThrow(/unsafe command.*COMMAND_SPEC_SHELL_SYNTAX/u);
  });

  it("rejects unsafe phase commands during plan validation", () => {
    expect(() => lintAcceptanceCommands([{
      id: "unsafe",
      title: "Unsafe",
      goal: "Unsafe command",
      dependencies: [],
      allowedScope: ["src/**"],
      acceptanceCommands: ["node --version | node --version"],
      maxAttempts: 1
    }])).toThrow(/EXECUTION_COMMAND_REJECTED/u);
  });

  it("validates the effective contract after a plan amendment", async () => {
    const service = await KeepCodingService.open(repository());
    try {
      await service.initialize("Verify the project");
      service.savePlan({
        goal: "Verify the project",
        nonGoals: [],
        constraints: [],
        deliverables: ["verified project"],
        invariants: [],
        doneWhen: ["syntax passes"]
      }, [{
        id: "verify",
        title: "Verify",
        goal: "Verify syntax",
        dependencies: [],
        allowedScope: ["src/**"],
        acceptanceCommands: ["node --check src/main.js"],
        maxAttempts: 1
      }]);
      expect(() => service.amendPlan({
        reason: "Add a release gate",
        addPhases: [],
        supersedePhaseIds: [],
        contractPatch: {
          selectiveTests: {
            commandTemplate: "node --check {tests}",
            fullSuiteCommands: ["node --version && node --version"]
          }
        }
      })).toThrow(/EXECUTION_COMMAND_REJECTED/u);
    } finally {
      service.close();
    }
  });
});
