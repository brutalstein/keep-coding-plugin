# Keep Coding

Keep Coding is a local-first control plane for long-running coding agents. It turns one project request into a durable contract, dependency-aware phase DAG, scoped implementation, evidence-backed checkpoints, and a full-suite completion gate. Existing v0.1-v0.3 SQLite state is upgraded additively.

## Status

**Current release: v0.4.0.** This release brings Python and C/C++ graph extraction to real syntax-tree fidelity, raises branch coverage to an enforced 75% floor, adds a reproducible paired-evaluation corpus, publishes host-agnostic MCP/Agent Skills packaging, and decomposes storage infrastructure without changing the durable data model.

## Core guarantees

- A phase reaches `COMPLETED` only after scope, secret, budget, selective-test, acceptance-command, approval, correction-radius, and configured critic gates pass.
- `complete_project` requires every active phase and impact-triggered reverification to pass, then runs the configured full suite.
- Plan amendments are versioned; completed evidence is never silently overwritten.
- Remote workspace access is canonical-root confined and patch writes remain phase-scoped.
- The production CLI and its parser sidecars are executed in CI; source-only success cannot mask a broken distribution.
- Low-confidence assumptions and high-ambiguity phases cannot silently pass checkpoints.
- Correction edits are restricted to the intersection of phase scope and the computed or explicitly justified blast radius.
- Native parser failure degrades to an explicit, telemetered legacy fallback instead of aborting indexing or returning a silent empty graph.

## Platform capabilities

- Adaptive plan insertion and supersession after work starts
- Atomic Git commit per passing phase, scoped baseline restore, and isolated parallel worktrees
- TypeScript compiler AST plus WASM tree-sitter parsers for Python, C, and C++
- Decorator, nested-scope, namespace, template, local/system include, and lexical call extraction
- Header/source symbol unification through explainable `same_symbol` graph edges
- Impact analysis, impacted-test selection, and completed-phase reverification
- Deterministic verification plus optional independent critic review
- Human approvals and enforceable token, cost, and wall-clock budgets
- Always-on secret scanning and command-quality warnings
- Sequence-aware delta context, unchanged-hook suppression, Tier-0 summaries, Tier-1 `expand_graph`, and `get_file_digest`
- Command-output compression, repeated-failure diffing, normalized failure clustering, and token telemetry
- Durable assumptions, bounded corrections, bilingual ambiguity detection, and opt-in correction anti-pattern memory
- Loopback dashboard, stdio/HTTP MCP, Codex hooks, Claude hooks, and hookless polling
- Canonical Agent Skills package shared byte-for-byte across host manifests
- Frozen 24-task paired evaluation corpus with detached worktrees, external verifier contracts, Wilson intervals, and exact McNemar analysis

## Requirements and development

Node.js 22.13 or newer and Git are required.

```bash
npm ci
npm run check
```

`npm run check` runs lint, strict TypeScript, source coverage, coverage-delta reporting, production build, byte-identical distribution checks, compiled-artifact scenarios, context and graph benchmarks, parser-asset integrity checks, corpus validation, cross-agent distribution validation, documentation drift checks, and executable plugin validation.

The committed distribution is the entire `plugins/keep-coding/dist/` directory: the executable `keep-coding.mjs` plus hash-manifested WASM grammars and tree-sitter queries.

Verified source suite: 128 tests across 31 files. The post-build artifact suite adds five compiled-distribution scenarios; context and graph benchmarks run separately.

## CLI

```bash
keep-coding init /path/to/repo < project-prompt.md
keep-coding status /path/to/repo
keep-coding context /path/to/repo
keep-coding poll /path/to/repo <last-sequence>
keep-coding impact /path/to/repo src/core/service.ts
keep-coding dashboard /path/to/repo
keep-coding pr-description /path/to/repo
keep-coding eval-corpus ./keep-coding.corpus.eval.json
```

The dashboard binds to `127.0.0.1`. The optional independent critic is configured with `KEEP_CODING_CRITIC_COMMAND` and receives structured JSON over stdin.

## Cross-agent installation

Use the generic MCP instructions in [docs/INSTALL_MCP.md](docs/INSTALL_MCP.md). The same canonical backend is exposed through:

- Codex plugin metadata and lifecycle hooks;
- Claude plugin metadata, MCP declaration, and lifecycle hooks;
- the open Agent Skills `SKILL.md` package;
- generic stdio or Streamable HTTP MCP for Cursor, Windsurf, VS Code, Gemini CLI, OpenCode, and other MCP hosts;
- `poll` as the sequence-aware fallback for hosts without lifecycle hooks.

Host integrations never fork the durable-memory or verification implementation.

## Semantic graph fidelity

TypeScript and JavaScript use the TypeScript compiler AST. Python, C, and C++ use `web-tree-sitter` with pinned grammar versions and SHA-256-verified sidecar assets. Golden adversarial fixtures cover decorated and nested Python definitions, multiline constructs, strings/comments containing fake code, C/C++ templates, namespaces, operators, declarations, definitions, and include classification.

Tree-sitter provides correct local syntax and lexical scope, not full compiler semantics. Cross-module Python type resolution, C/C++ macro expansion, conditional preprocessing, template instantiation, and overload resolution remain explicit Tier-2 work. Pyright or clangd enrichment will only be added after real corpus evidence justifies the additional subprocess and configuration boundary.

## Evaluation boundary

The repository includes a frozen 24-task corpus and a reproducible paired runner, but it does not publish fabricated efficacy percentages. [docs/EVALUATION_RESULTS.md](docs/EVALUATION_RESULTS.md) records the current evidence state and the exact command required to run authenticated treatment/baseline experiments. Provider credentials and agent executables are intentionally external to the repository.

## Architecture and safety

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/EVALUATION.md](docs/EVALUATION.md), [SECURITY.md](SECURITY.md), and [docs/README.tr.md](docs/README.tr.md).
