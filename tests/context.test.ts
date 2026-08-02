import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileContext } from "../src/core/context.js";
import { ProjectStore } from "../src/storage/store.js";

describe("context compiler", () => {
  it("includes durable state and respects its budget floor", () => {
    const root = mkdtempSync(path.join(tmpdir(), "keep-coding-context-"));
    const store = new ProjectStore(root);
    store.initialize("A large project");
    store.savePlan({ goal: "Deliver a complete tested system", nonGoals: [], constraints: ["Node 22"], deliverables: ["server"], invariants: ["safe"], doneWhen: ["tests pass"] }, [{ id: "server", title: "Server", goal: "Build the server", dependencies: [], allowedScope: ["src/**"], acceptanceCommands: ["npm test"], maxAttempts: 3 }]);
    const context = compileContext(store, 1_000);
    expect(context).toContain("KEEP CODING ACTIVE");
    expect(context).toContain("Deliver a complete tested system");
    expect(context.length).toBeLessThanOrEqual(1_010);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
});

