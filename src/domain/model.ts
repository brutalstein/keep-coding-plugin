export type ProjectStatus =
  | "PLANNING"
  | "ACTIVE"
  | "AWAITING_APPROVAL"
  | "BLOCKED_BUDGET"
  | "BLOCKED"
  | "READY_TO_COMPLETE"
  | "COMPLETED";

export type PhaseStatus =
  | "PENDING"
  | "READY"
  | "IN_PROGRESS"
  | "VERIFYING"
  | "AWAITING_APPROVAL"
  | "REVERIFY_REQUIRED"
  | "FAILED"
  | "BLOCKED_BUDGET"
  | "BLOCKED"
  | "COMPLETED"
  | "SUPERSEDED";

export interface BudgetLimits {
  maxTokens?: number | undefined;
  maxCostUsd?: number | undefined;
  maxWallClockMs?: number | undefined;
}
export interface BudgetUsage { tokens: number; costUsd: number; wallClockMs: number; updatedAt: string }
export interface BudgetEvidence { passed: boolean; limits: BudgetLimits; usage: BudgetUsage; violations: string[] }
export interface CriticPolicy { enabled: boolean; blocking: boolean }
export interface SelectiveTestPolicy { commandTemplate: string; fullSuiteCommands: string[] }

export interface ProjectContract {
  goal: string;
  nonGoals: string[];
  constraints: string[];
  deliverables: string[];
  invariants: string[];
  doneWhen: string[];
  budget?: BudgetLimits | undefined;
  critic?: CriticPolicy | undefined;
  selectiveTests?: SelectiveTestPolicy | undefined;
  playbookOptIn?: boolean | undefined;
}

export type ProjectContractPatch = {
  [Key in keyof ProjectContract]?: ProjectContract[Key] | undefined;
};

export interface PhaseDefinition {
  id: string;
  title: string;
  goal: string;
  dependencies: string[];
  allowedScope: string[];
  acceptanceCommands: string[];
  maxAttempts: number;
  budget?: BudgetLimits | undefined;
  criticBlocking?: boolean | undefined;
  requiresApproval?: boolean | undefined;
  approvalPrompt?: string | undefined;
  parallelSafe?: boolean | undefined;
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
  revision?: number | undefined;
  supersededBy?: string | null | undefined;
  approvedAt?: string | null | undefined;
  reverifyReason?: string | null | undefined;
}

export interface PlanAmendment {
  reason: string;
  addPhases: PhaseDefinition[];
  supersedePhaseIds: string[];
  contractPatch?: ProjectContractPatch | undefined;
}
export interface PlanRevisionRecord { version: number; contract: ProjectContract; amendment: PlanAmendment | null; createdAt: string }

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

export interface DecisionRecord { id: string; phaseId: string | null; title: string; rationale: string; alternatives: string[]; status: "active" | "superseded"; createdAt: string }
export interface FailureRecord { id: string; phaseId: string; fingerprint: string; summary: string; count: number; lastSeenAt: string; resolution: string | null }
export interface ApprovalRecord { id: string; phaseId: string; prompt: string; status: "pending" | "approved" | "rejected"; requestedAt: string; resolvedAt: string | null; resolutionNote: string | null }

export interface CommandEvidence { command: string; exitCode: number | null; passed: boolean; durationMs: number; stdout: string; stderr: string; timedOut: boolean }
export interface SecretFinding { ruleId: string; file: string; line: number; fingerprint: string; preview: string }
export interface SecretScanEvidence { passed: boolean; scannedFiles: string[]; findings: SecretFinding[] }
export interface CriticFinding { severity: "info" | "warning" | "error"; rule: string; message: string; file?: string | undefined }
export interface CriticEvidence { configured: boolean; blocking: boolean; passed: boolean; summary: string; findings: CriticFinding[]; rawOutput: string }

export interface VerificationEvidence {
  passed: boolean;
  scopePassed: boolean;
  scopeViolations: string[];
  changedFiles: string[];
  secretScan: SecretScanEvidence;
  budget: BudgetEvidence;
  selectiveCommands: CommandEvidence[];
  commands: CommandEvidence[];
  critic: CriticEvidence;
  impactedCompletedPhases: string[];
  diffHash: string;
  gitSha: string;
}

export interface CheckpointRecord { id: string; phaseId: string; gitSha: string; summary: string; changedFiles: string[]; verification: VerificationEvidence; createdAt: string }
export interface WorktreeRecord { phaseId: string; path: string; branch: string; status: "prepared" | "active" | "merged" | "failed"; baseSha: string; createdAt: string }

export interface GraphNode {
  id: string;
  type: "file" | "symbol" | "requirement" | "phase" | "decision" | "test" | "module";
  label: string;
  path: string | null;
  symbol: string | null;
  contentHash: string | null;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  type: "imports" | "contains" | "calls" | "references" | "tested_by" | "implements" | "modifies" | "verified_by" | "depends_on" | "supersedes";
  metadata: Record<string, unknown>;
}

export interface ImpactNode { node: GraphNode; distance: number; via: GraphEdge["type"] | null }
export interface EventRecord { sequence: number; timestamp: string; type: string; phaseId: string | null; payload: Record<string, unknown> }

export interface ProjectSnapshot {
  project: ProjectRecord;
  phases: PhaseRecord[];
  decisions: DecisionRecord[];
  failures: FailureRecord[];
  approvals?: ApprovalRecord[] | undefined;
  checkpoints: CheckpointRecord[];
  planRevisions?: PlanRevisionRecord[] | undefined;
  worktrees?: WorktreeRecord[] | undefined;
  budgetUsage?: Record<string, BudgetUsage> | undefined;
  recentEvents: EventRecord[];
}
