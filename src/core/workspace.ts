import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import type { ProjectStore } from "../storage/store.js";
import type { GitRepository } from "./git.js";

const MAX_READ_BYTES = 1_048_576;
const MAX_SEARCH_BYTES = 32 * 1024 * 1024;
const MAX_PATCH_BYTES = 256 * 1024;
const MAX_DIFF_CHARS = 100_000;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

export class WorkspaceTools {
  private readonly canonicalRoot: Promise<string>;

  constructor(private readonly git: GitRepository, private readonly store: ProjectStore) {
    this.canonicalRoot = realpath(git.root);
  }

  async listFiles(maxFiles = 500): Promise<{ files: string[]; truncated: boolean }> {
    const files = await this.git.allFiles();
    return { files: files.slice(0, maxFiles), truncated: files.length > maxFiles };
  }

  async readTextFile(relativePath: string, startLine = 1, endLine = 400): Promise<Record<string, unknown>> {
    if (startLine < 1 || endLine < startLine) throw new Error("line range is invalid");
    const safePath = await this.resolveExistingFile(relativePath);
    const info = await stat(safePath);
    if (!info.isFile()) throw new Error(`not a regular file: ${relativePath}`);
    if (info.size > MAX_READ_BYTES) throw new Error(`file exceeds ${MAX_READ_BYTES} bytes: ${relativePath}`);
    const buffer = await readFile(safePath);
    if (buffer.includes(0)) throw new Error(`binary files cannot be read as text: ${relativePath}`);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    const boundedEnd = Math.min(endLine, lines.length);
    return {
      path: normalizeRepositoryPath(relativePath),
      startLine,
      endLine: boundedEnd,
      totalLines: lines.length,
      content: lines.slice(startLine - 1, boundedEnd).map((line, index) => `${startLine + index}: ${line}`).join("\n")
    };
  }

  async searchCode(query: string, maxResults = 100): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
    const needle = query.toLowerCase();
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let inspectedBytes = 0;
    for (const file of await this.git.allFiles()) {
      const safePath = await this.resolveExistingFile(file).catch(() => null);
      if (safePath === null) continue;
      const info = await stat(safePath).catch(() => null);
      if (info === null || !info.isFile() || info.size > MAX_READ_BYTES) continue;
      inspectedBytes += info.size;
      if (inspectedBytes > MAX_SEARCH_BYTES) return { matches, truncated: true };
      const buffer = await readFile(safePath);
      if (buffer.includes(0)) continue;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (!line.toLowerCase().includes(needle)) continue;
        matches.push({ path: file, line: index + 1, text: line.slice(0, 500) });
        if (matches.length >= maxResults) return { matches, truncated: true };
      }
    }
    return { matches, truncated: false };
  }

  async diff(maxChars = 30_000): Promise<{ diff: string; changedFiles: string[]; truncated: boolean }> {
    const result = await runGit(this.git.root, ["diff", "--no-ext-diff", "--unified=3", "--", ".", ":(exclude).keep-coding/**"]);
    const changedFiles = await this.git.changedFiles();
    const trackedChanged = new Set((await runGit(this.git.root, ["diff", "--name-only", "--", ".", ":(exclude).keep-coding/**"])).stdout.split(/\r?\n/).filter(Boolean));
    const untracked = changedFiles.filter((file) => !trackedChanged.has(file));
    const suffix = untracked.length === 0 ? "" : `\n\nUntracked files:\n${untracked.map((file) => `- ${file}`).join("\n")}`;
    const value = `${result.stdout}${suffix}`;
    const limit = Math.min(maxChars, MAX_DIFF_CHARS);
    return { diff: value.slice(0, limit), changedFiles, truncated: value.length > limit };
  }

  async applyPatch(phaseId: string, patchText: string): Promise<Record<string, unknown>> {
    const patchBytes = Buffer.byteLength(patchText);
    if (patchBytes === 0) throw new Error("patch must not be empty");
    if (patchBytes > MAX_PATCH_BYTES) throw new Error(`patch exceeds ${MAX_PATCH_BYTES} bytes`);
    if (/^(?:new file mode|old mode) 120000$/m.test(patchText)) {
      throw new Error("symbolic-link patches are not allowed through remote workspace tools");
    }
    const phase = this.store.getPhase(phaseId);
    if (!phase) throw new Error(`unknown phase: ${phaseId}`);
    if (phase.status !== "IN_PROGRESS") throw new Error(`phase ${phaseId} is not in progress`);
    const files = extractPatchPaths(patchText);
    if (files.length === 0) throw new Error("patch does not contain any supported file changes");
    const violations = files.filter((file) => !phase.allowedScope.some((pattern) => minimatch(file, pattern, { dot: true })));
    if (violations.length > 0) throw new Error(`patch changes files outside phase scope: ${violations.join(", ")}`);
    await runGit(this.git.root, ["apply", "--check", "--recount", "--whitespace=error", "-"], patchText);
    await runGit(this.git.root, ["apply", "--recount", "--whitespace=error", "-"], patchText);
    this.store.appendEvent("workspace_patch_applied", phaseId, { files, patchBytes });
    return { applied: true, phaseId, files, diffHash: await this.git.diffHash() };
  }

  private async resolveExistingFile(relativePath: string): Promise<string> {
    const repositoryPath = normalizeRepositoryPath(relativePath);
    const root = await this.canonicalRoot;
    const candidate = path.resolve(root, ...repositoryPath.split("/"));
    const canonical = await realpath(candidate);
    const relative = path.relative(root, canonical);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`path escapes repository: ${relativePath}`);
    }
    return canonical;
  }
}

export function extractPatchPaths(patchText: string): string[] {
  const files = new Set<string>();
  for (const line of patchText.split(/\r?\n/)) {
    const match = /^(?:---|\+\+\+) (?:a|b)\/(.+)$/.exec(line);
    if (!match) continue;
    files.add(normalizeRepositoryPath(match[1] ?? ""));
  }
  return [...files].sort();
}

function normalizeRepositoryPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const protectedPath = normalized === ".git" || normalized.startsWith(".git/")
    || normalized === ".keep-coding" || normalized.startsWith(".keep-coding/");
  if (normalized === "" || protectedPath || path.posix.isAbsolute(normalized)) {
    throw new Error(`invalid repository path: ${value}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error(`invalid repository path: ${value}`);
  return parts.join("/");
}

async function runGit(cwd: string, args: string[], input?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= MAX_GIT_OUTPUT_BYTES) target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", reject);
    child.once("close", (code) => {
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0) resolve(result);
      else reject(new Error(`git ${args[0] ?? "command"} failed (${code ?? "signal"}): ${result.stderr.trim() || result.stdout.trim()}`));
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input, "utf8");
  });
}
