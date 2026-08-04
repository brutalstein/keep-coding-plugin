# Host integration

Keep Coding has one canonical executable and state model.

- **MCP stdio:** preferred for a trusted local repository.
- **Streamable HTTP:** bounded remote access; requires allowed roots and appropriate authentication.
- **Lifecycle hooks:** inject only changed durable context and enforce the stop guard.
- **Polling fallback:** `keep-coding poll <root> <sequence>` for MCP hosts without lifecycle hooks.

Hooks do not weaken or replace MCP verification. A hookless host remains fully functional; it refreshes durable state explicitly instead of receiving it automatically.
