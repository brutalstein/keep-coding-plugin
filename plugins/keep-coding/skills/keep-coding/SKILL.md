---
name: keep-coding
description: Manage large, multi-file, multi-phase software projects in Codex with a durable project contract, dependency-aware phases, verification gates, checkpoints, and resumable context. Use automatically when a user requests an end-to-end project, broad implementation, major migration, architecture plus implementation, or work likely to span many tools or context compactions; also use whenever an active .keep-coding project exists in the repository.
---

# Keep Coding

Run one evidence-gated workflow. Do not offer modes.

1. Use the current Git repository as `project_root` for every Keep Coding MCP call.
2. Call `initialize_project` idempotently before planning.
3. Inspect the repository, then call `save_plan` with a concrete contract and an acyclic phase list. Put measurable completion checks in every phase. Never use placeholder or no-op verification commands.
4. Call `get_context`, then `start_phase`. Work only on the active phase and its allowed scope.
5. Record durable architectural decisions with `record_decision`. Record repeated failures with `record_failure`; change the approach instead of retrying an identical failure.
6. Call `checkpoint_phase` after implementation. Treat its Git scope checks and command results as authoritative. Repair failures before moving on.
7. Continue with the next ready phase without asking the user for permission unless authority, credentials, destructive action, or a material product decision is missing.
8. Call `complete_project` only after every phase is verified. Never claim completion when Keep Coding reports `FAILED`, `BLOCKED`, or unfinished phases.

Keep the project contract stable. When discoveries require a plan change, explain the evidence and use `save_plan` only before implementation has begun; otherwise record the decision and preserve already verified phases.
