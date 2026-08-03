import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAllowedRootResolver, parseAllowedRoots } from "../src/mcp/root-policy.js";

describe("remote project-root policy", () => {
  it("parses the platform path-list format", () => {
    expect(parseAllowedRoots(["/one", "/two"].join(path.delimiter))).toEqual(["/one", "/two"]);
    expect(parseAllowedRoots(undefined)).toEqual([]);
  });

  it("canonicalizes roots and rejects paths outside the allowlist", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "keep-coding-roots-"));
    const allowed = path.join(base, "allowed");
    const project = path.join(allowed, "project");
    const outside = path.join(base, "outside");
    mkdirSync(project, { recursive: true });
    mkdirSync(outside);
    try {
      const resolve = await createAllowedRootResolver([allowed]);
      await expect(resolve(project)).resolves.toBe(realpathSync(project));
      await expect(resolve(outside)).rejects.toThrow("outside KEEP_CODING_ALLOWED_ROOTS");
      await expect(resolve("relative/project")).rejects.toThrow("absolute path");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("resolves symlinks before checking containment", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "keep-coding-symlink-"));
    const allowed = path.join(base, "allowed");
    const outside = path.join(base, "outside");
    const link = path.join(allowed, "escape");
    mkdirSync(allowed);
    mkdirSync(outside);
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    try {
      const resolve = await createAllowedRootResolver([allowed]);
      await expect(resolve(link)).rejects.toThrow("outside KEEP_CODING_ALLOWED_ROOTS");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("requires at least one configured root", async () => {
    await expect(createAllowedRootResolver([])).rejects.toThrow("at least one existing directory");
  });
});
