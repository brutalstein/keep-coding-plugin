# Evaluation readiness report

## Status

The v0.4 evaluation harness and frozen corpus are implemented and reproducible. This document deliberately does **not** publish a Keep Coding efficacy percentage because no authenticated external coding-agent runtime was available in the release environment. Fabricating baseline/treatment outcomes would violate the project's independent-evidence model.

## Frozen corpus

- 24 tasks
- 3 paired repetitions per task by default
- 72 paired outcomes and 144 agent runs for a complete execution
- four required categories: greenfield, existing-repository refactor, Python, and C++
- SHA-256 checked by `npm run check:corpus`
- task prompts, starting files, assertion contracts, and argv verifier commands stored in `evaluation/corpus/manifest.json`

The corpus includes deterministic behavior checks for parsers, caches, retries, immutable state, path confinement, asynchronous batching, Python package and async behavior, RAII, templates, header/source separation, numerical stability, and concurrency.

## Independence controls

The corpus runner:

1. materializes each task into a fresh Git repository and records its starting SHA;
2. hashes the exact prompt;
3. counterbalances baseline/treatment order by repetition;
4. creates detached worktrees for every arm;
5. launches agents with argv arrays rather than interpolated shell commands;
6. runs structured assertions and verifier commands outside the agent-authored plan;
7. writes append-only `raw.jsonl`, generated `summary.json`, and generated `summary.md`;
8. reports Wilson 95% intervals and the two-sided exact McNemar paired test.

Repository test code is not automatically trusted as an independent verifier. The frozen corpus contract remains outside each evaluated worktree.

## Reproduce a real paired run

Copy `examples/keep-coding.corpus.eval.example.json`, set two genuinely distinct baseline/treatment commands, and run:

```bash
node plugins/keep-coding/dist/keep-coding.mjs eval-corpus ./keep-coding.corpus.eval.json
```

Publish the complete `raw.jsonl` alongside the generated summary. Record model identifier, provider, permission policy, exclusions, runner image, and execution dates. Mixed or negative results must remain in the report.

## Release evidence that is available now

The release CI validates corpus structure, diversity, safety constraints, deterministic materialization, paired worktree isolation, report generation, and statistical aggregation using a fixture agent. These are harness-validity results, not product-effect results.

## Limitations

- The corpus is repository-authored and still requires external review for realism and selection bias.
- Three repetitions per task are a minimum, not a guarantee of narrow confidence intervals.
- Provider and model updates can confound runs separated in time.
- C++ tasks require a C++20 compiler; Python tasks require Python 3.
- Efficacy claims remain pending until raw authenticated baseline/treatment runs are published.
