# MCP tool policy

## Start and plan

1. `initialize_project`
2. `get_context`
3. bounded repository inspection (`list_files`, `get_file_digest`, `read_file`, `search_code`)
4. `save_plan`
5. `start_phase`

## Implement

- `apply_patch` is the bounded write path for remote hosts.
- `record_decision` stores durable rationale.
- `record_failure` stores normalized failed approaches.
- `record_assumption` and `link_assumption` precede uncertain implementation.
- `get_impact` and `expand_graph` precede broad dependency changes.
- `record_budget_usage` records host telemetry when available.

## Correct

1. `invalidate_assumption`
2. inspect the returned radius
3. `expand_correction_scope` only when justified
4. make only radius-and-phase-scoped changes
5. `checkpoint_phase`

## Finish

- resolve `request_approval` records with `resolve_approval`
- checkpoint every active phase
- satisfy all `REVERIFY_REQUIRED` phases
- call `complete_project`
