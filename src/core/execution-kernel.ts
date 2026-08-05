import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandEvidence } from "../domain/model.js";
import {
  commandSpecHash,
  parseCommandSpec,
  type CommandSpec,
  type ExecutionPurpose
} from "./command-spec.js";
import {
  buildExecutionEnvironment,
  commandAllowed,
  executableAllowed,
  loadExecutionPolicy,
  missingCapabilities,
  type ExecutionCapability,
  type ResolvedExecutionPolicy
} from "./execution-policy.js";

export interface ExecutionAttestation {
  version: 1;
  purpose: ExecutionPurpose;
  backend: "process" | "bubblewrap" | "denied";
  capabilities: ExecutionCapability[];
  commandSpecHash: string;
  policyHash: string;
  policySource: string;
  executablePath: string | null;
  executableSha256: string | null;
  environmentKeys: string[];
  network: "inherit" | "deny";
  projectWrites: "phase" | "deny";
  writeScopes: string[];
  operatorWriteScopes: string[];
  producedFiles: string[];
  inputTreeHash: string | null;
  outputSha256: string;
  startedAt: string;
  finishedAt: string;
  outputLimitExceeded: boolean;
}

export interface KernelCommandEvidence extends CommandEvidence {
  spec: CommandSpec | null;
  attestation: ExecutionAttestation;
  policyViolations: string[];
}

export interface ExecutionRequest {
  command: string;
  cwd: string;
  purpose: ExecutionPurpose;
  writeScopes: string[];
  stdin?: string | undefined;
  timeoutMs?: number | undefined;
  inputTreeHash?: string | undefined;
}

interface RawExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}

const PROCESS_CAPABILITIES: ExecutionCapability[] = [
  "shell-free", "environment-sanitized", "timeout-enforced", "output-bounded", "write-audited"
];
const BUBBLEWRAP_CAPABILITIES: ExecutionCapability[] = [
  ...PROCESS_CAPABILITIES, "filesystem-confined", "process-isolated"
];

export class ExecutionKernel {
  private constructor(
    readonly projectRoot: string,
    readonly policy: ResolvedExecutionPolicy,
    private readonly bubblewrapPath: string | null,
    private readonly sourceEnvironment: NodeJS.ProcessEnv
  ) {}

  static async open(
    projectRoot: string,
    env: NodeJS.ProcessEnv = process.env
  ): Promise<ExecutionKernel> {
    const canonicalRoot = await realpath(projectRoot);
    const policy = await loadExecutionPolicy(canonicalRoot, env);
    const bubblewrapPath = process.platform === "linux"
      ? await resolveExecutable("bwrap", canonicalRoot, env).catch(() => null)
      : null;
    return new ExecutionKernel(canonicalRoot, policy, bubblewrapPath, env);
  }

  async execute(request: ExecutionRequest): Promise<KernelCommandEvidence> {
    const started = performance.now();
    const startedAt = new Date().toISOString();
    let spec: CommandSpec;
    try {
      spec = parseCommandSpec(request.command);
    } catch (error) {
      return deniedEvidence(
        request,
        null,
        this.policy,
        started,
        startedAt,
        [error instanceof Error ? error.message : String(error)]
      );
    }

    let executablePath: string;
    try {
      executablePath = await resolveExecutable(spec.executable, request.cwd, this.sourceEnvironment);
    } catch (error) {
      return deniedEvidence(
        request,
        spec,
        this.policy,
        started,
        startedAt,
        [error instanceof Error ? error.message : String(error)]
      );
    }

    const policyViolations: string[] = [];
    if (!executableAllowed(this.policy, spec.executable, executablePath, this.projectRoot)) {
      policyViolations.push(`EXECUTION_EXECUTABLE_DENIED: ${spec.executable}`);
    }
    if (!commandAllowed(this.policy, spec)) {
      policyViolations.push("EXECUTION_COMMAND_DENIED: command is not present in the operator policy");
    }
    if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(executablePath)) {
      policyViolations.push("EXECUTION_WINDOWS_SHELL_SHIM_DENIED: .cmd and .bat executables require a shell");
    }

    const useBubblewrap = this.selectBubblewrap();
    const capabilities = useBubblewrap
      ? [...BUBBLEWRAP_CAPABILITIES, ...(this.policy.network === "deny" ? ["network-denied" as const] : [])]
      : PROCESS_CAPABILITIES;
    const missing = missingCapabilities(this.policy, capabilities);
    if (missing.length > 0) {
      policyViolations.push(`EXECUTION_CAPABILITY_UNAVAILABLE: ${missing.join(", ")}`);
    }
    if (this.policy.sandbox === "bubblewrap" && this.bubblewrapPath === null) {
      policyViolations.push("EXECUTION_SANDBOX_UNAVAILABLE: bubblewrap is required by policy");
    }
    if (this.policy.network === "deny" && !useBubblewrap) {
      policyViolations.push("EXECUTION_NETWORK_ISOLATION_UNAVAILABLE: network deny requires bubblewrap on Linux");
    }
    if (policyViolations.length > 0) {
      return deniedEvidence(
        request,
        spec,
        this.policy,
        started,
        startedAt,
        policyViolations,
        executablePath,
        capabilities
      );
    }

    const temporaryHome = await mkdtemp(path.join(tmpdir(), "keep-coding-exec-"));
    try {
      const sandboxHome = useBubblewrap ? "/tmp/keep-coding-home" : temporaryHome;
      const environment = buildExecutionEnvironment(this.policy, sandboxHome, this.sourceEnvironment);
      const timeoutMs = Math.max(
        1,
        Math.min(request.timeoutMs ?? this.policy.maxTimeoutMs, this.policy.maxTimeoutMs)
      );
      const executableSha256 = await hashFile(executablePath);
      const result = useBubblewrap
        ? await this.runBubblewrap(executablePath, spec.argv, request, environment, timeoutMs)
        : await runProcess(
            executablePath,
            spec.argv,
            request.cwd,
            environment,
            request.stdin,
            timeoutMs,
            this.policy.maxOutputBytes
          );
      if (result.outputLimitExceeded) {
        result.stderr = result.stderr
          ? `${result.stderr}\nEXECUTION_OUTPUT_LIMIT_EXCEEDED`
          : "EXECUTION_OUTPUT_LIMIT_EXCEEDED";
      }
      const finishedAt = new Date().toISOString();
      const outputSha256 = createHash("sha256")
        .update(result.stdout)
        .update("\0")
        .update(result.stderr)
        .digest("hex");
      return {
        command: request.command,
        exitCode: result.exitCode,
        passed: result.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded,
        durationMs: Math.round(performance.now() - started),
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        spec,
        policyViolations: [],
        attestation: {
          version: 1,
          purpose: request.purpose,
          backend: useBubblewrap ? "bubblewrap" : "process",
          capabilities,
          commandSpecHash: commandSpecHash(spec),
          policyHash: this.policy.hash,
          policySource: this.policy.source,
          executablePath,
          executableSha256,
          environmentKeys: Object.keys(environment).sort(),
          network: this.policy.network,
          projectWrites: this.policy.projectWrites,
          writeScopes: [...request.writeScopes].sort(),
          operatorWriteScopes: [...this.policy.allowedWriteScopes].sort(),
          producedFiles: [],
          inputTreeHash: request.inputTreeHash ?? null,
          outputSha256,
          startedAt,
          finishedAt,
          outputLimitExceeded: result.outputLimitExceeded
        }
      };
    } finally {
      await rm(temporaryHome, { recursive: true, force: true });
    }
  }

  private selectBubblewrap(): boolean {
    if (this.bubblewrapPath === null || process.platform !== "linux") return false;
    if (this.policy.sandbox === "process") return false;
    if (this.policy.sandbox === "bubblewrap") return true;
    return this.policy.network === "deny"
      || this.policy.requiredCapabilities.some((capability) =>
        capability === "filesystem-confined"
        || capability === "network-denied"
        || capability === "process-isolated");
  }

  private async runBubblewrap(
    executablePath: string,
    argv: string[],
    request: ExecutionRequest,
    environment: Record<string, string>,
    timeoutMs: number
  ): Promise<RawExecutionResult> {
    const bubblewrap = this.bubblewrapPath;
    if (!bubblewrap) throw new Error("bubblewrap path unexpectedly missing");
    const arguments_: string[] = [
      "--die-with-parent",
      "--new-session",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-uts",
      "--unshare-ipc",
      "--unshare-cgroup",
      "--uid", "0",
      "--gid", "0",
      "--cap-drop", "ALL",
      "--hostname", "keep-coding",
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      "--dir", "/tmp/keep-coding-home"
    ];
    if (this.policy.network === "deny") arguments_.push("--unshare-net");

    for (const systemPath of await existingSystemPaths()) {
      addDestinationParents(arguments_, systemPath);
      arguments_.push("--ro-bind", systemPath, systemPath);
    }
    addDestinationParents(arguments_, this.projectRoot);
    arguments_.push("--ro-bind", this.projectRoot, this.projectRoot);
    if (this.policy.projectWrites === "phase") {
      for (const writablePath of await writableBindings(
        this.projectRoot,
        request.writeScopes,
        this.policy.allowedWriteScopes
      )) {
        arguments_.push("--bind", writablePath, writablePath);
      }
    }
    arguments_.push("--chdir", request.cwd);
    arguments_.push("--clearenv");
    for (const [name, value] of Object.entries(environment)) {
      arguments_.push("--setenv", name, value);
    }
    arguments_.push("--", executablePath, ...argv);
    return runProcess(
      bubblewrap,
      arguments_,
      request.cwd,
      environment,
      request.stdin,
      timeoutMs,
      this.policy.maxOutputBytes
    );
  }
}

async function runProcess(
  executable: string,
  argv: string[],
  cwd: string,
  environment: Record<string, string>,
  stdin: string | undefined,
  timeoutMs: number,
  maxOutputBytes: number
): Promise<RawExecutionResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, argv, {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;

    const terminate = (): void => {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      } else {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref();

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) {
        outputLimitExceeded = true;
        terminate();
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => {
      stderr += error.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();

    function finish(code: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut, outputLimitExceeded });
    }
  });
}

function deniedEvidence(
  request: ExecutionRequest,
  spec: CommandSpec | null,
  policy: ResolvedExecutionPolicy,
  started: number,
  startedAt: string,
  policyViolations: string[],
  executablePath: string | null = null,
  capabilities: ExecutionCapability[] = PROCESS_CAPABILITIES
): KernelCommandEvidence {
  const stderr = policyViolations.join("\n");
  const finishedAt = new Date().toISOString();
  return {
    command: request.command,
    exitCode: null,
    passed: false,
    durationMs: Math.round(performance.now() - started),
    stdout: "",
    stderr,
    timedOut: false,
    spec,
    policyViolations,
    attestation: {
      version: 1,
      purpose: request.purpose,
      backend: "denied",
      capabilities,
      commandSpecHash: spec
        ? commandSpecHash(spec)
        : createHash("sha256").update(request.command).digest("hex"),
      policyHash: policy.hash,
      policySource: policy.source,
      executablePath,
      executableSha256: null,
      environmentKeys: [],
      network: policy.network,
      projectWrites: policy.projectWrites,
      writeScopes: [...request.writeScopes].sort(),
      operatorWriteScopes: [...policy.allowedWriteScopes].sort(),
      producedFiles: [],
      inputTreeHash: request.inputTreeHash ?? null,
      outputSha256: createHash("sha256").update("\0").update(stderr).digest("hex"),
      startedAt,
      finishedAt,
      outputLimitExceeded: false
    }
  };
}

async function resolveExecutable(
  executable: string,
  cwd: string,
  environment: NodeJS.ProcessEnv
): Promise<string> {
  const hasSeparator = executable.includes("/") || executable.includes("\\");
  if (hasSeparator) {
    const candidate = path.isAbsolute(executable) ? executable : path.resolve(cwd, executable);
    await access(candidate, constants.X_OK);
    return realpath(candidate);
  }

  const pathValue = environment.PATH ?? environment.Path ?? environment.path ?? "";
  const extensions = process.platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(
        directory,
        process.platform === "win32" ? `${executable}${extension}` : executable
      );
      try {
        await access(candidate, constants.X_OK);
        return await realpath(candidate);
      } catch {
        // Continue searching PATH.
      }
    }
  }
  throw new Error(`EXECUTION_EXECUTABLE_NOT_FOUND: ${executable}`);
}

async function hashFile(filePath: string): Promise<string> {
  const metadata = await stat(filePath);
  if (!metadata.isFile()) throw new Error(`EXECUTION_EXECUTABLE_INVALID: ${filePath} is not a regular file`);
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function writableBindings(
  projectRoot: string,
  phaseScopes: string[],
  operatorScopes: string[]
): Promise<string[]> {
  const prefixes = intersectScopePrefixes(phaseScopes, operatorScopes);
  const bindings: string[] = [];
  for (const prefix of prefixes) {
    const candidate = prefix === "" ? projectRoot : path.resolve(projectRoot, prefix);
    if (!isInside(projectRoot, candidate)) continue;
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) {
        const canonical = await realpath(candidate);
        if (!isInside(projectRoot, canonical)) {
          throw new Error(`EXECUTION_WRITE_SCOPE_SYMLINK_ESCAPE: ${prefix}`);
        }
      }
      bindings.push(await realpath(candidate));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("EXECUTION_WRITE_SCOPE_SYMLINK_ESCAPE")) throw error;
      throw new Error(`EXECUTION_WRITE_SCOPE_UNAVAILABLE: ${prefix || "."}`, { cause: error });
    }
  }
  return [...new Set(bindings)].sort();
}

function intersectScopePrefixes(left: string[], right: string[]): string[] {
  const leftPrefixes = left.map(scopePrefix);
  const rightPrefixes = right.map(scopePrefix);
  const intersections: string[] = [];
  for (const first of leftPrefixes) {
    for (const second of rightPrefixes) {
      if (first === "") intersections.push(second);
      else if (second === "") intersections.push(first);
      else if (first === second || first.startsWith(`${second}/`)) intersections.push(first);
      else if (second.startsWith(`${first}/`)) intersections.push(second);
    }
  }
  return [...new Set(intersections)];
}

function scopePrefix(pattern: string): string {
  const normalized = pattern.replace(/^!/u, "").replaceAll("\\", "/").replace(/^\.\//u, "");
  const wildcard = normalized.search(/[*?{[]/u);
  const prefix = wildcard >= 0 ? normalized.slice(0, wildcard) : normalized;
  return prefix.replace(/\/+$/u, "");
}

function addDestinationParents(arguments_: string[], destination: string): void {
  const parents: string[] = [];
  let current = path.dirname(destination);
  while (current !== path.dirname(current) && current !== "/") {
    parents.push(current);
    current = path.dirname(current);
  }
  for (const parent of parents.reverse()) arguments_.push("--dir", parent);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function existingSystemPaths(): Promise<string[]> {
  const candidates = [
    "/usr", "/bin", "/sbin", "/lib", "/lib64", "/usr/local", "/opt", "/nix/store",
    "/etc/alternatives", "/etc/ld.so.cache", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group",
    "/etc/hosts", "/etc/resolv.conf"
  ];
  const existing: string[] = [];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      existing.push(candidate);
    } catch {
      // Optional host path.
    }
  }
  return existing;
}
