import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

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
      .filter((file) => !file.startsWith(".keep-coding/"))
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
      .filter((file) => !file.startsWith(".keep-coding/"))
      .sort();
  }

  async diffHash(): Promise<string> {
    const hash = createHash("sha256");
    const { stdout } = await execFileAsync("git", ["diff", "--binary", "HEAD"], {
      cwd: this.root,
      encoding: "buffer",
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024
    }).catch(() => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
    hash.update(stdout);
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
}

function splitNull(value: string | Buffer): string[] {
  return Buffer.isBuffer(value)
    ? value.toString("utf8").split("\0").filter(Boolean)
    : value.split("\0").filter(Boolean);
}
