import type {
  ContextEnvelope, ContextSection, EventRecord, GraphNode, PlaybookPattern, ProjectSnapshot
} from "../domain/model.js";

const DEFAULT_MAX_CHARS = 12_000;
const ALL_SECTIONS: ContextSection[] = [
  "header", "contract", "active_phase", "approvals", "budget", "decisions", "failures", "checkpoints", "graph", "playbook"
];

export interface ContextStore {
  snapshot(): ProjectSnapshot;
  searchGraph(terms: string[], limit: number): GraphNode[];
  latestEventSequence(): number;
  eventsSince(sequence: number): EventRecord[];
}

export interface ContextCompileOptions {
  maxChars?: number;
  sinceSequence?: number;
  playbook?: PlaybookPattern[];
}

export function compileContext(store: ContextStore, maxChars = DEFAULT_MAX_CHARS): string {
  return compileContextEnvelope(store, { maxChars }).context ?? "";
}

export function compileContextEnvelope(store: ContextStore, options: ContextCompileOptions = {}): ContextEnvelope {
  const sequence = store.latestEventSequence();
  const since = options.sinceSequence;
  if (since !== undefined && since >= sequence) {
    return { unchanged: true, sequence, changedSections: [], unchangedSections: ALL_SECTIONS, estimatedTokens: 0 };
  }

  const snapshot = store.snapshot();
  const active = snapshot.project.currentPhaseId
    ? snapshot.phases.find((phase) => phase.id === snapshot.project.currentPhaseId) ?? null
    : null;
  const terms = tokenize([active?.title, active?.goal, ...(active?.allowedScope ?? [])].filter(Boolean).join(" "));
  const related = store.searchGraph(terms, 200);
  const changedSections = since === undefined
    ? [...ALL_SECTIONS]
    : changedSectionsFromEvents(store.eventsSince(since));
  const effectiveChanged = changedSections.length === 0 ? ["header" as const] : changedSections;
  const sectionValues = new Map<ContextSection, string>([
    ["header", header(snapshot)],
    ["contract", contractSection(snapshot)],
    ["active_phase", phaseSection(snapshot)],
    ["approvals", approvalSection(snapshot)],
    ["budget", budgetSection(snapshot)],
    ["decisions", decisionSection(snapshot)],
    ["failures", failureSection(snapshot)],
    ["checkpoints", checkpointSection(snapshot)],
    ["graph", graphSummarySection(related)],
    ["playbook", playbookSection(options.playbook ?? [])]
  ]);
  const rendered = effectiveChanged.map((section) => sectionValues.get(section) ?? "").filter(Boolean);
  const unchangedSections = ALL_SECTIONS.filter((section) => !effectiveChanged.includes(section));
  if (since !== undefined && unchangedSections.length > 0) {
    rendered.push(`Unchanged since sequence ${since}: ${unchangedSections.join(", ")}.`);
  }
  const context = fitSections(rendered, options.maxChars ?? DEFAULT_MAX_CHARS);
  return {
    unchanged: false,
    sequence,
    context,
    changedSections: effectiveChanged,
    unchangedSections,
    estimatedTokens: estimateTokens(context)
  };
}

function changedSectionsFromEvents(events: EventRecord[]): ContextSection[] {
  const sections = new Set<ContextSection>();
  for (const event of events) {
    const type = event.type;
    if (/^(project_initialized|plan_saved|plan_amended)$/u.test(type)) {
      sections.add("header"); sections.add("contract"); sections.add("active_phase");
    }
    if (/^(phase_|project_completion|project_completed|approval_)/u.test(type)) {
      sections.add("header"); sections.add("active_phase");
    }
    if (/^approval_/u.test(type)) sections.add("approvals");
    if (/^(budget_|plugin_token_)/u.test(type)) sections.add("budget");
    if (/^decision_/u.test(type)) sections.add("decisions");
    if (/^failure_/u.test(type)) sections.add("failures");
    if (/^(phase_completed|phase_verification|project_completion_gate)/u.test(type)) sections.add("checkpoints");
    if (/^(repository_indexed|phase_completed|phase_reverification)/u.test(type)) sections.add("graph");
    if (/^playbook_/u.test(type)) sections.add("playbook");
  }
  return ALL_SECTIONS.filter((section) => sections.has(section));
}

function header(snapshot: ProjectSnapshot): string {
  return [
    "# KEEP CODING ACTIVE",
    "Use the evidence-gated workflow. Never claim completion without passing deterministic evidence.",
    `Project root: ${snapshot.project.root}`,
    `Project status: ${snapshot.project.status}`,
    `Plan version: ${snapshot.project.planVersion}`
  ].join("\n");
}

function contractSection(snapshot: ProjectSnapshot): string {
  const contract = snapshot.project.contract;
  if (!contract) return "## Required next action\nInspect the repository, then call `save_plan`.";
  return [
    "## Project contract", `Goal: ${contract.goal}`,
    `Deliverables:\n${bullets(contract.deliverables)}`,
    `Constraints:\n${bullets(contract.constraints)}`,
    `Invariants:\n${bullets(contract.invariants)}`,
    `Done when:\n${bullets(contract.doneWhen)}`
  ].join("\n");
}

function phaseSection(snapshot: ProjectSnapshot): string {
  const active = snapshot.project.currentPhaseId
    ? snapshot.phases.find((phase) => phase.id === snapshot.project.currentPhaseId)
    : null;
  if (!active) return `## Phase status\n${snapshot.phases.map((phase) => `- ${phase.id}: ${phase.status}`).join("\n") || "Plan not saved."}`;
  return [
    "## Active phase", `${active.id} — ${active.title} [${active.status}]`, `Goal: ${active.goal}`,
    `Allowed scope:\n${bullets(active.allowedScope)}`,
    `Acceptance commands:\n${bullets(active.acceptanceCommands)}`,
    `Attempts: ${active.attempts}/${active.maxAttempts}`,
    active.reverifyReason ? `Reverification reason: ${active.reverifyReason}` : "",
    "Implement, checkpoint, repair failures, and continue without weakening gates."
  ].filter(Boolean).join("\n");
}

function approvalSection(snapshot: ProjectSnapshot): string {
  const pending = (snapshot.approvals ?? []).filter((item) => item.status === "pending");
  return pending.length === 0 ? "" : `## Pending human approvals\n${pending.map((item) => `- ${item.id} [${item.phaseId}]: ${item.prompt}`).join("\n")}`;
}

function budgetSection(snapshot: ProjectSnapshot): string {
  const entries = Object.entries(snapshot.budgetUsage ?? {});
  const lines = entries.map(([scope, usage]) => {
    const estimated = usage.estimatedTokens ? ` (${usage.estimatedTokens} estimated plugin tokens)` : "";
    return `- ${scope}: ${usage.tokens} tokens${estimated}, $${usage.costUsd.toFixed(4)}, ${usage.wallClockMs} ms`;
  });
  const maximum = snapshot.project.contract?.budget?.maxTokens;
  const projectUsage = snapshot.budgetUsage?.[`project:${snapshot.project.id}`];
  if (maximum && projectUsage) {
    const percentage = Math.floor((projectUsage.tokens / maximum) * 100);
    if (percentage >= 90) lines.unshift(`Budget ${percentage}% used — use delta context, minimal diffs, file digests, and avoid rereading unchanged files.`);
    else if (percentage >= 70) lines.unshift(`Budget ${percentage}% used — prefer get_file_digest and expand_graph over broad file or graph reads.`);
  }
  return lines.length === 0 ? "" : `## Budget usage\n${lines.join("\n")}`;
}

function decisionSection(snapshot: ProjectSnapshot): string {
  const decisions = snapshot.decisions.filter((decision) => decision.status === "active").slice(-12);
  return decisions.length === 0 ? "" : `## Active decisions\n${decisions.map((decision) => `- ${decision.title}: ${decision.rationale}`).join("\n")}`;
}

function failureSection(snapshot: ProjectSnapshot): string {
  const unresolved = snapshot.failures.filter((failure) => failure.resolution === null);
  const failures = [...unresolved].sort((left, right) => right.count - left.count || right.lastSeenAt.localeCompare(left.lastSeenAt)).slice(0, 5);
  if (failures.length === 0) return "";
  const suppressed = unresolved.length - failures.length;
  return `## Unresolved failure memory\n${failures.map((failure) => `- [${failure.phaseId}] x${failure.count} ${failure.summary}`).join("\n")}${suppressed > 0 ? `\n+${suppressed} similar failures suppressed (see get_status for the complete list).` : ""}`;
}

function checkpointSection(snapshot: ProjectSnapshot): string {
  const checkpoints = snapshot.checkpoints.slice(-5);
  return checkpoints.length === 0 ? "" : `## Recent verified checkpoints\n${checkpoints.map((checkpoint) => `- ${checkpoint.phaseId} @ ${checkpoint.gitSha.slice(0, 12)}: ${checkpoint.summary}`).join("\n")}`;
}

function graphSummarySection(nodes: GraphNode[]): string {
  if (nodes.length === 0) return "";
  const files = new Set(nodes.map((node) => node.path).filter((value): value is string => Boolean(value)));
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  const groups = [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5).map(([type, count]) => `${count} ${type}`).join(", ");
  return [
    "## Semantic graph — Tier 0",
    `${nodes.length} relevant nodes across ${files.size} files: ${groups}.`,
    "Use `expand_graph` only when exact node, import, call, or reference detail is needed."
  ].join("\n");
}

function playbookSection(patterns: PlaybookPattern[]): string {
  if (patterns.length === 0) return "";
  return `## Relevant playbook patterns\n${patterns.slice(0, 3).map((entry) => `- ${entry.pattern}: ${entry.resolution.join("; ")} [scope: ${entry.applicabilityScope.join(", ")}]`).join("\n")}`;
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

export function tokenize(value: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "bir", "ve", "ile", "için", "bu"]);
  return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])].filter((term) => !stop.has(term)).slice(0, 20);
}
export function estimateTokens(value: string): number { return Math.ceil(value.length / 4); }
function bullets(values: string[]): string { return values.length === 0 ? "- None" : values.map((value) => `- ${value}`).join("\n"); }
