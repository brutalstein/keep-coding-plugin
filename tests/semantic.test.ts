import { describe, expect, it } from "vitest";
import { parseSemanticDocument } from "../src/core/graph/semantic.js";

describe("semantic parser adapters", () => {
  it("extracts TypeScript AST imports, declarations and calls", () => {
    const document = parseSemanticDocument("src/service.ts", `
      import { helper } from "./helper.js";
      export function run(value: string) { return helper(value); }
      export class Service { execute() { return run("x"); } }
    `);
    expect(document.parser).toBe("typescript-compiler-ast");
    expect(document.imports).toEqual(["./helper.js"]);
    expect(document.symbols.find((symbol) => symbol.name === "run")?.calls).toContain("helper");
    expect(document.symbols.find((symbol) => symbol.name === "Service")).toBeDefined();
  });

  it("extracts Python symbols and relationships through the adapter boundary", () => {
    const document = parseSemanticDocument("worker.py", `
import json

def encode(value):
    return json.dumps(value)
`);
    expect(document.parser).toBe("python-structural-ast");
    expect(document.imports).toEqual(["json"]);
    expect(document.symbols[0]).toMatchObject({ name: "encode", kind: "function" });
    expect(document.symbols[0]?.calls).toContain("dumps");
  });

  it("degrades safely for unsupported languages", () => {
    expect(parseSemanticDocument("README.md", "# docs")).toEqual({ parser: "structural-fallback", imports: [], symbols: [] });
  });
});
