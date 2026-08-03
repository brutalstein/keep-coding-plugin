# Security

## Trust model

Keep Coding runs with the operating-system authority of its host process. The local Codex transport is stdio-only. The optional `mcp-http` transport opens a network listener and must be treated as a privileged code-editing service.

Acceptance commands execute in the target repository and are not sandboxed. In local agent mode, review commands through the host's permission controls. In HTTP mode, every saved or executed acceptance command must exactly match the operator-owned `KEEP_CODING_ALLOWED_COMMANDS_JSON` allowlist. There is no generic remote shell tool.

The evaluator and full-suite completion gate execute project-owned commands. The evaluator also creates and removes Git worktrees. Treat evaluation configuration, package scripts, and repository content as executable input.

## Checkpoint invariants

Every checkpoint applies controls that the plan author cannot disable:

- changed files must remain inside the active phase's `allowedScope`;
- added diff lines are scanned for private keys, known token formats, suspicious credential assignments, and high-entropy values;
- configured project/phase budgets are enforced;
- selective and declared deterministic commands must pass;
- a critic can block only when the contract explicitly sets `criticGate: "blocking"`.

Secret scanning is defense in depth, not proof that a repository contains no credentials. It examines checkpoint additions and can produce false positives or miss novel formats. The `keep-coding: allow-secret` marker suppresses one added line and must be reviewed like a security exception.

`KEEP_CODING_CRITIC_COMMAND_JSON` must be a JSON string array. Keep Coding spawns it without a shell and sends the contract, phase, changed-file list, and bounded diff through stdin. The critic process inherits the host environment and should be treated as trusted local code.

## Git writes and rollback

Passing checkpoints stage and commit only the verified changed-file set with a local Keep Coding identity. Existing user Git configuration is not modified.

At phase start, rollback content is captured only for files inside the declared scope and is bounded to 8 MiB. `restore_phase` filters changed files through that scope before restoring or removing them. It must not be used as a substitute for reviewing user work.

Parallel execution creates sibling worktrees and phase branches. Scope-overlap detection is intentionally conservative but cannot prove semantic independence. Merges are explicit and can still conflict; review the branch before merging into a sensitive repository.

## HTTP deployment

- The listener binds to `127.0.0.1` by default.
- `KEEP_CODING_ALLOWED_ROOTS` is mandatory. Paths are canonicalized before containment checks, including symlink resolution.
- Wildcard binds require an explicit Host allowlist; non-loopback binds require a bearer token.
- Prefer Secure MCP Tunnel or an authenticated reverse proxy. Public deployments require HTTPS and production authentication; the built-in bearer check is not an OAuth provider.
- Remote patches require an active phase, obey its minimatch scope, reject protected `.git/` and `.keep-coding/` paths, reject symbolic-link patches, and pass `git apply --check` before mutation.
- Keep allowlisted roots narrow. Do not include unrelated repositories, credentials, or sensitive files the connected model should not inspect.

Write actions remain vulnerable to malicious repository content and prompt injection. Review app action permissions, require confirmation for modifications where available, and connect only trusted MCP servers.

## Dashboard

The observability dashboard is a separate read-only HTTP server. It rejects non-loopback hosts, exposes only `GET /` and `GET /api/status`, sets no-store and content-security headers, and provides no authentication because it is not designed for remote exposure. Do not proxy or tunnel it publicly.

## Data

Project prompts, plan versions, decisions, failures, approvals, file paths, content hashes, checkpoint evidence, critic summaries, budget usage, and command output are stored in `.keep-coding/state.db` inside each target repository. Source contents are read for indexing and workspace operations but are not stored wholesale in the ledger.

When `KEEP_CODING_PLAYBOOK=1`, reusable phase metadata and normalized failure fingerprints are stored separately in `~/.keep-coding/playbook.db`. Repository source is not intentionally copied there, but titles, goals, scopes, commands, and failure summaries may contain sensitive organizational information. Keep the feature disabled when cross-project metadata sharing is inappropriate.

Keep Coding itself makes no outbound network requests. A critic command, tunnel, reverse proxy, ChatGPT connection, or host agent may introduce separate network and data-processing boundaries.

## Reporting

Report vulnerabilities privately to the repository maintainers with reproduction steps, impact, affected version, and a proposed mitigation. Do not include real credentials or proprietary source.
