# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are 0.x until 1.0, and a minor version may break. Breaking means a change to the `delegate` or `usage` tool schemas, config `version: 1` and its keys, the lane keys in tier entries, or the CLI commands and flags.

## [Unreleased]

### Added

- `delegate` MCP tool: hands 1 to 8 coding subtasks per call to workers on Claude, Codex, Grok and Antigravity over the Agent Client Protocol, using your existing logins.
- Routing by pace: the subscription most at risk of expiring unused at its reset, on a model at or above the task's tier, with a 2% quota floor and a reserve for the driver's own subscription.
- Tier list with a built-in default and a `tiers` override in `~/.config/schmear/config.json`.
- `usage` tool and `schmear usage` command: every pool's windows, pace and status, and the lane each tier would take next.
- `schmear init`: consent per provider, overage confirmations, and MCP registration with long timeouts in Claude Code, Codex, Grok and Antigravity.
- Optional `claude-credits` lane that spends expiring Anthropic API credits, metered by a local ledger.
- Permission requests from workers are forwarded to the driver's user; a worker's own `schmear serve` hides `delegate`, which prevents accidental delegation loops.
