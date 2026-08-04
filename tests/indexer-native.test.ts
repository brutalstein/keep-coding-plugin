import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitRepository } from "../src/core/git.js";
import { indexRepository } from "../src/core/indexer.js";
import { PlatformStore } from "../src/storage/platform-store.js";

function nativeRepository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-native-index-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  mkdirSync(path.join(root, "include")); mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "include", "api.hpp"), "namespace demo { int compute(int value); }\n");
  writeFileSync(path.join(root, "src", "api.cpp"), "#include \"../include/api.hpp\"\nnamespace demo { int compute(int value) { return value + 1; } }\n");
  writeFileSync(path.join(root, "src", "main.cpp"), "#include \"../include/api.hpp\"\nint main(){ return demo::compute(1); }\n");
  execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

describe("native semantic indexing", () => {
  it("resolves local includes and unifies header declarations with source definitions", async () => {
    const root = nativeRepository();
    const store = new PlatformStore(root);
    try {
      const result = await indexRepository(store, await GitRepository.open(root));
      expect(result.fallbacks).toBe(0);
      expect(result.parserCounts["tree-sitter-cpp"]).toBe(3);
      const declaration = store.searchGraph(["compute"], 20).find((node) => node.path === "include/api.hpp");
      const definition = store.searchGraph(["compute"], 20).find((node) => node.path === "src/api.cpp");
      expect(declaration).toBeTruthy(); expect(definition).toBeTruthy();
      expect(store.getEdgesFrom(declaration!.id, "same_symbol").map((edge) => edge.targetId)).toContain(definition!.id);
      expect(store.getEdgesFrom("file:src/main.cpp", "imports").map((edge) => edge.targetId)).toContain("file:include/api.hpp");
      const impact = store.impact(declaration!.id, 3).map((item) => item.node.path);
      expect(impact).toEqual(expect.arrayContaining(["include/api.hpp", "src/api.cpp"]));
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
