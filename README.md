# Keep Coding

Keep Coding is a runtime-agnostic durable-memory and verification layer for long-running coding agents. It keeps one default workflow: contract → dependency-aware phases → implementation → evidence-backed checkpoint → completion. Existing v0.1/v0.2 state databases continue through additive SQLite migrations.

## Status

**Current release: v0.3.0.** This release adds an assumption ledger and bounded blast-radius correction protocol on top of the v0.2.1 evidence and token-efficiency platform. Wrong interpretations are now durable graph entities: the agent records them before implementation, links the artifacts that depend on them, invalidates them into a computed correction radius, and cannot silently edit outside that radius.

## Core guarantees

- A phase reaches `COMPLETED` only after scope, secret, budget, selective-test, acceptance-command, and configured critic gates finish.
- `complete_project` requires every active phase—including impact-triggered reverification—to be complete and runs configured full-suite commands.
- Plan amendments are versioned; completed evidence is never silently overwritten.
- Remote workspace access remains root-confined and patch writes remain phase-scoped.
- `npm run check` executes the built production artifact; source-only green tests cannot mask a broken distributable.
- Low-confidence open assumptions and high-ambiguity phases cannot pass a checkpoint without explicit resolution.
- Correction edits are restricted to the intersection of the phase scope and the computed/justifiably expanded blast radius.

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
- Durable assumptions linked to exact files, symbols, and decisions
- Cycle-safe, hop-limited correction blast radii with contained/expanded outcome tracking
- Bilingual ambiguity pre-flight, blocking low-confidence critic escalation, and non-blocking apology-language correction nudges
- Cross-project correction anti-patterns with measured hit rate and deduplication
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

Verified source suite: 107 tests across 26 files. The post-build artifact suite adds four compiled-binary scenarios, and the context benchmark runs separately.

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

## Assumption and correction protocol

When an interpretation is uncertain, call `record_assumption` before editing, then `link_assumption` to the exact graph nodes that were built because of it. Resolve it with `confirm_assumption`, or call `invalidate_assumption` to compute a bounded correction radius. A correction checkpoint may touch only files inside both the original phase scope and that radius. `expand_correction_scope` requires a non-empty justification and records the expansion for review.

The default confidence threshold is `0.6` and can be changed with `contract.assumptionConfidenceThreshold`. Matching contained corrections can be promoted into the opt-in playbook as anti-patterns and surfaced before the same mistake is repeated. Evaluation reports include containment rate, Wilson 95% confidence interval, project-scoped tokens per correction, anti-pattern hit rate, and an optional enabled-vs-disabled paired comparison.

## Architecture and evaluation

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/EVALUATION.md](docs/EVALUATION.md), [SECURITY.md](SECURITY.md), and [docs/README.tr.md](docs/README.tr.md).
