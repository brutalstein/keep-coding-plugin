import { createHash } from "node:crypto";

export function normalizeDiagnosticText(value: string): string {
  return value.toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/giu, "<timestamp>")
    .replace(/(?:[a-z]:\\|\/)(?:[^\s:]+[\\/])+[^\s:]+/giu, "<path>")
    .replace(/:\d+(?::\d+)?\b/gu, ":<line>")
    .replace(/0x[0-9a-f]+/giu, "<hex>")
    .replace(/\b\d+\b/gu, "<n>")
    .replace(/\s+/gu, " ").trim();
}

export function normalizedDiagnosticSignature(value: string, length = 24): string {
  return createHash("sha256").update(normalizeDiagnosticText(value)).digest("hex").slice(0, length);
}
