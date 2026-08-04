import type { CommandQualityWarning, PhaseDefinition, ProjectContract } from "../domain/model.js";

const VERIFICATION_CATEGORIES: Array<{ name: string; pattern: RegExp }> = [
  { name: "test", pattern: /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\b(?:pytest|vitest|jest|mocha|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)\b/iu },
  { name: "lint", pattern: /\b(?:eslint|ruff|pylint|flake8|golangci-lint|clippy|shellcheck|stylelint|lint)\b/iu },
  { name: "typecheck", pattern: /\b(?:tsc|mypy|pyright|typecheck|cargo\s+check|go\s+vet)\b/iu },
  { name: "build", pattern: /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b|\b(?:cargo\s+build|go\s+build|dotnet\s+build|mvn\s+package|gradle\s+build|cmake\s+--build|make)\b/iu },
  { name: "syntax", pattern: /\b(?:node|python|ruby)\s+--?check\b|\bgit\s+diff\s+--check\b/iu }
];

export function lintAcceptanceCommands(phases: PhaseDefinition[], contract?: ProjectContract | null): CommandQualityWarning[] {
  const warnings: CommandQualityWarning[] = [];
  const owners = new Map<string, string[]>();
  for (const phase of phases) {
    const normalized = phase.acceptanceCommands.map(normalizeCommand);
    for (const command of normalized) owners.set(command, [...(owners.get(command) ?? []), phase.id]);
    if (phase.verificationKind !== "non-code" && !phase.acceptanceCommands.some(recognizedVerification)) {
      warnings.push({
        phaseId: phase.id,
        code: "weak-verification-category",
        message: `Phase ${phase.id} has no recognizable test, lint, type-check, build, or syntax verification command.`,
        commands: phase.acceptanceCommands
      });
      if (contract?.critic?.blocking !== true && phase.criticBlocking !== true) {
        warnings.push({
          phaseId: phase.id,
          code: "critic-recommended",
          message: `Enable a blocking independent critic for phase ${phase.id} while deterministic acceptance evidence remains weak.`,
          commands: phase.acceptanceCommands
        });
      }
    }
  }
  for (const [command, phaseIds] of owners) {
    const unique = [...new Set(phaseIds)];
    if (unique.length < 2) continue;
    for (const phaseId of unique) {
      warnings.push({
        phaseId,
        code: "duplicate-verification-command",
        message: `The same acceptance command is reused by unrelated phases: ${unique.join(", ")}. Confirm that it validates each phase's deliverable.`,
        commands: [command]
      });
    }
  }
  return dedupeWarnings(warnings);
}

export function recognizedVerification(command: string): boolean {
  return VERIFICATION_CATEGORIES.some((category) => category.pattern.test(command));
}

function normalizeCommand(value: string): string { return value.trim().replace(/\s+/g, " ").toLowerCase(); }
function dedupeWarnings(values: CommandQualityWarning[]): CommandQualityWarning[] {
  return [...new Map(values.map((warning) => [`${warning.phaseId}:${warning.code}:${warning.commands.join("|")}`, warning])).values()];
}
