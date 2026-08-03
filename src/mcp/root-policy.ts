import { realpath } from "node:fs/promises";
import path from "node:path";

export type ProjectRootResolver = (projectRoot: string) => Promise<string>;

export function parseAllowedRoots(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
}

export async function createAllowedRootResolver(allowedRoots: string[]): Promise<ProjectRootResolver> {
  if (allowedRoots.length === 0) {
    throw new Error("KEEP_CODING_ALLOWED_ROOTS must contain at least one existing directory");
  }
  const canonicalRoots = await Promise.all(allowedRoots.map(async (root) => {
    if (!path.isAbsolute(root)) throw new Error(`Allowed root must be absolute: ${root}`);
    return realpath(root);
  }));

  return async (projectRoot: string) => {
    if (!path.isAbsolute(projectRoot)) throw new Error("project_root must be an absolute path");
    const canonicalProjectRoot = await realpath(projectRoot);
    if (!canonicalRoots.some((root) => containsPath(root, canonicalProjectRoot))) {
      throw new Error(`project_root is outside KEEP_CODING_ALLOWED_ROOTS: ${projectRoot}`);
    }
    return canonicalProjectRoot;
  };
}

function containsPath(root: string, candidate: string): boolean {
  const normalizedRoot = comparisonKey(root);
  const normalizedCandidate = comparisonKey(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function comparisonKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
