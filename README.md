# Keep Coding

Keep Coding is a runtime-agnostic durable-memory and verification layer for long-running coding agents. It keeps one default workflow: contract → dependency-aware phases → implementation → evidence-backed checkpoint → completion. New capabilities activate only when used, and existing v0.1 repositories continue through additive SQLite migrations.

## Core guarantees

- A phase reaches `COMPLETED` only after scope, secret, budget, selective-test, acceptance-command, and configured critic gates finish.
- `complete_project` requires every active phase—including impact-triggered reverification—to be complete and runs configured full-suite commands.
- Plan amendments are versioned; completed evidence is never silently overwritten.
- Remote workspace access remains root-confined and patch writes remain phase-scoped.

## Platform capabilities

- Adaptive plan insertion and supersession after work starts
- Atomic Git commit per passing phase, scoped baseline restore, and isolated parallel worktrees
- Parser-backed multi-language semantic graph, `get_impact`, impacted-test selection, and completed-phase reverification
- Deterministic authoritative verification plus an optional independent critic command
- Human approval and enforceable token, cost, and wall-clock budgets
- Always-on secret scanning
- Opt-in cross-project playbook memory
- Loopback-only read-only dashboard
- Codex, Claude-style hook, and generic polling continuity adapters
- GitHub CI and decision-sourced PR-description generation

## Requirements and development

Node.js 22.13 or newer and Git are required.

```bash
npm ci
npm run check
```

The committed distributable is `plugins/keep-coding/dist/keep-coding.mjs`.

## CLI

```bash
keep-coding init /path/to/repo < project-prompt.md
keep-coding status /path/to/repo
keep-coding context /path/to/repo
keep-coding impact /path/to/repo src/core/service.ts
keep-coding dashboard /path/to/repo
keep-coding pr-description /path/to/repo
```

The dashboard binds to `127.0.0.1` by default. The optional independent critic is configured with `KEEP_CODING_CRITIC_COMMAND`; it receives JSON on stdin and returns `{ "passed": boolean, "summary": string, "findings": [] }`.

## MCP workflow

Initialize and save a plan, start ready phases, apply scoped edits, checkpoint, resolve any approval, budget, or reverification state, then call `complete_project`. `amend_plan` is the only supported way to change an active plan. `prepare_parallel_phases` creates worktree-isolated branches only for independent `parallelSafe` phases.

Normal ChatGPT can use the bounded `mcp-http` surface described in [docs/CHATGPT_APP.md](docs/CHATGPT_APP.md). Codex uses plugin hooks. Other runtimes can use the adapter layer or poll the CLI.

## Architecture and evaluation

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/EVALUATION.md](docs/EVALUATION.md), [SECURITY.md](SECURITY.md), and [docs/README.tr.md](docs/README.tr.md).
