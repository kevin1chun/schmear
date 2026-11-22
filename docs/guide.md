# Guide

Reference for [schmear](../README.md). Safety and vendor terms are in [safety.md](safety.md).

## Terms

- **Driver**: the agent you type into. **Worker**: the CLI that runs a delegated task.
- **Pool**: one quota that can run out, with one or more windows, such as Claude's 5-hour and weekly limits. Antigravity has three: `agy-gemini` (Gemini models), `agy-argon` (Gemini 4 Argon) and `agy-3p` (its Claude and GPT models).
- **Lane**: one model on one subscription, such as `grok:grok-4.7`. Its key (`claude`, `codex`, `grok`, `agy-gemini`, `agy-argon`, `agy-3p`, `claude-credits`) names the route; several lanes can draw on one pool.
- **Tier**: the weakest model class a task may use, from 1 (Haiku-class) to 4 (Fable-class) by default. A task may run higher, never lower.
- **Pace**: per window, the share of quota left above the floor or reserve, divided by the share of time left until reset. Above 1, quota would go unused at an even rate. The highest pace goes first.

## How it works

After `schmear init`, restart your agent and work as usual, for example: *"Have another agent write tests for src/parse.ts in a new worktree."* schmear's MCP instructions tell the agent when to delegate, and each result names the worker that ran it.

- **Delegate.** Claude Code calls `delegate({tasks:[{prompt:"Add tests for src/parse.ts ...", cwd:"/repo/.wt/parse-tests", tier:2}]})`, having made that worktree itself. schmear picks the best-paced lane whose model meets tier 2, sends the prompt unchanged, and returns the reply with `provider`, `model`, `effort` and `session`. Any permission request from the worker appears in Claude Code as "agy worker on 'Add tests for src/parse.ts' asks: ...".
- **Fan out.** One call carries 1 to 8 tasks that run concurrently and return together. Three read-only reviews with the same `cwd` share that directory and spread across the lanes in the pick's tie band.
- **Check quota.** `schmear usage`, or the `usage` tool, prints every pool with its windows, pace and status, and the lane the next task of each tier would take.
- **Continue.** Pass an earlier result's `session` back to `delegate` to resume that worker on the same provider and model.
- **Scope.** schmear only routes. The driver owns everything else: worktrees, read-only versus writing, commits, merging, ordering.

`schmear usage` in a terminal has no driver, so it applies no reserve:

```
driver: unknown

## claude
pool claude: short 5h 74% left, resets 2026-11-23T00:20:00.088Z; period 7d 50% left, resets 2026-11-26T00:00:00.088Z | pace 1.10 | ok
pool claude-fable [fable]: period 7d 77% left, resets 2026-11-26T00:00:00.088Z | pace 1.72 | ok

## codex
pool codex: period 30d 5% left, resets 2026-11-28T18:59:26.000Z | pace 0.15 | ok

## grok
source: grok.com
pool grok: period 7d 100% left, resets 2026-11-29T00:00:00.000Z | pace 1.14 | ok

## agy
pool agy-gemini: period 7d 62% left, resets 2026-11-28T10:20:26.000Z; short 5h 87% left, resets 2026-11-23T01:59:42.000Z | pace 0.76 | ok
pool agy-3p: period 7d 0% left, resets 2026-11-25T01:20:13.000Z | pace - | out: period window 0% left, threshold 2%
pool agy-argon: period 7d 37% left, resets 2026-11-28T10:19:13.000Z | pace 0.44 | ok

next: tier 1 → grok:grok-4.7 (medium)
next: tier 2 → grok:grok-4.7 (medium)
next: tier 3 → claude:opus (medium)
next: tier 4 → claude:fable (medium)
```

## Install

Requires Node 22.18 or newer on macOS or Linux (Windows is not supported), and at least one of the four CLIs, logged in. `--omit=optional` skips ~724 MB of bundled Claude and Codex binaries from the ACP adapters because schmear launches your own `claude` and `codex` CLIs. Install as in the [Quickstart](../README.md#quickstart); `schmear init --yes` answers the Codex, Grok and Antigravity consent questions for you.

From source: `git clone https://github.com/kevin1chun/schmear && cd schmear && npm ci --omit=optional && npm run build && npm i -g .`

Init does the following and nothing else:

- Detects `claude`, `codex`, `agy` and `grok` on your PATH, prints each one's path and version, and records each binary's absolute path in `~/.config/schmear/config.json`. `schmear serve` never resolves PATH.
- Asks one consent question per provider, naming what is read. For Codex, Grok and Antigravity it also asks you to confirm that paid overage (Codex credits, Grok on-demand and prepaid spend, Antigravity AI credits) is off, because schmear cannot read those settings or stop them mid-task. A provider without that confirmation is not routed to. Grok's billing does show its on-demand cap and prepaid balance, so either above zero also skips Grok.
- Once Claude is consented, offers the [credit lane](#credit-pools) and asks its questions.
- Reads usage once and prints what `schmear usage` prints.
- Registers the server in every host it found on PATH (Claude Code, Codex, Grok, Antigravity), even one whose worker you declined or whose detection failed: consent covers only the worker role, so you can still delegate *from* that host. The entry runs `<node> <global root>/schmear/dist/cli.js serve` with absolute paths to the `node` running init and to the installed `cli.js`, so a host started without your shell's PATH still finds them. Each entry gets a 24 hour tool timeout (Codex defaults to 60 s, Antigravity to 180 s), and Codex's also gets `env_vars = ["SCHMEAR_WORKER"]`.
- Leaves an entry alone when the keys init writes match, and otherwise replaces those keys and reports "updated in <host>"; keys you added stay. In Claude Code the replacement is `claude mcp remove -s user schmear` followed by `claude mcp add-json -s user`, and a project or local entry that shadows the user entry is reported.
- Prints `claude mcp get schmear` and `<host> mcp list` for each host found.
- Refuses to run from an npx cache.

`--yes` answers only the Codex, Grok and Antigravity consent questions. Claude's consent needs a typed `yes`, and each overage confirmation a typed `y` or `yes`. A typed Claude consent or overage confirmation is kept by later runs without asking again, so `init --yes` cannot drop it.

State lives in `~/.local/state/schmear/` (usage cache, offered-model lists, credit ledger, the secret that signs `session` handles) and `~/.config/schmear/config.json`. To remove schmear, run `rm -r ~/.config/schmear ~/.local/state/schmear`, delete the `schmear` entry from each host's MCP config (see [manual registration](#manual-registration)), then `npm rm -g schmear`.

## Tested versions

Tested against `claude` 2.1.330, `codex` 0.147.0, `grok` 1.0.77 and `agy` 1.5.14, with `@agentclientprotocol/claude-agent-acp` 0.109.1 and `@agentclientprotocol/codex-acp` 2.9.0. Usage reads rely on undocumented vendor interfaces, so a CLI update can break them. They fail closed: a pool whose usage cannot be read is skipped.

## Routing

- **Tiers are a floor.** Tiers are an ordered list, weakest first. The default has four, referenced to Anthropic's Haiku, Sonnet, Opus and Fable at medium effort; each tier names the `lane:model@effort` entries that qualify, and the ratings and sources are in [`research/model-tiers.md`](research/model-tiers.md) §3; the list is [below](#tier-configuration). `tier` is 1 to the list's length. A task may run on a stronger tier, never a weaker one. There is no `effort` parameter: more thinking is a higher tier. Models an account does not offer are dropped.
- **Pace.** Each usage window gives `(remaining - threshold) x periodHours / hoursUntilReset`, so the pool with the most unused quota per hour left leads. The pool's pace is the minimum over its period windows (weekly, 30-day).
- **Floor.** A pool at or below 2% remaining in any window, including a 5-hour one, counts as out. A pool that cannot be read is skipped.
- **Reserve.** The driver's own subscription holds back 5% of every period window by default, waived in the last 2 hours before reset; set it per agent with `reserve` (the 2% floor still holds). The driver is identified from the MCP handshake.
- **Pick.** Lanes within 5% of the best pace form a tie band. The least-loaded pool wins first, then the lowest tier (the exact tier when it is in the band), then lanes outside the driver's provider, then pace.
- **Batch split.** Tasks in one call spread over every lane in the tie band, least-loaded pool first; lanes that share a pool count together, and a lane outside the band gets no task.
- **Quota mid-task.** A quota failure excludes that lane for the call, rereads usage, and reroutes the task. Claude overage is detected live and cancels the task at once. An `agents` allowlist of agents (`claude`, `codex`, `grok`, `agy`) bounds the reroute; schmear still picks the subscription within them; with no lane left the result is `no_quota`.
- **`usage`.** Shows the detected driver, per agent its pools with each window's remaining and reset, per pool the pace and status, "next: tier N → <lane> (<effort>)" for each tier 1..N, and the entries of your tier list that your account does not offer. Routing reuses a usage reading up to 5 minutes old; `usage` rereads after 60 seconds. `schmear usage` in a terminal has no driver, so it prints `driver: unknown` and applies no reserve; call the `usage` tool from your agent to see that agent's routing.

## Tier configuration

`tiers` in `~/.config/schmear/config.json` replaces the default list whole. Each entry is `"<lane key>:<model>@<effort>"`, with a lane key from `claude`, `codex`, `grok`, `agy-gemini`, `agy-argon`, `agy-3p`, `claude-credits` and the provider's own model and effort values. A bad entry is an error naming the tier and entry, and schmear does not start on it. Credit pools spend only through `claude-credits:` entries.

<details><summary>Default tier list</summary>

```json
[
  [
    "claude:haiku@medium",
    "codex:gpt-5.6-terra@max",
    "grok:grok-4.7@medium",
    "agy-gemini:gemini-4-hydrogen@medium",
    "agy-argon:gemini-4-argon@medium",
    "agy-3p:claude-sonnet-5-5@medium",
    "claude-credits:haiku@medium"
  ],
  [
    "claude:sonnet@medium",
    "codex:gpt-5.6-terra@max",
    "grok:grok-4.7@medium",
    "agy-gemini:gemini-4-hydrogen@medium",
    "agy-argon:gemini-4-argon@medium",
    "agy-3p:claude-sonnet-5-5@medium",
    "claude-credits:sonnet@medium"
  ],
  [
    "claude:opus@medium",
    "agy-gemini:gemini-4-hydrogen@high",
    "agy-argon:gemini-4-argon@medium",
    "agy-3p:claude-opus-5-5@medium",
    "claude-credits:opus@medium"
  ],
  [
    "claude:fable@medium",
    "claude-credits:fable@medium"
  ]
]
```

</details>

This two-tier list with a 10% Claude reserve is an example, not a rating:

```json
{
  "version": 1,
  "agents": { "claude": { "consent": true, "path": "/usr/local/bin/claude" } },
  "tiers": [
    ["claude:sonnet@low", "codex:gpt-5.6-terra@medium", "agy-gemini:gemini-4-hydrogen@medium"],
    ["claude:opus@high", "agy-3p:claude-opus-5-5@high", "agy-gemini:gemini-4-neon@high"]
  ],
  "reserve": { "claude": 0.1 }
}
```

## Credit pools

Claude Max, Ultra and Team plans include monthly Anthropic API credits through a linked Console org; they expire each cycle. schmear can spend them on a separate `claude-credits` lane: Claude workers run with `ANTHROPIC_API_KEY` set to that org's key instead of your claude.ai login. It is the only credit lane; Google and OpenAI credits are not used.

`schmear init` offers the lane once Claude is consented, and only on typed answers (`--yes` never sets it up). It asks for the grant per cycle (USD), the day the cycle starts, the most one task may spend (USD), and a command that prints the key, as a JSON array. On macOS, keep the key in the keychain:

```
security add-generic-password -s schmear-anthropic -a "$USER" -w
```

and give init `["security","find-generic-password","-s","schmear-anthropic","-w"]`. schmear runs that command per task and keeps the key in memory only. If the command fails, that task skips the credit lane and runs on another one.

No vendor exposes a credit balance, so schmear meters the grant locally, in a ledger under `~/.local/state/schmear/ledger/`. Before each task it reserves a budget B = min(remaining − 2% of the grant, per-task cap); with nothing left above that floor the lane is out. The worker stops once a turn passes B, and one turn can overshoot it, which the 2% floor absorbs. Each task is charged the SDK's reported cost, which the SDK calls an estimate, not a billing statement, so the Console spend limit is the hard stop. Anthropic's "credit balance is too low" error closes the lane until the next cycle.

Anthropic bills past the grant if purchased credits or auto-reload are on, and schmear cannot see that. Init therefore requires you to confirm that nothing past the grant can be billed. Use a dedicated Console workspace whose spend limit equals the grant.

The key is in the worker's environment, so every command, hook and MCP server a credit-lane Claude worker starts can read it. Subscription workers never get it.

To remove the lane, delete `"credits"` from `~/.config/schmear/config.json`; later `init` runs keep it otherwise.

## Manual registration

`init` writes these for you, and finds a matching entry unchanged on a later run. If you register by hand, keep the timeouts: without them hosts cut long calls (Codex 60 s, Antigravity 180 s). Use absolute paths: `<node>` is the output of `command -v node` and `<global root>` the output of `npm root -g`.

Claude Code:

```
claude mcp add-json -s user schmear '{"type":"stdio","command":"<node>","args":["<global root>/schmear/dist/cli.js","serve"],"timeout":86400000}'
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.schmear]
command = "<node>"
args = ["<global root>/schmear/dist/cli.js", "serve"]
tool_timeout_sec = 86400
env_vars = ["SCHMEAR_WORKER"]
```

`env_vars` lets the worker marker reach a Codex worker's nested server. Codex applies its own approval policy to `delegate`, as to any MCP tool. To let Codex call `delegate` without asking, add `default_tools_approval_mode = "approve"` to that entry.

Grok, in `~/.grok/config.toml`:

```toml
[mcp_servers.schmear]
command = "<node>"
args = ["<global root>/schmear/dist/cli.js", "serve"]
tool_timeout_sec = 86400
```

Antigravity, in `~/.gemini/config/mcp_config.json`:

```json
{ "mcpServers": { "schmear": { "command": "<node>", "args": ["<global root>/schmear/dist/cli.js", "serve"], "timeoutSeconds": 86400 } } }
```

Claude Code and Codex run parallel tool calls only for tools marked read-only, Antigravity runs them serially, and Grok runs them concurrently; one `delegate` call carrying several tasks avoids the difference.

## Troubleshooting

Run `schmear usage`; every skipped agent says why.

| Reason | Meaning and fix |
|---|---|
| `skipped: no consent` / `not configured` | Run `schmear init`. |
| `skipped: overage not confirmed off` | Turn off Codex credits, Grok on-demand and prepaid spend, or Antigravity AI credits in the vendor's settings, then confirm in `schmear init`. |
| `skipped: grok on-demand or prepaid spend is on (…)` | Grok's billing shows an on-demand cap or prepaid balance above zero, which can pay past your plan; Grok is skipped until both are zero. |
| `Claude reports no plan limits for this login` | The login is not a subscription with plan limits (an API key or a gateway), so it is not routed. |
| `Claude usage read ran your hooks` | Warning: your SessionStart hooks fired during the token-free usage read. |
| `Grok login token expired (run grok login)` | Log in again with the `grok` CLI. |
| `Grok reports no usage percent`, `Grok billing period unknown` | Neither ACP billing nor grok.com gave a usable reading; Grok is skipped. |
| `agy /usage timed out` | Antigravity answered too slowly; rerun. |
| `log in with the <agent> CLI` | A worker was refused authentication; log in with that CLI. |
| `skipped: credit ledger unreadable: …` | A line in `~/.local/state/schmear/ledger/claude-credits.jsonl` does not parse or has an invalid field (the message names the line and field); only the credit lane is skipped until you repair it. |
| `skipped: credit pool config invalid: …` | The named field of `credits` in `~/.config/schmear/config.json` is missing or out of range; rerun `schmear init` or fix it. |
| `claude-credits ledger write failed…` (task note) | The ledger could not be written; the task ran on another lane, or, after the run, its reservation stays counted. |
| `no_quota` | No consented lane at or above the task's tier has quota; do the task yourself. |
