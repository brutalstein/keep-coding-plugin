export type ProjectStatus = "PLANNING" | "ACTIVE" | "BLOCKED" | "READY_TO_COMPLETE" | "COMPLETED";
export type PhaseStatus =
  | "PENDING"
  | "READY"
  | "IN_PROGRESS"
  | "VERIFYING"
  | "FAILED"
  | "BLOCKED"
  | "BLOCKED_BUDGET"
  | "AWAITING_APPROVAL"
  | "NEEDS_REVERIFICATION"
  | "SUPERSEDED"
  | "COMPLETED";

export interface BudgetLimits {
  maxTokens?: number | undefined;
  maxCostUsd?: number | undefined;
  maxWallClockMs?: number | undefined;
}

export interface BudgetUsage {
  tokens?: number | undefined;
  costUsd?: number | undefined;
  wallClockMs?: number | undefined;
}

export interface ProjectContract {
  goal: string;
  nonGoals: string[];
  constraints: string[];
  deliverables: string[];
  invariants: string[];
  doneWhen: string[];
  budget?: BudgetLimits | undefined;
  criticGate?: "disabled" | "advisory" | "blocking" | undefined;
}

export interface PhaseDefinition {
  id: string;
  title: string;
  goal: string;
  dependencies: string[];
  allowedScope: string[];
  acceptanceCommands: string[];
  maxAttempts: number;
  budget?: BudgetLimits | undefined;
  requiresApproval?: boolean | undefined;
}

export interface PhaseRecord extends PhaseDefinition {
  ordinal: number;
  status: PhaseStatus;
  attempts: number;
  startedAt: string | null;
  completedAt: string | null;
  baseSha: string | null;
  headSha: string | null;
  summary: string | null;
  planVersion: number;
  supersededBy: string | null;
}

export interface ProjectRecord {
  id: string;
  root: string;
  originalPrompt: string;
  status: ProjectStatus;
  contract: ProjectContract | null;
  planVersion: number;
  currentPhaseId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanAmendment {
  reason: string;
  addPhases?: PhaseDefinition[] | undefined;
  supersedePhaseIds?: string[] | undefined;
}

export interface DecisionRecord {
  id: string;
  phaseId: string | null;
  title: string;
  rationale: string;
  alternatives: string[];
  status: "active" | "superseded";
  createdAt: string;
}

export interface FailureRecord {
  id: string;
  phaseId: string;
  fingerprint: string;
  summary: string;
  count: number;
  lastSeenAt: string;
  resolution: string | null;
}

export interface ApprovalRecord {
  id: string;
  phaseId: string;
  question: string;
  details: string;
  status: "pending" | "approved" | "rejected";
  response: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface CommandEvidence {
  command: string;
  exitCode: number | null;
  passed: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SecretFinding {
  file: string;
  line: number;
  rule: string;
  preview: string;
}

export interface CriticEvidence {
  configured: boolean;
  passed: boolean;
  blocking: boolean;
  summary: string;
  findings: string[];
}

export interface BudgetEvidence {
  limits: BudgetLimits;
  usage: BudgetUsage;
  passed: boolean;
  violations: string[];
}

export interface VerificationEvidence {
  passed: boolean;
  scopePassed: boolean;
  scopeViolations: string[];
  changedFiles: string[];
  commands: CommandEvidence[];
  selectiveCommands: CommandEvidence[];
  impactedTests: string[];
  secretScanPassed: boolean;
  secretFindings: SecretFinding[];
  budget: BudgetEvidence | null;
  critic: CriticEvidence | null;
  diffHash: string;
  gitSha: string;
  checkpointCommitSha: string | null;
}

export interface CheckpointRecord {
  id: string;
  phaseId: string;
  gitSha: string;
  summary: string;
  changedFiles: string[];
  verification: VerificationEvidence;
  createdAt: string;
}

export interface GraphNode {
  id: string;
  type: "file" | "symbol" | "requirement" | "phase" | "decision" | "test";
  label: string;
  path: string | null;
  symbol: string | null;
  contentHash: string | null;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  type:
    | "imports"
    | "contains"
    | "implements"
    | "modifies"
    | "verified_by"
    | "depends_on"
    | "supersedes"
    | "calls"
    | "references"
    | "impacts";
  metadata: Record<string, unknown>;
}

export interface ImpactResult {
  subject: string;
  files: string[];
  symbols: string[];
  tests: string[];
  phases: string[];
  explanation: string[];
}

export interface EventRecord {
  sequence: number;
  timestamp: string;
  type: string;
  phaseId: string | null;
  payload: Record<string, unknown>;
}

export interface ProjectSnapshot {
  project: ProjectRecord;
  phases: PhaseRecord[];
  decisions: DecisionRecord[];
  failures: FailureRecord[];
  approvals: ApprovalRecord[];
  checkpoints: CheckpointRecord[];
  recentEvents: EventRecord[];
}
