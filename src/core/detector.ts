const PROJECT_SIGNALS: Array<{ pattern: RegExp; weight: number; reason: string }> = [
  { pattern: /\b(end[- ]to[- ]end|uçtan uca|full|complete|entire|whole|tüm|bütün)\b/iu, weight: 2, reason: "end-to-end scope" },
  { pattern: /\b(architecture|mimari|migration|refactor|production[- ]ready|github[- ]ready)\b/iu, weight: 2, reason: "architecture or production scope" },
  { pattern: /\b(test|tests|testler|ci|deploy|integration|entegrasyon|documentation|dokümantasyon)\b/iu, weight: 1, reason: "delivery disciplines" },
  { pattern: /\b(phase|phases|faz|fazlar|multi[- ]agent|parallel|paralel)\b/iu, weight: 2, reason: "multi-phase execution" },
  { pattern: /\b(build|create|implement|develop|kur|oluştur|geliştir|yap|ekle|tasarla)\b/iu, weight: 1, reason: "implementation action" }
];

export interface DetectionOptions { force?: boolean; threshold?: number }
export interface DetectionSignal { reason: string; weight: number }
export interface DetectionResult {
  activate: boolean;
  score: number;
  confidence: number;
  threshold: number;
  signals: DetectionSignal[];
  reasons: string[];
  manualOverride: boolean;
}

export function detectLargeProject(prompt: string, options: DetectionOptions = {}): DetectionResult {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  const threshold = options.threshold ?? 5;
  const signals: DetectionSignal[] = [];
  if (normalized.length >= 700) signals.push({ reason: "long specification", weight: 3 });
  else if (normalized.length >= 300) signals.push({ reason: "substantial specification", weight: 2 });
  else if (normalized.length >= 160) signals.push({ reason: "multi-sentence request", weight: 1 });
  const wordCount = normalized === "" ? 0 : normalized.split(" ").length;
  if (wordCount >= 120) signals.push({ reason: "many requirements", weight: 2 });
  else if (wordCount >= 60) signals.push({ reason: "several requirements", weight: 1 });
  for (const signal of PROJECT_SIGNALS) if (signal.pattern.test(normalized)) signals.push({ reason: signal.reason, weight: signal.weight });
  const listItems = (prompt.match(/(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/g) ?? []).length;
  if (listItems >= 5) signals.push({ reason: "large deliverable list", weight: 2 });
  else if (listItems >= 2) signals.push({ reason: "deliverable list", weight: 1 });
  const score = signals.reduce((total, signal) => total + signal.weight, 0);
  const manualOverride = options.force === true;
  return {
    activate: manualOverride || score >= threshold,
    score,
    confidence: manualOverride ? 1 : Math.min(0.99, score / (threshold + 3)),
    threshold,
    signals,
    reasons: signals.map((signal) => `${signal.reason} (+${signal.weight})`),
    manualOverride
  };
}
