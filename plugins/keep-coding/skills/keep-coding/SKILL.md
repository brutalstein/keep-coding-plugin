---
name: keep-coding
description: Manage large multi-phase software projects with durable contracts, adaptive versioned plans, semantic impact analysis, evidence-gated checkpoints, approvals, budgets, parallel worktrees, and resumable context.
---

# Keep Coding

Use one evidence-gated workflow. Do not offer modes.

1. Use the current Git repository as `project_root` for every call and initialize idempotently.
2. Inspect the repository and save a measurable acyclic plan. Use tight scopes and real commands.
3. Start only dependency-ready phases. Use parallel worktrees only for explicitly `parallelSafe`, scope-independent phases.
4. Record durable decisions, failures, and budget usage. Request human approval for subjective or destructive decisions.
5. Change an active plan only through `amend_plan`; preserve completed evidence and explain the amendment.
6. Check impact before broad changes. Run selective impacted tests during a phase and preserve the full suite for completion.
7. Treat scope, secret, budget, command, approval, and impact-reverification states as authoritative. The critic is advisory unless explicitly blocking.
8. Checkpoint each phase, repair failures, and continue without asking for permission unless authority or human judgment is required.
9. Call `complete_project` only after every active phase and required reverification passes.

Never claim completion while durable state reports unfinished, failed, blocked-budget, awaiting-approval, or reverify-required work.
