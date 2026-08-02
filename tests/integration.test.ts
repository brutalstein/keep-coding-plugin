import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KeepCodingService } from "../src/core/service.js";
import { handleHook } from "../src/hooks/handler.js";

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-integration-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) { return a + b; }\n");
  writeFileSync(path.join(root, "package.json"), "{\"type\":\"module\",\"scripts\":{\"test\":\"node --check src/math.js\"}}\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

describe("integrated continuity workflow", () => {
  it("indexes, plans, verifies and completes one default workflow", async () => {
    const root = repository();
    const service = await KeepCodingService.open(root);
    const initialized = await service.initialize("Build a tested math feature");
    expect(initialized.index).toMatchObject({ filesIndexed: 2 });
    expect(service.store.searchGraph(["add"])[0]?.symbol).toBe("add");
    service.savePlan(
      { goal: "Deliver a tested math feature", nonGoals: [], constraints: [], deliverables: ["math function"], invariants: ["syntax valid"], doneWhen: ["npm test passes"] },
      [
        { id: "math", title: "Math", goal: "Update math", dependencies: [], allowedScope: ["src/**"], acceptanceCommands: ["npm test"], maxAttempts: 2 },
        { id: "docs", title: "Docs", goal: "Document math", dependencies: ["math"], allowedScope: ["README.md"], acceptanceCommands: ["npm test"], maxAttempts: 2 }
      ]
    );
    await service.startPhase("math");
    writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) { return Number(a) + Number(b); }\n");
    const checkpoint = await service.checkpoint("math", "hardened addition");
    expect(checkpoint.evidence).toMatchObject({ passed: true });
    await service.startPhase("docs");
    writeFileSync(path.join(root, "README.md"), "# Math\n");
    const docsCheckpoint = await service.checkpoint("docs", "documented math");
    expect(docsCheckpoint.evidence).toMatchObject({ passed: true, changedFiles: ["README.md"] });
    expect(service.store.completeProject().status).toBe("COMPLETED");
    service.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("auto-activates and guards an unfinished large request", async () => {
    const root = repository();
    const prompt = "Build a production-ready modular complete project with architecture, integrations, tests, deployment and phases. ".repeat(5);
    const activation = await handleHook("UserPromptSubmit", { cwd: root, prompt });
    const activationContext = activation.hookSpecificOutput as { hookEventName?: unknown; additionalContext?: unknown };
    expect(activationContext.hookEventName).toBe("UserPromptSubmit");
    expect(String(activationContext.additionalContext)).toContain("KEEP CODING ACTIVE");
    const stop = await handleHook("Stop", { cwd: root });
    expect(stop.decision).toBe("block");
    const released = await handleHook("Stop", { cwd: root, stop_hook_active: true });
    expect(released.continue).toBe(true);
    const resumed = await handleHook("SessionStart", { cwd: root });
    const resumedContext = resumed.hookSpecificOutput as { hookEventName?: unknown; additionalContext?: unknown };
    expect(resumedContext.hookEventName).toBe("SessionStart");
    expect(String(resumedContext.additionalContext)).toContain("KEEP CODING ACTIVE");
    rmSync(root, { recursive: true, force: true });
  });
});
