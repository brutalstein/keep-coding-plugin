import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PlaybookStore } from "../src/storage/playbook.js";
import type { PhaseDefinition } from "../src/domain/model.js";

function phase(id: string, title: string, goal: string, scope: string): PhaseDefinition {
  return {
    id, title, goal, dependencies: [], allowedScope: [scope],
    acceptanceCommands: [`npm run test -- ${id}`], maxAttempts: 2
  };
}

describe("cross-project playbook", () => {
  it("merges duplicate structured patterns across projects", () => {
    const root = mkdtempSync(path.join(tmpdir(), "keep-coding-playbook-"));
    const store = new PlaybookStore(path.join(root, "playbook.db"));
    try {
      const template = phase("auth", "Authentication hardening", "Harden token validation", "src/auth/**");
      const first = store.rememberPhase("/projects/one", template, ["authentication", "tokens"]);
      const second = store.rememberPhase("/projects/two", template, ["authentication", "tokens"]);
      expect(second.id).toBe(first.id);
      expect(second.successCount).toBe(2);
      expect(second.sourceProjects).toEqual(expect.arrayContaining(["/projects/one", "/projects/two"]));
      expect(store.suggest("authentication token validation", 10)).toHaveLength(1);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces only the top-K patterns relevant to the active query", () => {
    const root = mkdtempSync(path.join(tmpdir(), "keep-coding-playbook-relevance-"));
    const store = new PlaybookStore(path.join(root, "playbook.db"));
    try {
      store.rememberPhase("/p", phase("auth", "Authentication token validation", "Validate access tokens", "src/auth/**"), ["oauth", "jwt"]);
      store.rememberPhase("/p", phase("session", "Authentication session rotation", "Rotate secure sessions", "src/session/**"), ["auth", "session"]);
      store.rememberPhase("/p", phase("docs", "Documentation refresh", "Update user guide", "docs/**"), ["markdown"]);
      store.rememberPhase("/p", phase("ui", "Button styling", "Polish button styles", "src/ui/**"), ["css"]);
      const suggestions = store.suggest("authentication jwt session security", 2);
      expect(suggestions).toHaveLength(2);
      expect(suggestions.map((item) => item.pattern).join(" ")).toMatch(/Authentication/);
      expect(suggestions.some((item) => item.pattern === "Documentation refresh")).toBe(false);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
