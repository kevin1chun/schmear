# Security policy

## Reporting a vulnerability

Report privately through GitHub's "Report a vulnerability" (private vulnerability reporting) on this repository's Security tab. Do not open a public issue.

## Supported versions

The latest 0.x release.

## In scope

- Routing work into paid overage.
- A credit key leaking, or being written to disk or logs.
- A stripped billing variable reaching a worker.
- A token being logged or persisted.

## Out of scope

[docs/safety.md](docs/safety.md) is the threat model. These are known, documented behaviours:

- What a worker does under its own CLI's permission mode and sandbox, including work a sandboxed or read-only driver could not do itself.
- A Codex worker trusting its cwd, so a repository's `.codex/config.toml` (including MCP server commands) takes effect without Codex's trust prompt.
- A worker reaching `delegate` despite the recursion guard, which prevents accidental loops and is not a security boundary.
