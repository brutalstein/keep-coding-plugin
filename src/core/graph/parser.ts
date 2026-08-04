import type * as TypeScript from "typescript";

export interface ParsedSymbol {
  name: string;
  kind: string;
  line: number;
}

export interface ParsedReference {
  from: string | null;
  target: string;
  kind: "calls" | "references";
  line: number;
}

export interface ParsedFile {
  symbols: ParsedSymbol[];
  imports: string[];
  references: ParsedReference[];
}

const SCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
let typescriptPromise: Promise<typeof TypeScript> | null = null;

export async function parseSemanticFile(content: string, extension: string): Promise<ParsedFile> {
  if (SCRIPT_EXTENSIONS.has(extension)) return parseTypeScript(content, extension);
  if (extension === ".py") return parsePython(content);
  return parseCStyle(content);
}

async function loadTypeScript(): Promise<typeof TypeScript> {
  typescriptPromise ??= import("typescript").then((loaded) => {
    const compatible = loaded as typeof loaded & { default?: typeof TypeScript };
    return compatible.default ?? compatible;
  });
  return typescriptPromise;
}

async function parseTypeScript(content: string, extension: string): Promise<ParsedFile> {
  const ts = await loadTypeScript();
  const kind = extension === ".tsx" || extension === ".jsx" ? ts.ScriptKind.TSX
    : extension === ".js" || extension === ".mjs" || extension === ".cjs" ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const source = ts.createSourceFile(`file${extension}`, content, ts.ScriptTarget.Latest, true, kind);
  const symbols: ParsedSymbol[] = [];
  const imports = new Set<string>();
  const references: ParsedReference[] = [];
  const scope: string[] = [];

  const line = (node: TypeScript.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const nameOf = (node: TypeScript.Node): string | null => {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
    return null;
  };

  const visit = (node: TypeScript.Node): void => {
    let pushed = false;
    if (ts.isClassDeclaration(node) && node.name) {
      symbols.push({ name: node.name.text, kind: "class", line: line(node) });
      scope.push(node.name.text);
      pushed = true;
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.push({ name: node.name.text, kind: "function", line: line(node) });
      scope.push(node.name.text);
      pushed = true;
    } else if (ts.isMethodDeclaration(node) && node.name) {
      const name = nameOf(node.name);
      if (name) {
        symbols.push({ name, kind: "method", line: line(node) });
        scope.push(name);
        pushed = true;
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      symbols.push({ name: node.name.text, kind: "interface", line: line(node) });
    } else if (ts.isTypeAliasDeclaration(node)) {
      symbols.push({ name: node.name.text, kind: "type", line: line(node) });
    } else if (ts.isEnumDeclaration(node)) {
      symbols.push({ name: node.name.text, kind: "enum", line: line(node) });
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer;
      const symbolKind = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) ? "function" : "variable";
      symbols.push({ name: node.name.text, kind: symbolKind, line: line(node) });
      if (symbolKind === "function") {
        scope.push(node.name.text);
        pushed = true;
      }
    }

    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const target = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
      if (target) references.push({ from: scope.at(-1) ?? null, target, kind: "calls", line: line(node) });
      if (target === "require" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.add(node.arguments[0].text);
      if (expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.add(node.arguments[0].text);
    }
    if (ts.isIdentifier(node) && isReferenceIdentifier(ts, node)) references.push({ from: scope.at(-1) ?? null, target: node.text, kind: "references", line: line(node) });
    ts.forEachChild(node, visit);
    if (pushed) scope.pop();
  };
  visit(source);
  return { symbols: dedupeSymbols(symbols), imports: [...imports], references: dedupeReferences(references) };
}

function isReferenceIdentifier(ts: typeof TypeScript, node: TypeScript.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if ((isDeclarationIdentifier(ts, node) || ts.isPropertyAccessExpression(parent) && parent.name === node) || ts.isImportSpecifier(parent)) return false;
  return !ts.isPropertyAssignment(parent) || parent.initializer === node;
}

function isDeclarationIdentifier(ts: typeof TypeScript, node: TypeScript.Identifier): boolean {
  const parent = node.parent;
  return Boolean(parent && (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
    (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node)
  ));
}

function parsePython(content: string): ParsedFile {
  const symbols: ParsedSymbol[] = [];
  const imports = new Set<string>();
  const references: ParsedReference[] = [];
  const scopes: Array<{ indent: number; name: string }> = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    const indent = text.match(/^\s*/)?.[0].replace(/\t/g, "    ").length ?? 0;
    while (scopes.length > 0 && indent <= mustLast(scopes).indent && text.trim()) scopes.pop();
    const declaration = text.match(/^\s*(?:async\s+)?(class|def)\s+([A-Za-z_]\w*)/);
    if (declaration?.[1] && declaration[2]) {
      symbols.push({ name: declaration[2], kind: declaration[1] === "def" ? "function" : "class", line: index + 1 });
      scopes.push({ indent, name: declaration[2] });
    }
    const fromImport = text.match(/^\s*from\s+([\w.]+)\s+import/);
    const directImport = text.match(/^\s*import\s+([\w.]+)/);
    if (fromImport?.[1]) imports.add(fromImport[1]);
    if (directImport?.[1]) imports.add(directImport[1]);
    for (const call of text.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) if (call[1] && !["if", "for", "while", "return", "class", "def"].includes(call[1])) references.push({ from: scopes.at(-1)?.name ?? null, target: call[1], kind: "calls", line: index + 1 });
  }
  return { symbols: dedupeSymbols(symbols), imports: [...imports], references: dedupeReferences(references) };
}

function parseCStyle(content: string): ParsedFile {
  const symbols: ParsedSymbol[] = [];
  const imports = new Set<string>();
  const references: ParsedReference[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    const declaration = text.match(/^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|fn\s+|func\s+)*(class|struct|interface|enum|fn|func)\s+([A-Za-z_]\w*)/);
    if (declaration?.[1] && declaration[2]) symbols.push({ name: declaration[2], kind: declaration[1], line: index + 1 });
    const include = text.match(/^\s*#include\s*[<"]([^>"]+)/);
    const use = text.match(/^\s*(?:use|import)\s+([\w:./-]+)/);
    if (include?.[1]) imports.add(include[1]);
    if (use?.[1]) imports.add(use[1]);
    for (const call of text.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) if (call[1] && !["if", "for", "while", "switch", "return", "sizeof"].includes(call[1])) references.push({ from: null, target: call[1], kind: "calls", line: index + 1 });
  }
  return { symbols: dedupeSymbols(symbols), imports: [...imports], references: dedupeReferences(references) };
}

function dedupeSymbols(values: ParsedSymbol[]): ParsedSymbol[] { return [...new Map(values.map((item) => [`${item.kind}:${item.name}:${item.line}`, item])).values()].slice(0, 1_000); }
function dedupeReferences(values: ParsedReference[]): ParsedReference[] { return [...new Map(values.map((item) => [`${item.from}:${item.target}:${item.kind}:${item.line}`, item])).values()].slice(0, 5_000); }
function mustLast<T>(values: T[]): T { const value = values.at(-1); if (!value) throw new Error("missing scope"); return value; }
