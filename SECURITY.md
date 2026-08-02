# Security

## Trust model

Keep Coding runs locally with the same operating-system authority as Codex. Review plugin hooks before enabling them. The MCP transport is stdio-only and opens no network listener.

Acceptance commands are shell commands proposed during planning and executed in the target repository. They are not a sandbox. Use Codex permission controls, review commands, and never place untrusted task specifications in an environment with secrets or broad write authority.

The evaluator executes commands from its JSON configuration and creates/removes Git worktrees under its configured output directory. Treat evaluation configurations as executable code.

## Data

Project prompts, decisions, failures, file paths, content hashes, and command output are stored locally in `.keep-coding/state.db`. Source contents are read to build the graph but are not stored wholesale. Keep Coding makes no network requests.

## Reporting

Report vulnerabilities privately to the repository maintainers with reproduction steps, impact, affected version, and a proposed mitigation. Do not include real credentials or proprietary source.

