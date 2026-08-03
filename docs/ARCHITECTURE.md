# Architecture

Keep Coding is single-workflow and local-first, with an optional remote MCP adapter for normal ChatGPT chats.

## Boundaries

| Layer | Responsibility | Must not do |
|---|---|---|
| Skill | Tell Codex when and how to use the workflow | Pretend checks passed |
| Hooks | Activate, restore context, and guard stopping in Codex | Mutate source code |
| MCP server | Validate inputs and expose lifecycle/workspace operations | Keep process-global project state |
| HTTP adapter | Authenticate, bound requests, validate Host, and restrict roots/commands | Expose unrestricted filesystem or shell access |
| Workspace tools | Read/search/diff and apply phase-scoped patches | Escape the Git root or bypass phase scope |
| Service | Coordinate Git, graph indexing, storage, workspace, and verification | Bypass the state machine |
| Store | Persist contracts, phases, events, evidence, and graph | Execute shell commands |
| Verifier | Enforce phase scope, scan changed files for secrets, and execute declared checks | Promote phases directly |
| Evaluator | Run controlled paired experiments | Score subjective quality internally |

## State machine

A project moves through `PLANNING → ACTIVE → READY_TO_COMPLETE → COMPLETED`, with `BLOCKED` as an intervention state. A phase moves through `PENDING → READY → IN_PROGRESS → VERIFYING → COMPLETED`. Failed evidence produces `FAILED` until the attempt budget is exhausted, then `BLOCKED`.

Dependent phases become `READY` only in the same database transaction that records a passing checkpoint. Completion is rejected unless all phases are `COMPLETED`.

At first phase start, Keep Coding stores a content-hash snapshot of the working tree. Scope verification compares against that snapshot, not `HEAD`, so pre-existing edits and files changed by earlier verified phases do not contaminate the current phase.

## Verification pipeline

Every checkpoint runs the following gates in order:

1. compute the changed-file set from the phase baseline;
2. enforce the phase's declared `allowedScope` patterns;
3. scan every changed text file for private-key markers, provider token formats, suspicious secret assignments, and high-entropy credential candidates;
4. execute the phase's declared acceptance commands only when scope and secret scanning pass.

Secret scanning is an invariant rather than a plan option. A phase author cannot disable it or omit it from `acceptanceCommands`. Binary files and text files larger than 2 MiB are skipped to keep verification bounded. Findings store a rule identifier, path, line, non-reversible fingerprint, and redacted preview; raw secret values are never persisted in checkpoint evidence.

## Persistence

Each target Git repository owns one `.keep-coding/state.db`. SQLite uses WAL mode, foreign keys, and a busy timeout. The append-only event sequence lets the Codex Stop hook distinguish real progress from a continuation loop.

Normal ChatGPT does not execute Codex hooks. It uses the same persisted state through explicit MCP calls, so the app must be selected or invoked in the conversation.

## Remote transport

`mcp-http` uses the MCP SDK's per-request Streamable HTTP handler. Project state remains repository-scoped in SQLite. Before service access, the adapter applies:

1. request-size limits;
2. HTTP Host allowlisting;
3. an authentication boundary;
4. canonical project-root allowlisting.

The operator also supplies an exact acceptance-command allowlist. It is checked when a remote plan is saved and again immediately before a checkpoint, including plans created by an earlier local session.

## Workspace tools

The remote surface is narrower than a coding-agent shell:

- bounded file listing and text reads;
- bounded literal text search;
- bounded Git diff;
- unified patches checked with `git apply --check`;
- active-phase and `allowedScope` enforcement;
- protected metadata paths and symbolic-link patch rejection.

No arbitrary process-execution tool is exposed. Only checkpoint commands already approved by the server operator can run.

## Code graph

The index stores file nodes, common JavaScript/TypeScript/Python symbols, relative imports, phase dependencies, decisions, and phase-to-file modification edges. Passing checkpoints refresh hashes and structural relationships. This is a continuity graph, not language-server-grade semantic analysis.

## Packaging

`scripts/build.mjs` bundles the TypeScript server, HTTP adapter, hook runner, CLI, evaluator, and workspace tools into one ESM executable. Codex uses the local stdio command; normal ChatGPT deployments start the same executable with `mcp-http` and connect the remote endpoint as a custom app.
