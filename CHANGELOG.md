# Changelog

## 0.2.1 — 2026-08-04

- Fixed a packaging defect where the published `dist/keep-coding.mjs` crashed on every invocation because the TypeScript compiler was unintentionally bundled into ESM output.
- Externalized and lazy-loaded the TypeScript compiler, reducing the production bundle and isolating semantic parsing from unrelated CLI and hook commands.
- Added compiled-artifact smoke tests covering version, detection, the complete hook lifecycle, and a full stdio MCP workflow.
- Made plugin validation execute the compiled CLI so `npm run check` cannot pass with a non-runnable distributable.
- Added sequence-aware delta context, default snapshot omission, per-session hook cursors, Tier-0/Tier-1 graph delivery, and indexed file digests.
- Added command-output noise stripping, marker-aware truncation, repeated-failure diffing, normalized failure clustering, token telemetry, budget advisories, and compact deduplicated playbook patterns.
- Added non-blocking acceptance-command quality warnings and a bilingual detector precision/recall corpus.

## 0.2.0 — 2026-08-04

- Added versioned adaptive replanning and auditable phase supersession.
- Added Git-native checkpoint commits, scoped restore, and parallel worktree orchestration.
- Added parser-backed semantic impact analysis, selective tests, and impact-triggered reverification.
- Added budget enforcement, human approvals, optional independent critic review, and opt-in playbook memory.
- Added a loopback dashboard, runtime adapters, GitHub CI and PR generation, and expanded tests.
- Preserved bounded remote ChatGPT workspace tools, exact command policies, always-on secret scanning, and migration compatibility with v0.1 state databases.

## 0.1.0 — 2026-08-02

- First GitHub-ready product version.
- Added the Keep Coding skill, Codex lifecycle hooks, local and bounded HTTP MCP servers.
- Added durable SQLite state, phase DAG validation, failure memory, code graph indexing, and paired evaluation.
