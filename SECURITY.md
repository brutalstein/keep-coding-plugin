# Security

## Trust model

Keep Coding runs with the operating-system authority of its host process. The local Codex transport is stdio-only. The optional `mcp-http` transport opens a network listener and must be treated as a privileged code-editing service.

Acceptance commands execute in the target repository and are not sandboxed. In local Codex mode, review commands through Codex permission controls. In HTTP mode, every saved or executed acceptance command must exactly match the operator-owned `KEEP_CODING_ALLOWED_COMMANDS_JSON` allowlist. There is no generic remote shell tool.

The evaluator executes commands from its JSON configuration and creates/removes Git worktrees under its output directory. Treat evaluation configurations as executable code.

## Acceptance evidence quality

The agent authors the plan and therefore selects its own deterministic acceptance commands. This is an unavoidable trust dependency: a command may be syntactically valid and still provide weak evidence for the claimed deliverable.

Keep Coding raises the bar in three ways:

- exact no-op commands remain blocked;
- `save_plan` and `amend_plan` return non-blocking warnings when a code phase lacks a recognizable test, lint, type-check, build, or syntax-validation category, or when unrelated phases reuse identical commands;
- phases may explicitly declare `verificationKind: "non-code"`; otherwise weak deterministic evidence also produces a recommendation to enable a blocking independent critic.

These heuristics do not prove that a command is sufficient, cannot understand every custom build tool, and do not remove the trust dependency on agent-authored plans. High-assurance projects should use operator-owned command allowlists, measurable phase-specific commands, full-suite completion gates, and `critic.blocking = true` when deterministic evidence is incomplete.

## HTTP deployment

- The listener binds to `127.0.0.1` by default.
- `KEEP_CODING_ALLOWED_ROOTS` is mandatory. Paths are canonicalized before containment checks, including symlink resolution.
- Wildcard binds require an explicit Host allowlist; non-loopback binds require a bearer token.
- Prefer Secure MCP Tunnel or an authenticated reverse proxy. Public deployments require HTTPS and production authentication; the built-in bearer check is not an OAuth provider.
- Remote patches require an active phase, obey its minimatch scope, reject protected `.git/` and `.keep-coding/` paths, reject symbolic-link patches, and pass `git apply --check` before mutation.
- Keep allowlisted roots narrow. Do not include unrelated repositories, credentials, or sensitive files the connected model should not inspect.

Write actions remain vulnerable to malicious repository content and prompt injection. Review ChatGPT app action permissions, require confirmation for modifications where available, and connect only trusted MCP servers.

## Data

Project prompts, decisions, normalized failure records, file paths, content hashes, compact command evidence, token telemetry, and approvals are stored in `.keep-coding/state.db` inside each target repository. Source contents are read for indexing and remote workspace operations but are not stored wholesale in the ledger. The optional cross-project playbook stores compact structured patterns in `~/.keep-coding/playbook.db` only when explicitly enabled.

Keep Coding itself makes no outbound network requests. A tunnel, reverse proxy, critic command, or ChatGPT connection introduces its own network and data-processing boundary.

## Reporting

Report vulnerabilities privately to the repository maintainers with reproduction steps, impact, affected version, and a proposed mitigation. Do not include real credentials or proprietary source.
