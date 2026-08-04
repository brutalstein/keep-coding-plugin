# Architecture

Keep Coding is a single-workflow, local-first continuity platform with an optional bounded HTTP MCP adapter.

## Layers

| Layer | Responsibility |
|---|---|
| Runtime adapters | Normalize Codex hooks, Claude-style hooks, or polling into sequence-aware continuity directives. |
| MCP/CLI | Validate explicit project roots and expose lifecycle, delta context, digest, graph, and workspace operations. |
| Service | Coordinate state, Git, graph indexing, verification, telemetry, playbook, and orchestration. |
| Store | Migration-safe SQLite source of truth for plan versions, phases, evidence, approvals, budgets, graph, worktrees, command failures, cursors, and events. |
| Semantic graph | Lazy TypeScript compiler AST plus bounded language adapters for symbols, imports, calls, references, tests, and blast radius. |
| Verifier | Scope → secret scan → budget → selective tests → acceptance commands → optional critic, with compressed command evidence. |
| Orchestrator | Isolated worktrees and merge-after-evidence for independent parallel-safe phases. |
| Dashboard | Loopback-only read-only HTML and JSON projection of durable state. |

## State and migrations

Old v0.1/v0.2 databases are upgraded additively. New phase states include `AWAITING_APPROVAL`, `REVERIFY_REQUIRED`, `BLOCKED_BUDGET`, and `SUPERSEDED`. Plan revisions and amendments are append-only records. Completed checkpoints remain attached to their original phase revision. Efficiency migrations add estimated-token telemetry, per-hook context cursors, command-failure history, and phase verification kinds without rewriting historical evidence.

## Adaptive planning

`amend_plan` can add phases and supersede inactive phases after implementation starts. It rejects in-progress supersession, duplicate IDs, invalid dependencies, cycles, exact no-op acceptance commands, and invalid budgets. It also returns non-blocking command-quality warnings when code-phase evidence lacks a recognizable verification category or unrelated phases reuse the same command.

## Context delivery

The append-only event sequence is the context version. `get_context` accepts `since_sequence` and omits `snapshot` by default:

- when the supplied sequence is current, the response is only `{ unchanged: true, sequence }` plus compact section metadata;
- when state changed, event types map to durable sections such as contract, active phase, approvals, budget, decisions, failures, checkpoints, graph, and playbook;
- only changed sections are rendered, followed by a one-line index of unchanged sections;
- `include_snapshot: true` is reserved for structured tooling and debugging.

Context-injecting hooks maintain a cursor per runtime, session, and hook name. Repeated `SessionStart`, `UserPromptSubmit`, `PreCompact`, or `PostCompact` events return bare `{ continue: true }` when no durable event occurred since the previous delivery. This guard removes redundant payload; it never removes a verification gate or durable record.

## Git-native checkpoints and parallelism

A passing checkpoint stages only the phase change set and creates a phase-scoped commit. Baseline restore is explicit. Parallel execution is conservative: every phase must be `READY`, `parallelSafe`, and have disjoint scope roots. Each receives a Git worktree and branch; verification runs in isolation and merge occurs only after passing evidence.

## Semantic impact and lazy expansion

TypeScript/JavaScript files use the TypeScript compiler AST, loaded lazily only when those files are indexed. Python and C-style languages use bounded structural adapters. The graph emits file, test, and symbol nodes plus `contains`, `imports`, `calls`, `references`, and `tested_by` edges.

Default context contains only a fixed-size Tier-0 graph summary. `expand_graph` returns Tier-1 node detail on explicit demand. `get_file_digest` projects an indexed file's content hash, line count, symbols, imports, and last modifying phase without sending the complete source file. `get_impact` returns distance and edge provenance. Changed files determine impacted tests, and completed phases move to `REVERIFY_REQUIRED` when later work touches their verified ownership.

## Verification, command evidence, and safety

Secret scanning is unconditional and stores only redacted previews and non-reversible fingerprints. Budgets merge project and phase limits using the stricter value. Deterministic commands remain authoritative. The critic is independent and optional; advisory output never blocks unless the contract explicitly makes it blocking. A blocking critic without a configured command fails closed.

Command output is normalized before storage or transmission: ANSI escapes, duplicate blank lines, duplicate adjacent lines, and Node internal frames are stripped; repeated failures are reduced to changed line windows; marker-aware truncation preserves context around `Error`, `FAIL`, `Exception`, `fatal`, `panic`, and assertion markers. Compression metadata records original/emitted size and unchanged-line counts.

## Token telemetry and regulation

When a runtime exposes token usage, adapters record it as actual usage. Otherwise Keep Coding estimates its own contribution from emitted context and command-output characters using an explicit four-characters-per-token approximation. Estimated tokens remain labeled. Context injects concise advice after 70% and 90% of a configured token budget, directing the agent toward deltas, file digests, graph expansion, and minimal diffs.

## Human approval

A phase may declare `requiresApproval`. `request_approval` records the question and pauses the project. Only `resolve_approval` can return it to `READY` or block it after rejection.

## Compounding memory

With `playbookOptIn`, successful work is stored as a compact tuple of pattern, trigger conditions, resolution, and applicability scope. Canonical signatures merge duplicates across projects and preserve source-project counts. Context surfaces only the top relevant entries for the active phase. Failure summaries use normalized signatures that remove timestamps, paths, line numbers, addresses, and incidental numeric values before deduplication.

## Remote transport and workspace safety

The Streamable HTTP adapter retains canonical allowed-root checks, Host and request-size validation, authentication boundaries, and exact acceptance-command allowlisting. Workspace writes are limited to phase-scoped unified patches and reject protected metadata paths and symbolic links. No generic remote shell tool is exposed.

## Observability and integrations

`keep-coding dashboard` binds only to loopback and exposes no mutation route. GitHub integration generates PR prose and commit messages from durable decisions and checkpoints. CI runs the full repository check on pushes and pull requests.

## Packaging

`scripts/build.mjs` creates one ESM executable while marking `typescript` external. The parser module has no top-level runtime dependency on the compiler; it performs a cached dynamic import only for TypeScript/JavaScript indexing. The production pipeline builds first, then executes the compiled artifact through version, hook, and full stdio MCP smoke tests. Plugin validation also runs the built CLI, so a module-evaluation crash cannot pass `npm run check`.
