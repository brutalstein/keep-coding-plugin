import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { GitRepository } from "./git.js";
import type { ProjectStore } from "../storage/store.js";

const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".jsx",
  ".json", ".kt", ".md", ".mjs", ".php", ".py", ".rb", ".rs", ".sh", ".sql", ".swift", ".toml",
  ".ts", ".tsx", ".vue", ".yaml", ".yml"
]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 10_000;

export interface IndexResult {
  filesIndexed: number;
  symbolsIndexed: number;
  importsIndexed: number;
  skipped: number;
}

export async function indexRepository(store: ProjectStore, git: GitRepository): Promise<IndexResult> {
  const files = (await git.allFiles()).slice(0, MAX_FILES);
  const fileSet = new Set(files);
  const result: IndexResult = { filesIndexed: 0, symbolsIndexed: 0, importsIndexed: 0, skipped: 0 };
  store.clearFileGraph();

  for (const relativePath of files) {
    if (!TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
      result.skipped += 1;
      continue;
    }
    const absolutePath = path.join(git.root, relativePath);
    const info = await stat(absolutePath).catch(() => null);
    if (!info?.isFile() || info.size > MAX_FILE_BYTES) {
      result.skipped += 1;
      continue;
    }
    const content = await readFile(absolutePath, "utf8").catch(() => null);
    if (content === null || content.includes("\0")) {
      result.skipped += 1;
      continue;
    }
    const fileId = `file:${toPosix(relativePath)}`;
    store.upsertGraphNode({
      id: fileId,
      type: "file",
      label: path.basename(relativePath),
      path: toPosix(relativePath),
      symbol: null,
      contentHash: sha256(content),
      metadata: { bytes: info.size, extension: path.extname(relativePath).toLowerCase() }
    });
    result.filesIndexed += 1;

    for (const symbol of extractSymbols(content, path.extname(relativePath).toLowerCase())) {
      const symbolId = `symbol:${toPosix(relativePath)}:${symbol.kind}:${symbol.name}`;
      store.upsertGraphNode({
        id: symbolId,
        type: "symbol",
        label: symbol.name,
        path: toPosix(relativePath),
        symbol: symbol.name,
        contentHash: null,
        metadata: { kind: symbol.kind, line: symbol.line }
      });
      store.upsertGraphEdge({ sourceId: fileId, targetId: symbolId, type: "contains", metadata: {} });
      result.symbolsIndexed += 1;
    }

    for (const specifier of extractImports(content, path.extname(relativePath).toLowerCase())) {
      const resolved = resolveImport(relativePath, specifier, fileSet);
      if (!resolved) continue;
      store.upsertGraphEdge({ sourceId: fileId, targetId: `file:${resolved}`, type: "imports", metadata: { specifier } });
      result.importsIndexed += 1;
    }
  }
  store.appendEvent("repository_indexed", null, { ...result });
  return result;
}

interface SymbolInfo { name: string; kind: string; line: number }

function extractSymbols(content: string, extension: string): SymbolInfo[] {
  const patterns = extension === ".py"
    ? [
        { kind: "class", expression: /^\s*class\s+([A-Za-z_]\w*)/gm },
        { kind: "function", expression: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm }
      ]
    : [
        { kind: "class", expression: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
        { kind: "function", expression: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm },
        { kind: "function", expression: /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm },
        { kind: "interface", expression: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm },
        { kind: "type", expression: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/gm }
      ];
  const symbols: SymbolInfo[] = [];
  for (const { kind, expression } of patterns) {
    for (const match of content.matchAll(expression)) {
      const name = match[1];
      if (!name || match.index === undefined) continue;
      symbols.push({ name, kind, line: content.slice(0, match.index).split("\n").length });
    }
  }
  return symbols.slice(0, 500);
}

function extractImports(content: string, extension: string): string[] {
  const expressions = extension === ".py"
    ? [/^\s*from\s+([\w.]+)\s+import/gm, /^\s*import\s+([\w.]+)/gm]
    : [
        /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g,
        /require\(\s*["']([^"']+)["']\s*\)/g,
        /import\(\s*["']([^"']+)["']\s*\)/g
      ];
  const values = new Set<string>();
  for (const expression of expressions) {
    for (const match of content.matchAll(expression)) if (match[1]) values.add(match[1]);
  }
  return [...values];
}

function resolveImport(source: string, specifier: string, files: Set<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(toPosix(source)), specifier));
  const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".py"].map((extension) => `${base}${extension}`),
    ...["index.ts", "index.tsx", "index.js", "__init__.py"].map((name) => `${base}/${name}`)];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
