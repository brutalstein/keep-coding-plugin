# Security

## Trust model

Keep Coding runs with the operating-system authority of its host process. The local Codex transport is stdio-only. The optional `mcp-http` transport opens a network listener and must be treated as a privileged code-editing service.

Acceptance commands execute in the target repository and are not sandboxed. In local Codex mode, review commands through Codex permission controls. In HTTP mode, every saved or executed acceptance command must exactly match the operator-owned `KEEP_CODING_ALLOWED_COMMANDS_JSON` allowlist. There is no generic remote shell tool.

The evaluator executes commands from its JSON configuration and creates/removes Git worktrees under its output directory. Treat evaluation configurations as executable code.

## HTTP deployment

- The listener binds to `127.0.0.1` by default.
- `KEEP_CODING_ALLOWED_ROOTS` is mandatory. Paths are canonicalized before containment checks, including symlink resolution.
- Wildcard binds require an explicit Host allowlist; non-loopback binds require a bearer token.
- Prefer Secure MCP Tunnel or an authenticated reverse proxy. Public deployments require HTTPS and production authentication; the built-in bearer check is not an OAuth provider.
- Remote patches require an active phase, obey its minimatch scope, reject protected `.git/` and `.keep-coding/` paths, reject symbolic-link patches, and pass `git apply --check` before mutation.
- Keep allowlisted roots narrow. Do not include unrelated repositories, credentials, or sensitive files the connected model should not inspect.

Write actions remain vulnerable to malicious repository content and prompt injection. Review ChatGPT app action permissions, require confirmation for modifications where available, and connect only trusted MCP servers.

## Data

Project prompts, decisions, failures, file paths, content hashes, and command output are stored in `.keep-coding/state.db` inside each target repository. Source contents are read for indexing and remote workspace operations but are not stored wholesale in the ledger.

Keep Coding itself makes no outbound network requests. A tunnel, reverse proxy, or ChatGPT connection introduces its own network and data-processing boundary.

## Reporting

Report vulnerabilities privately to the repository maintainers with reproduction steps, impact, affected version, and a proposed mitigation. Do not include real credentials or proprietary source.
