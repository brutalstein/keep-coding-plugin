# Repository guidance

- Keep one default workflow; do not add user-facing modes in v1.
- Preserve the evidence-gated phase state machine and explicit `project_root` isolation.
- Use `apply_patch` for source edits and run `npm run check` before completion.
- Commit the bundled `plugins/keep-coding/dist/keep-coding.mjs` so marketplace consumers do not install dependencies.
- Do not commit `.keep-coding/`, evaluation worktrees, coverage output, or secrets.

