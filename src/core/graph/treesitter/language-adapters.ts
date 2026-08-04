import type { Node, QueryCapture, QueryMatch } from "web-tree-sitter";
import type { ParsedFile, ParsedImportKind, ParsedReference, ParsedSymbol } from "../parser.js";
import { runTreeSitterQuery, type TreeSitterOptions } from "./engine.js";

export async function parsePythonTreeSitter(content: string, options?: TreeSitterOptions): Promise<ParsedFile> {
  return runTreeSitterQuery("python", content, "python.scm", ({ matches, hasError, errorRatio, elapsedMs }) => {
    if (hasError && errorRatio > 0.35) throw new Error(`python syntax tree dominated by errors (${errorRatio.toFixed(3)})`);
    const symbols: ParsedSymbol[] = [];
    const imports = new Set<string>();
    const importKinds: Record<string, ParsedImportKind> = {};
    const references: ParsedReference[] = [];
    for (const match of matches) {
      const captures = captureMap(match);
      const functionName = first(captures, "symbol.function.name");
      const functionDefinition = first(captures, "symbol.function.definition");
      if (functionName && functionDefinition) symbols.push(symbolFor(functionName, "function", functionDefinition, "python"));
      const className = first(captures, "symbol.class.name");
      const classDefinition = first(captures, "symbol.class.definition");
      if (className && classDefinition) symbols.push(symbolFor(className, "class", classDefinition, "python"));
      const importStatement = first(captures, "import.statement");
      if (importStatement) for (const specifier of pythonImports(importStatement)) {
        imports.add(specifier);
        importKinds[specifier] = specifier.startsWith(".") ? "relative" : "module";
      }
      const callTarget = first(captures, "reference.call.target");
      const call = first(captures, "reference.call");
      if (callTarget && call) {
        const target = callableName(callTarget);
        if (target) references.push({ from: nearestScope(call, "python"), target, kind: "calls", line: call.startPosition.row + 1 });
      }
    }
    return finalize(symbols, imports, references, importKinds, "tree-sitter-python", hasError, errorRatio, elapsedMs);
  }, options);
}

export async function parseCOrCppTreeSitter(content: string, language: "c" | "cpp", options?: TreeSitterOptions): Promise<ParsedFile> {
  const queryFile = language === "c" ? "c.scm" : "cpp.scm";
  return runTreeSitterQuery(language, content, queryFile, ({ matches, hasError, errorRatio, elapsedMs }) => {
    if (hasError && errorRatio > 0.35) throw new Error(`${language} syntax tree dominated by errors (${errorRatio.toFixed(3)})`);
    const symbols: ParsedSymbol[] = [];
    const imports = new Set<string>();
    const importKinds: Record<string, ParsedImportKind> = {};
    const references: ParsedReference[] = [];
    for (const match of matches) {
      const captures = captureMap(match);
      const functionDefinition = first(captures, "symbol.function.definition");
      const functionDeclaration = first(captures, "symbol.function.declaration");
      const declarator = first(captures, "symbol.function.declarator");
      const owner = functionDefinition ?? functionDeclaration;
      if (owner && declarator) {
        const nameNode = declaratorNameNode(declarator);
        if (nameNode) {
          const qualifiedName = qualify(nameNode.text, owner, language);
          symbols.push({
            name: bareName(nameNode.text), qualifiedName, kind: templateAncestor(owner) ? "template" : "function",
            line: owner.startPosition.row + 1, arity: parameterArity(declarator), declarationOnly: Boolean(functionDeclaration)
          });
        }
      }
      for (const kind of ["class", "struct", "union", "enum", "namespace"] as const) {
        const name = first(captures, `symbol.${kind}.name`);
        const definition = first(captures, `symbol.${kind}.definition`);
        if (name && definition) symbols.push(symbolFor(name, kind, definition, language));
      }
      const includePath = first(captures, "import.path");
      if (includePath) {
        const raw = includePath.text.trim();
        const specifier = raw.replace(/^<|>$/gu, "").replace(/^"|"$/gu, "");
        if (specifier) {
          imports.add(specifier);
          importKinds[specifier] = raw.startsWith("<") ? "system" : "local";
        }
      }
      const callTarget = first(captures, "reference.call.target");
      const call = first(captures, "reference.call");
      if (callTarget && call) {
        const target = callableName(callTarget);
        if (target) references.push({ from: nearestScope(call, language), target, kind: "calls", line: call.startPosition.row + 1 });
      }
    }
    return finalize(symbols, imports, references, importKinds, language === "c" ? "tree-sitter-c" : "tree-sitter-cpp", hasError, errorRatio, elapsedMs);
  }, options);
}

function captureMap(match: QueryMatch): Map<string, QueryCapture[]> {
  const result = new Map<string, QueryCapture[]>();
  for (const capture of match.captures) {
    const values = result.get(capture.name) ?? [];
    values.push(capture);
    result.set(capture.name, values);
  }
  return result;
}
function first(captures: Map<string, QueryCapture[]>, name: string): Node | null {
  return captures.get(name)?.[0]?.node ?? null;
}

function symbolFor(nameNode: Node, kind: string, definition: Node, language: "python" | "c" | "cpp"): ParsedSymbol {
  const name = bareName(nameNode.text);
  return {
    name,
    qualifiedName: qualify(name, definition, language),
    kind,
    line: definition.startPosition.row + 1
  };
}

function qualify(name: string, node: Node, language: "python" | "c" | "cpp"): string {
  const separator = language === "python" ? "." : "::";
  const scopes: string[] = [];
  let current = node.parent;
  while (current) {
    if (scopeNodeTypes(language).has(current.type)) {
      const scopeName = definitionName(current);
      if (scopeName) scopes.unshift(scopeName);
    }
    current = current.parent;
  }
  return [...scopes, bareName(name)].filter(Boolean).join(separator);
}

function nearestScope(node: Node, language: "python" | "c" | "cpp"): string | null {
  let current = node.parent;
  while (current) {
    if (scopeNodeTypes(language).has(current.type)) {
      const name = definitionName(current);
      if (name) return qualify(name, current, language);
    }
    current = current.parent;
  }
  return null;
}

function scopeNodeTypes(language: "python" | "c" | "cpp"): Set<string> {
  return language === "python"
    ? new Set(["function_definition", "class_definition"])
    : new Set(["function_definition", "class_specifier", "struct_specifier", "namespace_definition"]);
}

function definitionName(node: Node): string | null {
  const direct = node.childForFieldName("name");
  if (direct) return bareName(direct.text);
  const declarator = node.childForFieldName("declarator");
  const name = declarator ? declaratorNameNode(declarator) : null;
  return name ? bareName(name.text) : null;
}

function declaratorNameNode(node: Node): Node | null {
  if (["identifier", "field_identifier", "type_identifier", "namespace_identifier", "destructor_name", "operator_name"].includes(node.type)) return node;
  const preferred = ["declarator", "name", "field"].map((field) => node.childForFieldName(field)).find((child): child is Node => child !== null);
  if (preferred) return declaratorNameNode(preferred);
  for (const child of [...node.namedChildren].reverse()) {
    const found = declaratorNameNode(child);
    if (found) return found;
  }
  return null;
}

function parameterArity(declarator: Node): number {
  const parameters = declarator.descendantsOfType("parameter_list")[0];
  if (!parameters) return 0;
  return parameters.namedChildren.filter((child) => !["comment"].includes(child.type)).length;
}

function templateAncestor(node: Node): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === "template_declaration") return true;
    if (["translation_unit", "namespace_definition", "class_specifier", "struct_specifier"].includes(current.type)) return false;
    current = current.parent;
  }
  return false;
}

function pythonImports(statement: Node): string[] {
  const text = statement.text.trim();
  if (text.startsWith("from ")) {
    const match = text.match(/^from\s+([^\s]+)\s+import\s+/u);
    return match?.[1] ? [match[1]] : [];
  }
  if (text.startsWith("import ")) {
    return text.slice("import ".length).split(",").map((part) => part.trim().split(/\s+as\s+/u)[0] ?? "").filter(Boolean);
  }
  return [];
}

function callableName(node: Node): string | null {
  const preferred = node.childForFieldName("attribute") ?? node.childForFieldName("field") ?? node.childForFieldName("name");
  if (preferred) return callableName(preferred);
  if (["identifier", "field_identifier", "type_identifier", "operator_name", "destructor_name"].includes(node.type)) return bareName(node.text);
  const text = node.text.replace(/<[^<>]*>/gu, "").trim();
  const pieces = text.split(/(?:::|\.|->)/u);
  const candidate = pieces.at(-1)?.match(/[~A-Za-z_]\w*|operator\s*[^\s(]+/u)?.[0];
  return candidate ? bareName(candidate) : null;
}

function bareName(value: string): string {
  return value.trim().split(/(?:::|\.)/u).at(-1)?.replace(/^~/u, "") ?? value.trim();
}

function finalize(
  symbols: ParsedSymbol[], imports: Set<string>, references: ParsedReference[], importKinds: Record<string, ParsedImportKind>,
  parser: string, hasError: boolean, errorRatio: number, elapsedMs: number
): ParsedFile {
  return {
    symbols: [...new Map(symbols.map((item) => [`${item.kind}:${item.qualifiedName ?? item.name}:${item.line}:${item.declarationOnly ?? false}`, item])).values()].slice(0, 1_000),
    imports: [...imports],
    references: [...new Map(references.map((item) => [`${item.from}:${item.target}:${item.kind}:${item.line}`, item])).values()].slice(0, 5_000),
    importKinds,
    parser,
    degraded: false,
    diagnostics: hasError ? [`syntax tree contains recoverable errors (ratio=${errorRatio.toFixed(3)})`] : [],
    parseMs: Number(elapsedMs.toFixed(3))
  };
}
