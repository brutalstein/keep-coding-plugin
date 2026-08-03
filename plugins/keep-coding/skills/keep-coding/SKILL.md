---
name: keep-coding
description: Manage large, multi-file, multi-phase software projects with a durable project contract, adaptive dependency-aware phases, evidence gates, Git checkpoints, impact analysis, and resumable context. Use automatically for end-to-end projects, broad implementations, major migrations, architecture plus implementation, or whenever an active .keep-coding project exists.
---

# Keep Coding

Run one default evidence-gated workflow. Do not offer modes.

1. Use the current Git repository as `project_root` for every Keep Coding MCP call.
2. Call `initialize_project` idempotently before planning. Inspect the activation confidence and repository index rather than relying on prompt length alone.
3. Inspect the repository, then call `save_plan` with a measurable contract and an acyclic phase DAG. Give every phase tight `allowedScope`, real `acceptanceCommands`, optional budgets, and `requiresApproval` only when a material human decision is genuinely needed.
4. Consult `suggest_phases` only when the opt-in playbook is enabled. Treat suggestions as prior art, not authority.
5. Call `get_context`, then `start_phase`. Work only inside the active phase and its declared scope. Use `prepare_parallel_phases` only when at least two `READY` phases have independent scopes; keep each phase isolated in its returned worktree.
6. Record architectural and product decisions with `record_decision`. Record failed approaches with `record_failure`; change the approach instead of retrying the same fingerprint.
7. Use `get_impact` before changing shared files or symbols. When later changes invalidate completed evidence, complete every phase marked `NEEDS_REVERIFICATION` before project completion.
8. When repository discoveries change the plan after work begins, use `amend_plan` with a concrete reason. Add new phases or supersede only unstarted phases; never delete or rewrite completed checkpoint evidence.
9. Use `request_approval` for missing authority, credentials, destructive actions, or material product choices. Stop normally while a phase is `AWAITING_APPROVAL`; continue only after `resolve_approval` approves it.
10. Call `checkpoint_phase` after implementation and report budget usage when available. Scope, always-on secret scanning, selective impacted tests, deterministic acceptance commands, and any blocking critic result are authoritative. A passing checkpoint creates a Git commit for the phase.
11. Repair a failed checkpoint or use `restore_phase` to roll back only that phase's allowed scope to its captured baseline. Never use rollback to discard unrelated user changes.
12. Call `complete_project` only after every active phase is `COMPLETED`. It runs the inferred full-suite gate. Never claim completion while any phase is `FAILED`, `BLOCKED`, `BLOCKED_BUDGET`, `AWAITING_APPROVAL`, `NEEDS_REVERIFICATION`, or otherwise unfinished.

Preserve the one-workflow philosophy: advanced capabilities activate only when needed and otherwise degrade to the original serial v0.1 behavior.
