# Execution Policy Kernel

Keep Coding treats command execution as a privileged operation. The agent may propose a command, but it cannot grant that command authority.

Every acceptance, selective-test, full-suite, and configured critic command passes through one execution kernel. The kernel parses the retained command string into an argv-only specification, resolves operator policy, checks capabilities, launches without a shell, bounds the process, audits repository writes, and emits a durable execution attestation.

## Security invariants

1. Shells are never used to interpret verification commands.
2. Unquoted shell operators, substitutions, redirections, control characters, and inline environment assignments are rejected.
3. The executable must be allowed by operator policy.
4. A repository-controlled executable found through `PATH` is rejected unless operator policy explicitly enables project executables.
5. Only allowlisted environment variables enter the child process. `HOME`, temporary directories, and their Windows equivalents point to an isolated temporary location.
6. Operator write scope, phase scope, and correction scope are cumulative restrictions. A file must satisfy all applicable scopes.
7. Changed files and secrets are scanned again after command execution.
8. Requested capabilities are fail-closed. A policy that requires unavailable isolation does not silently fall back.
9. Policy files must be absolute, canonical, outside the target repository, owned by the process user on POSIX, and not group- or world-writable.
10. Execution evidence records the command, policy, executable identity, backend capabilities, input state, output digest, and produced files.

## Assurance levels

### Audited process backend

The portable backend is available on supported Node.js platforms. It provides:

- argv-only `spawn` with `shell: false`;
- executable and optional exact-command allowlists;
- sanitized environment variables;
- isolated temporary home directories;
- wall-clock timeout and process-group termination on POSIX;
- bounded stdout and stderr;
- pre- and post-command repository auditing;
- content-hashed executable and output attestation.

This backend does **not** claim kernel-enforced filesystem or network isolation. Code launched by an allowed executable retains the operating-system authority of the Keep Coding process. Use it for trusted local repositories or when external isolation already exists.

### Confined Bubblewrap backend

On Linux, an operator policy may require Bubblewrap. The backend:

- creates user, PID, IPC, UTS, and cgroup namespaces;
- drops capabilities;
- mounts system toolchain paths read-only;
- mounts the repository read-only first;
- rebinds only effective static write-scope roots as writable;
- provides private `/tmp`, `/proc`, `/dev`, and home paths;
- optionally creates a private network namespace;
- fails closed when Bubblewrap or a requested capability is unavailable.

Bubblewrap is not a virtual machine and cannot defend against a host-kernel vulnerability. Untrusted native code should still run inside a hardened VM or container boundary maintained by the operator.

## Configure an operator policy

Copy the example policy outside every target repository:

```bash
mkdir -p "$HOME/.config/keep-coding"
cp examples/keep-coding.execution-policy.example.json \
  "$HOME/.config/keep-coding/execution-policy.json"
chmod 600 "$HOME/.config/keep-coding/execution-policy.json"
```

Then start Keep Coding with an absolute path:

```bash
export KEEP_CODING_EXECUTION_POLICY_PATH="$HOME/.config/keep-coding/execution-policy.json"
node plugins/keep-coding/dist/keep-coding.mjs mcp
```

For Linux confined execution, install Bubblewrap through the operating-system package manager and retain `sandbox: "bubblewrap"` plus the required isolation capabilities.

## Policy schema

```json
{
  "version": 1,
  "allowedExecutables": ["node", "npm"],
  "allowedCommands": ["npm test", "npm run build"],
  "allowedEnvironment": ["PATH", "CI", "NODE_ENV"],
  "fixedEnvironment": { "CI": "true" },
  "sandbox": "bubblewrap",
  "network": "deny",
  "projectWrites": "phase",
  "allowedWriteScopes": ["src/**", "tests/**", "dist/**"],
  "allowProjectExecutables": false,
  "requiredCapabilities": [
    "shell-free",
    "environment-sanitized",
    "timeout-enforced",
    "output-bounded",
    "write-audited",
    "filesystem-confined",
    "network-denied",
    "process-isolated"
  ],
  "maxTimeoutMs": 180000,
  "maxOutputBytes": 8388608
}
```

### `allowedExecutables`

Required. Entries may be executable names or absolute canonical paths. Name entries match the requested executable and the resolved basename. Executables resolved inside the target repository are denied unless `allowProjectExecutables` is explicitly true.

### `allowedCommands`

Optional exact argv allowlist. Commands are parsed and stored as canonical command-spec hashes. When the list is non-empty, an executable being allowed is insufficient: the complete executable-plus-argv specification must also match.

### Environment

`allowedEnvironment` copies only named host values. `fixedEnvironment` then applies operator-controlled values. Keep Coding overwrites home and temporary-directory variables with isolated paths. Secret variables are not inherited unless the operator explicitly names them.

### Sandbox and network

- `sandbox: "process"` selects the portable audited backend.
- `sandbox: "bubblewrap"` requires Linux Bubblewrap and fails closed otherwise.
- `sandbox: "auto"` selects Bubblewrap only when a requested capability requires it and Bubblewrap is available.
- `network: "deny"` requires a backend that advertises `network-denied`; it never degrades to inherited networking.

### Write authority

- `projectWrites: "deny"` rejects every repository write produced by a command.
- `projectWrites: "phase"` requires every produced file to satisfy operator `allowedWriteScopes`, phase `allowedScope`, and any active correction radius.

The process backend detects durable repository mutations after execution. The Bubblewrap backend additionally makes the repository read-only and rebinds effective static scope roots writable. Post-command audit remains mandatory for both.

## Execution attestation

Successful and denied command evidence includes:

- purpose and selected backend;
- advertised capabilities;
- canonical command-spec hash;
- policy hash and policy source;
- resolved executable path and SHA-256;
- inherited environment-variable names, never their values;
- network and write policies;
- phase and operator write scopes;
- files produced during execution;
- input tree hash;
- stdout/stderr digest;
- start and finish timestamps;
- timeout and output-limit state.

The attestation is stored inside normal checkpoint verification evidence and therefore inherits checkpoint durability, crash recovery, and Git binding.

## Operational guidance

- Keep policy files outside repositories and source-control worktrees.
- Prefer exact `allowedCommands` for release gates and network-facing MCP deployments.
- Prefer package-manager scripts over repository-provided executable wrappers.
- Do not allow secrets into command environments unless the command and data boundary are independently reviewed.
- Require Bubblewrap capabilities for repositories that are not fully trusted.
- Use a VM or dedicated container for hostile native code, compiler plugins, package installation, or kernel-facing tests.
