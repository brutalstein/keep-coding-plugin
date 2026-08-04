---
name: keep-coding
description: Manage large multi-phase software projects with durable contracts, adaptive plans, semantic impact, token-efficient context, evidence gates, approvals, budgets, parallel worktrees, and resumable state.
---

# Keep Coding

Use one evidence-gated workflow. Do not offer modes.

1. Use the current Git repository as `project_root` for every call and initialize idempotently.
2. Inspect the repository and save a measurable acyclic plan. Use tight scopes and real phase-specific verification commands; respond to command-quality warnings instead of ignoring them.
3. Start only dependency-ready phases. Use parallel worktrees only for explicitly `parallelSafe`, scope-independent phases.
4. Record durable decisions, failures, and budget usage. Request human approval for subjective or destructive decisions.
5. Change an active plan only through `amend_plan`; preserve completed evidence and explain the amendment.
6. Check impact before broad changes. Run selective impacted tests during a phase and preserve the full suite for completion.
7. Treat scope, secret, budget, command, approval, and impact-reverification states as authoritative. The critic is advisory unless explicitly blocking.
8. Checkpoint each phase, repair failures, and continue without asking for permission unless authority or human judgment is required.
9. Call `complete_project` only after every active phase and required reverification passes.

## Token-efficient tool policy

- Use `get_context` prose by default. Carry its returned `sequence` into the next call as `since_sequence`.
- Do not request `include_snapshot: true` unless exact structured fields are needed by tooling or debugging.
- Prefer `get_file_digest` before reading an entire file when orienting or checking impact. Read the full file when editing or when the digest is insufficient.
- Accept the default Tier-0 graph summary. Call `expand_graph` only when exact import, call, reference, or shared-module dependency detail is needed.
- Do not re-request unchanged context after `{ "unchanged": true }`; continue from the durable state already delivered.
- Follow 70%/90% budget advisories by using minimal diffs, avoiding unchanged rereads, and preserving only actionable command-output deltas.

Never claim completion while durable state reports unfinished, failed, blocked-budget, awaiting-approval, or reverify-required work.
