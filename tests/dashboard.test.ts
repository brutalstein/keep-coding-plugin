import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KeepCodingService } from "../src/core/service.js";
import { startDashboard } from "../src/dashboard/server.js";

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keep-coding-dashboard-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "# project\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd: root });
  return root;
}

describe("observability dashboard", () => {
  it("serves a loopback-only read-only status view", async () => {
    const root = repository();
    const service = await KeepCodingService.open(root);
    await service.initialize("Build a verified project");
    service.close();
    const dashboard = await startDashboard(root);
    const page = await fetch(dashboard.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Keep Coding Dashboard");
    const status = await fetch(`${dashboard.url}/api/status`);
    expect(await status.json()).toMatchObject({ project: { root, status: "PLANNING" } });
    const writeAttempt = await fetch(`${dashboard.url}/api/status`, { method: "POST" });
    expect(writeAttempt.status).toBe(405);
    await dashboard.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects non-loopback binding", async () => {
    await expect(startDashboard(process.cwd(), 0, "0.0.0.0")).rejects.toThrow(/loopback-only/);
  });
});
