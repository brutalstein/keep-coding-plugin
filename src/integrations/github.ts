import type { CheckpointRecord, ProjectSnapshot } from "../domain/model.js";

export function generatePullRequestDescription(snapshot: ProjectSnapshot): string {
  const contract = snapshot.project.contract;
  const completed = snapshot.phases.filter((phase) => phase.status === "COMPLETED");
  const pending = snapshot.phases.filter((phase) => !["COMPLETED", "SUPERSEDED"].includes(phase.status));
  const latestCheckpoints = snapshot.checkpoints.slice(-20);
  const decisions = snapshot.decisions.filter((decision) => decision.status === "active").slice(-12);
  const secretFindings = latestCheckpoints.reduce((total, checkpoint) => total + checkpoint.verification.secretFindings.length, 0);
  const failedChecks = latestCheckpoints.flatMap((checkpoint) => [
    ...checkpoint.verification.selectiveCommands,
    ...checkpoint.verification.commands
  ]).filter((command) => !command.passed);
  const impactedTests = [...new Set(latestCheckpoints.flatMap((checkpoint) => checkpoint.verification.impactedTests))].sort();

  return [
    `## Summary`,
    contract?.goal ?? snapshot.project.originalPrompt,
    "",
    "## Delivered",
    bullets((contract?.deliverables ?? completed.map((phase) => phase.title)).slice(0, 20)),
    "",
    "## Phase status",
    `- Completed: ${completed.length}`,
    `- Pending intervention or verification: ${pending.length}`,
    `- Plan version: ${snapshot.project.planVersion}`,
    "",
    phaseTable(snapshot),
    "",
    "## Verification evidence",
    checkpointTable(latestCheckpoints),
    "",
    `- Secret findings in recorded checkpoints: ${secretFindings}`,
    `- Failed recorded commands: ${failedChecks.length}`,
    impactedTests.length > 0 ? `- Impacted tests: ${impactedTests.map((test) => `\`${test}\``).join(", ")}` : "- Impacted tests: none recorded",
    "",
    "## Decisions",
    decisions.length > 0 ? decisions.map((decision) => `- **${decision.title}:** ${decision.rationale}`).join("\n") : "- No durable decisions recorded.",
    "",
    "## Remaining work",
    pending.length > 0 ? pending.map((phase) => `- ${phase.id}: ${phase.status} — ${phase.goal}`).join("\n") : "- None. All active phases are verified.",
    "",
    "_Generated from the Keep Coding durable event and checkpoint ledger._"
  ].join("\n");
}

export function generateCheckpointCommitMessage(checkpoint: CheckpointRecord): string {
  const files = checkpoint.changedFiles.length;
  const tests = checkpoint.verification.impactedTests.length;
  const summary = checkpoint.summary.trim().replace(/\s+/g, " ");
  return `keep-coding(${checkpoint.phaseId}): ${summary}\n\nVerified ${files} changed file${files === 1 ? "" : "s"}; ${tests} impacted test${tests === 1 ? "" : "s"}.`;
}

function phaseTable(snapshot: ProjectSnapshot): string {
  const rows = snapshot.phases.map((phase) => `| \`${phase.id}\` | ${phase.status} | ${phase.dependencies.join(", ") || "—"} | ${phase.summary ?? "—"} |`);
  return ["| Phase | Status | Depends on | Evidence summary |", "|---|---|---|---|", ...rows].join("\n");
}

function checkpointTable(checkpoints: CheckpointRecord[]): string {
  if (checkpoints.length === 0) return "No checkpoints recorded.";
  const rows = checkpoints.map((checkpoint) => {
    const verification = checkpoint.verification;
    const commands = verification.commands.length + verification.selectiveCommands.length;
    return `| \`${checkpoint.phaseId}\` | ${verification.passed ? "pass" : "fail"} | ${checkpoint.changedFiles.length} | ${commands} | ${verification.checkpointCommitSha?.slice(0, 12) ?? checkpoint.gitSha.slice(0, 12)} |`;
  });
  return ["| Phase | Result | Files | Commands | Commit |", "|---|---:|---:|---:|---|", ...rows].join("\n");
}

function bullets(values: string[]): string {
  return values.length === 0 ? "- None recorded." : values.map((value) => `- ${value}`).join("\n");
}
