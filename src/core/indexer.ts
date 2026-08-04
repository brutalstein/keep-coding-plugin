import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { GitRepository } from "./git.js";
import { parseSemanticFile, type ParsedFile, type ParsedSymbol } from "./graph/parser.js";
import type { ProjectStore } from "../storage/store.js";

const TEXT_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx", ".cs", ".css", ".go", ".h", ".hh", ".hpp", ".hxx", ".html", ".java", ".js", ".jsx", ".json", ".kt", ".md", ".mjs", ".cjs", ".php", ".py", ".rb", ".rs", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx", ".vue", ".yaml", ".yml"]);
const HEADER_EXTENSIONS = new Set([".h", ".hh", ".hpp", ".hxx"]);
const SOURCE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx"]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 10_000;

export interface IndexResult {
  filesIndexed: number;
  symbolsIndexed: number;
  importsIndexed: number;
  referencesIndexed: number;
  testsIndexed: number;
  skipped: number;
  fallbacks: number;
  parserCounts: Record<string, number>;
  parseMs: number;
  parser: "semantic-parser-tiers";
}

interface IndexedSymbol {
  id: string;
  relativePath: string;
  extension: string;
  symbol: ParsedSymbol;
}
interface ParsedEntry { relativePath: string; extension: string; parsed: ParsedFile; symbols: IndexedSymbol[] }

export async function indexRepository(store: ProjectStore, git: GitRepository): Promise<IndexResult> {
  const files = (await git.allFiles()).slice(0, MAX_FILES).map(toPosix);
  const fileSet = new Set(files);
  const entries: ParsedEntry[] = [];
  const aliases = new Map<string, IndexedSymbol[]>();
  const result: IndexResult = {
    filesIndexed: 0, symbolsIndexed: 0, importsIndexed: 0, referencesIndexed: 0, testsIndexed: 0,
    skipped: 0, fallbacks: 0, parserCounts: {}, parseMs: 0, parser: "semantic-parser-tiers"
  };
  store.clearFileGraph();

  for (const relativePath of files) {
    const extension = path.extname(relativePath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) { result.skipped += 1; continue; }
    const absolutePath = path.join(git.root, relativePath);
    const info = await stat(absolutePath).catch(() => null);
    if (!info?.isFile() || info.size > MAX_FILE_BYTES) { result.skipped += 1; continue; }
    const content = await readFile(absolutePath, "utf8").catch(() => null);
    if (content === null || content.includes("\0")) { result.skipped += 1; continue; }
    const parsed = await parseSemanticFile(content, extension);
    const backend = parsed.parser ?? "unsupported";
    result.parserCounts[backend] = (result.parserCounts[backend] ?? 0) + 1;
    result.parseMs += parsed.parseMs ?? 0;
    if (parsed.degraded) result.fallbacks += 1;
    const isTest = isTestPath(relativePath);
    const fileId = `file:${relativePath}`;
    store.upsertGraphNode({
      id: fileId,
      type: isTest ? "test" : "file",
      label: path.basename(relativePath),
      path: relativePath,
      symbol: null,
      contentHash: sha256(content),
      metadata: {
        bytes: info.size,
        lineCount: content.split("\n").length,
        extension,
        parser: backend,
        parserDegraded: parsed.degraded ?? false,
        parserDiagnostics: parsed.diagnostics ?? [],
        parseMs: parsed.parseMs ?? 0
      }
    });
    result.filesIndexed += 1;
    if (isTest) result.testsIndexed += 1;
    const indexedSymbols: IndexedSymbol[] = [];
    const collisionCounts = new Map<string, number>();
    for (const symbol of parsed.symbols) {
      const logicalName = symbol.qualifiedName ?? symbol.name;
      const baseId = `symbol:${relativePath}:${symbol.kind}:${logicalName}`;
      const collision = collisionCounts.get(baseId) ?? 0;
      collisionCounts.set(baseId, collision + 1);
      const symbolId = collision === 0 ? baseId : `${baseId}:${symbol.arity ?? "na"}:${symbol.line}`;
      const indexed: IndexedSymbol = { id: symbolId, relativePath, extension, symbol };
      indexedSymbols.push(indexed);
      for (const alias of symbolAliases(symbol)) addAlias(aliases, alias, indexed);
      store.upsertGraphNode({
        id: symbolId,
        type: "symbol",
        label: symbol.name,
        path: relativePath,
        symbol: logicalName,
        contentHash: null,
        metadata: {
          kind: symbol.kind,
          line: symbol.line,
          qualifiedName: logicalName,
          arity: symbol.arity ?? null,
          declarationOnly: symbol.declarationOnly ?? false,
          parser: backend
        }
      });
      store.upsertGraphEdge({ sourceId: fileId, targetId: symbolId, type: "contains", metadata: {} });
      result.symbolsIndexed += 1;
    }
    entries.push({ relativePath, extension, parsed, symbols: indexedSymbols });
  }

  linkHeaderSourceSymbols(store, entries);

  for (const entry of entries) {
    const fileId = `file:${entry.relativePath}`;
    for (const specifier of entry.parsed.imports) {
      const resolved = resolveImport(entry.relativePath, specifier, fileSet, entry.extension, entry.parsed.importKinds?.[specifier]);
      if (!resolved) continue;
      store.upsertGraphEdge({ sourceId: fileId, targetId: `file:${resolved}`, type: "imports", metadata: { specifier, kind: entry.parsed.importKinds?.[specifier] ?? "module" } });
      if (isTestPath(entry.relativePath)) store.upsertGraphEdge({ sourceId: `file:${resolved}`, targetId: fileId, type: "tested_by", metadata: { specifier } });
      result.importsIndexed += 1;
    }
    for (const reference of entry.parsed.references) {
      const targets = rankTargets(aliases.get(reference.target) ?? [], entry, reference.target);
      const sourceId = reference.from ? findSourceSymbol(entry, reference.from)?.id ?? fileId : fileId;
      for (const target of targets.slice(0, 20)) {
        if (sourceId === target.id) continue;
        store.upsertGraphEdge({ sourceId, targetId: target.id, type: reference.kind, metadata: { line: reference.line } });
        result.referencesIndexed += 1;
      }
    }
  }
  result.parseMs = Number(result.parseMs.toFixed(3));
  store.appendEvent("repository_indexed", null, { ...result });
  return result;
}

function linkHeaderSourceSymbols(store: ProjectStore, entries: ParsedEntry[]): void {
  const groups = new Map<string, IndexedSymbol[]>();
  for (const entry of entries) {
    if (!HEADER_EXTENSIONS.has(entry.extension) && !SOURCE_EXTENSIONS.has(entry.extension)) continue;
    for (const indexed of entry.symbols) {
      const key = canonicalNativeSymbol(indexed.symbol);
      const values = groups.get(key) ?? [];
      values.push(indexed);
      groups.set(key, values);
    }
  }
  for (const [key, group] of groups) {
    const headers = group.filter((item) => HEADER_EXTENSIONS.has(item.extension));
    const sources = group.filter((item) => SOURCE_EXTENSIONS.has(item.extension));
    for (const header of headers) for (const source of sources) {
      const metadata = { canonicalSymbol: key, header: header.relativePath, source: source.relativePath };
      store.upsertGraphEdge({ sourceId: header.id, targetId: source.id, type: "same_symbol", metadata });
      store.upsertGraphEdge({ sourceId: source.id, targetId: header.id, type: "same_symbol", metadata });
    }
  }
}

function canonicalNativeSymbol(symbol: ParsedSymbol): string {
  return `${(symbol.qualifiedName ?? symbol.name).replace(/\s+/gu, "")}/${symbol.arity ?? "na"}/${symbol.kind === "template" ? "function" : symbol.kind}`;
}

function rankTargets(values: IndexedSymbol[], entry: ParsedEntry, target: string): IndexedSymbol[] {
  return [...values].sort((left, right) => scoreTarget(right, entry, target) - scoreTarget(left, entry, target) || left.id.localeCompare(right.id));
}
function scoreTarget(value: IndexedSymbol, entry: ParsedEntry, target: string): number {
  let score = 0;
  if (value.relativePath === entry.relativePath) score += 100;
  if (!(value.symbol.declarationOnly ?? false)) score += 20;
  if ((value.symbol.qualifiedName ?? value.symbol.name) === target) score += 10;
  if (languageFamily(value.extension) === languageFamily(entry.extension)) score += 5;
  return score;
}
function findSourceSymbol(entry: ParsedEntry, from: string): IndexedSymbol | null {
  return entry.symbols.find((item) => item.symbol.qualifiedName === from)
    ?? entry.symbols.find((item) => item.symbol.name === from)
    ?? null;
}
function symbolAliases(symbol: ParsedSymbol): string[] {
  return [...new Set([symbol.name, symbol.qualifiedName, symbol.qualifiedName?.split(/(?:::|\.)/u).at(-1)].filter((value): value is string => Boolean(value)))];
}
function addAlias(map: Map<string, IndexedSymbol[]>, alias: string, value: IndexedSymbol): void {
  const current = map.get(alias) ?? [];
  current.push(value);
  map.set(alias, current);
}

function resolveImport(source: string, specifier: string, files: Set<string>, extension: string, kind?: string): string | null {
  if (extension === ".py") return resolvePythonImport(source, specifier, files);
  if (HEADER_EXTENSIONS.has(extension) || SOURCE_EXTENSIONS.has(extension)) {
    if (kind === "system") return null;
    const directory = path.posix.dirname(source);
    const candidates = [path.posix.normalize(path.posix.join(directory, specifier)), path.posix.normalize(specifier)];
    const direct = candidates.find((candidate) => files.has(candidate));
    if (direct) return direct;
    const basenameMatches = [...files].filter((candidate) => path.posix.basename(candidate) === path.posix.basename(specifier));
    return basenameMatches.length === 1 ? basenameMatches[0]! : null;
  }
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier));
  const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java"].map((suffix) => `${base}${suffix}`), ...["index.ts", "index.tsx", "index.js", "index.mjs", "__init__.py"].map((name) => `${base}/${name}`)];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function resolvePythonImport(source: string, specifier: string, files: Set<string>): string | null {
  const relative = specifier.match(/^(\.*)(.*)$/u);
  const dots = relative?.[1]?.length ?? 0;
  const module = relative?.[2] ?? specifier;
  let baseDirectory = path.posix.dirname(source);
  if (dots > 0) for (let index = 1; index < dots; index += 1) baseDirectory = path.posix.dirname(baseDirectory);
  const modulePath = module.replace(/\./gu, "/");
  const roots = dots > 0 ? [baseDirectory] : ["", path.posix.dirname(source)];
  const candidates = roots.flatMap((root) => {
    const base = path.posix.normalize(path.posix.join(root, modulePath));
    return [`${base}.py`, `${base}/__init__.py`];
  });
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function languageFamily(extension: string): string {
  if (extension === ".py") return "python";
  if (HEADER_EXTENSIONS.has(extension) || SOURCE_EXTENSIONS.has(extension)) return "native";
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return "typescript";
  return "other";
}
function isTestPath(value: string): boolean { return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/iu.test(value); }
function toPosix(value: string): string { return value.split(path.sep).join("/"); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
