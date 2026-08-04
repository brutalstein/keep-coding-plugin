import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, Query, type Node, type QueryMatch } from "web-tree-sitter";

export type TreeSitterLanguageId = "python" | "c" | "cpp";

export interface TreeSitterRun {
  root: Node;
  matches: QueryMatch[];
  hasError: boolean;
  errorRatio: number;
  elapsedMs: number;
}

export interface TreeSitterOptions {
  assetDirectory?: string;
  maxParseMs?: number;
  maxQueryMs?: number;
  forceFailure?: boolean;
}

const LANGUAGE_ASSETS: Record<TreeSitterLanguageId, string> = {
  python: "tree-sitter-python.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm"
};
const RUNTIME_ASSET = "web-tree-sitter.wasm";
const DEFAULT_PARSE_MS = 2_000;
const DEFAULT_QUERY_MS = 2_000;
let runtimePromise: Promise<void> | null = null;
const languagePromises = new Map<string, Promise<Language>>();
const assetVerificationPromises = new Map<string, Promise<void>>();

export async function runTreeSitterQuery<T>(
  languageId: TreeSitterLanguageId,
  content: string,
  queryFile: string,
  consume: (run: TreeSitterRun) => T,
  options: TreeSitterOptions = {}
): Promise<T> {
  if (options.forceFailure) throw new Error("tree-sitter failure forced for validation");
  const assetDirectory = options.assetDirectory ?? await resolveAssetDirectory();
  await verifyAssetDirectory(assetDirectory);
  await initializeRuntime(assetDirectory);
  const language = await loadLanguage(languageId, assetDirectory);
  const parser = new Parser();
  let tree: ReturnType<Parser["parse"]> = null;
  let query: Query | null = null;
  try {
    parser.setLanguage(language);
    const parseStarted = performance.now();
    const parseDeadline = parseStarted + (options.maxParseMs ?? DEFAULT_PARSE_MS);
    tree = parser.parse(content, null, { progressCallback: () => performance.now() > parseDeadline });
    if (!tree) throw new Error(`tree-sitter ${languageId} parse cancelled or returned no tree`);
    const queryStarted = performance.now();
    const queryDeadline = queryStarted + (options.maxQueryMs ?? DEFAULT_QUERY_MS);
    const querySource = await readFile(path.join(assetDirectory, "queries", queryFile), "utf8");
    query = new Query(language, querySource);
    query.matchLimit = 20_000;
    const matches = query.matches(tree.rootNode, { progressCallback: () => performance.now() > queryDeadline });
    if (query.didExceedMatchLimit()) throw new Error(`tree-sitter ${languageId} query match limit exceeded`);
    const diagnostics = countErrors(tree.rootNode);
    return consume({
      root: tree.rootNode,
      matches,
      hasError: tree.rootNode.hasError,
      errorRatio: diagnostics.total === 0 ? 0 : diagnostics.errors / diagnostics.total,
      elapsedMs: performance.now() - parseStarted
    });
  } finally {
    query?.delete();
    tree?.delete();
    parser.delete();
  }
}

export async function resolveAssetDirectory(): Promise<string> {
  const candidates = [
    process.env.KEEP_CODING_TREE_SITTER_ASSET_DIR,
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "grammars"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../assets/tree-sitter"),
    path.resolve(process.cwd(), "assets/tree-sitter"),
    path.resolve(process.cwd(), "plugins/keep-coding/dist/grammars")
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (await exists(path.join(candidate, RUNTIME_ASSET))) return candidate;
  }
  throw new Error(`tree-sitter assets not found; checked ${candidates.join(", ")}`);
}

async function verifyAssetDirectory(assetDirectory: string): Promise<void> {
  let promise = assetVerificationPromises.get(assetDirectory);
  if (!promise) {
    promise = (async () => {
      const manifestPath = path.join(assetDirectory, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        schemaVersion: number; files: Record<string, { sha256: string; bytes: number }>;
      };
      if (manifest.schemaVersion !== 1 || typeof manifest.files !== "object") throw new Error("invalid tree-sitter asset manifest");
      for (const [relative, expected] of Object.entries(manifest.files)) {
        const file = path.join(assetDirectory, relative);
        const bytes = await readFile(file);
        const info = await stat(file);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (info.size !== expected.bytes || digest !== expected.sha256) {
          throw new Error(`tree-sitter asset integrity mismatch: ${relative}`);
        }
      }
    })().catch((error: unknown) => {
      assetVerificationPromises.delete(assetDirectory);
      throw error;
    });
    assetVerificationPromises.set(assetDirectory, promise);
  }
  await promise;
}

async function initializeRuntime(assetDirectory: string): Promise<void> {
  if (runtimePromise === null) {
    runtimePromise = Parser.init({ locateFile: () => path.join(assetDirectory, RUNTIME_ASSET) }).catch((error: unknown) => {
      runtimePromise = null;
      throw error;
    });
  }
  await runtimePromise;
}

async function loadLanguage(languageId: TreeSitterLanguageId, assetDirectory: string): Promise<Language> {
  const key = `${assetDirectory}:${languageId}`;
  let promise = languagePromises.get(key);
  if (!promise) {
    promise = Language.load(path.join(assetDirectory, LANGUAGE_ASSETS[languageId])).catch((error: unknown) => {
      languagePromises.delete(key);
      throw error;
    });
    languagePromises.set(key, promise);
  }
  return promise;
}

function countErrors(root: Node): { errors: number; total: number } {
  let errors = 0;
  let total = 0;
  const stack = [root];
  while (stack.length > 0 && total < 100_000) {
    const current = stack.pop();
    if (!current) break;
    total += 1;
    if (current.isError || current.isMissing) errors += 1;
    for (const child of current.namedChildren) stack.push(child);
  }
  return { errors, total };
}

async function exists(value: string): Promise<boolean> {
  return access(value).then(() => true, () => false);
}
