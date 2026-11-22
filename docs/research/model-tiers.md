# Model tiers: ACP controls, pools and the tier list

Gathered 2026-11-21 on the R1–R4 machine (claude 2.1.330, codex-cli 0.147.0, grok 1.0.77, agy 1.5.14; claude-agent-acp 0.109.1, codex-acp 2.9.0, both still the npm latest). The default list applies the spec's model-tiers decision (`docs/spec.md` Decisions) at reference effort `medium`: tier 1 Haiku, 2 Sonnet, 3 Opus, 4 Fable; the tier is a floor.

## 1. Probe

`T=<probe dir>/tiers`, `A=<probe dir>/adapters` (spec §19 setup), `S=docs/probes/config_probe.py`. The script sends `initialize` and `session/new {cwd, mcpServers: []}`, writes `configOptions`/`models`/`modes` to `$T/out/<label>.json`, sends `session/close` (all four advertise it, all answered ok), and terminates. It never sends `session/prompt`, so no inference ran. Cwd: a fresh `git init` dir `$T/run`.

```
CLAUDE_CODE_EXECUTABLE=$(command -v claude) python3 -I $S claude $T/run $T/out -- node $A/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js
CODEX_PATH=$(command -v codex) python3 -I $S codex $T/run $T/out -- node $A/codex-acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js
python3 -I $S grok $T/run $T/out -- grok --no-auto-update agent stdio
AGY_CLI_DISABLE_AUTO_UPDATE=true python3 -I $S agy $T/run $T/out -- agy acp
```

### claude (claude-agent-acp 0.109.1, user's claude 2.1.330)

| id | category | values (current first) |
|---|---|---|
| `model` | `model` | current `opus`; `default` (Opus 5.5), `opus` (Opus 5.5), `fable` (Fable 5.2), `sonnet` (Sonnet 5.5), `haiku` (Haiku 5.5), `claude-fable-5-1`, `claude-haiku-4-5-20251001`, `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6` |
| `effort` | `thought_level` | current `high`; `default`, `low`, `medium`, `high`, `xhigh`, `max` |
| `fast` | `speed` | current `off`; `off`, `on` |
| `ultracode` | `model_config` | current `off`; `on`, `off` |
| `mode` | `mode` | current `auto`; `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions` |
| `agent` | none | current `default`; `default` plus the user's own subagent names |

- Effort is a separate `thought_level` option. Its values are the current model's `supportedEffortLevels` from the SDK, so the list changes when the model changes (`dist/session-effort.js:82–121`).
- Anthropic's effort doc says Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5 each support all five levels. Haiku 4.5 is not on its effort list, and Opus 4.6 lacks `xhigh` (platform.claude.com/docs/en/build-with-claude/effort).
- The current models are offered only as the aliases `haiku`, `sonnet`, `opus` and `fable`, so the list uses those. No pinned id for them is listed.
- No `models` field (the unstable API) is returned.

### codex (codex-acp 2.9.0, user's codex 0.147.0; probed on a Free-plan ChatGPT account, R13)

| id | category | values |
|---|---|---|
| `model` | `model` | current `gpt-5.6-terra`; `gpt-5.6-terra` ("Legacy balanced model for agentic coding"), `gpt-5.6-luna` ("Legacy fast model for simpler tasks") |
| `reasoning_effort` | `thought_level` | current `medium`; `low`, `medium`, `high`, `xhigh`, `max`, `ultra` ("Maximum reasoning with automatic task delegation") |
| `mode` | `mode` | current `agent`; `read-only`, `workspace-write`, `agent`, `agent-full-access` |
| `collaboration_mode` | `collaboration_mode` | current `default`; `default`, `plan` |

- Effort has two forms: the separate `thought_level` option, and model-id suffixes in `models.availableModels` (`gpt-5.6-terra[low]` … `[ultra]`, current `gpt-5.6-terra[medium]`).
- Luna lists `low`–`max` and has no `ultra`.
- The list never uses `ultra`: it delegates the work, so it is not an effort level.

### grok (`grok --no-auto-update agent stdio` 1.0.77; probed on a Free-tier account, R14)

| id | category | values |
|---|---|---|
| `model` | `model` | current `grok-4.6`; options list only `grok-4.7` |

- There is no effort configOption.
- Effort appears only as `models.availableModels[grok-4.7]._meta`: `supportsReasoningEffort: true`, `reasoningEffort: "high"`, and `reasoningEfforts` with ids `xhigh`, `high` (default), `medium` and `low`. The same `_meta` has `contextWindows [256000, 500000]`.
- The binary has `session/set_config_option`, `session/set_model` and a `reasoningEffort…modelOptions` string, but how to set effort per session over ACP is unprobed.
- The documented route is the launch overlay `GROK_CONFIG='{"models":{"default":"grok-4.7","default_reasoning_effort":"<effort>"}}'` (`~/.grok/docs/user-guide/05-configuration.md:30–33`; `models.*` is on its allowlist). schmear sets model and effort this way at launch; the live tiers test confirmed it (spec R41).
- The current `grok-4.6` (the binary's default; the probed config sets none) is not offered. Only offered models are listed, so it is dropped.

### agy (`agy acp` 1.5.14)

| id | category | values |
|---|---|---|
| `model` | `model` | current `gemini-4-neon`; `gemini-4-neon`, `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-pro-orchestrator-neon`, `gemini-pro-orchestrator-g1-pro` ("Orchestrator (Argon)"), `gemini-3.8-flash`, `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-oss-120b-medium` |
| `thought_level` | `thought_level` | current `high`; `low`, `medium`, `high`, `xhigh` ("Extra") |
| `mode` | `mode` | current `default`; `default`, `accept-edits`, `auto`, `plan` |

- Effort has two forms: the `thought_level` option, and suffixed ids in `models.availableModels` (current `gemini-4-neon-high`).
- The suffixes give each model's real effort set:

  | Model | Efforts |
  |---|---|
  | Neon, Hydrogen | low–xhigh |
  | Argon, 3.8 Flash | low–high |
  | Claude Opus 5.5, Claude Sonnet 5.5 | low–high |
  | Orchestrators | no effort variant |
  | `gpt-oss-120b-medium` | medium only |

- An entry's `model` is the configOption value, and its `effort` is the `thought_level` value.

## 2. Quota pools

| Agent | Model | Pool and windows |
|---|---|---|
| claude | every model | `claude`: `five_hour` + `seven_day` (spec §8.1) |
| claude | `sonnet` | + `seven_day_sonnet` |
| claude | `opus` | + `seven_day_opus` |
| claude | `fable` | + its `limits[].weekly_scoped` row ([CodexBar `docs/claude.md`](https://github.com/steipete/CodexBar/blob/e6edfb87d5bcdcd942de8b11d111d6c132ee392e/docs/claude.md) lines 254, 267 name Fable) |
| claude | `haiku` | main windows only (no Haiku-scoped window is documented) |
| codex | terra, luna | `codex`: one 43200-min window on the probed Free plan (R13) |
| grok | grok-4.7 | `grok`: weekly `currentPeriod` (R14) |
| agy | neon, hydrogen | `Gemini Models` (weekly + 5h). Neon and Hydrogen share it. |
| agy | argon | `Gemini 4 Argon` (weekly) and also `Gemini Models`: Argon draws on both pools |
| agy | claude-opus-5-5, claude-sonnet-5-5, gpt-oss-120b | `Claude and GPT models` (weekly; its 5h bucket was `disabled: True` on the probed account) |
| agy | 3.8 Flash, orchestrators | Assumption: `Gemini Models`, with Orchestrator (Argon) also in Argon. `/usage` groups list no members. |

Group names come from `AGY_CLI_DISABLE_AUTO_UPDATE=true agy -p /usage --output-format json` (`status SUCCESS`, `num_turns 0`). It printed groups `Gemini Models` [weekly, 5h], `Claude and GPT models` [weekly, 5h disabled] and `Gemini 4 Argon` [weekly].

Because pools differ inside agy, the list keys agy by its spec §8.4 lanes: `agy-gemini`, `agy-argon` and `agy-3p`.

## 3. Tier list

**Reference scores.** Artificial Analysis Intelligence Index v5.0.1 per effort, from artificialanalysis.ai/models/<model>, read 2026-11-21:

| Model | low | medium | high | xhigh | max |
|---|---|---|---|---|---|
| Haiku 5.5 (tier 1) | 19 | 25 | 30 | 35 | 36 |
| Sonnet 5.5 (tier 2) | 26 | 31 | 42 | 50 | 55 |
| Opus 5.5 (tier 3) | 35 | 48 | 52 | 57 | 59 |
| Fable 5.2 (tier 4) | 54 | 56 | 62 | 62 | 65 |

**Rule.** The list is the `medium` column of `docs/probes/grid.py`'s output.

1. Per lane, tier T holds the weakest offered `model@effort`, effort ≥ `medium`, whose score is at least the Claude tier-T model's score at `medium` (Haiku 25, Sonnet 31, Opus 48, Fable 56).
2. The chosen effort is never below `medium`. When the model lacks `medium`, it clamps to the model's highest effort, and only if that still meets the score.
3. When an effort has no AA score, it takes the nearest lower measured score. With no lower measured score, that effort is unrated.
4. Tier 4 is Fable only.

| Model | AA v5.0.1 scores | Epoch ECI (epoch.ai/data/eci_scores.csv) | Rating |
|---|---|---|---|
| haiku, sonnet, opus, fable | above | 160.3, 166.6, 168.7, 173.4 | Definitional: tiers 1–4 at `medium` ("Model selection matrix", platform.claude.com/docs/en/about-claude/models/choosing-a-model). |
| gpt-5.6-terra | max 32; other efforts unscored | 160.8 | `max` meets tiers 1–2 (32 ≥ Haiku 25 and Sonnet 31). |
| gpt-5.6-luna | max 24 | 156.7 | None: `max` (24) misses Haiku `medium` (25). codex-acp labels both "Legacy" and AA marks both deprecated. |
| grok-4.7 | low 31, high 35, xhigh 35; medium assumed 31 | 156.4 | `medium` meets tiers 1–2 (assumed 31 ≥ Sonnet 31); `high`/`xhigh` (35) miss Opus `medium` (48). |
| gemini-4-neon | low 44, medium 55, high 60, xhigh 61 | not listed | None: Hydrogen dominates at tiers 1–3 in the same pool, and tier 4 is Fable only. |
| gemini-4-hydrogen | low 27, medium 41, high 51, xhigh 54 | 166.8 | `medium` meets tiers 1–2 (41 ≥ Sonnet 31); `high` meets tier 3 (51 ≥ Opus 48). |
| gemini-4-argon | medium 48, high 50; low unscored ("2 effort levels") | 166.5 | `medium` meets tiers 1–3 (48 ≥ Opus 48). Behind on coding (owner). |
| claude-opus-5-5, claude-sonnet-5-5 via agy | Assumption: the native scores | as native | As native: Sonnet `medium` at tiers 1–2, Opus `medium` at tier 3; capped at `high` by agy's suffix list. |
| gemini-3.8-flash | low 23, medium 30, high 31 | 158.8 | Excluded: AA marks it deprecated, and Hydrogen beats it at every effort in the same pool. |
| gpt-oss-120b-medium | high 4 | 140.2 | Excluded: below tier 1. |
| orchestrators | no score | no score | Excluded: unrated. |
| Tier 4, non-Claude | Fable 62–65 at high and above is beyond every offered model; Neon xhigh 61 would pass Fable low and medium (54, 56) on AA alone | Fable 173.4 vs best offered 166.8 | None: owner ruling, tier 4 is native `fable` only. Users can replace the list in config. |

Entries are `lane:model@effort`, using the provider's own values. `claude-credits` mirrors `claude`.

| tier | entries |
|---|---|
| 1 | `claude:haiku@medium`, `codex:gpt-5.6-terra@max`, `grok:grok-4.7@medium`, `agy-gemini:gemini-4-hydrogen@medium`, `agy-argon:gemini-4-argon@medium`, `agy-3p:claude-sonnet-5-5@medium`, `claude-credits:haiku@medium` |
| 2 | `claude:sonnet@medium`, `codex:gpt-5.6-terra@max`, `grok:grok-4.7@medium`, `agy-gemini:gemini-4-hydrogen@medium`, `agy-argon:gemini-4-argon@medium`, `agy-3p:claude-sonnet-5-5@medium`, `claude-credits:sonnet@medium` |
| 3 | `claude:opus@medium`, `agy-gemini:gemini-4-hydrogen@high`, `agy-argon:gemini-4-argon@medium`, `agy-3p:claude-opus-5-5@medium`, `claude-credits:opus@medium` |
| 4 | `claude:fable@medium`, `claude-credits:fable@medium` |

## 4. List as data

The default list is `DEFAULT_TIERS` in `src/tiers.ts`, printed in `docs/guide.md`.

## 5. Main unresolved uncertainty

The non-Claude entries rest on one aggregate index (AA v5.0.1). Most of its lower-effort scores for GPT-5.6 are missing, and it ranks Grok 4.7 and GPT-5.6 Terra differently from Epoch's ECI. Every codex and grok entry is therefore a judgment call that could move by a tier. The Codex and Grok model lists also came from free-plan accounts (§1); rating models a paid plan adds needs new probes.
