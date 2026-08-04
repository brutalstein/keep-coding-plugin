import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { GitRepository } from "./git.js";
import { parseSemanticFile, type ParsedFile } from "./graph/parser.js";
import type { ProjectStore } from "../storage/store.js";

const TEXT_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".jsx", ".json", ".kt", ".md", ".mjs", ".cjs", ".php", ".py", ".rb", ".rs", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx", ".vue", ".yaml", ".yml"]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 10_000;

export interface IndexResult {
  filesIndexed: number;
  symbolsIndexed: number;
  importsIndexed: number;
  referencesIndexed: number;
  testsIndexed: number;
  skipped: number;
  parser: "typescript-ast-with-language-adapters";
}

interface ParsedEntry { relativePath: string; extension: string; parsed: ParsedFile }

export async function indexRepository(store: ProjectStore, git: GitRepository): Promise<IndexResult> {
  const files = (await git.allFiles()).slice(0, MAX_FILES).map(toPosix);
  const fileSet = new Set(files);
  const entries: ParsedEntry[] = [];
  const symbolIds = new Map<string, string[]>();
  const result: IndexResult = { filesIndexed: 0, symbolsIndexed: 0, importsIndexed: 0, referencesIndexed: 0, testsIndexed: 0, skipped: 0, parser: "typescript-ast-with-language-adapters" };
  store.clearFileGraph();

  for (const relativePath of files) {
    const extension = path.extname(relativePath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) { result.skipped += 1; continue; }
    const absolutePath = path.join(git.root, relativePath);
    const info = await stat(absolutePath).catch(() => null);
    if (!info?.isFile() || info.size > MAX_FILE_BYTES) { result.skipped += 1; continue; }
    const content = await readFile(absolutePath, "utf8").catch(() => null);
    if (content === null || content.includes("\0")) { result.skipped += 1; continue; }
    const isTest = isTestPath(relativePath);
    const fileId = `file:${relativePath}`;
    store.upsertGraphNode({
      id: fileId,
      type: isTest ? "test" : "file",
      label: path.basename(relativePath),
      path: relativePath,
      symbol: null,
      contentHash: sha256(content),
      metadata: { bytes: info.size, lineCount: content.split("\n").length, extension, parser: parserName(extension) }
    });
    result.filesIndexed += 1;
    if (isTest) result.testsIndexed += 1;
    const parsed = await parseSemanticFile(content, extension);
    entries.push({ relativePath, extension, parsed });
    for (const symbol of parsed.symbols) {
      const symbolId = `symbol:${relativePath}:${symbol.kind}:${symbol.name}`;
      const existing = symbolIds.get(symbol.name) ?? [];
      existing.push(symbolId);
      symbolIds.set(symbol.name, existing);
      store.upsertGraphNode({ id: symbolId, type: "symbol", label: symbol.name, path: relativePath, symbol: symbol.name, contentHash: null, metadata: { kind: symbol.kind, line: symbol.line, parser: parserName(extension) } });
      store.upsertGraphEdge({ sourceId: fileId, targetId: symbolId, type: "contains", metadata: {} });
      result.symbolsIndexed += 1;
    }
  }

  for (const entry of entries) {
    const fileId = `file:${entry.relativePath}`;
    for (const specifier of entry.parsed.imports) {
      const resolved = resolveImport(entry.relativePath, specifier, fileSet, entry.extension);
      if (!resolved) continue;
      store.upsertGraphEdge({ sourceId: fileId, targetId: `file:${resolved}`, type: "imports", metadata: { specifier } });
      if (isTestPath(entry.relativePath)) store.upsertGraphEdge({ sourceId: `file:${resolved}`, targetId: fileId, type: "tested_by", metadata: { specifier } });
      result.importsIndexed += 1;
    }
    for (const reference of entry.parsed.references) {
      const targets = symbolIds.get(reference.target) ?? [];
      const sourceId = reference.from ? symbolIds.get(reference.from)?.find((candidate) => candidate.startsWith(`symbol:${entry.relativePath}:`)) ?? fileId : fileId;
      for (const targetId of targets.slice(0, 20)) {
        if (sourceId === targetId) continue;
        store.upsertGraphEdge({ sourceId, targetId, type: reference.kind, metadata: { line: reference.line } });
        result.referencesIndexed += 1;
      }
    }
  }
  store.appendEvent("repository_indexed", null, { ...result });
  return result;
}

function resolveImport(source: string, specifier: string, files: Set<string>, extension: string): string | null {
  if (extension === ".py" && !specifier.startsWith(".")) {
    const pythonPath = specifier.replace(/\./g, "/");
    return [`${pythonPath}.py`, `${pythonPath}/__init__.py`, path.posix.join(path.posix.dirname(source), `${pythonPath}.py`)].find((candidate) => files.has(candidate)) ?? null;
  }
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier));
  const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java"].map((suffix) => `${base}${suffix}`), ...["index.ts", "index.tsx", "index.js", "index.mjs", "__init__.py"].map((name) => `${base}/${name}`)];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}
function isTestPath(value: string): boolean { return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(value); }
function parserName(extension: string): string { if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return "typescript-ast"; if (extension === ".py") return "python-structural-adapter"; return "language-structural-adapter"; }
function toPosix(value: string): string { return value.split(path.sep).join("/"); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
