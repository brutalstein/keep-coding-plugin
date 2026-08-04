import type { ProjectSnapshot } from "../domain/model.js";

export function generatePullRequestDescription(snapshot: ProjectSnapshot): string {
  const completed = snapshot.phases.filter((phase) => phase.status === "COMPLETED");
  const decisions = snapshot.decisions.filter((decision) => decision.status === "active").slice(-12);
  const checks = snapshot.checkpoints.flatMap((checkpoint) => [...checkpoint.verification.selectiveCommands, ...checkpoint.verification.commands])
    .filter((item, index, all) => all.findIndex((candidate) => candidate.command === item.command) === index);
  return [
    `## Goal\n\n${snapshot.project.contract?.goal ?? snapshot.project.originalPrompt}`,
    `## Delivered phases\n\n${completed.map((phase) => `- **${phase.title}** — ${phase.summary ?? phase.goal}`).join("\n") || "- None"}`,
    decisions.length > 0 ? `## Decisions\n\n${decisions.map((decision) => `- **${decision.title}:** ${decision.rationale}`).join("\n")}` : "",
    `## Verification\n\n${checks.map((check) => `- \`${check.command}\` — ${check.passed ? "passed" : "failed"}`).join("\n") || "- No checkpoint commands recorded"}`,
    `## Evidence\n\n- Plan version: ${snapshot.project.planVersion}\n- Checkpoints: ${snapshot.checkpoints.length}\n- Event sequence: ${snapshot.recentEvents.at(-1)?.sequence ?? 0}`
  ].filter(Boolean).join("\n\n");
}

export function generateCommitMessage(phaseId: string, summary: string): string {
  const normalized = summary.trim().replace(/\s+/g, " ").slice(0, 68);
  return `keep-coding(${phaseId}): ${normalized}`;
}
