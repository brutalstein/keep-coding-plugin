import type { BudgetLimits, PhaseDefinition, ProjectContract } from "../domain/model.js";

export function validateContract(contract: ProjectContract): void {
  if (contract.goal.trim().length < 10) throw new Error("contract goal is too short");
  if (contract.deliverables.length === 0) throw new Error("contract requires deliverables");
  if (contract.doneWhen.length === 0) throw new Error("contract requires measurable done-when criteria");
  validateBudgetLimits(contract.budget, "contract budget");
  const threshold = contract.assumptionConfidenceThreshold;
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
    throw new Error("assumptionConfidenceThreshold must be in [0, 1]");
  }
}

export function validatePlan(phases: PhaseDefinition[]): void {
  if (phases.length === 0) throw new Error("plan requires at least one phase");
  const ids = new Set<string>();
  for (const phase of phases) {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(phase.id)) throw new Error(`invalid phase id: ${phase.id}`);
    if (ids.has(phase.id)) throw new Error(`duplicate phase id: ${phase.id}`);
    if (phase.acceptanceCommands.length === 0) throw new Error(`phase ${phase.id} requires verification commands`);
    if (phase.acceptanceCommands.some((command) => /^(?:true|echo\b|exit\s+0)$/i.test(command.trim()))) {
      throw new Error(`phase ${phase.id} contains a no-op verification command`);
    }
    validateBudgetLimits(phase.budget, `phase ${phase.id} budget`);
    if (phase.maxAttempts < 1 || phase.maxAttempts > 10) throw new Error(`phase ${phase.id} maxAttempts must be 1..10`);
    ids.add(phase.id);
  }
  for (const phase of phases) {
    for (const dependency of phase.dependencies) {
      if (!ids.has(dependency)) throw new Error(`phase ${phase.id} has unknown dependency ${dependency}`);
      if (dependency === phase.id) throw new Error(`phase ${phase.id} cannot depend on itself`);
    }
  }
  assertAcyclic(phases);
}

export function validateBudgetLimits(budget: BudgetLimits | undefined, label: string): void {
  if (!budget) return;
  for (const [name, value] of Object.entries(budget)) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`${label} ${name} must be positive`);
    }
  }
}

function assertAcyclic(phases: PhaseDefinition[]): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("phase dependency graph contains a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    const phase = byId.get(id);
    if (!phase) throw new Error(`missing phase ${id}`);
    for (const dependency of phase.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const phase of phases) visit(phase.id);
}
