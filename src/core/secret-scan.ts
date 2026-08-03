import type { SecretFinding } from "../domain/model.js";

interface Rule {
  name: string;
  expression: RegExp;
}

const RULES: Rule[] = [
  { name: "private-key", expression: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "aws-access-key", expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "github-token", expression: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{30,}\b/ },
  { name: "openai-token", expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "slack-token", expression: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: "generic-secret-assignment", expression: /\b(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{20,}/i }
];

export interface SecretScanResult {
  passed: boolean;
  findings: SecretFinding[];
}

export function scanUnifiedDiff(diff: string): SecretScanResult {
  const findings: SecretFinding[] = [];
  let file = "<diff>";
  let newLine = 0;
  for (const rawLine of diff.split("\n")) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(rawLine);
    if (fileMatch?.[1]) {
      file = fileMatch[1];
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(rawLine);
    if (hunk?.[1]) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      const line = rawLine.slice(1);
      if (!line.includes("keep-coding: allow-secret")) {
        for (const rule of RULES) {
          if (rule.expression.test(line)) findings.push(finding(file, newLine, rule.name, line));
        }
        const candidate = entropyCandidate(line);
        if (candidate && shannonEntropy(candidate) >= 4.35) findings.push(finding(file, newLine, "high-entropy-secret", line));
      }
      newLine += 1;
    } else if (!rawLine.startsWith("-")) {
      newLine += 1;
    }
  }
  return { passed: findings.length === 0, findings: deduplicate(findings) };
}

function entropyCandidate(line: string): string | null {
  const assignment = /\b(?:key|secret|token|password|credential)\w*\b\s*[:=]\s*["']?([A-Za-z0-9_./+\-=]{32,})/i.exec(line);
  return assignment?.[1] ?? null;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function finding(file: string, line: number, rule: string, source: string): SecretFinding {
  return { file, line: Math.max(1, line), rule, preview: redact(source.trim()) };
}

function redact(value: string): string {
  if (value.length <= 24) return "[redacted]";
  return `${value.slice(0, 8)}…[redacted]…${value.slice(-4)}`;
}

function deduplicate(findings: SecretFinding[]): SecretFinding[] {
  const seen = new Set<string>();
  return findings.filter((item) => {
    const key = `${item.file}:${item.line}:${item.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
