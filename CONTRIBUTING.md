# Contributing

Use Node.js 22.13 or newer. Create focused changes and run:

```bash
npm ci
npm run check
```

New state transitions require tests for successful and rejected paths. New MCP tools require protocol discovery tests, bounded inputs, explicit project roots, and documentation. Never weaken verification by accepting no-op commands or model-authored claims as evidence.

Keep v1's single default workflow intact. Propose schema migrations with backward-compatibility notes and benchmark graph changes on large repositories.

