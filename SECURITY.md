# Security

## Trust model

Keep Coding runs with the operating-system authority of its host process. The local Codex transport is stdio-only. The optional `mcp-http` transport opens a network listener and must be treated as a privileged code-editing service.

Every acceptance, selective-test, full-suite, and configured critic command now passes through the same execution policy kernel. The kernel never asks a shell to interpret agent-authored command strings. It parses commands into executable-plus-argv specifications, rejects shell operators and substitutions, resolves an operator-owned policy, sanitizes the child environment, enforces time and output bounds, audits repository writes, and records execution attestation inside verification evidence.

The portable process backend is an **audited execution boundary**, not a kernel sandbox. An operator-approved executable still runs with the host process's filesystem and network authority. On Linux, an operator may require the Bubblewrap backend for namespace isolation, read-only repository mounting, bounded writable scope roots, capability dropping, and optional network denial. Requested isolation capabilities fail closed when the selected backend cannot supply them.

The evaluator executes commands from its JSON configuration and creates/removes Git worktrees under its output directory. Treat evaluation configurations as executable code. Evaluation commands do not become trusted merely because verification commands use the policy kernel.

## Execution policy authority

The agent may propose a command, but it cannot grant that command authority.

Effective command authority is bounded by:

1. the operator execution policy;
2. the durable project contract;
3. the active phase scope;
4. any active correction radius;
5. the capabilities available from the selected execution backend.

External execution policy files are loaded through `KEEP_CODING_EXECUTION_POLICY_PATH`. They must use an absolute canonical path outside the target repository. On POSIX they must be owned by the Keep Coding process user and must not be group- or world-writable. This prevents repository content from rewriting its own execution authority.

Policies may restrict:

- executable names or exact canonical paths;
- exact executable-plus-argv command specifications;
- inherited environment-variable names;
- fixed operator-owned environment values;
- maximum duration and output size;
- project write behavior and operator write scopes;
- network access;
- required backend capabilities;
- use of executables resolved from inside the target repository.

Repository-controlled executable shadowing through `PATH` is denied by default. Windows `.cmd` and `.bat` shims are also denied because they require command-shell interpretation; operators should invoke a real executable or interpreter entry point instead.

See [`docs/EXECUTION_POLICY.md`](docs/EXECUTION_POLICY.md) for configuration and assurance-level details.

## Execution attestation

Command evidence records:

- the canonical command-spec hash;
- policy hash and policy source;
- resolved executable path and SHA-256;
- backend and advertised capabilities;
- inherited environment-variable names, never their values;
- network and project-write modes;
- operator, phase, and correction write boundaries;
- repository files produced during execution;
- input tree hash;
- stdout/stderr digest;
- start and finish times;
- timeout and output-limit status.

Attestation proves what Keep Coding launched and observed. It does not prove that an allowed compiler, interpreter, package manager, plugin, or native dependency is benign.

## Acceptance evidence quality

The agent authors the plan and therefore proposes its deterministic acceptance commands. This remains a trust dependency: a command may be syntactically safe and still provide weak evidence for the claimed deliverable.

Keep Coding raises the bar in several ways:

- shell-bearing and malformed command specifications are rejected before plan persistence;
- exact no-op commands remain blocked;
- `save_plan` and `amend_plan` return non-blocking warnings when a code phase lacks a recognizable test, lint, type-check, build, or syntax-validation category, or when unrelated phases reuse identical commands;
- plan amendments validate the effective patched contract before durable persistence;
- HTTP exact-command configuration is parsed and validated before server startup;
- phases may explicitly declare `verificationKind: "non-code"`; otherwise weak deterministic evidence also produces a recommendation to enable a blocking independent critic;
- repository scope and secret scanning run again after command execution;
- high-assurance policies can require exact operator-owned commands and a blocking independent critic.

These controls do not prove semantic sufficiency and cannot understand every custom build system. High-assurance projects should use measurable phase-specific commands, exact operator allowlists, full-suite completion gates, independently maintained verifier contracts, and `critic.blocking = true` when deterministic evidence is incomplete.

## Backend boundaries

### Audited process backend

The process backend provides shell-free argv execution, environment sanitization, timeout enforcement, POSIX process-group termination, output bounding, executable hashing, and post-command repository auditing.

It does **not** enforce filesystem or network isolation. Code run through an approved interpreter can still inspect or modify resources available to the Keep Coding process until post-command audit detects durable repository mutations. Use this backend only for trusted repositories, trusted toolchains, or execution already contained by an operator-managed VM or container.

### Confined Bubblewrap backend

On Linux, Bubblewrap can provide user, PID, IPC, UTS, and cgroup namespaces; capability dropping; read-only system and repository mounts; private temporary paths; and optional network namespace isolation. The repository is mounted read-only first, then only effective static write-scope roots are rebound writable. Post-command audit remains mandatory.

Bubblewrap is not a virtual machine and does not protect against host-kernel vulnerabilities. Static writable root binding is coarser than exact glob semantics, so exact phase, correction, and operator glob rules are still enforced by post-command audit. Hostile native code, compiler plugins, package installation, or kernel-facing tests should run inside a hardened VM or dedicated container boundary.

## HTTP deployment

- The listener binds to `127.0.0.1` by default.
- `KEEP_CODING_ALLOWED_ROOTS` is mandatory. Paths are canonicalized before containment checks, including symlink resolution.
- Wildcard binds require an explicit Host allowlist; non-loopback binds require a bearer token.
- Prefer Secure MCP Tunnel or an authenticated reverse proxy. Public deployments require HTTPS and production authentication; the built-in bearer check is not an OAuth provider.
- Every configured HTTP acceptance command must be an exact operator-owned command and must pass shell-free command parsing at startup.
- Remote patches require an active phase, obey its minimatch scope, reject protected `.git/` and `.keep-coding/` paths, reject symbolic-link patches, and pass `git apply --check` before mutation.
- Keep allowlisted roots narrow. Do not include unrelated repositories, credentials, or sensitive files the connected model should not inspect.
- For network-facing deployments, use an external execution policy with exact `allowedCommands`; require Bubblewrap capabilities on Linux when repositories are not fully trusted.

Write actions remain vulnerable to malicious repository content and prompt injection. Review ChatGPT app action permissions, require confirmation for modifications where available, and connect only trusted MCP servers.

## Data

Project prompts, decisions, normalized failure records, file paths, content hashes, compact command evidence, execution attestations, token telemetry, and approvals are stored in `.keep-coding/state.db` inside each target repository. Source contents are read for indexing and remote workspace operations but are not stored wholesale in the ledger. The optional cross-project playbook stores compact structured patterns in `~/.keep-coding/playbook.db` only when explicitly enabled.

Attestations include executable paths, hashes, policy source paths, environment-variable names, write scopes, and output digests. These can reveal workstation layout and project intent even though secret values and wholesale source contents are not recorded. Protect `.keep-coding/state.db`, external policy files, and `~/.keep-coding/playbook.db` accordingly.

Keep Coding itself makes no outbound network requests. A tunnel, reverse proxy, critic command, allowed verification command, package manager, or ChatGPT connection introduces its own network and data-processing boundary unless the execution backend enforces network denial.

## Assumption and correction trust boundary

Assumption confidence is agent-authored metadata, not a probability guarantee. Values outside `[0,1]` are rejected rather than clamped, but an agent can still report an unjustifiably high value. High-assurance workflows should retain measurable acceptance commands, operator allowlists, and independent critic review; the assumption ledger narrows correction work but does not prove the original interpretation was correct.

`invalidate_assumption` computes only from explicit graph links and bounded dependency edges. Empty seeds return an empty radius. The verifier intersects that radius with the existing phase scope and operator write policy, so an assumption cannot grant broader write authority. `expand_correction_scope` requires a stored non-empty justification and any unexplained excess file remains a normal scope violation. The apology-language hook is advisory only and never grants or removes write authority.

Project databases also store assumption statements, rejected alternatives, confidence, graph dependencies, root causes, correction scopes, justifications, outcomes, and token counters. Opt-in cross-project playbook memory may store compact correction anti-patterns. These records can expose product requirements or design intent even though source file contents are not stored wholesale.

## Native parser sidecars

Python, C, and C++ parsing loads pinned WASM artifacts from the installed distribution. Before first use, Keep Coding verifies every grammar, query, and the tree-sitter runtime against the committed SHA-256 and byte-count manifest. Missing or modified assets cannot be treated as trusted syntax trees; indexing records an explicit degraded fallback. The parsers have bounded query match counts, parse/query deadlines, and output caps.

Tree-sitter provides syntax, not compiler authority. No source-controlled grammar, query, or repository file can enable a new subprocess. Any future Pyright, clangd, or compiler-authoritative enrichment must use the same execution policy kernel, bounded argv execution, explicit binary discovery, content-hash caches, and a documented failure mode.

## Cross-agent packaging

Codex, Claude, Agent Skills, and generic MCP packages point to one executable. Distribution validation prevents host-specific skill forks and checks that hook manifests declare their runtime identity. Streamable HTTP remains the only network-facing mode and retains its root, host, bearer-token, request-size, exact-command, and execution-policy boundaries.

## Reporting

Report vulnerabilities privately to the repository maintainers with reproduction steps, impact, affected version, and a proposed mitigation. Do not include real credentials or proprietary source.
