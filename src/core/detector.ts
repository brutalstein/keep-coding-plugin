const LARGE_PROJECT_TERMS = [
  "end-to-end",
  "end to end",
  "uçtan uca",
  "full project",
  "complete project",
  "entire project",
  "whole project",
  "koca proje",
  "tüm proje",
  "bütün proje",
  "architecture",
  "mimari",
  "migration",
  "migrate",
  "refactor",
  "production-ready",
  "production ready",
  "github-ready",
  "githuba atmalık",
  "phases",
  "fazlar",
  "modular",
  "modüler",
  "tests",
  "testler",
  "deploy",
  "integration",
  "entegrasyon"
];

const IMPLEMENTATION_TERMS = [
  "build",
  "create",
  "implement",
  "develop",
  "kur",
  "oluştur",
  "geliştir",
  "yap",
  "ekle",
  "tasarla"
];

export interface DetectionResult {
  activate: boolean;
  score: number;
  reasons: string[];
}

export function detectLargeProject(prompt: string): DetectionResult {
  const normalized = prompt.toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();
  const words = normalized.length === 0 ? [] : normalized.split(" ");
  const reasons: string[] = [];
  let score = 0;

  if (normalized.length >= 700) {
    score += 3;
    reasons.push("long specification");
  } else if (normalized.length >= 300) {
    score += 2;
    reasons.push("substantial specification");
  } else if (normalized.length >= 160) {
    score += 1;
    reasons.push("multi-sentence request");
  }

  if (words.length >= 120) {
    score += 2;
    reasons.push("many requirements");
  } else if (words.length >= 60) {
    score += 1;
    reasons.push("several requirements");
  }

  const projectTerms = LARGE_PROJECT_TERMS.filter((term) => normalized.includes(term));
  if (projectTerms.length >= 3) {
    score += 3;
    reasons.push("multiple project-scale signals");
  } else if (projectTerms.length >= 1) {
    score += 2;
    reasons.push(`project signal: ${projectTerms[0]}`);
  }

  const actionCount = IMPLEMENTATION_TERMS.filter((term) => new RegExp(`(^|[^\\p{L}])${escapeRegExp(term)}([^\\p{L}]|$)`, "u").test(normalized)).length;
  if (actionCount >= 2) {
    score += 1;
    reasons.push("multiple implementation actions");
  }

  const listItems = (prompt.match(/(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/g) ?? []).length;
  if (listItems >= 5) {
    score += 2;
    reasons.push("large deliverable list");
  } else if (listItems >= 2) {
    score += 1;
    reasons.push("deliverable list");
  }

  return { activate: score >= 4, score, reasons };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
