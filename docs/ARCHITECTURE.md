# Architecture

Keep Coding is intentionally local-first and single-workflow.

## Boundaries

| Layer | Responsibility | Must not do |
|---|---|---|
| Skill | Tell Codex when and how to use the workflow | Pretend checks passed |
| Hooks | Activate, restore context, and guard stopping | Mutate source code |
| MCP server | Validate inputs and expose lifecycle operations | Keep process-global project state |
| Service | Coordinate Git, graph indexing, storage, and verification | Bypass the state machine |
| Store | Persist contracts, phases, events, evidence, and graph | Execute shell commands |
| Verifier | Enforce phase scope and execute declared checks | Promote phases directly |
| Evaluator | Run controlled paired experiments | Score subjective quality internally |

## State machine

A project moves through `PLANNING → ACTIVE → READY_TO_COMPLETE → COMPLETED`, with `BLOCKED` as an explicit terminal intervention state. A phase moves through `PENDING → READY → IN_PROGRESS → VERIFYING → COMPLETED`. Failed evidence produces `FAILED` until the attempt budget is exhausted, then `BLOCKED`.

Dependent phases become `READY` only inside the same database transaction that records a passing checkpoint. Completion is rejected unless all phases are `COMPLETED`.

At first phase start, Keep Coding stores a content-hash snapshot of the working tree. Scope verification compares against that snapshot, not against `HEAD`, so pre-existing user edits and files changed by earlier verified phases do not contaminate the current phase. Failed retries retain the original baseline.

## Persistence

Each target Git repository owns one `.keep-coding/state.db`. SQLite runs in WAL mode with foreign keys and a busy timeout. The append-only event sequence is used by the Stop hook to distinguish real new progress from a continuation loop.

## Code graph

The v1 index stores file nodes, common JavaScript/TypeScript/Python symbol nodes, relative import edges, phase dependencies, decisions, and phase-to-file modification edges. Every passing checkpoint refreshes file content hashes and structural relationships. Context retrieval tokenizes the active phase and queries only relevant graph nodes before applying a fixed character budget.

This is a fast continuity graph, not language-server-grade semantic analysis. Parser adapters can be added without changing MCP contracts or the state schema.

## Packaging

`scripts/build.mjs` bundles the TypeScript server, hook runner, CLI, and evaluator into one ESM executable. The plugin manifest points to a relative `.mcp.json`; hook commands use `PLUGIN_ROOT`, so a marketplace installation does not depend on the source checkout path.
