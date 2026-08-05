# Changelog

## Unreleased

- Replaced shell-interpreted acceptance, selective-test, full-suite, and critic commands with one shell-free executable-plus-argv execution kernel.
- Added operator-owned JSON execution policies with executable and exact-command authority, sanitized environments, fixed operator values, write scopes, resource bounds, network policy, and fail-closed capability requirements.
- Added portable audited process execution and an optional Linux Bubblewrap backend with namespace isolation, capability dropping, read-only repository mounting, scoped writable bindings, and network denial.
- Added durable execution attestation covering command and policy hashes, executable identity, backend capabilities, environment key names, input state, output digest, produced files, and resource-limit outcomes.
- Added plan-time and amendment-time command validation, HTTP startup validation, repository executable-shadowing protection, post-command scope and secret rescanning, and read-only critic enforcement.
- Added malicious-command coverage for shell injection, environment-secret exposure, output flooding, timeout/process-tree termination, policy-file trust, exact-command authority, operator/phase scope intersection, repository PATH shadowing, generated secrets, and critic writes.
- Compatibility tightening: persisted commands that depend on shell operators, substitutions, redirection, inline environment assignment, or Windows `.cmd`/`.bat` interpretation are intentionally rejected. Operators must use a real executable/interpreter argv entry point.

## 0.4.0 — 2026-08-04

- Replaced regex-first Python and C/C++ graph extraction with pinned, hash-verified `web-tree-sitter` WASM parsers and explicit degraded fallback telemetry.
- Added adversarial golden corpora, differential precision checks, runtime asset tamper detection, a large-file graph benchmark, and header/source `same_symbol` unification.
- Raised the enforced branch-coverage floor to 75%, brought MCP transports into coverage, and added targeted plan, budget, critic, scope, auth, and parser failure-path tests.
- Added a frozen 24-task paired evaluation corpus, detached-worktree runner, external verifier contracts, counterbalanced repetitions, Wilson intervals, exact McNemar analysis, and an honest no-fabrication results document.
- Added canonical Agent Skills distribution, Claude plugin/MCP/hook manifests, generic MCP installation examples, and sequence-aware polling for hookless hosts.
- Split project-store migrations, validation, and row mapping into dedicated modules while preserving additive SQLite compatibility.
- Expanded the source suite to 128 tests across 31 files and the compiled distribution suite to five scenarios.

## 0.3.0 — 2026-08-04

- Added a durable assumption ledger with validated confidence, alternatives, terminal status transitions, and graph links to files, symbols, and decisions.
- Added bounded correction records with hop-limited cycle-safe blast-radius traversal, explicit scope expansion, and contained/expanded outcomes.
- Added MCP tools for recording, linking, confirming, invalidating, and expanding assumptions/corrections, including conservative single-assumption auto-linking.
- Added delta-aware open-assumption and correction context, ambiguity pre-flight, low-confidence checkpoint enforcement, and mandatory blocking critic escalation.
- Added cross-project correction anti-patterns, bilingual apology-language nudges, and a non-negotiable skill protocol for structured correction instead of apology-and-restart.
- Added assumption-ledger evaluation metrics: containment rate with Wilson interval, project-scoped tokens per correction, anti-pattern hit rate, and enabled-vs-disabled McNemar comparison.
- Expanded the source suite from 51 to 107 tests and added a compiled-artifact correction lifecycle scenario.

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
