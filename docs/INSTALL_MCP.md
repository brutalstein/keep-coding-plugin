# Host-agnostic installation

Keep Coding ships one canonical Node.js executable. Codex and Claude plugins are packaging layers around the same MCP server and SQLite state model; other MCP clients use the executable directly.

## Requirements

- Node.js 22.13 or newer
- Git
- a trusted local clone of this repository or a release artifact containing `plugins/keep-coding/dist/`

## Local stdio MCP

Build and validate once:

```bash
npm ci
npm run check
```

Configure the client with an absolute path. The portable shape is in `examples/mcp/stdio.json`:

```json
{
  "mcpServers": {
    "keep_coding": {
      "command": "node",
      "args": ["/absolute/path/to/plugins/keep-coding/dist/keep-coding.mjs", "mcp"]
    }
  }
}
```

The process receives target repositories explicitly through each MCP tool's `project_root`; do not rely on the client's working directory.

### Claude Code

Project-scoped stdio registration:

```bash
claude mcp add --scope project --transport stdio keep_coding -- \
  node /absolute/path/to/plugins/keep-coding/dist/keep-coding.mjs mcp
```

The bundled Claude plugin is also loadable directly during development:

```bash
claude --plugin-dir ./plugins/keep-coding
```

Its `.claude-plugin/plugin.json`, Claude-specific hooks, and MCP manifest all point to the same executable.

### Codex plugin

The existing `.agents/plugins/marketplace.json` and `plugins/keep-coding/.codex-plugin/plugin.json` package the same MCP server, skill, and lifecycle hook protocol for Codex.

## Streamable HTTP

Start the bounded HTTP transport only with explicit roots and authentication configuration:

```bash
KEEP_CODING_ALLOWED_ROOTS=/absolute/repo \
KEEP_CODING_BEARER_TOKEN=replace-me \
node plugins/keep-coding/dist/keep-coding.mjs mcp-http
```

Use the configuration shape in `examples/mcp/streamable-http.json`. Keep the default loopback bind unless an authenticated reverse proxy and TLS boundary are already in place. The built-in bearer token is not an OAuth provider.

## Hookless clients

MCP remains fully functional without lifecycle hooks. Refresh changed durable context explicitly:

```bash
node plugins/keep-coding/dist/keep-coding.mjs poll /absolute/repo 42
```

The final argument is the last delivered sequence. An unchanged project returns the compact unchanged envelope; a changed project returns only changed sections plus the new sequence.

## Skill-only discovery

The canonical Agent Skills directory is `skills/keep-coding/`. It follows the open `SKILL.md` format and has focused references for MCP policy and host integration. Plugin copies are checked byte-for-byte in CI so behavioral instructions cannot drift between hosts.

## Security boundary

Connecting an MCP server grants the host the tools exposed by that server. Keep roots narrow, review write permissions, preserve command allowlists for HTTP deployment, and treat repository content as untrusted input. See `SECURITY.md`.
