import type TypeScript from "typescript";
import { emptyParsedFile, parseCStyleLegacy, parsePythonLegacy } from "./legacy-regex-fallback.js";
import { parseCOrCppTreeSitter, parsePythonTreeSitter } from "./treesitter/language-adapters.js";
import type { TreeSitterOptions } from "./treesitter/engine.js";

export type ParsedImportKind = "module" | "relative" | "local" | "system";

export interface ParsedSymbol {
  name: string;
  kind: string;
  line: number;
  qualifiedName?: string;
  arity?: number;
  declarationOnly?: boolean;
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
  importKinds?: Record<string, ParsedImportKind>;
  parser?: string;
  degraded?: boolean;
  diagnostics?: string[];
  parseMs?: number;
}

export interface SemanticParseOptions extends TreeSitterOptions {
  legacyOnly?: boolean;
}

const SCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const C_EXTENSIONS = new Set([".c", ".h"]);
const CPP_EXTENSIONS = new Set([".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"]);
const LEGACY_STRUCTURAL_EXTENSIONS = new Set([".cs", ".go", ".java", ".kt", ".php", ".rb", ".rs", ".swift"]);
let typescriptPromise: Promise<typeof TypeScript> | null = null;

export async function parseSemanticFile(content: string, extension: string, options: SemanticParseOptions = {}): Promise<ParsedFile> {
  if (SCRIPT_EXTENSIONS.has(extension)) return parseTypeScript(content, extension);
  if (extension === ".py") {
    if (options.legacyOnly) return parsePythonLegacy(content, "legacy parser explicitly requested");
    return parsePythonTreeSitter(content, options).catch((error: unknown) => parsePythonLegacy(content, fallbackReason(error)));
  }
  if (C_EXTENSIONS.has(extension)) {
    if (options.legacyOnly) return parseCStyleLegacy(content, "legacy parser explicitly requested");
    return parseCOrCppTreeSitter(content, "c", options).catch((error: unknown) => parseCStyleLegacy(content, fallbackReason(error)));
  }
  if (CPP_EXTENSIONS.has(extension)) {
    if (options.legacyOnly) return parseCStyleLegacy(content, "legacy parser explicitly requested");
    return parseCOrCppTreeSitter(content, "cpp", options).catch((error: unknown) => parseCStyleLegacy(content, fallbackReason(error)));
  }
  if (LEGACY_STRUCTURAL_EXTENSIONS.has(extension)) return parseCStyleLegacy(content, `no tree-sitter grammar configured for ${extension}`);
  return emptyParsedFile();
}

async function loadTypeScript(): Promise<typeof TypeScript> {
  if (typescriptPromise === null) typescriptPromise = import("typescript").then((loaded) => loaded.default);
  return typescriptPromise;
}

async function parseTypeScript(content: string, extension: string): Promise<ParsedFile> {
  const started = performance.now();
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
  const qualified = (name: string): string => [...scope, name].join(".");

  const visit = (node: TypeScript.Node): void => {
    let pushed = false;
    if (ts.isClassDeclaration(node) && node.name) {
      symbols.push({ name: node.name.text, qualifiedName: qualified(node.name.text), kind: "class", line: line(node) });
      scope.push(node.name.text); pushed = true;
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.push({ name: node.name.text, qualifiedName: qualified(node.name.text), kind: "function", line: line(node), arity: node.parameters.length });
      scope.push(node.name.text); pushed = true;
    } else if (ts.isMethodDeclaration(node) && node.name) {
      const name = nameOf(node.name);
      if (name) {
        symbols.push({ name, qualifiedName: qualified(name), kind: "method", line: line(node), arity: node.parameters.length });
        scope.push(name); pushed = true;
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      symbols.push({ name: node.name.text, qualifiedName: qualified(node.name.text), kind: "interface", line: line(node) });
    } else if (ts.isTypeAliasDeclaration(node)) {
      symbols.push({ name: node.name.text, qualifiedName: qualified(node.name.text), kind: "type", line: line(node) });
    } else if (ts.isEnumDeclaration(node)) {
      symbols.push({ name: node.name.text, qualifiedName: qualified(node.name.text), kind: "enum", line: line(node) });
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer;
      const symbolKind = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) ? "function" : "variable";
      symbols.push({ name: node.name.text, qualifiedName: qualified(node.name.text), kind: symbolKind, line: line(node) });
      if (symbolKind === "function") { scope.push(node.name.text); pushed = true; }
    }

    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const target = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
      if (target) references.push({ from: scope.length > 0 ? scope.join(".") : null, target, kind: "calls", line: line(node) });
      if (target === "require" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.add(node.arguments[0].text);
      if (expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.add(node.arguments[0].text);
    }
    if (ts.isIdentifier(node) && isReferenceIdentifier(ts, node)) references.push({ from: scope.length > 0 ? scope.join(".") : null, target: node.text, kind: "references", line: line(node) });
    ts.forEachChild(node, visit);
    if (pushed) scope.pop();
  };
  visit(source);
  return {
    symbols: dedupeSymbols(symbols), imports: [...imports], references: dedupeReferences(references),
    importKinds: Object.fromEntries([...imports].map((specifier) => [specifier, specifier.startsWith(".") ? "relative" : "module"])),
    parser: "typescript-ast", degraded: false, diagnostics: [], parseMs: Number((performance.now() - started).toFixed(3))
  };
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

function dedupeSymbols(values: ParsedSymbol[]): ParsedSymbol[] {
  return [...new Map(values.map((item) => [`${item.kind}:${item.qualifiedName ?? item.name}:${item.line}`, item])).values()].slice(0, 1_000);
}
function dedupeReferences(values: ParsedReference[]): ParsedReference[] {
  return [...new Map(values.map((item) => [`${item.from}:${item.target}:${item.kind}:${item.line}`, item])).values()].slice(0, 5_000);
}
function fallbackReason(error: unknown): string {
  return `tree-sitter fallback: ${error instanceof Error ? error.message : String(error)}`;
}
