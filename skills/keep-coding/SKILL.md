---
name: keep-coding
description: Run large or long-lived coding projects through durable contracts, dependency-aware phases, semantic impact analysis, assumption tracking, bounded corrections, evidence-gated checkpoints, budgets, approvals, and resumable context. Use when a task spans multiple files or sessions, requires measurable completion, or risks scope drift and repeated failed approaches.
license: MIT
compatibility: Requires Node.js 22.13+, Git, and a configured Keep Coding MCP server. Hooks are optional; hookless hosts use the polling command.
metadata:
  author: keep-coding-contributors
  version: "0.4.0"
---

# Keep Coding

Use one evidence-gated workflow. Do not offer alternate modes.

1. Use the active Git repository as `project_root` and initialize idempotently.
2. Inspect the repository, define measurable deliverables and invariants, then save an acyclic phase plan with narrow scopes and phase-specific verification commands.
3. Start only dependency-ready phases. Use isolated worktrees only for phases marked `parallelSafe` whose scopes are disjoint.
4. Persist architectural decisions, failed approaches, assumptions, approvals, and budget usage instead of relying on conversation memory.
5. Change an active plan only through `amend_plan`; preserve completed evidence and state the reason for every amendment.
6. Use `get_impact`, `get_file_digest`, and selective tests before broad changes. Reserve full-suite verification for `complete_project`.
7. Treat scope, secrets, budgets, approvals, correction radii, command results, and required reverification as authoritative gates.
8. Checkpoint each phase only after its implementation and evidence are complete. Repair failed gates rather than narrating completion.
9. Call `complete_project` only after every active phase and every impact-triggered reverification passes.

## Token-efficient operation

- Use `get_context` with the last returned `sequence`; do not retransmit an unchanged snapshot.
- Request `include_snapshot: true` only for structured diagnostics.
- Read `get_file_digest` before a whole file when orientation is sufficient.
- Keep the default Tier-0 graph summary and call `expand_graph` only for exact dependency detail.
- Follow 70% and 90% budget advisories with minimal diffs, bounded reads, and command-output deltas.

## Assumption and correction protocol

- Record an actionable uncertain interpretation with `record_assumption` before implementation. Include honest confidence and rejected alternatives.
- Link the exact file, symbol, test, or decision nodes created because of it with `link_assumption`.
- Confirm it with evidence through `confirm_assumption`, or invalidate it through `invalidate_assumption` when it is wrong.
- Do not apologize and restart broad work. Do not broadly re-read the project. Use the returned cycle-safe blast radius as the correction boundary.
- Expand a radius only with `expand_correction_scope`, exact additional node IDs, and a concrete non-empty justification before editing them.
- Resolve every open assumption below the contract threshold before checkpointing. A low-confidence assumption forces blocking critic review.

## Host behavior

Lifecycle hooks improve automatic context injection but are not required. In a host without hooks, call:

```text
keep-coding poll <project-root> <last-sequence>
```

Use the returned context and carry its sequence into the next poll. The MCP lifecycle and all verification gates remain identical across hosts.

See [MCP tool policy](references/MCP_TOOLS.md) for the compact tool ordering and [host integration](references/HOST_INTEGRATION.md) for stdio, HTTP, hooks, and polling behavior.

Never claim completion while durable state reports unfinished, failed, blocked-budget, awaiting-approval, open low-confidence assumptions, or reverify-required work.
