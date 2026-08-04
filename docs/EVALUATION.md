# Evaluation protocol

The primary question is paired: for the same repository state and prompt, does Keep Coding increase independently verified task completion?

## Experimental unit

Use a task with a frozen starting commit, prompt, model/configuration, permission policy, time budget, and verifier suite. For every repetition, run both arms from detached worktrees created from that commit. The runner counterbalances arm order across pairs and records the starting SHA and prompt hash.

- **Baseline:** Codex without Keep Coding available.
- **Treatment:** identical Codex setup with Keep Coding installed and trusted.

Randomize arm order externally when provider load or time trends may matter. Do not let one arm's files or conversation leak into the other.

## Primary outcome

A run succeeds only when the agent exits successfully and every independent verifier command exits zero. Verifiers should test observable requirements and must not be written by the same run being evaluated.

Recommended secondary outcomes include duration, token use, number of failed checks, scope violations, and human-blinded maintainability ratings. v0.1.0 records duration and verifier evidence; token extraction can be layered onto provider-specific JSONL.

## Statistics

The report includes:

- success rate for each arm;
- Wilson 95% confidence interval for each binomial rate;
- paired absolute success-rate difference;
- two-sided exact McNemar test over discordant pairs.

A small p-value is not an effect size, and a large p-value with few runs is not evidence of equivalence. Publish the task set, raw JSONL, starting SHAs, commands, model identifier, and all exclusions.

## Threats to validity

- Model nondeterminism requires repeated runs.
- Provider updates can confound runs separated in time.
- A verifier can reward superficial solutions or miss regressions.
- Hook availability and trust state must be confirmed before treatment runs.
- Tasks used while developing Keep Coding should be separated from the final holdout set.

## Assumption-ledger dimension

Set `assumptionLedger.enabled` in the evaluation configuration to include the correction subsystem in a paired experiment. Keep the task corpus, starting commit, verifier commands, model settings, and arm ordering identical. The runner propagates `KEEP_CODING_ASSUMPTION_LEDGER=1|0` to the evaluated process and omits the entire metrics section when disabled.

The subsystem metrics are:

- **Correction containment rate:** completed corrections with `outcome=contained` divided by all completed contained/expanded corrections, with a Wilson 95% interval.
- **Tokens per correction:** project-scoped recorded token counter at the successful correction checkpoint minus the counter captured by `invalidate_assumption`; phase counters are deliberately excluded to prevent double counting.
- **Anti-pattern hit rate:** distinct proactive correction warnings fired divided by matching situations in the frozen corpus.
- **Enabled-vs-disabled outcome:** an optional paired success comparison summarized by the same exact McNemar function used by the main A/B report.

Self-reported confidence is not treated as calibrated probability. Evaluate confidence calibration indirectly through containment, repeated correction frequency, and the relationship between confidence bands and later invalidations.
