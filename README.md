# Keep Coding

Keep Coding is a runtime-agnostic durable-memory and verification layer for long-running coding agents. It keeps one default workflow: contract → dependency-aware phases → implementation → evidence-backed checkpoint → completion. Existing v0.1/v0.2 state databases continue through additive SQLite migrations.

## Status

**Current release: v0.2.1.** This release fixes the v0.2.0 production bundle crash, makes the compiled artifact executable in CI, and adds token-efficient context delivery. The v0.2 platform capabilities remain intact: adaptive replanning, worktree parallelism, semantic impact analysis, budgets, approvals, critic review, dashboard, and GitHub integration.

## Core guarantees

- A phase reaches `COMPLETED` only after scope, secret, budget, selective-test, acceptance-command, and configured critic gates finish.
- `complete_project` requires every active phase—including impact-triggered reverification—to be complete and runs configured full-suite commands.
- Plan amendments are versioned; completed evidence is never silently overwritten.
- Remote workspace access remains root-confined and patch writes remain phase-scoped.
- `npm run check` executes the built production artifact; source-only green tests cannot mask a broken distributable.

## Platform capabilities

- Adaptive plan insertion and supersession after work starts
- Atomic Git commit per passing phase, scoped baseline restore, and isolated parallel worktrees
- Parser-backed TypeScript/JavaScript graph plus bounded language adapters, impact analysis, selective tests, and reverification
- Deterministic verification plus optional independent critic review
- Human approval and enforceable token, cost, and wall-clock budgets
- Always-on secret scanning and non-blocking acceptance-command quality warnings
- Sequence-aware delta context and per-session unchanged-hook suppression
- Tier-0 semantic summaries with explicit Tier-1 `expand_graph`
- Indexed `get_file_digest` for low-token orientation before full file reads
- Failure-output diffing, marker-aware truncation, normalized failure clustering, and token telemetry
- Compact opt-in cross-project playbook patterns
- Loopback-only read-only dashboard
- Codex, Claude-style hook, and generic polling continuity adapters
- GitHub CI and decision-sourced PR-description generation

## Requirements and development

Node.js 22.13 or newer and Git are required.

```bash
npm ci
npm run check
```

`npm run check` runs lint, strict TypeScript, source coverage, production build, compiled-artifact smoke tests, the context payload benchmark, documentation/version checks, and plugin validation. The committed distributable is `plugins/keep-coding/dist/keep-coding.mjs`.

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

## MCP workflow and token-efficient usage

Initialize and save a plan, start ready phases, apply scoped edits, checkpoint, resolve any approval, budget, or reverification state, then call `complete_project`. `amend_plan` is the only supported way to change an active plan.

Use `get_context` without `include_snapshot` for normal reasoning. Pass the last `sequence` as `since_sequence`; an unchanged project returns a near-zero `{ "unchanged": true, "sequence": ... }` response. Request `include_snapshot: true` only for structured tooling or debugging. Prefer `get_file_digest` before a full file read, and call `expand_graph` only when exact dependency nodes are needed.

Normal ChatGPT can use the bounded `mcp-http` surface described in [docs/CHATGPT_APP.md](docs/CHATGPT_APP.md). Codex uses plugin hooks. Other runtimes can use the adapter layer or poll the CLI.

## Architecture and evaluation

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/EVALUATION.md](docs/EVALUATION.md), [SECURITY.md](SECURITY.md), and [docs/README.tr.md](docs/README.tr.md).
