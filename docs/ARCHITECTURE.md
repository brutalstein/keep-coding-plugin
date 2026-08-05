# Architecture

Keep Coding is a single-workflow, local-first continuity platform with an optional bounded HTTP MCP adapter.

## Layers

| Layer | Responsibility |
|---|---|
| Runtime adapters | Normalize Codex hooks, Claude-style hooks, or polling into sequence-aware continuity directives. |
| MCP/CLI | Validate explicit project roots and expose lifecycle, delta context, digest, graph, and workspace operations. |
| Service | Coordinate state, Git, graph indexing, verification, telemetry, playbook, and orchestration. |
| Store | Migration-safe SQLite source of truth for plan versions, phases, evidence, approvals, budgets, graph, worktrees, command failures, cursors, and events. |
| Semantic graph | TypeScript compiler AST plus hash-verified WASM tree-sitter adapters for Python, C, and C++; emits symbols, imports, calls, references, tests, symbol equivalence, and blast radius. |
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

Checkpoint execution is a durable saga rather than an in-memory sequence. `checkpoint_runs` journals verification, exact diff binding, Git commit or merge SHA, durable phase-state commit, indexing, reverification, playbook memory, and worktree cleanup. A lease heartbeat and compare-and-swap phase transition prevent concurrent checkpoint owners. Git commits and merges carry deterministic run trailers, so startup recovery can identify an already-applied operation without duplicating it. Budget telemetry, critic evidence, checkpoint rows, playbook writes, and audit events use run-scoped receipts or uniqueness constraints. Recovery automatically resets evidence-free interrupted verification, replays proven steps, cleans merged worktrees, and fails closed when repository history or workspace bytes no longer match the recorded evidence.

## Semantic impact and lazy expansion

TypeScript/JavaScript files use the TypeScript compiler AST, loaded lazily only when those files are indexed. Python, C, and C++ use pinned `web-tree-sitter` WASM grammars and language-specific query assets. Every sidecar is verified against a SHA-256/byte-count manifest before the first parse in an asset directory. Parsing and query execution are time-bounded and capped; failure is explicit and degrades to the retained legacy structural parser. The graph emits file, test, and symbol nodes plus `contains`, `imports`, `calls`, `references`, `tested_by`, and header/source `same_symbol` edges.

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

`scripts/build.mjs` creates one ESM executable while marking `typescript` external, then copies the tree-sitter runtime, grammars, queries, and integrity manifest into `dist/grammars`. The parser performs cached lazy initialization. The production pipeline verifies the complete distribution directory, executes version/hook/MCP/assumption/native-parser scenarios, and refuses stale generated files. The executable remains under the 3 MB guard; parser sidecars have a separate 8 MB budget.

## Assumption ledger and bounded correction

An assumption is a first-class durable entity, separate from a technical failure or architectural decision. Each assumption records its phase, statement, self-reported confidence, considered alternatives, terminal status, and resolution evidence. Recording an assumption creates an `assumption` graph node. `link_assumption` adds `depends_on_assumption` edges to exact file, symbol, or decision nodes; a checkpoint auto-links changed files only when exactly one open phase assumption exists and no explicit link was recorded.

Invalidation creates a correction record with a cycle-safe, hop-limited traversal result. The traversal starts only from explicit assumption dependencies; an assumption with no links produces an empty radius rather than an all-project fallback. Correction verification uses the intersection of the original phase globs and the correction's declared files. Scope can grow only through `expand_correction_scope` with a non-empty justification. The next checkpoint records `contained` when all changes stay in the original radius, or `expanded` when justified extra nodes were required; unauthorized extra files use the normal scope-violation path.

Open assumptions and known corrections are normal delta-context sections. `assumption_*`, `correction_*`, and anti-pattern warning events participate in sequence-based change classification, so adding this subsystem does not reintroduce full-context retransmission. Low-confidence assumptions render an imperative directive. High-ambiguity phases must record an assumption before checkpointing, and open low-confidence assumptions force an independent blocking critic invocation before the structural checkpoint rejection.

Contained corrections may be promoted, only with playbook opt-in, into structured `anti_pattern` records. Matching uses the same bounded keyword-overlap approach as phase templates; deduplication reuses the normalized failure-signature utility. A matching warning is counted once per phase/pattern and is injected before a new assumption is formed.

## Assumption evaluation boundary

The evaluation configuration accepts `assumptionLedger.enabled`. When enabled, reports may include correction outcomes and token counters, anti-pattern warning/matching counts, and paired enabled/disabled outcomes. The resulting section reports containment rate with an existing Wilson 95% interval, project-scoped tokens per completed correction, anti-pattern hit rate, and an exact McNemar comparison. When disabled, the runner does not emit a subsystem section or create project ledger persistence.


## Storage decomposition

`ProjectStore` remains the compatibility facade used by the service and `PlatformStore`, but infrastructure concerns no longer live in one file. `migrations.ts` owns additive schema creation, `validation.ts` owns contract/phase/budget invariants, and `row-mappers.ts` owns scalar coercion and durable-record mapping. Existing project databases and public store methods are unchanged. This split keeps migration review, validation review, and persistence-shape review independent without introducing an abstraction layer over SQLite transactions.

## Cross-agent distribution

The canonical implementation is the same `dist/keep-coding.mjs` MCP backend for every host. A single Agent Skills source is byte-compared with the Codex and Claude package copies. Codex and Claude add only host-specific manifests and lifecycle hook commands. Hosts with MCP but no lifecycle hooks call the sequence-aware `poll` command. Distribution validation checks version parity, manifest shape, MCP arguments, hook runtime identity, and canonical skill hashes.

## Evaluation corpus

The corpus runner accepts exactly 20-30 frozen tasks, materializes each seed as a fresh Git repository, creates detached paired worktrees, counterbalances treatment order, and invokes agent/verifier commands as argv arrays without shell interpolation. Verifier contracts remain outside the mutable worktree. Every record includes the starting SHA and prompt hash. Reports use Wilson 95% intervals and the existing exact McNemar implementation. Missing provider executables or credentials are treated as an absent experiment, never as synthetic success data.

## Tier-2 semantic enrichment boundary

Pyright and clangd remain deferred. Tree-sitter establishes correct local syntax and lexical scope without requiring a project build configuration. Cross-module type binding, macro expansion, conditional preprocessing, template instantiation, and overload resolution require compiler/LSP processes. Those subprocesses will only be introduced as explicit opt-ins after the frozen corpus produces real Python/C++ evidence and after their timeout, binary-discovery, cache, and security boundaries are specified.
