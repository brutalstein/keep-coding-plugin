import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectStore } from "../storage/store.js";
import { parseSemanticDocument, type SemanticDocument } from "./graph/semantic.js";
import type { GitRepository } from "./git.js";

const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".jsx",
  ".json", ".kt", ".md", ".mjs", ".cjs", ".php", ".py", ".rb", ".rs", ".sh", ".sql", ".swift", ".toml",
  ".ts", ".tsx", ".vue", ".yaml", ".yml"
]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 10_000;

export interface IndexResult {
  filesIndexed: number;
  testsIndexed: number;
  symbolsIndexed: number;
  importsIndexed: number;
  callsIndexed: number;
  referencesIndexed: number;
  skipped: number;
}

interface IndexedDocument {
  path: string;
  semantic: SemanticDocument;
  symbolIds: Map<string, string[]>;
}

export async function indexRepository(store: ProjectStore, git: GitRepository): Promise<IndexResult> {
  const files = (await git.allFiles()).slice(0, MAX_FILES).map(toPosix);
  const fileSet = new Set(files);
  const result: IndexResult = {
    filesIndexed: 0,
    testsIndexed: 0,
    symbolsIndexed: 0,
    importsIndexed: 0,
    callsIndexed: 0,
    referencesIndexed: 0,
    skipped: 0
  };
  const documents: IndexedDocument[] = [];
  const globalSymbols = new Map<string, string[]>();
  store.clearFileGraph();

  for (const relativePath of files) {
    const extension = path.extname(relativePath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) {
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
    const fileId = `file:${relativePath}`;
    const semantic = parseSemanticDocument(relativePath, content);
    store.upsertGraphNode({
      id: fileId,
      type: "file",
      label: path.basename(relativePath),
      path: relativePath,
      symbol: null,
      contentHash: sha256(content),
      metadata: { bytes: info.size, extension, parser: semantic.parser }
    });
    result.filesIndexed += 1;

    if (isTestPath(relativePath)) {
      const testId = `test:${relativePath}`;
      store.upsertGraphNode({
        id: testId,
        type: "test",
        label: path.basename(relativePath),
        path: relativePath,
        symbol: null,
        contentHash: sha256(content),
        metadata: { framework: inferTestFramework(relativePath, content) }
      });
      store.upsertGraphEdge({ sourceId: testId, targetId: fileId, type: "verified_by", metadata: { direct: true } });
      result.testsIndexed += 1;
    }

    const symbolIds = new Map<string, string[]>();
    for (const symbol of semantic.symbols) {
      const symbolId = `symbol:${relativePath}:${symbol.kind}:${symbol.name}:${symbol.line}`;
      store.upsertGraphNode({
        id: symbolId,
        type: "symbol",
        label: symbol.name,
        path: relativePath,
        symbol: symbol.name,
        contentHash: null,
        metadata: { kind: symbol.kind, line: symbol.line, parser: semantic.parser }
      });
      store.upsertGraphEdge({ sourceId: fileId, targetId: symbolId, type: "contains", metadata: {} });
      appendMap(symbolIds, symbol.name, symbolId);
      appendMap(globalSymbols, symbol.name, symbolId);
      result.symbolsIndexed += 1;
    }
    documents.push({ path: relativePath, semantic, symbolIds });
  }

  for (const document of documents) {
    const sourceFileId = `file:${document.path}`;
    for (const specifier of document.semantic.imports) {
      const resolved = resolveImport(document.path, specifier, fileSet);
      if (!resolved) continue;
      store.upsertGraphEdge({ sourceId: sourceFileId, targetId: `file:${resolved}`, type: "imports", metadata: { specifier } });
      if (isTestPath(document.path)) {
        store.upsertGraphEdge({ sourceId: `test:${document.path}`, targetId: `file:${resolved}`, type: "verified_by", metadata: { specifier } });
      }
      result.importsIndexed += 1;
    }
    for (const symbol of document.semantic.symbols) {
      const sources = document.symbolIds.get(symbol.name) ?? [];
      for (const sourceId of sources) {
        for (const call of symbol.calls) {
          for (const targetId of globalSymbols.get(call) ?? []) {
            if (targetId === sourceId) continue;
            store.upsertGraphEdge({ sourceId, targetId, type: "calls", metadata: { name: call } });
            result.callsIndexed += 1;
          }
        }
        for (const reference of symbol.references) {
          for (const targetId of globalSymbols.get(reference) ?? []) {
            if (targetId === sourceId) continue;
            store.upsertGraphEdge({ sourceId, targetId, type: "references", metadata: { name: reference } });
            result.referencesIndexed += 1;
          }
        }
      }
    }
  }
  store.appendEvent("repository_indexed", null, { ...result });
  return result;
}

function resolveImport(source: string, specifier: string, files: Set<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(toPosix(source)), specifier));
  const candidates = [
    base,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"].map((extension) => `${base}${extension}`),
    ...["index.ts", "index.tsx", "index.js", "index.mjs", "__init__.py"].map((name) => `${base}/${name}`)
  ];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function appendMap(map: Map<string, string[]>, key: string, value: string): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function isTestPath(value: string): boolean {
  return /(^|\/)(?:tests?|__tests__)(\/|$)/i.test(value) || /\.(?:test|spec)\.[^.]+$/i.test(value);
}

function inferTestFramework(file: string, content: string): string {
  if (file.endsWith(".py")) return "pytest-compatible";
  if (/\b(?:describe|it|test)\s*\(/.test(content)) return "javascript-test";
  return "unknown";
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
