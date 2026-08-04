import { expect, it } from "vitest";
import { parseSemanticFile } from "../src/core/graph/parser.js";

it("parses a generated 2000-line native file within the bounded indexing budget", async () => {
  const functions = Array.from({ length: 2_200 }, (_, index) => `int f${index}(int x) { return helper(x) + ${index}; }`).join("\n");
  const source = `#include "local.h"\nnamespace bench {\n${functions}\n}\n`;
  await parseSemanticFile("int warmup(){ return helper(); }", ".cpp");
  const started = performance.now();
  const parsed = await parseSemanticFile(source, ".cpp");
  const elapsed = performance.now() - started;
  expect(parsed.parser).toBe("tree-sitter-cpp");
  expect(parsed.symbols).toHaveLength(1_000);
  expect(parsed.references).toHaveLength(2_200);
  expect(elapsed).toBeLessThan(4_000);
  console.log(JSON.stringify({ benchmark: "graph-cpp", lines: source.split("\n").length, symbols: parsed.symbols.length, references: parsed.references.length, elapsedMs: Number(elapsed.toFixed(2)) }));
});
