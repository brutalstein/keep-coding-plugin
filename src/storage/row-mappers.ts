import type {
  AssumptionAlternative, AssumptionRecord, AssumptionStatus, BlastRadius, CheckpointRecord, CorrectionRecord,
  CorrectionScopeExpansion, DecisionRecord, EventRecord, FailureRecord, GraphEdge, GraphNode, PhaseRecord,
  PhaseStatus, ProjectContract, ProjectRecord, ProjectStatus, VerificationEvidence
} from "../domain/model.js";

export type DatabaseRow = Record<string, unknown>;

export function projectFromRow(row: DatabaseRow): ProjectRecord {
  return {
    id: text(row.id), root: text(row.root), originalPrompt: text(row.original_prompt),
    status: text(row.status) as ProjectStatus,
    contract: row.contract_json ? JSON.parse(text(row.contract_json)) as ProjectContract : null,
    planVersion: Number(row.plan_version), currentPhaseId: nullableText(row.current_phase_id),
    createdAt: text(row.created_at), updatedAt: text(row.updated_at)
  };
}

export function phaseFromRow(row: DatabaseRow): PhaseRecord {
  return {
    id: text(row.id), ordinal: Number(row.ordinal), title: text(row.title), goal: text(row.goal),
    status: text(row.status) as PhaseStatus,
    dependencies: JSON.parse(text(row.dependencies_json)) as string[],
    allowedScope: JSON.parse(text(row.allowed_scope_json)) as string[],
    acceptanceCommands: JSON.parse(text(row.acceptance_commands_json)) as string[],
    maxAttempts: Number(row.max_attempts), attempts: Number(row.attempts),
    startedAt: nullableText(row.started_at), completedAt: nullableText(row.completed_at), baseSha: nullableText(row.base_sha),
    headSha: nullableText(row.head_sha), summary: nullableText(row.summary)
  };
}

export function decisionFromRow(row: DatabaseRow): DecisionRecord {
  return {
    id: text(row.id), phaseId: nullableText(row.phase_id), title: text(row.title), rationale: text(row.rationale),
    alternatives: JSON.parse(text(row.alternatives_json)) as string[], status: text(row.status) as "active" | "superseded",
    createdAt: text(row.created_at)
  };
}

export function failureFromRow(row: DatabaseRow): FailureRecord {
  return {
    id: text(row.id), phaseId: text(row.phase_id), fingerprint: text(row.fingerprint), summary: text(row.summary),
    count: Number(row.count), lastSeenAt: text(row.last_seen_at), resolution: nullableText(row.resolution)
  };
}

export function assumptionFromRow(row: DatabaseRow): AssumptionRecord {
  const alternatives = JSON.parse(text(row.alternatives_json)) as unknown;
  if (!Array.isArray(alternatives)) throw new Error("INVALID_ALTERNATIVES: stored alternatives must be an array");
  return {
    id: text(row.id), phaseId: nullableText(row.phase_id), statement: text(row.statement), confidence: Number(row.confidence),
    alternatives: alternatives as AssumptionAlternative[], status: text(row.status) as AssumptionStatus,
    createdAt: text(row.created_at), resolvedAt: nullableText(row.resolved_at), resolutionEvidence: nullableText(row.resolution_evidence),
    explicitLinkedAt: nullableText(row.explicit_linked_at)
  };
}

export function correctionFromRow(row: DatabaseRow): CorrectionRecord {
  return {
    id: text(row.id), assumptionId: text(row.assumption_id), phaseId: nullableText(row.phase_id), rootCause: text(row.root_cause),
    blastRadius: JSON.parse(text(row.blast_radius_json)) as BlastRadius, blastRadiusSize: Number(row.blast_radius_size),
    appliedAt: text(row.applied_at), outcome: row.outcome ? text(row.outcome) as "contained" | "expanded" : null,
    expansions: JSON.parse(text(row.expansions_json ?? "[]")) as CorrectionScopeExpansion[], completedAt: nullableText(row.completed_at),
    tokenStart: Number(row.token_start ?? 0), tokenEnd: row.token_end === null || row.token_end === undefined ? null : Number(row.token_end)
  };
}

export function checkpointFromRow(row: DatabaseRow): CheckpointRecord {
  return {
    id: text(row.id), phaseId: text(row.phase_id), gitSha: text(row.git_sha), summary: text(row.summary),
    changedFiles: JSON.parse(text(row.changed_files_json)) as string[],
    verification: JSON.parse(text(row.verification_json)) as VerificationEvidence,
    createdAt: text(row.created_at)
  };
}

export function eventFromRow(row: DatabaseRow): EventRecord {
  return {
    sequence: Number(row.sequence), timestamp: text(row.timestamp), type: text(row.type),
    phaseId: nullableText(row.phase_id), payload: JSON.parse(text(row.payload_json)) as Record<string, unknown>
  };
}

export function graphEdgeFromRow(row: DatabaseRow): GraphEdge {
  return {
    sourceId: text(row.source_id), targetId: text(row.target_id), type: text(row.type) as GraphEdge["type"],
    metadata: JSON.parse(text(row.metadata_json)) as Record<string, unknown>
  };
}

export function graphNodeFromRow(row: DatabaseRow): GraphNode {
  return {
    id: text(row.id), type: text(row.type) as GraphNode["type"], label: text(row.label), path: nullableText(row.path),
    symbol: nullableText(row.symbol), contentHash: nullableText(row.content_hash),
    metadata: JSON.parse(text(row.metadata_json)) as Record<string, unknown>
  };
}

export function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

export function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return `${value}`;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  throw new Error("database returned a non-scalar value");
}
