const PROJECT_SCALE_TERMS = [
  "end-to-end", "end to end", "uçtan uca", "full project", "complete project", "entire project", "whole project",
  "koca proje", "tüm proje", "bütün proje", "architecture", "mimari", "migration", "migrate", "refactor",
  "production-ready", "production ready", "github-ready", "githuba atmalık", "phases", "fazlar", "modular",
  "modüler", "tests", "testler", "deploy", "integration", "entegrasyon", "repository", "codebase"
];

const IMPLEMENTATION_TERMS = [
  "build", "create", "implement", "develop", "upgrade", "rewrite", "kur", "oluştur", "geliştir", "yap", "ekle", "tasarla"
];

const MULTI_AREA_TERMS = [
  "architecture", "api", "database", "storage", "frontend", "backend", "cli", "security", "testing", "documentation",
  "mimari", "veritabanı", "güvenlik", "test", "dokümantasyon"
];

export interface DetectionSignal {
  name: string;
  weight: number;
  evidence: string;
}

export interface DetectionResult {
  activate: boolean;
  score: number;
  confidence: number;
  reasons: string[];
  signals: DetectionSignal[];
  manualOverride: "activate" | "disable" | null;
}

export interface DetectionOptions {
  force?: boolean;
}

export function detectLargeProject(prompt: string, options: DetectionOptions = {}): DetectionResult {
  const normalized = prompt.toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();
  const words = normalized.length === 0 ? [] : normalized.split(" ");
  const signals: DetectionSignal[] = [];

  if (normalized.length >= 1_200) add(signals, "specification_length", 3, `${normalized.length} characters`);
  else if (normalized.length >= 500) add(signals, "specification_length", 2, `${normalized.length} characters`);
  else if (normalized.length >= 180) add(signals, "specification_length", 1, `${normalized.length} characters`);

  if (words.length >= 180) add(signals, "requirement_density", 2, `${words.length} words`);
  else if (words.length >= 70) add(signals, "requirement_density", 1, `${words.length} words`);

  const projectTerms = PROJECT_SCALE_TERMS.filter((term) => normalized.includes(term));
  if (projectTerms.length >= 4) add(signals, "project_scale_language", 3, projectTerms.slice(0, 6).join(", "));
  else if (projectTerms.length >= 1) add(signals, "project_scale_language", 2, projectTerms.slice(0, 3).join(", "));

  const actions = IMPLEMENTATION_TERMS.filter((term) => wordContains(normalized, term));
  if (actions.length >= 3) add(signals, "implementation_actions", 2, actions.slice(0, 5).join(", "));
  else if (actions.length >= 1) add(signals, "implementation_actions", 1, actions.join(", "));

  const areas = MULTI_AREA_TERMS.filter((term) => wordContains(normalized, term));
  if (areas.length >= 4) add(signals, "cross_cutting_scope", 2, areas.slice(0, 6).join(", "));
  else if (areas.length >= 2) add(signals, "cross_cutting_scope", 1, areas.join(", "));

  const listItems = (prompt.match(/(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/g) ?? []).length;
  if (listItems >= 8) add(signals, "deliverable_list", 2, `${listItems} items`);
  else if (listItems >= 2) add(signals, "deliverable_list", 1, `${listItems} items`);

  const fileReferences = new Set(prompt.match(/(?:^|\s)[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|cpp|md|json|ya?ml)(?=\s|$|[,;:)])/gi) ?? []);
  if (fileReferences.size >= 5) add(signals, "multi_file_scope", 2, `${fileReferences.size} files referenced`);
  else if (fileReferences.size >= 2) add(signals, "multi_file_scope", 1, `${fileReferences.size} files referenced`);

  const rawScore = signals.reduce((total, signal) => total + signal.weight, 0);
  const confidence = clamp(1 - Math.exp(-rawScore / 5.5), 0, 0.99);
  const environmentOverride = process.env.KEEP_CODING_ACTIVATE === "1"
    ? "activate"
    : process.env.KEEP_CODING_DISABLE === "1"
      ? "disable"
      : null;
  const manualOverride = options.force === true ? "activate" : options.force === false ? "disable" : environmentOverride;
  const activate = manualOverride === "activate" || (manualOverride !== "disable" && confidence >= 0.52);
  const reasons = signals.map((signal) => `${signal.name}: ${signal.evidence}`);
  if (manualOverride) reasons.unshift(`manual override: ${manualOverride}`);

  return { activate, score: rawScore, confidence, reasons, signals, manualOverride };
}

function add(signals: DetectionSignal[], name: string, weight: number, evidence: string): void {
  signals.push({ name, weight, evidence });
}

function wordContains(value: string, term: string): boolean {
  return new RegExp(`(^|[^\\p{L}])${escapeRegExp(term)}([^\\p{L}]|$)`, "u").test(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
