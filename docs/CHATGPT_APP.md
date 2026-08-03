# Use Keep Coding in normal ChatGPT chats

Keep Coding can expose its durable project workflow through a remote MCP endpoint and be connected as a custom ChatGPT app.

## What carries over

The app receives the project contract, dependency-aware phases, decisions, failure memory, checkpoints, and repository graph. It can also list files, read bounded text, search code, inspect the Git diff, and apply a unified patch inside the active phase's `allowedScope`.

The remote app does **not** receive Codex lifecycle hooks. It cannot automatically intercept every prompt or prevent a chat from ending. Select the app in the chat, or refer to it explicitly, and keep work inside the evidence-gated tool sequence.

## Availability

As of August 3, 2026, ChatGPT cannot connect directly to a local stdio MCP process. The endpoint must be reachable remotely; OpenAI recommends Secure MCP Tunnel for a server on a developer machine or private network. Full MCP write/modify actions are currently available in beta for ChatGPT Business, Enterprise, and Edu workspaces. Pro can connect custom MCP apps with read/fetch permissions, but not the write tools required for `apply_patch`. Recheck the current OpenAI documentation before deployment.

## Build and run

```bash
npm ci
npm run check

export KEEP_CODING_ALLOWED_ROOTS="/home/me/projects"
export KEEP_CODING_ALLOWED_COMMANDS_JSON='["npm run check","npm test","git diff --check"]'
node plugins/keep-coding/dist/keep-coding.mjs mcp-http
```

Default endpoint: `http://127.0.0.1:8787/mcp`.

| Variable | Required | Purpose |
|---|---:|---|
| `KEEP_CODING_ALLOWED_ROOTS` | yes | Existing absolute parent directories, separated by the OS path delimiter. |
| `KEEP_CODING_ALLOWED_COMMANDS_JSON` | yes | JSON array of exact acceptance commands that remote plans/checkpoints may use. |
| `KEEP_CODING_HTTP_HOST` | no | Bind address; default `127.0.0.1`. |
| `KEEP_CODING_HTTP_PORT` or `PORT` | no | Port; default `8787`. |
| `KEEP_CODING_HTTP_PATH` | no | MCP path; default `/mcp`. |
| `KEEP_CODING_ALLOWED_HOSTS` | wildcard binds | Comma-separated HTTP Host allowlist. |
| `KEEP_CODING_BEARER_TOKEN` | non-loopback binds | Static bearer token expected by the listener. Prefer a tunnel or OAuth-aware gateway. |
| `KEEP_CODING_MAX_BODY_BYTES` | no | Request limit; default 1 MiB. |

`project_root` is a path on the MCP server machine. It must resolve under an allowed root and must be a Git repository.

## Connect to ChatGPT

1. Keep the server on loopback and connect it through OpenAI Secure MCP Tunnel, or deploy it behind HTTPS and an authentication gateway.
2. In an eligible ChatGPT workspace, enable developer mode.
3. Create a custom app and enter the remote `/mcp` endpoint and authentication settings.
4. Scan and review every tool before enabling or publishing the app.
5. Open a new chat and select Keep Coding from the tools menu, or refer to it in the prompt.

Example:

> Use Keep Coding on `/home/me/projects/example`. Initialize the project, save a measurable phase plan using only operator-approved acceptance commands, implement each phase with the workspace tools, checkpoint every phase, and complete only after all evidence passes.

## Security model

- The HTTP listener defaults to loopback.
- Canonical paths and symlinks are checked against the allowed-root policy.
- Remote patches require an `IN_PROGRESS` phase and are rejected outside its `allowedScope`.
- Patches cannot target `.git/`, `.keep-coding/`, or create symbolic links.
- No generic remote shell tool is exposed.
- Checkpoint commands execute repository code, so the operator must explicitly list every permitted command.
- Keep roots narrow and exclude unrelated repositories, credentials, and sensitive data.

The built-in bearer option is not a complete OAuth server. Shared/public deployments should terminate TLS and authentication in a trusted tunnel or gateway and keep Keep Coding on a private interface.
