# Architecture

Keep Coding 0.2 keeps one default evidence-gated workflow and adds capabilities only when a project requires them. Local Codex hooks, Claude-style lifecycle adapters, generic polling runtimes, and the optional remote MCP transport all use the same repository-scoped service and SQLite ledger.

## Boundaries

| Layer | Responsibility | Must not do |
|---|---|---|
| Skill | Tell an agent how to use the single workflow | Pretend checks passed |
| Runtime adapters | Normalize lifecycle events and context/stop responses | Mutate project files |
| MCP server | Validate inputs and expose lifecycle/workspace operations | Keep process-global project state |
| HTTP adapter | Authenticate, bound requests, validate Host, and restrict roots/commands | Expose unrestricted filesystem or shell access |
| Workspace tools | Read/search/diff and apply phase-scoped patches | Escape the Git root or bypass phase scope |
| Service | Coordinate Git, graph, storage, playbook, orchestration, and verification | Bypass the state machine |
| Store | Persist contracts, phase versions, events, evidence, approvals, and graph | Execute shell commands |
| Verifier | Enforce invariants and execute declared checks | Promote phases directly |
| Orchestrator | Prepare and merge isolated phase worktrees | Spawn an unrestricted agent or merge failing work |
| Dashboard | Render read-only local state | Bind beyond loopback or expose writes |
| Evaluator | Run controlled paired experiments | Score subjective quality internally |

## State machines

A project moves through `PLANNING → ACTIVE → READY_TO_COMPLETE → COMPLETED`, with `BLOCKED` as an intervention state.

A phase may move through:

```text
PENDING → READY → IN_PROGRESS → VERIFYING → COMPLETED
                    │              ├→ FAILED → IN_PROGRESS
                    │              ├→ BLOCKED
                    │              └→ BLOCKED_BUDGET
                    ├→ AWAITING_APPROVAL → READY | BLOCKED
COMPLETED → NEEDS_REVERIFICATION → IN_PROGRESS
PENDING | READY | FAILED → SUPERSEDED
```

Dependencies become `READY` in the same transaction that records a passing checkpoint. `SUPERSEDED` phases remain in the ledger but no longer block completion. Completed evidence is never deleted or silently replaced.

## Adaptive plans

`save_plan` creates the initial DAG. Once work begins, `amend_plan` is the only plan mutation path. An amendment:

- increments `project.planVersion`;
- records its reason and affected phase IDs in the append-only event log;
- may add new phases;
- may supersede only phases that have not started verification or completed;
- preserves all checkpoint, decision, and failure lineage.

Existing v0.1 databases are migrated additively. New phase columns and the approvals table are created with defaults, and older checkpoint JSON is normalized on read.

## Git checkpoints and recovery

At first phase start Keep Coding captures two baselines:

1. a content-hash snapshot used for scope comparison;
2. a bounded content snapshot of only the phase's `allowedScope` used for recovery.

A passing checkpoint stages only verified changed files and creates a phase commit with a deterministic local identity. Failed or budget-blocked phases can call `restore_phase`; recovery touches only files matching that phase's scope, so unrelated user changes are preserved.

Independent `READY` phases can be prepared as sibling Git worktrees. Scope-overlap screening is conservative. Keep Coding returns the isolated workspace and branch metadata; the host runtime may run agents concurrently there. Merge and discard are explicit operations.

## Verification pipeline

The checkpoint pipeline is ordered so cheap safety invariants fail before expensive commands:

1. compute files changed since the phase baseline;
2. enforce minimatch scope;
3. scan added diff lines for private keys, known token formats, suspicious assignments, and high-entropy credential values;
4. enforce the tighter of project and phase token/cost/wall-clock budgets;
5. derive impacted tests from the semantic graph and run a supported selective test command;
6. run every declared acceptance command in order, stopping on the first failure;
7. optionally invoke an independent critic adapter.

Deterministic checks remain authoritative. The critic is advisory by default and becomes blocking only when the contract explicitly requests it. It is configured as a JSON argv array in `KEEP_CODING_CRITIC_COMMAND_JSON`; no shell interpolation is used.

`complete_project` first requires every active phase to be `COMPLETED`, then runs an inferred full-suite command (`npm run check`, `npm test`, or `python -m pytest`) before changing project status.

## Semantic graph and impact analysis

The graph stores files, tests, symbols, phases, requirements, and decisions. Edges include imports, containment, calls, references, phase dependencies, modifications, verification relationships, and supersession.

JavaScript and TypeScript use the TypeScript compiler AST. Python currently uses a structural parser behind the same adapter boundary; unsupported languages degrade to file-level indexing. The adapter design permits tree-sitter or language-server parsers without changing MCP contracts or the SQLite graph schema.

`get_impact` performs bounded bidirectional graph traversal and reports affected files, symbols, tests, phases, and the traversed relationships. Before a checkpoint is finalized, files owned by earlier completed checkpoints are detected. Those phases move to `NEEDS_REVERIFICATION` and must pass again before completion.

## Budgets, approvals, and playbook memory

Project and phase budgets are optional. A phase exceeding a declared limit receives `BLOCKED_BUDGET`, distinct from a failed command or exhausted retry budget.

`request_approval` creates an auditable pending record and moves the phase to `AWAITING_APPROVAL`. Approval returns it to `READY`; rejection blocks it. Stop hooks release normally while waiting for a human rather than forcing an agent continuation loop.

Cross-project playbook memory is opt-in through `KEEP_CODING_PLAYBOOK=1`. It uses a separate SQLite database under the user's home directory and stores reusable phase templates and normalized failure fingerprints. Repository source is not copied into the playbook. Suggestions never bypass planning validation.

## Runtime continuity

`ContinuityAdapter` normalizes lifecycle events while keeping platform-specific response envelopes outside the core service:

- `CodexContinuityAdapter` supports current plugin hooks;
- `ClaudeCodeContinuityAdapter` is a reference hook mapping;
- `PollingContinuityAdapter` supports runtimes that periodically request durable context.

The generic CLI command is `keep-coding poll <repository>`.

## Observability

`keep-coding dashboard <repository>` starts a local read-only HTTP view. It binds only to `127.0.0.1`, `::1`, or `localhost`, applies no-store and CSP headers, exposes only `GET /` and `GET /api/status`, and polls the same SQLite snapshot used by MCP. It renders phase state, dependencies, checkpoint evidence, budgets, approvals, and the event stream.

## Remote transport

`mcp-http` uses the MCP SDK's per-request Streamable HTTP handler. Before service access it applies request-size limits, Host allowlisting, authentication, canonical root allowlisting, and an exact operator-owned acceptance-command allowlist. Remote editing remains limited to bounded reads/search/diffs and phase-scoped unified patches checked with `git apply --check`.

## CI and GitHub integration

The repository workflow runs `npm ci` and `npm run check` on supported Node versions and uploads the generated distribution. `keep-coding pr-description` renders a PR body from the durable contract, phase status, decisions, and checkpoint evidence. Checkpoint commit-message generation uses the same evidence records.

## Packaging

`scripts/build.mjs` bundles the TypeScript server, HTTP adapter, runtime adapters, dashboard, hook runner, CLI, evaluator, semantic parser, and workspace tools into one ESM executable. Codex uses stdio; remote ChatGPT deployments use `mcp-http`; other runtimes can use hooks or polling without changing storage semantics.
