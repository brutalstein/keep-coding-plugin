import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { NetworkAccess } from "./command-spec.js";

export type SandboxBackendPreference = "auto" | "process" | "bubblewrap";
export type ProjectWritePolicy = "phase" | "deny";
export type ExecutionCapability =
  | "shell-free"
  | "environment-sanitized"
  | "timeout-enforced"
  | "output-bounded"
  | "write-audited"
  | "filesystem-confined"
  | "network-denied"
  | "process-isolated";

export interface ExecutionPolicyDocument {
  version: 1;
  allowedExecutables: string[];
  allowedEnvironment?: string[];
  fixedEnvironment?: Record<string, string>;
  sandbox?: SandboxBackendPreference;
  network?: NetworkAccess;
  projectWrites?: ProjectWritePolicy;
  requiredCapabilities?: ExecutionCapability[];
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ResolvedExecutionPolicy {
  source: string;
  hash: string;
  allowedExecutables: string[];
  allowedEnvironment: string[];
  fixedEnvironment: Record<string, string>;
  sandbox: SandboxBackendPreference;
  network: NetworkAccess;
  projectWrites: ProjectWritePolicy;
  requiredCapabilities: ExecutionCapability[];
  maxTimeoutMs: number;
  maxOutputBytes: number;
}

const DEFAULT_ALLOWED_EXECUTABLES = [
  "node", "npm", "npx", "pnpm", "yarn", "bun",
  "python", "python3", "pytest", "ruff", "mypy", "pyright",
  "tsc", "eslint", "vitest", "jest", "mocha",
  "cargo", "rustc", "clippy", "go", "dotnet",
  "mvn", "mvnw", "gradle", "gradlew", "cmake", "ctest", "make", "ninja",
  "git", "ruby", "bundle", "php", "composer"
];
const DEFAULT_ALLOWED_ENVIRONMENT = [
  "PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC",
  "CI", "NODE_ENV", "LANG", "LC_ALL", "TMP", "TEMP"
];
const DEFAULT_REQUIRED_CAPABILITIES: ExecutionCapability[] = [
  "shell-free", "environment-sanitized", "timeout-enforced", "output-bounded", "write-audited"
];
const CAPABILITIES = new Set<ExecutionCapability>([
  ...DEFAULT_REQUIRED_CAPABILITIES,
  "filesystem-confined", "network-denied", "process-isolated"
]);

export async function loadExecutionPolicy(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ResolvedExecutionPolicy> {
  const configuredPath = env.KEEP_CODING_EXECUTION_POLICY_PATH?.trim();
  if (!configuredPath) return resolvePolicy(defaultPolicy(), "builtin");
  if (!path.isAbsolute(configuredPath)) {
    throw new Error("EXECUTION_POLICY_PATH_INVALID: KEEP_CODING_EXECUTION_POLICY_PATH must be absolute");
  }

  const [canonicalRoot, canonicalPolicy] = await Promise.all([
    realpath(projectRoot),
    realpath(configuredPath)
  ]);
  if (isInside(canonicalRoot, canonicalPolicy)) {
    throw new Error("EXECUTION_POLICY_TRUST_BOUNDARY: operator policy must live outside the target repository");
  }
  const metadata = await stat(canonicalPolicy);
  if (!metadata.isFile()) throw new Error("EXECUTION_POLICY_PATH_INVALID: policy path must reference a regular file");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("EXECUTION_POLICY_OWNER_INVALID: policy file must be owned by the Keep Coding process user");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(canonicalPolicy, "utf8"));
  } catch (error) {
    throw new Error(
      `EXECUTION_POLICY_PARSE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  return resolvePolicy(validatePolicyDocument(parsed), canonicalPolicy);
}

export function defaultExecutionPolicy(): ResolvedExecutionPolicy {
  return resolvePolicy(defaultPolicy(), "builtin");
}

export function buildExecutionEnvironment(
  policy: ResolvedExecutionPolicy,
  temporaryHome: string,
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of policy.allowedEnvironment) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  Object.assign(environment, policy.fixedEnvironment);
  environment.HOME = temporaryHome;
  environment.USERPROFILE = temporaryHome;
  environment.TMPDIR = temporaryHome;
  environment.TMP = temporaryHome;
  environment.TEMP = temporaryHome;
  return environment;
}

export function executableAllowed(
  policy: ResolvedExecutionPolicy,
  requestedExecutable: string,
  resolvedExecutable: string
): boolean {
  const requested = normalizeExecutable(requestedExecutable);
  const resolved = normalizeExecutable(resolvedExecutable);
  const basename = normalizeExecutable(path.basename(resolvedExecutable));
  return policy.allowedExecutables.some((entry) => {
    const allowed = normalizeExecutable(entry);
    return allowed === requested || allowed === resolved || allowed === basename;
  });
}

export function missingCapabilities(
  policy: ResolvedExecutionPolicy,
  available: Iterable<ExecutionCapability>
): ExecutionCapability[] {
  const supported = new Set(available);
  return policy.requiredCapabilities.filter((capability) => !supported.has(capability));
}

function defaultPolicy(): ExecutionPolicyDocument {
  return {
    version: 1,
    allowedExecutables: DEFAULT_ALLOWED_EXECUTABLES,
    allowedEnvironment: DEFAULT_ALLOWED_ENVIRONMENT,
    fixedEnvironment: { KEEP_CODING_EXECUTION: "1" },
    sandbox: "auto",
    network: "inherit",
    projectWrites: "phase",
    requiredCapabilities: DEFAULT_REQUIRED_CAPABILITIES,
    maxTimeoutMs: 300_000,
    maxOutputBytes: 16 * 1024 * 1024
  };
}

function validatePolicyDocument(value: unknown): ExecutionPolicyDocument {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("EXECUTION_POLICY_SCHEMA: version must be exactly 1");
  }
  const allowedExecutables = stringArray(value.allowedExecutables, "allowedExecutables", true);
  const allowedEnvironment = value.allowedEnvironment === undefined
    ? undefined
    : stringArray(value.allowedEnvironment, "allowedEnvironment", false);
  const fixedEnvironment = value.fixedEnvironment === undefined
    ? undefined
    : stringRecord(value.fixedEnvironment, "fixedEnvironment");
  const sandbox = enumValue(value.sandbox, ["auto", "process", "bubblewrap"] as const, "sandbox", "auto");
  const network = enumValue(value.network, ["inherit", "deny"] as const, "network", "inherit");
  const projectWrites = enumValue(value.projectWrites, ["phase", "deny"] as const, "projectWrites", "phase");
  const requiredCapabilities = value.requiredCapabilities === undefined
    ? undefined
    : stringArray(value.requiredCapabilities, "requiredCapabilities", false).map(executionCapability);
  const maxTimeoutMs = optionalPositiveInteger(value.maxTimeoutMs, "maxTimeoutMs");
  const maxOutputBytes = optionalPositiveInteger(value.maxOutputBytes, "maxOutputBytes");
  return {
    version: 1,
    allowedExecutables,
    ...(allowedEnvironment !== undefined ? { allowedEnvironment } : {}),
    ...(fixedEnvironment !== undefined ? { fixedEnvironment } : {}),
    sandbox,
    network,
    projectWrites,
    ...(requiredCapabilities !== undefined ? { requiredCapabilities } : {}),
    ...(maxTimeoutMs !== undefined ? { maxTimeoutMs } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {})
  };
}

function resolvePolicy(document: ExecutionPolicyDocument, source: string): ResolvedExecutionPolicy {
  const resolved = {
    source,
    allowedExecutables: [...new Set(document.allowedExecutables.map((entry) => entry.trim()))],
    allowedEnvironment: [...new Set(document.allowedEnvironment ?? DEFAULT_ALLOWED_ENVIRONMENT)],
    fixedEnvironment: { ...(document.fixedEnvironment ?? {}) },
    sandbox: document.sandbox ?? "auto",
    network: document.network ?? "inherit",
    projectWrites: document.projectWrites ?? "phase",
    requiredCapabilities: [...new Set(document.requiredCapabilities ?? DEFAULT_REQUIRED_CAPABILITIES)],
    maxTimeoutMs: document.maxTimeoutMs ?? 300_000,
    maxOutputBytes: document.maxOutputBytes ?? 16 * 1024 * 1024
  };
  return {
    ...resolved,
    hash: createHash("sha256").update(stableJson(resolved)).digest("hex")
  };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeExecutable(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return process.platform === "win32"
    ? normalized.toLowerCase().replace(/\.(?:exe|cmd|bat)$/u, "")
    : normalized;
}

function stringArray(value: unknown, field: string, requireOne: boolean): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "" || entry !== entry.trim())) {
    throw new Error(`EXECUTION_POLICY_SCHEMA: ${field} must be an array of non-empty trimmed strings`);
  }
  if (requireOne && value.length === 0) throw new Error(`EXECUTION_POLICY_SCHEMA: ${field} must not be empty`);
  return value.map((entry) => String(entry));
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (!isRecord(value) || Object.entries(value).some(([key, entry]) => key.trim() === "" || typeof entry !== "string")) {
    throw new Error(`EXECUTION_POLICY_SCHEMA: ${field} must map non-empty names to string values`);
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]));
}

function executionCapability(value: string): ExecutionCapability {
  const match = [...CAPABILITIES].find((capability) => capability === value);
  if (!match) throw new Error(`EXECUTION_POLICY_SCHEMA: unknown required capability ${value}`);
  return match;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`EXECUTION_POLICY_SCHEMA: ${field} must be a positive integer`);
  }
  return Number(value);
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  field: string,
  fallback: Values[number]
): Values[number] {
  if (value === undefined) return fallback;
  const match = values.find((candidate) => candidate === value);
  if (!match) throw new Error(`EXECUTION_POLICY_SCHEMA: ${field} must be one of ${values.join(", ")}`);
  return match;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
