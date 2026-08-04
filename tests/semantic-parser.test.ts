import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSemanticFile } from "../src/core/graph/parser.js";

const fixture = (name: string): string => readFileSync(path.join(import.meta.dirname, "fixtures", "semantic", name), "utf8");

describe("tree-sitter semantic parser parity", () => {
  it("extracts exact Python declarations, imports and lexical call scopes", async () => {
    const parsed = await parseSemanticFile(fixture("python_adversarial.py"), ".py");
    expect(parsed.parser).toBe("tree-sitter-python");
    expect(parsed.degraded).toBe(false);
    expect(parsed.symbols.map((item) => [item.qualifiedName, item.kind])).toEqual([
      ["outer", "function"], ["outer.inner", "function"], ["Worker", "class"], ["Worker.run", "function"]
    ]);
    expect(parsed.imports).toEqual(["..pkg.tools", "os", "json"]);
    expect(parsed.references.map((item) => [item.from, item.target])).toEqual([
      [null, "register"], ["outer.inner", "real_call"], ["outer", "inner"], ["Worker.run", "outer"]
    ]);
    expect(parsed.references.map((item) => item.target)).not.toEqual(expect.arrayContaining(["fake_call", "string_call", "comment_call", "ghost"]));
  });

  it("extracts C declarations, local/system includes and function-local calls", async () => {
    const parsed = await parseSemanticFile(fixture("c_adversarial.c"), ".c");
    expect(parsed.parser).toBe("tree-sitter-c");
    expect(parsed.symbols.map((item) => [item.qualifiedName, item.kind, item.declarationOnly ?? false])).toEqual([
      ["Item", "struct", false], ["State", "enum", false], ["declared", "function", true], ["compute", "function", false]
    ]);
    expect(parsed.importKinds).toEqual({ "local.h": "local", "stdio.h": "system" });
    expect(parsed.references).toEqual([{ from: "compute", target: "helper", kind: "calls", line: 10 }]);
  });

  it("extracts C++ namespace, template and method scopes", async () => {
    const parsed = await parseSemanticFile(fixture("cpp_adversarial.cpp"), ".cpp");
    expect(parsed.parser).toBe("tree-sitter-cpp");
    expect(parsed.symbols.map((item) => [item.qualifiedName, item.kind, item.arity ?? null])).toEqual([
      ["demo", "namespace", null], ["demo::transform", "template", 1], ["demo::Runner", "class", null], ["demo::Runner::run", "function", 0]
    ]);
    expect(parsed.importKinds).toEqual({ "api.hpp": "local", vector: "system" });
    expect(parsed.references.map((item) => [item.from, item.target])).toEqual([
      ["demo::transform", "helper"], ["demo::Runner::run", "transform"]
    ]);
  });

  it("is a strict precision improvement over the legacy parser on known false positives", async () => {
    const source = fixture("python_adversarial.py");
    const modern = await parseSemanticFile(source, ".py");
    const legacy = await parseSemanticFile(source, ".py", { legacyOnly: true });
    expect(legacy.degraded).toBe(true);
    expect(legacy.references.some((item) => item.target === "fake_call")).toBe(true);
    expect(modern.references.some((item) => item.target === "fake_call")).toBe(false);
    for (const expected of ["outer", "inner", "Worker", "run"]) expect(modern.symbols.some((item) => item.name === expected)).toBe(true);
  });

  it("falls back explicitly instead of throwing when the WASM parser fails", async () => {
    const parsed = await parseSemanticFile("def work():\n    return helper()\n", ".py", { forceFailure: true });
    expect(parsed.parser).toBe("python-regex-fallback");
    expect(parsed.degraded).toBe(true);
    expect(parsed.diagnostics?.[0]).toContain("tree-sitter fallback");
    expect(parsed.symbols[0]?.name).toBe("work");
  });

  it("rejects tampered sidecar assets and degrades through the explicit fallback", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "keep-coding-tree-sitter-tamper-"));
    try {
      cpSync(path.resolve("assets/tree-sitter"), directory, { recursive: true });
      writeFileSync(path.join(directory, "queries", "python.scm"), "(module) @tampered\n");
      const parsed = await parseSemanticFile("def work():\n    return helper()\n", ".py", { assetDirectory: directory });
      expect(parsed.parser).toBe("python-regex-fallback");
      expect(parsed.degraded).toBe(true);
      expect(parsed.diagnostics?.[0]).toContain("asset integrity mismatch");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

});
