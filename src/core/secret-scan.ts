import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SecretFinding, SecretScanEvidence } from "../domain/model.js";

interface SecretRule {
  id: string;
  pattern: RegExp;
}

const RULES: SecretRule[] = [
  { id: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { id: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g },
  { id: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,255}\b/g },
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/g },
  { id: "generic-secret-assignment", pattern: /\b(?:api[_-]?key|secret|token|password|passwd|pwd)\b\s*[:=]\s*["']?([A-Za-z0-9+/_=-]{20,})["']?/gi }
];

const TEXT_SIZE_LIMIT = 2 * 1024 * 1024;
const ENTROPY_THRESHOLD = 4.3;
const MIN_ENTROPY_TOKEN_LENGTH = 32;
const MAX_FINDINGS = 100;

export async function scanChangedFiles(root: string, changedFiles: string[]): Promise<SecretScanEvidence> {
  const findings: SecretFinding[] = [];
  const scannedFiles: string[] = [];

  for (const file of changedFiles) {
    if (findings.length >= MAX_FINDINGS) break;
    const absolute = path.join(root, file);
    const content = await readFile(absolute).catch(() => null);
    if (content === null || content.length > TEXT_SIZE_LIMIT || content.includes(0)) continue;

    const text = content.toString("utf8");
    scannedFiles.push(file);
    scanRules(file, text, findings);
    scanHighEntropyTokens(file, text, findings);
  }

  return { passed: findings.length === 0, scannedFiles, findings };
}

function scanRules(file: string, text: string, findings: SecretFinding[]): void {
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      if (findings.length >= MAX_FINDINGS) return;
      const value = match[1] ?? match[0];
      findings.push(makeFinding(rule.id, file, text, match.index ?? 0, value));
    }
  }
}

function scanHighEntropyTokens(file: string, text: string, findings: SecretFinding[]): void {
  const tokenPattern = /[A-Za-z0-9+/_=-]{32,}/g;
  for (const match of text.matchAll(tokenPattern)) {
    if (findings.length >= MAX_FINDINGS) return;
    const value = match[0];
    if (isLikelyNonSecret(value) || shannonEntropy(value) < ENTROPY_THRESHOLD) continue;
    findings.push(makeFinding("high-entropy-token", file, text, match.index ?? 0, value));
  }
}

function isLikelyNonSecret(value: string): boolean {
  if (value.length < MIN_ENTROPY_TOKEN_LENGTH) return true;
  if (/^[0-9a-f]{40,128}$/i.test(value)) return true;
  if (/^[A-Za-z]+$/.test(value)) return true;
  return false;
}

function shannonEntropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function makeFinding(ruleId: string, file: string, text: string, index: number, value: string): SecretFinding {
  return {
    ruleId,
    file,
    line: 1 + text.slice(0, index).split("\n").length - 1,
    fingerprint: createHash("sha256").update(`${ruleId}\0${value}`).digest("hex").slice(0, 16),
    preview: redact(value)
  };
}

function redact(value: string): string {
  if (value.length <= 8) return "[REDACTED]";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
