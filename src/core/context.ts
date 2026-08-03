import type { ProjectSnapshot } from "../domain/model.js";
import type { ProjectStore } from "../storage/store.js";

const DEFAULT_MAX_CHARS = 12_000;

export function compileContext(store: ProjectStore, maxChars = DEFAULT_MAX_CHARS): string {
  const snapshot = store.snapshot();
  const active = snapshot.project.currentPhaseId
    ? snapshot.phases.find((phase) => phase.id === snapshot.project.currentPhaseId) ?? null
    : null;
  const terms = tokenize([active?.title, active?.goal, ...(active?.allowedScope ?? [])].filter(Boolean).join(" "));
  const related = store.searchGraph(terms, 35);
  const sections = [
    header(snapshot),
    contractSection(snapshot),
    phaseSection(snapshot),
    approvalSection(snapshot),
    decisionSection(snapshot),
    failureSection(snapshot),
    checkpointSection(snapshot),
    related.length > 0
      ? `## Relevant repository graph\n${related.map((node) => `- ${node.type}: ${node.path ?? node.label}${node.symbol ? `#${node.symbol}` : ""}`).join("\n")}`
      : ""
  ].filter(Boolean);
  return fitSections(sections, maxChars);
}

function header(snapshot: ProjectSnapshot): string {
  return [
    "# KEEP CODING ACTIVE",
    "Use the Keep Coding MCP workflow. Do not declare completion without passing checkpoints and the final full-suite gate.",
    `Project root: ${snapshot.project.root}`,
    `Project status: ${snapshot.project.status}`,
    `Plan version: ${snapshot.project.planVersion}`
  ].join("\n");
}

function contractSection(snapshot: ProjectSnapshot): string {
  const contract = snapshot.project.contract;
  if (!contract) return "## Required next action\nInspect the repository, then call `save_plan` with a measurable contract and dependency-aware phases.";
  return [
    "## Project contract",
    `Goal: ${contract.goal}`,
    `Deliverables:\n${bullets(contract.deliverables)}`,
    `Constraints:\n${bullets(contract.constraints)}`,
    `Invariants:\n${bullets(contract.invariants)}`,
    `Done when:\n${bullets(contract.doneWhen)}`,
    `Critic gate: ${contract.criticGate ?? "advisory"}`,
    contract.budget ? `Project budget: ${JSON.stringify(contract.budget)}` : ""
  ].filter(Boolean).join("\n");
}

function phaseSection(snapshot: ProjectSnapshot): string {
  const active = snapshot.project.currentPhaseId
    ? snapshot.phases.find((phase) => phase.id === snapshot.project.currentPhaseId)
    : null;
  if (!active) return `## Phase status\n${snapshot.phases.map((phase) => `- ${phase.id}: ${phase.status}`).join("\n") || "Plan not saved."}`;
  return [
    "## Active phase",
    `${active.id} — ${active.title} [${active.status}]`,
    `Goal: ${active.goal}`,
    `Allowed scope:\n${bullets(active.allowedScope)}`,
    `Acceptance commands:\n${bullets(active.acceptanceCommands)}`,
    `Attempts: ${active.attempts}/${active.maxAttempts}`,
    active.budget ? `Phase budget: ${JSON.stringify(active.budget)}` : "",
    nextPhaseInstruction(active.status)
  ].filter(Boolean).join("\n");
}

function approvalSection(snapshot: ProjectSnapshot): string {
  const pending = snapshot.approvals.filter((approval) => approval.status === "pending");
  return pending.length === 0 ? "" : `## Pending human approval\n${pending.map((approval) => `- ${approval.id} [${approval.phaseId}]: ${approval.question}\n  ${approval.details}`).join("\n")}`;
}

function decisionSection(snapshot: ProjectSnapshot): string {
  const decisions = snapshot.decisions.filter((decision) => decision.status === "active").slice(-12);
  return decisions.length === 0 ? "" : `## Active decisions\n${decisions.map((decision) => `- ${decision.title}: ${decision.rationale}`).join("\n")}`;
}

function failureSection(snapshot: ProjectSnapshot): string {
  const failures = snapshot.failures.filter((failure) => failure.resolution === null).slice(-10);
  return failures.length === 0 ? "" : `## Unresolved failure memory\n${failures.map((failure) => `- [${failure.phaseId}] x${failure.count} ${failure.summary}`).join("\n")}`;
}

function checkpointSection(snapshot: ProjectSnapshot): string {
  const checkpoints = snapshot.checkpoints.slice(-5);
  return checkpoints.length === 0 ? "" : `## Recent verified checkpoints\n${checkpoints.map((checkpoint) => {
    const verification = checkpoint.verification;
    return `- ${checkpoint.phaseId} @ ${(verification.checkpointCommitSha ?? checkpoint.gitSha).slice(0, 12)}: ${checkpoint.summary}; files=${checkpoint.changedFiles.length}, tests=${verification.impactedTests.length}, secrets=${verification.secretFindings.length}`;
  }).join("\n")}`;
}

function nextPhaseInstruction(status: string): string {
  switch (status) {
    case "AWAITING_APPROVAL":
      return "Wait for the human response and call `resolve_approval`; do not continue implementation.";
    case "NEEDS_REVERIFICATION":
      return "Re-run this phase's acceptance evidence because a later change invalidated the prior checkpoint.";
    case "FAILED":
      return "Repair the failure or call `restore_phase`, then restart and checkpoint the phase.";
    case "BLOCKED":
    case "BLOCKED_BUDGET":
      return "Human intervention or a versioned plan amendment is required before continuing.";
    default:
      return "Complete this phase, call `checkpoint_phase`, repair failures, then continue to the next ready phase.";
  }
}

function fitSections(sections: string[], maxChars: number): string {
  const selected: string[] = [];
  let remaining = Math.max(1_000, maxChars);
  for (const section of sections) {
    if (remaining <= 0) break;
    const chunk = section.length <= remaining ? section : `${section.slice(0, Math.max(0, remaining - 40))}\n[context truncated]`;
    selected.push(chunk);
    remaining -= chunk.length + 2;
  }
  return selected.join("\n\n");
}

function tokenize(value: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "bir", "ve", "ile", "için", "bu"]);
  return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])].filter((term) => !stop.has(term)).slice(0, 12);
}

function bullets(values: string[]): string {
  return values.length === 0 ? "- None" : values.map((value) => `- ${value}`).join("\n");
}
