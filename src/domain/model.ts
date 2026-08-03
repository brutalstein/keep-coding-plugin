export type ProjectStatus = "PLANNING" | "ACTIVE" | "BLOCKED" | "READY_TO_COMPLETE" | "COMPLETED";
export type PhaseStatus = "PENDING" | "READY" | "IN_PROGRESS" | "VERIFYING" | "FAILED" | "BLOCKED" | "COMPLETED";

export interface ProjectContract {
  goal: string;
  nonGoals: string[];
  constraints: string[];
  deliverables: string[];
  invariants: string[];
  doneWhen: string[];
}

export interface PhaseDefinition {
  id: string;
  title: string;
  goal: string;
  dependencies: string[];
  allowedScope: string[];
  acceptanceCommands: string[];
  maxAttempts: number;
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
  ruleId: string;
  file: string;
  line: number;
  fingerprint: string;
  preview: string;
}

export interface SecretScanEvidence {
  passed: boolean;
  scannedFiles: string[];
  findings: SecretFinding[];
}

export interface VerificationEvidence {
  passed: boolean;
  scopePassed: boolean;
  scopeViolations: string[];
  changedFiles: string[];
  secretScan: SecretScanEvidence;
  commands: CommandEvidence[];
  diffHash: string;
  gitSha: string;
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
  type: "imports" | "contains" | "implements" | "modifies" | "verified_by" | "depends_on" | "supersedes";
  metadata: Record<string, unknown>;
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
  checkpoints: CheckpointRecord[];
  recentEvents: EventRecord[];
}
