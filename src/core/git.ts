import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export class GitRepository {
  readonly root: string;
  private constructor(root: string) { this.root = root; }

  static async open(candidate: string): Promise<GitRepository> {
    const cwd = path.resolve(candidate);
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 10_000 });
    return new GitRepository(path.resolve(stdout.trim()));
  }

  async headSha(): Promise<string> { try { return await this.runText(["rev-parse", "HEAD"]); } catch { return "UNBORN"; } }
  async currentBranch(): Promise<string> { return this.runText(["branch", "--show-current"]); }

  async changedFiles(): Promise<string[]> {
    const [tracked, untracked] = await Promise.all([
      execFileAsync("git", ["diff", "--name-only", "-z", "HEAD"], { cwd: this.root, encoding: "buffer", timeout: 15_000 }).catch(() => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })),
      execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: this.root, encoding: "buffer", timeout: 15_000 })
    ]);
    return [...new Set([...splitNull(tracked.stdout), ...splitNull(untracked.stdout)])].filter((file) => !file.startsWith(".keep-coding/")).sort();
  }

  async allFiles(): Promise<string[]> {
    const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: this.root, encoding: "buffer", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    return [...new Set(splitNull(stdout))].filter((file) => !file.startsWith(".keep-coding/")).sort();
  }

  async diffHash(): Promise<string> {
    const hash = createHash("sha256");
    hash.update(await this.diff(64 * 1024 * 1024));
    for (const file of await this.changedFiles()) hash.update(`\0${file}`);
    return hash.digest("hex");
  }

  async diff(maxBytes = 1_000_000): Promise<string> {
    const { stdout } = await execFileAsync("git", ["diff", "--binary", "HEAD"], { cwd: this.root, encoding: "buffer", timeout: 30_000, maxBuffer: Math.max(maxBytes, 1024 * 1024) }).catch(() => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
    return stdout.subarray(0, maxBytes).toString("utf8");
  }

  async workingTreeSnapshot(): Promise<Record<string, string>> {
    const files = await this.allFiles();
    const snapshot: Record<string, string> = {};
    for (let offset = 0; offset < files.length; offset += 128) {
      const entries = await Promise.all(files.slice(offset, offset + 128).map(async (file) => {
        const content = await readFile(path.join(this.root, file)).catch(() => null);
        return [file, content === null ? "<missing>" : createHash("sha256").update(content).digest("hex")] as const;
      }));
      for (const [file, fingerprint] of entries) snapshot[file] = fingerprint;
    }
    return snapshot;
  }

  async changedFilesSince(baseline: Record<string, string>): Promise<string[]> {
    const current = await this.workingTreeSnapshot();
    return [...new Set([...Object.keys(baseline), ...Object.keys(current)])].filter((file) => baseline[file] !== current[file]).sort();
  }

  async commitFiles(files: string[], message: string): Promise<string> {
    if (files.length === 0) return this.headSha();
    await execFileAsync("git", ["add", "-A", "--", ...files], { cwd: this.root, timeout: 30_000 });
    const hasStaged = await execFileAsync("git", ["diff", "--cached", "--quiet"], { cwd: this.root, timeout: 10_000 }).then(() => false).catch((error: unknown) => {
      const code = (error as { code?: number }).code;
      if (code === 1) return true;
      throw error;
    });
    if (!hasStaged) return this.headSha();
    await execFileAsync("git", ["commit", "-m", message], { cwd: this.root, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    return this.headSha();
  }

  async restoreFiles(baseSha: string, files: string[]): Promise<void> {
    if (files.length === 0) return;
    await execFileAsync("git", ["restore", "--source", baseSha, "--staged", "--worktree", "--", ...files], { cwd: this.root, timeout: 30_000 }).catch(async () => {
      await execFileAsync("git", ["checkout", baseSha, "--", ...files], { cwd: this.root, timeout: 30_000 });
    });
    await execFileAsync("git", ["clean", "-f", "--", ...files], { cwd: this.root, timeout: 30_000 }).catch(() => undefined);
  }

  async createWorktree(phaseId: string, baseSha: string): Promise<{ path: string; branch: string }> {
    const safe = phaseId.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const shortSha = baseSha.slice(0, 8);
    const branch = `keep-coding/${safe}-${shortSha}`;
    const worktreePath = path.join(this.root, ".keep-coding", "worktrees", `${safe}-${shortSha}`);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await rm(worktreePath, { recursive: true, force: true });
    await execFileAsync("git", ["worktree", "add", "-b", branch, worktreePath, baseSha], { cwd: this.root, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    return { path: worktreePath, branch };
  }

  async mergeWorktree(branch: string): Promise<string> {
    const dirty = await this.changedFiles();
    if (dirty.length > 0) throw new Error("main worktree must be clean before merging a parallel phase");
    try {
      await execFileAsync("git", ["merge", "--no-ff", "--no-edit", branch], { cwd: this.root, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
    } catch (error) {
      await execFileAsync("git", ["merge", "--abort"], { cwd: this.root, timeout: 15_000 }).catch(() => undefined);
      throw error;
    }
    return this.headSha();
  }

  async removeWorktree(worktreePath: string, branch: string): Promise<void> {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: this.root, timeout: 60_000 }).catch(() => undefined);
    await execFileAsync("git", ["branch", "-D", branch], { cwd: this.root, timeout: 30_000 }).catch(() => undefined);
    await execFileAsync("git", ["worktree", "prune"], { cwd: this.root, timeout: 30_000 }).catch(() => undefined);
  }

  private async runText(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: this.root, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  }
}

function splitNull(value: string | Buffer): string[] {
  return Buffer.isBuffer(value) ? value.toString("utf8").split("\0").filter(Boolean) : value.split("\0").filter(Boolean);
}
