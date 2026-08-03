# Architecture

Keep Coding is a single-workflow, local-first continuity platform with an optional bounded HTTP MCP adapter.

## Layers

| Layer | Responsibility |
|---|---|
| Runtime adapters | Normalize Codex hooks, Claude-style hooks, or polling into continuity directives. |
| MCP/CLI | Validate explicit project roots and expose lifecycle and workspace operations. |
| Service | Coordinate state, Git, graph indexing, verification, playbook, and orchestration. |
| Store | Migration-safe SQLite source of truth for plan versions, phases, evidence, approvals, budgets, graph, worktrees, and events. |
| Semantic graph | TypeScript AST plus language adapters for symbols, imports, calls, references, tests, and blast radius. |
| Verifier | Scope → secret scan → budget → selective tests → acceptance commands → optional critic. |
| Orchestrator | Isolated worktrees and merge-after-evidence for independent parallel-safe phases. |
| Dashboard | Loopback-only read-only HTML and JSON projection of durable state. |

## State and migrations

Old v0.1 databases are upgraded additively. New phase states include `AWAITING_APPROVAL`, `REVERIFY_REQUIRED`, `BLOCKED_BUDGET`, and `SUPERSEDED`. Plan revisions and amendments are append-only records. Completed checkpoints remain attached to their original phase revision.

## Adaptive planning

`amend_plan` can add phases and supersede inactive phases after implementation starts. It rejects in-progress supersession, duplicate IDs, invalid dependencies, cycles, no-op acceptance commands, and invalid budgets. Events record the reason, added phases, superseded phases, and plan version.

## Git-native checkpoints and parallelism

A passing checkpoint stages only the phase change set and creates a phase-scoped commit. Baseline restore is explicit. Parallel execution is conservative: every phase must be `READY`, `parallelSafe`, and have disjoint scope roots. Each receives a Git worktree and branch; verification runs in isolation and merge occurs only after passing evidence.

## Semantic impact and testing

The index is parser-backed rather than regex-only. It emits file, test, and symbol nodes plus `contains`, `imports`, `calls`, `references`, and `tested_by` edges. `get_impact` returns distance and edge provenance. Changed files determine a minimal impacted-test list when a contract provides `selectiveTests.commandTemplate`. Project completion reserves `fullSuiteCommands` as the authoritative final gate. If a later phase touches files previously owned by a completed phase, that phase moves to `REVERIFY_REQUIRED`.

## Verification and safety

Secret scanning is unconditional and stores only redacted previews and non-reversible fingerprints. Budgets merge project and phase limits using the stricter value. Deterministic commands remain authoritative. The critic is independent and optional; advisory output never blocks unless the contract explicitly makes it blocking. A blocking critic without a configured command fails closed.

## Human approval

A phase may declare `requiresApproval`. `request_approval` records the question and pauses the project. Only `resolve_approval` can return it to `READY` or block it after rejection.

## Compounding memory

With `playbookOptIn`, successful phase templates and failure fingerprints are stored in a separate user-level SQLite database. Projects never write cross-project memory without this explicit contract flag.

## Remote transport and workspace safety

The Streamable HTTP adapter retains canonical allowed-root checks, Host and request-size validation, authentication boundaries, and exact acceptance-command allowlisting. Workspace writes are limited to phase-scoped unified patches and reject protected metadata paths and symbolic links. No generic remote shell tool is exposed.

## Observability and integrations

`keep-coding dashboard` binds only to loopback and exposes no mutation route. GitHub integration generates PR prose and commit messages from durable decisions and checkpoints. CI runs the full repository check on pushes and pull requests.

## Packaging

`scripts/build.mjs` bundles the server, adapters, hook runner, CLI, evaluator, dashboard, semantic parser, and workspace tools into one ESM executable.
