export interface PairedOutcome { baseline: boolean; keepCoding: boolean }

export interface EvaluationStatistics {
  runs: number;
  baselineSuccesses: number;
  keepCodingSuccesses: number;
  baselineRate: number;
  keepCodingRate: number;
  absoluteDelta: number;
  discordant: { baselineOnly: number; keepCodingOnly: number };
  mcnemarExactP: number;
  baselineWilson95: [number, number];
  keepCodingWilson95: [number, number];
}

export function summarizeOutcomes(outcomes: PairedOutcome[]): EvaluationStatistics {
  if (outcomes.length === 0) throw new Error("at least one paired outcome is required");
  const baselineSuccesses = outcomes.filter((item) => item.baseline).length;
  const keepCodingSuccesses = outcomes.filter((item) => item.keepCoding).length;
  const baselineOnly = outcomes.filter((item) => item.baseline && !item.keepCoding).length;
  const keepCodingOnly = outcomes.filter((item) => !item.baseline && item.keepCoding).length;
  const runs = outcomes.length;
  return {
    runs,
    baselineSuccesses,
    keepCodingSuccesses,
    baselineRate: baselineSuccesses / runs,
    keepCodingRate: keepCodingSuccesses / runs,
    absoluteDelta: (keepCodingSuccesses - baselineSuccesses) / runs,
    discordant: { baselineOnly, keepCodingOnly },
    mcnemarExactP: exactMcNemar(baselineOnly, keepCodingOnly),
    baselineWilson95: wilson95(baselineSuccesses, runs),
    keepCodingWilson95: wilson95(keepCodingSuccesses, runs)
  };
}

export function wilson95(successes: number, total: number): [number, number] {
  if (total <= 0 || successes < 0 || successes > total) throw new Error("invalid binomial counts");
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total) / denominator;
  return [successes === 0 ? 0 : Math.max(0, center - margin), successes === total ? 1 : Math.min(1, center + margin)];
}

export function exactMcNemar(baselineOnly: number, keepCodingOnly: number): number {
  const discordant = baselineOnly + keepCodingOnly;
  if (discordant === 0) return 1;
  const tail = Math.min(baselineOnly, keepCodingOnly);
  let probability = 0;
  for (let k = 0; k <= tail; k += 1) probability += combination(discordant, k) * Math.pow(0.5, discordant);
  return Math.min(1, 2 * probability);
}

function combination(n: number, k: number): number {
  const smaller = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= smaller; index += 1) result = result * (n - smaller + index) / index;
  return result;
}


export interface AssumptionCorrectionMetricInput {
  outcome: "contained" | "expanded" | null;
  tokenStart: number;
  tokenEnd: number | null;
}

export interface AssumptionLedgerMetricInput {
  corrections: AssumptionCorrectionMetricInput[];
  antiPatternHits: number;
  matchingSituations: number;
}

export interface AssumptionLedgerMetrics {
  completedCorrections: number;
  containedCorrections: number;
  expandedCorrections: number;
  containmentRate: number;
  containmentWilson95: [number, number];
  totalCorrectionTokens: number;
  tokensPerCorrection: number;
  antiPatternHits: number;
  matchingSituations: number;
  antiPatternHitRate: number;
}

export function summarizeAssumptionLedger(input: AssumptionLedgerMetricInput): AssumptionLedgerMetrics {
  if (!Number.isInteger(input.antiPatternHits) || input.antiPatternHits < 0) throw new Error("anti-pattern hits must be a non-negative integer");
  if (!Number.isInteger(input.matchingSituations) || input.matchingSituations < 0 || input.antiPatternHits > input.matchingSituations) {
    throw new Error("invalid anti-pattern hit counts");
  }
  const completed = input.corrections.filter((correction) => correction.outcome !== null && correction.tokenEnd !== null);
  const containedCorrections = completed.filter((correction) => correction.outcome === "contained").length;
  const expandedCorrections = completed.filter((correction) => correction.outcome === "expanded").length;
  const totalCorrectionTokens = completed.reduce((sum, correction) => {
    const end = correction.tokenEnd ?? correction.tokenStart;
    if (!Number.isFinite(correction.tokenStart) || !Number.isFinite(end) || correction.tokenStart < 0 || end < correction.tokenStart) {
      throw new Error("invalid correction token counters");
    }
    return sum + (end - correction.tokenStart);
  }, 0);
  const completedCorrections = completed.length;
  return {
    completedCorrections,
    containedCorrections,
    expandedCorrections,
    containmentRate: completedCorrections === 0 ? 0 : containedCorrections / completedCorrections,
    containmentWilson95: completedCorrections === 0 ? [0, 0] : wilson95(containedCorrections, completedCorrections),
    totalCorrectionTokens,
    tokensPerCorrection: completedCorrections === 0 ? 0 : totalCorrectionTokens / completedCorrections,
    antiPatternHits: input.antiPatternHits,
    matchingSituations: input.matchingSituations,
    antiPatternHitRate: input.matchingSituations === 0 ? 0 : input.antiPatternHits / input.matchingSituations
  };
}
