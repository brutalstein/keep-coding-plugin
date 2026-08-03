import path from "node:path";
import ts from "typescript";

export interface SemanticSymbol {
  name: string;
  kind: string;
  line: number;
  calls: string[];
  references: string[];
}

export interface SemanticDocument {
  parser: string;
  imports: string[];
  symbols: SemanticSymbol[];
}

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export function parseSemanticDocument(filePath: string, content: string): SemanticDocument {
  const extension = path.extname(filePath).toLowerCase();
  if (TYPESCRIPT_EXTENSIONS.has(extension)) return parseTypeScript(filePath, content, extension);
  if (extension === ".py") return parsePython(content);
  return { parser: "structural-fallback", imports: [], symbols: [] };
}

function parseTypeScript(filePath: string, content: string, extension: string): SemanticDocument {
  const scriptKind = extension === ".tsx" ? ts.ScriptKind.TSX
    : extension === ".jsx" ? ts.ScriptKind.JSX
      : extension === ".js" || extension === ".mjs" || extension === ".cjs" ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);
  const imports = new Set<string>();
  const symbols: SemanticSymbol[] = [];
  const declared = new Set<string>();

  const declarationName = (node: ts.Node): string | null => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) return node.name.text;
    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) return node.name.text;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
    return null;
  };

  const kind = (node: ts.Node): string => {
    if (ts.isClassDeclaration(node)) return "class";
    if (ts.isInterfaceDeclaration(node)) return "interface";
    if (ts.isTypeAliasDeclaration(node)) return "type";
    if (ts.isEnumDeclaration(node)) return "enum";
    if (ts.isMethodDeclaration(node)) return "method";
    if (ts.isVariableDeclaration(node)) return "variable";
    return "function";
  };

  const collectWithin = (node: ts.Node): { calls: string[]; references: string[] } => {
    const calls = new Set<string>();
    const references = new Set<string>();
    const walk = (child: ts.Node): void => {
      if (ts.isCallExpression(child)) {
        const expression = child.expression;
        if (ts.isIdentifier(expression)) calls.add(expression.text);
        else if (ts.isPropertyAccessExpression(expression)) calls.add(expression.name.text);
      }
      if (ts.isIdentifier(child) && !isDeclarationIdentifier(child)) references.add(child.text);
      ts.forEachChild(child, walk);
    };
    ts.forEachChild(node, walk);
    return { calls: [...calls].sort(), references: [...references].filter((name) => name.length > 1).sort() };
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier)) imports.add(specifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) imports.add(argument.text);
    }
    const name = declarationName(node);
    if (name && !declared.has(`${kind(node)}:${name}:${source.getLineAndCharacterOfPosition(node.getStart()).line}`)) {
      declared.add(`${kind(node)}:${name}:${source.getLineAndCharacterOfPosition(node.getStart()).line}`);
      const relationships = collectWithin(node);
      symbols.push({
        name,
        kind: kind(node),
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        calls: relationships.calls,
        references: relationships.references.filter((reference) => reference !== name)
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { parser: "typescript-compiler-ast", imports: [...imports].sort(), symbols: symbols.slice(0, 1_000) };
}

function parsePython(content: string): SemanticDocument {
  const imports = new Set<string>();
  const symbols: SemanticSymbol[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const importMatch = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/.exec(line);
    const imported = importMatch?.[1] ?? importMatch?.[2];
    if (imported) imports.add(imported);
    const declaration = /^\s*(class|(?:async\s+)?def)\s+([A-Za-z_]\w*)/.exec(line);
    if (!declaration?.[2]) continue;
    const indentation = line.match(/^\s*/)?.[0].length ?? 0;
    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor] ?? "";
      if (candidate.trim() && (candidate.match(/^\s*/)?.[0].length ?? 0) <= indentation) break;
      body.push(candidate);
    }
    const calls = new Set<string>();
    const references = new Set<string>();
    for (const bodyLine of body) {
      for (const match of bodyLine.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) if (match[1]) calls.add(match[1]);
      for (const match of bodyLine.matchAll(/\b([A-Za-z_]\w*)\b/g)) if (match[1]) references.add(match[1]);
    }
    symbols.push({
      name: declaration[2],
      kind: declaration[1].includes("def") ? "function" : "class",
      line: index + 1,
      calls: [...calls].sort(),
      references: [...references].filter((name) => name !== declaration[2]).sort()
    });
  }
  return { parser: "python-structural-ast", imports: [...imports].sort(), symbols: symbols.slice(0, 1_000) };
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return Boolean(
    (ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node
  );
}
