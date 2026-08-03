import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { minimatch } from "minimatch";

const execFileAsync = promisify(execFile);
const MAX_RESTORE_BYTES = 8 * 1024 * 1024;

export interface WorktreeRecord {
  phaseId: string;
  branch: string;
  path: string;
  baseSha: string;
}

export class GitRepository {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(candidate: string): Promise<GitRepository> {
    const cwd = path.resolve(candidate);
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000
    });
    return new GitRepository(path.resolve(stdout.trim()));
  }

  async headSha(): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: this.root,
        encoding: "utf8",
        timeout: 10_000
      });
      return stdout.trim();
    } catch {
      return "UNBORN";
    }
  }

  async currentBranch(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
        cwd: this.root,
        encoding: "utf8",
        timeout: 10_000
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async changedFiles(): Promise<string[]> {
    const [tracked, untracked] = await Promise.all([
      execFileAsync("git", ["diff", "--name-only", "-z", "HEAD"], {
        cwd: this.root,
        encoding: "buffer",
        timeout: 15_000
      }).catch(() => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })),
      execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: this.root,
        encoding: "buffer",
        timeout: 15_000
      })
    ]);
    return [...new Set([...splitNull(tracked.stdout), ...splitNull(untracked.stdout)])]
      .filter(isProjectFile)
      .sort();
  }

  async allFiles(): Promise<string[]> {
    const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd: this.root,
      encoding: "buffer",
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024
    });
    return [...new Set(splitNull(stdout))]
      .filter(isProjectFile)
      .sort();
  }

  async diffText(maxBytes = 4 * 1024 * 1024): Promise<string> {
    const { stdout } = await execFileAsync("git", ["diff", "--no-ext-diff", "--unified=3", "HEAD"], {
      cwd: this.root,
      encoding: "buffer",
      timeout: 30_000,
      maxBuffer: Math.max(maxBytes, 1024 * 1024)
    }).catch(() => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
    const tracked = stdout.subarray(0, maxBytes).toString("utf8");
    const untrackedParts: string[] = [];
    for (const file of await this.untrackedFiles()) {
      if (Buffer.byteLength(tracked + untrackedParts.join("\n"), "utf8") >= maxBytes) break;
      const content = await readFile(path.join(this.root, file), "utf8").catch(() => null);
      if (content !== null) untrackedParts.push(`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n${content.split("\n").map((line) => `+${line}`).join("\n")}`);
    }
    return [tracked, ...untrackedParts].filter(Boolean).join("\n").slice(0, maxBytes);
  }

  async diffHash(): Promise<string> {
    const hash = createHash("sha256");
    hash.update(await this.diffText(64 * 1024 * 1024));
    for (const file of await this.changedFiles()) hash.update(`\0${file}`);
    return hash.digest("hex");
  }

  async workingTreeSnapshot(): Promise<Record<string, string>> {
    const files = await this.allFiles();
    const snapshot: Record<string, string> = {};
    const batchSize = 128;
    for (let offset = 0; offset < files.length; offset += batchSize) {
      const batch = files.slice(offset, offset + batchSize);
      const entries = await Promise.all(batch.map(async (file) => {
        const content = await readFile(path.join(this.root, file)).catch(() => null);
        return [file, content === null ? "<missing>" : createHash("sha256").update(content).digest("hex")] as const;
      }));
      for (const [file, fingerprint] of entries) snapshot[file] = fingerprint;
    }
    return snapshot;
  }

  async changedFilesSince(baseline: Record<string, string>): Promise<string[]> {
    const current = await this.workingTreeSnapshot();
    return [...new Set([...Object.keys(baseline), ...Object.keys(current)])]
      .filter((file) => baseline[file] !== current[file])
      .sort();
  }

  async captureScopeSnapshot(patterns: string[]): Promise<Record<string, string | null>> {
    const snapshot: Record<string, string | null> = {};
    let total = 0;
    for (const file of await this.allFiles()) {
      if (!matchesAny(file, patterns)) continue;
      const content = await readFile(path.join(this.root, file)).catch(() => null);
      if (content === null) continue;
      total += content.length;
      if (total > MAX_RESTORE_BYTES) throw new Error("phase restore snapshot exceeds 8 MiB; narrow allowedScope");
      snapshot[file] = content.toString("base64");
    }
    return snapshot;
  }

  async restoreScopeSnapshot(snapshot: Record<string, string | null>, changedFiles: string[]): Promise<string[]> {
    const restored: string[] = [];
    for (const file of changedFiles) {
      const target = path.join(this.root, file);
      const encoded = snapshot[file];
      if (encoded === undefined || encoded === null) {
        await rm(target, { force: true, recursive: false }).catch(() => undefined);
      } else {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(encoded, "base64"));
      }
      restored.push(file);
    }
    return restored;
  }

  async commitFiles(files: string[], message: string): Promise<string | null> {
    if (files.length === 0 || await this.headSha() === "UNBORN") return null;
    const normalized = [...new Set(files.map(toPosix).filter(isProjectFile))];
    if (normalized.length === 0) return null;
    await execFileAsync("git", ["add", "-A", "--", ...normalized], { cwd: this.root, timeout: 30_000 });
    const { stdout: staged } = await execFileAsync("git", ["diff", "--cached", "--name-only"], {
      cwd: this.root,
      encoding: "utf8",
      timeout: 10_000
    });
    if (!staged.trim()) return null;
    await execFileAsync("git", [
      "-c", "user.name=Keep Coding",
      "-c", "user.email=keep-coding@localhost",
      "commit", "--no-gpg-sign", "-m", message.trim().slice(0, 200), "--", ...normalized
    ], { cwd: this.root, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    return this.headSha();
  }

  async createPhaseWorktree(phaseId: string): Promise<WorktreeRecord> {
    const safe = phaseId.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const branch = `keep-coding/${safe}`;
    const parent = path.join(path.dirname(this.root), `.${path.basename(this.root)}-keep-coding-worktrees`);
    const target = path.join(parent, safe);
    await mkdir(parent, { recursive: true });
    await rm(target, { recursive: true, force: true });
    const baseSha = await this.headSha();
    const branchExists = await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: this.root })
      .then(() => true).catch(() => false);
    if (branchExists) await execFileAsync("git", ["branch", "-D", branch], { cwd: this.root, timeout: 15_000 });
    await execFileAsync("git", ["worktree", "add", "-b", branch, target, baseSha], { cwd: this.root, timeout: 60_000 });
    return { phaseId, branch, path: target, baseSha };
  }

  async mergePhaseWorktree(record: WorktreeRecord): Promise<string> {
    await execFileAsync("git", ["merge", "--no-ff", "--no-edit", record.branch], {
      cwd: this.root,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024
    });
    await this.removePhaseWorktree(record);
    return this.headSha();
  }

  async removePhaseWorktree(record: WorktreeRecord): Promise<void> {
    await execFileAsync("git", ["worktree", "remove", "--force", record.path], { cwd: this.root, timeout: 60_000 }).catch(() => undefined);
    await execFileAsync("git", ["worktree", "prune"], { cwd: this.root, timeout: 15_000 }).catch(() => undefined);
  }

  private async untrackedFiles(): Promise<string[]> {
    const { stdout } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: this.root,
      encoding: "buffer",
      timeout: 15_000
    });
    return splitNull(stdout).filter(isProjectFile);
  }
}

function splitNull(value: string | Buffer): string[] {
  return Buffer.isBuffer(value)
    ? value.toString("utf8").split("\0").filter(Boolean)
    : value.split("\0").filter(Boolean);
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.length === 0 || patterns.some((pattern) => minimatch(file, pattern, { dot: true, matchBase: false }));
}

function isProjectFile(file: string): boolean {
  const normalized = toPosix(file);
  return !normalized.startsWith(".keep-coding/") && !normalized.startsWith(".git/");
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
