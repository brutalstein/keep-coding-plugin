# Assumption ledger manual E2E evidence

Run date: 2026-08-04  
Artifact: built `plugins/keep-coding/dist/keep-coding.mjs` v0.3.0  
Result: **8/8 PASS**

This walkthrough used fresh scratch Git repositories and the compiled stdio MCP/CLI, not source imports.

1. **Fresh ambiguous repository — PASS.** Initialized a three-file export fixture from the prompt “Add an endpoint that lets users export their data.”
2. **Ambiguity pre-flight — PASS.** Compiled context emitted: `AMBIGUITY PREFLIGHT: record_assumption before any scoped edit`, with vague-outcome and underspecified-verb reasons.
3. **Low-confidence structural gate — PASS.** `record_assumption("Export returns CSV", confidence=0.5)` was linked to two source/test files. The first checkpoint was rejected with `LOW_CONFIDENCE_ASSUMPTIONS` and named the exact assumption ID and statement.
4. **Exact computed radius — PASS.** `invalidate_assumption` returned four graph nodes and exactly two files: `src/export.js` and `src/export.test.js`. During this step the manual run exposed and led to a fix for indexed `test` nodes not being projected into the file list; a regression test now covers it.
5. **Unauthorized expansion rejection — PASS.** Editing `docs/export.md` without expansion returned `passed=false`, `scopePassed=false`, and `scopeViolations=["docs/export.md"]`; the correction was persisted as pending `expanded`.
6. **Justified expansion and persistence — PASS.** `expand_correction_scope` accepted `file:docs/export.md` with a non-empty public-contract justification. The retried checkpoint passed and direct SQLite inspection confirmed `outcome='expanded'`, the exact justification, and a non-null `completed_at`. The observed project token counter moved from **587 to 901**, or **314 tokens for the correction interval**.
7. **Cross-project proactive warning — PASS.** A second keyword-similar export project received `Relevant past correction: Avoid assumption: Export returns CSV ... Actual requirement was JSON` before any new assumption existed (`assumptions.length=0`).
8. **Bilingual-style correction nudge remains non-blocking — PASS.** On a completed project, a Stop payload containing “sorry, I misunderstood ... restart” returned `{continue:true}` with an `invalidate_assumption` reminder and no blocking decision.

The scratch repositories and temporary playbook database were deleted after the evidence was recorded.
