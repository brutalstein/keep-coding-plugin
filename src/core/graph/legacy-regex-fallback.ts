import type { ParsedFile, ParsedReference, ParsedSymbol } from "./parser.js";

export function parsePythonLegacy(content: string, reason = "tree-sitter unavailable"): ParsedFile {
  const symbols: ParsedSymbol[] = [];
  const imports = new Set<string>();
  const references: ParsedReference[] = [];
  const scopes: Array<{ indent: number; name: string }> = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    const indent = text.match(/^\s*/u)?.[0].replace(/\t/gu, "    ").length ?? 0;
    while (scopes.length > 0 && indent <= last(scopes).indent && text.trim()) scopes.pop();
    const declaration = text.match(/^\s*(?:async\s+)?(class|def)\s+([A-Za-z_]\w*)/u);
    if (declaration?.[1] && declaration[2]) {
      const parent = scopes.at(-1)?.name;
      const qualifiedName = parent ? `${parent}.${declaration[2]}` : declaration[2];
      symbols.push({ name: declaration[2], qualifiedName, kind: declaration[1] === "def" ? "function" : "class", line: index + 1 });
      scopes.push({ indent, name: qualifiedName });
    }
    const fromImport = text.match(/^\s*from\s+([\w.]+)\s+import/u);
    const directImport = text.match(/^\s*import\s+([\w.]+)/u);
    if (fromImport?.[1]) imports.add(fromImport[1]);
    if (directImport?.[1]) imports.add(directImport[1]);
    for (const call of text.matchAll(/\b([A-Za-z_]\w*)\s*\(/gu)) {
      if (call[1] && !["if", "for", "while", "return", "class", "def"].includes(call[1])) {
        references.push({ from: scopes.at(-1)?.name ?? null, target: call[1], kind: "calls", line: index + 1 });
      }
    }
  }
  return finalize(symbols, imports, references, "python-regex-fallback", reason);
}

export function parseCStyleLegacy(content: string, reason = "tree-sitter unavailable"): ParsedFile {
  const symbols: ParsedSymbol[] = [];
  const imports = new Set<string>();
  const references: ParsedReference[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    const declaration = text.match(/^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|fn\s+|func\s+)*(class|struct|interface|enum|fn|func)\s+([A-Za-z_]\w*)/u);
    if (declaration?.[1] && declaration[2]) symbols.push({ name: declaration[2], qualifiedName: declaration[2], kind: declaration[1], line: index + 1 });
    const include = text.match(/^\s*#include\s*[<"]([^>"]+)/u);
    const use = text.match(/^\s*(?:use|import)\s+([\w:./-]+)/u);
    if (include?.[1]) imports.add(include[1]);
    if (use?.[1]) imports.add(use[1]);
    for (const call of text.matchAll(/\b([A-Za-z_]\w*)\s*\(/gu)) {
      if (call[1] && !["if", "for", "while", "switch", "return", "sizeof"].includes(call[1])) references.push({ from: null, target: call[1], kind: "calls", line: index + 1 });
    }
  }
  return finalize(symbols, imports, references, "structural-regex-fallback", reason);
}

export function emptyParsedFile(): ParsedFile {
  return { symbols: [], imports: [], references: [] };
}

function finalize(symbols: ParsedSymbol[], imports: Set<string>, references: ParsedReference[], parser: string, reason: string): ParsedFile {
  return {
    symbols: dedupeSymbols(symbols), imports: [...imports], references: dedupeReferences(references),
    parser, degraded: true, diagnostics: [reason]
  };
}

function dedupeSymbols(values: ParsedSymbol[]): ParsedSymbol[] {
  return [...new Map(values.map((item) => [`${item.kind}:${item.qualifiedName ?? item.name}:${item.line}`, item])).values()].slice(0, 1_000);
}
function dedupeReferences(values: ParsedReference[]): ParsedReference[] {
  return [...new Map(values.map((item) => [`${item.from}:${item.target}:${item.kind}:${item.line}`, item])).values()].slice(0, 5_000);
}
function last<T>(values: T[]): T {
  const value = values.at(-1);
  if (!value) throw new Error("missing scope");
  return value;
}
