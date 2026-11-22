# schmear: design spec

Package and binary name: `schmear`. Standing decisions: [Decisions](#decisions). Research inputs: `docs/research/` (tiers: `docs/research/model-tiers.md`). Probe scripts: `docs/probes/`.

## 1. Goal

schmear is an open-source TypeScript MCP server for people who pay for several AI coding subscriptions (Claude, ChatGPT/Codex, Google AI via Antigravity, SuperGrok). Whichever agent the user types into (the driver) calls one tool, `delegate`, to hand coding subtasks to the other agents (workers). schmear only load-balances: it launches each worker over the Agent Client Protocol (ACP) on the user's existing login, in the cwd the driver names, with the prompt the driver wrote, on a model at least as strong as the task's tier, and on the subscription most at risk of expiring unused at its reset, never spending into paid overage. The driver owns everything else: worktrees, read-only vs writing, commits, merging, ordering. Install is `npm i -g schmear --omit=optional && schmear init`.

## 2. Approach

- **One stdio MCP server per host session, no daemon.** Each host spawns its own `schmear serve`; processes share a usage cache and a credit ledger through files (§11). Nothing runs as a service.
- **A blocking `delegate` that takes a batch.** One call carries 1–8 tasks that run concurrently and return together. Host-side parallel tool calls are unreliable (Antigravity serial; Claude Code and Codex only with `readOnlyHint`, R8), and every host tolerates long calls once `init` sets its timeout (R8–R11); `start`/`wait` polling would cost driver turns.
- **ACP is the only launch path.** All four ACP routes passed a live task (R1–R4). No CLI launcher exists.
- **`@agentclientprotocol/sdk` 2.9.1 as the ACP client.** Both official adapters depend on it, and it ships the typed v1 schema.
- **Native permissions, prompts forwarded.** Workers keep each CLI's own permission mode and sandbox settings; schmear forwards every permission request a worker sends to the driver's user as an MCP elicitation, and rejects it when nobody can answer.
- **Usage reads are read-only and fail closed, after CodexBar.** Grok and Antigravity copy CodexBar's reads; Codex uses CodexBar's app-server source only (R13); Claude uses its own CLI's `get_usage` control request (R34), a token-free read CodexBar does not use (its Claude sources are OAuth, a CLI PTY and the web), mapped with CodexBar's OAuth field mapping. In detail: Claude through `get_usage`, Codex through its app-server, Grok through ACP billing (R14) with CodexBar's bearer fallbacks, Antigravity through `agy -p /usage` (R12). The only token schmear reads is the grok login's bearer, in memory, for those fallbacks. An unreadable pool is skipped.
- **A tier list**, weakest first, of any length: each tier names the `lane:model@effort` entries that qualify. The default is `DEFAULT_TIERS` in `src/tiers.ts`, rated in `docs/research/model-tiers.md` §3; `Config.tiers` replaces it whole. More thinking is a higher tier, and routing treats the tier as a floor.

| # | Question | Decision | Evidence |
|---|---|---|---|
| 1 | ACP launch | `claude-agent-acp` 0.109.1 with the user's `claude`, `codex-acp` 2.9.0 with the user's `codex`, `grok agent stdio`, `agy acp`. The registry's `agy-acp-server` fails auth and is not used. | R1–R4, R1b, R2b, R4b |
| 2 | ACP surface | SDK stable app API: `initialize`, `session/new`, `session/set_config_option` found by category (`mode`, `model`, `thought_level`), `session/prompt`, `session/update`, `session/request_permission`, `session/cancel`, `session/resume`/`session/load`. | §7, R1–R4, R33 |
| 3 | Quota signal | Claude `-32603` `billing_error`, or `rate_limit` with `rateLimit.status` `rejected`, plus the live `_claude/rateLimit` watch; Codex `-32603` `usageLimitExceeded`; Grok and agy assumed message matches. | §8 |
| 4 | Host timeouts, parallelism | Blocking batch `delegate`; init writes a 24 h timeout per host. | R8–R11 |
| 5 | clientInfo.name | `claude-code`, `codex-mcp-client`, `grok-shell-<server>`, `antigravity-client`. | R8 |
| 6 | Rule files | Each worker loads what its CLI loads natively in the driver's cwd; schmear adds nothing. | R1–R4 |
| 7 | Shared state | Per-agent usage cache (served up to 5 min for routing, 60 s for `usage` and for a failed reading), per-lane-key offered-model list, and an append-only credit ledger; no locks. | §11 |
| 8 | Project | `schmear`, MIT, one package, GitHub Actions CI, tag-triggered `npm publish --provenance`. | §15 |

## Decisions

Settled; not reopened here.

- Delegation surface: one MCP server exposing a `delegate` tool and a read-only `usage` tool.
- schmear only load-balances subagents across subscriptions. The driver owns the prompt, the cwd (a worktree or not), read-only vs writing, commits, branches, merging, ordering and parallelism; schmear adds no prompt text and makes no worktree, branch or commit, and the cwd need not be a git repo. v1 targets coding subagents.
- Contract, per task in one batched `delegate` call (hosts run parallel tool calls unreliably): `prompt`, `cwd` and `tier` required; `description` optional; `agents` optional, an allowlist of agent ids (`claude`, `codex`, `grok`, `agy`), and schmear always picks the subscription; `session` optional, to continue an earlier subagent on its own provider and account without routing (that account out of quota → `no_quota`). Results carry status, reply, provider, model, effort, session, notes or error, and cost when reported (§6).
- Model tiers: an ordered list, weakest first, of any length, that the user can replace in config; each tier lists the `lane:model@effort` entries that qualify, and the shipped list, rated from public sources (Artificial Analysis, Epoch AI, Anthropic's model guidance), is the default. There is no per-task effort: more thinking is a higher tier. The tier is a floor; within the pace tie band the exact tier wins; models an account does not offer are dropped; one model reachable through several subscriptions is a separate lane per subscription.
- TypeScript, published to npm; no Swift and no CodexBar dependency.
- Usage reading follows CodexBar per provider, ported to TypeScript (Claude instead uses its CLI's token-free `get_usage`, §2). schmear never writes or refreshes a token and never runs inference with one, rereads credentials on every check, asks consent once per provider at `init`, and skips a pool whose usage cannot be read (fail closed).
- Grok usage copies CodexBar's Grok pipeline exactly, including its grok.com path and its rule that a missing percent counts as zero only where CodexBar accepts it; no ACP-only inference.
- ACP is the only launch path. A per-agent CLI launcher is allowed only for an agent whose ACP route fails a real test.
- Claude launches over ACP via `@agentclientprotocol/claude-agent-acp` without `--hide-claude-auth`, despite Anthropic's Agent SDK policy on claude.ai login in third-party products; `docs/safety.md` and the init consent prompt disclose this. schmear does not otherwise act on that policy.
- Monthly API or cloud credits included with a subscription are extra pools spent before they expire (`docs/research/api-credits.md`); a credit pool stops at its balance and never falls through to a card.
- Workers have the tools, MCP servers, skills and plugins their CLI has when used directly, and run with its native permission mode and sandbox settings in the driver's cwd; schmear strips billing env vars and, for parity, sets the codex-acp mode matching the Codex config. Grok is a full worker. `docs/safety.md` discloses that workers can use the user's MCP tools.
- Permission prompts are forwarded to the driver's user over MCP elicitation, naming the worker and task; decline, cancel, or a driver without elicitation rejects that one request and the worker continues.
- Rule files: each worker sees only what its CLI loads natively.
- Never route into paid overage: a pool at or below the 2% floor counts as out.
- The driver is identified from the MCP handshake `clientInfo`; a reserve, 5% unless the user sets one per agent in config, is held on the driver's own pools and waived in the last 2 hours before their reset.
- The interactive permission-prompt check at each driver is deferred past v1.

## 3. User walkthroughs

1. **Install.** `npm i -g schmear --omit=optional && schmear init`: init finds `claude`, `codex`, `agy`, `grok`, asks one consent question per provider (plus the overage confirmation and the Claude risk sentence), reads usage once, prints the pools it found or why one is skipped, and registers the server in each host with long timeouts.
2. **Delegate from Claude Code.** Claude calls `delegate({tasks:[{prompt:"Add tests for src/parse.ts …", cwd:"/repo/.wt/parse-tests", tier:2}]})`, having made that worktree itself. schmear picks the highest-pace lane whose model meets tier 2, say `agy-gemini:gemini-4-hydrogen`, sends the prompt unchanged, and returns the reply with `provider: agy`, `model`, `effort`, `session`. Any permission request from the worker appears in Claude Code as "agy worker on 'Add tests for src/parse.ts' asks: …".
3. **Fan out.** Three read-only reviews in one call, all with `cwd: "/repo"`: they share that directory and run concurrently, spread across the lanes in the pick's tie band.
4. **Check quota.** `schmear usage`, or the `usage` tool, prints every pool with its windows, pace and status, and the lane the next task of each tier 1..N would take.
5. **Continue.** `delegate({tasks:[{session:"<from the earlier result>", prompt:"Fix the review notes", cwd:"/repo/.wt/parse-tests", tier:2}]})` resumes the same worker session on the same provider.

## 4. Architecture

```
driver host (Claude Code | Codex | Grok | Antigravity)
   │ MCP stdio: initialize(clientInfo) → tools/call delegate | usage; ← elicitation/create (worker prompts)
   ▼
schmear serve ── server.ts ── delegate.ts ──► router.ts (pure) ◄── tiers.ts (list)
   │                    │             └─► acp.ts ──spawn──► claude-agent-acp | codex-acp | grok agent stdio | agy acp
   │                    └─► agents/<id>.ts: readUsage(), launch(), classifyFailure()
   └─► state.ts, credit.ts: ~/.local/state/schmear/{usage,offered,ledger}, ~/.config/schmear/config.json
```

- One worker process per task, one ACP session per process, one prompt per session. No pooling.
- A nested `schmear serve` started from a worker's MCP config sees `SCHMEAR_WORKER=1` and exposes only `usage` (§14).

## 5. Files

| Path | Purpose |
|---|---|
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `biome.json`, `LICENSE` | Project configuration and license. |
| `README.md`, `docs/guide.md`, `docs/safety.md` | User docs (§15). |
| `src/types.ts` | §6. |
| `src/cli.ts` | `serve`, `init [--yes]`, `usage`, `--version`. |
| `src/server.ts` | `createServer(adapters)` (async): `delegate` and `usage` tools, driver detection, permission prompts, worker mode (§12). |
| `src/delegate.ts` | Validate, route, launch, collect, reroute (§10). |
| `src/router.ts` | Pure pace, eligibility, and the load-first pick that also splits a batch (§9.2). |
| `src/tiers.ts` | The default tier list, `parseTiers()`, `candidates()` (§9.1). |
| `src/acp.ts` | `runWorker()` (§7), `withAcp()` (§7 steps 3 and 8, shared with Grok's probes), `workerEnv()` (§14). |
| `src/state.ts` | Paths, atomic write, usage cache, offered models, config (§11). |
| `src/credit.ts` | Credit ledger, its replay, the credit pool reading and the reservation (§11, §13). |
| `src/init.ts` | Detection, consent, registration (§12). |
| `src/agents/{claude,codex,grok,agy}.ts` | One `AgentAdapter` each (§8). |
| `src/util.ts` | Helpers every layer uses: `PACKAGE_VERSION`, `isRecord`, `errorMessage`, `versionLine`, `unreadable`, and the process-group teardown (`leadGroup`, `endChild`). |
| `src/agents/permit.ts`, `shared.ts`, `index.ts` | §8 permission policy; package-bin, window and line-exchange helpers; registry. |
| `test/*.test.ts`, `test/fake-agent.ts`, `test/fixtures/*.json` | Unit tests; scripted ACP agent; usage payloads from R12–R14, R34 and CodexBar's provider docs with numbers changed and no tokens. |
| `test/live/*.test.ts`, `test/live/guard.ts` | Opt-in live tests (never in CI) and the money guard. |
| `.github/workflows/ci.yml`, `release.yml` | §15. |

Runtime dependencies: `@agentclientprotocol/sdk` 2.9.1, `claude-agent-acp` 0.109.1, `codex-acp` 2.9.0, `@modelcontextprotocol/sdk` ^1.32.2, `zod`, `smol-toml`.

## 6. Interfaces (`src/types.ts`)

```ts
export const AGENT_IDS = ["claude", "codex", "grok", "agy"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export const LANE_KEYS = ["claude", "codex", "grok", "agy-gemini", "agy-argon", "agy-3p", "claude-credits"] as const;
export type LaneKey = (typeof LANE_KEYS)[number];

/** Asks the driver's user to pick one of a permission request's options. optionId, or undefined on decline/cancel; throws on error. */
export type Ask = (message: string, options: PermissionOption[], signal: AbortSignal) => Promise<string | undefined>;

export interface Window {
  kind: "short" | "period";              // short: rolling ≤ 24 h; period: weekly, 30-day, cycle
  remaining: number;                     // fraction left, 0..1
  resetsAt: number | null;               // epoch ms
  periodHours: number;
}
export interface Pool {
  id: string;                            // "claude", "claude-opus", "codex", "agy-gemini", ...
  agent: AgentId;
  keys: LaneKey[];                       // lanes of these keys draw on it
  models?: string[];                     // only lanes running one of these model values; undefined = every model
  windows: Window[];
}
export interface UsageReading {
  agent: AgentId; fetchedAt: number; pools: Pool[];
  error?: string;                        // unreadable: the agent is skipped (fail closed)
  warnings: string[];
  source?: string;                       // the step that produced the reading (Grok: acp, grok.com, cli-proxy)
}

/** A parsed tier-list entry `key:model@effort`; model and effort are the provider's own option values. */
export interface Entry { key: LaneKey; model: string; effort: string }
/** Weakest first: index 0 is tier 1. */
export type TierList = Entry[][];
/** Models each lane key's account offered at its last run; absent = unknown. */
export type Offered = Partial<Record<LaneKey, string[]>>;

export interface Lane {
  id: string;                            // `${key}:${model}`
  agent: AgentId;
  key: LaneKey; tier: number; model: string; effort: string;   // the entry that runs (tier ≥ the task's)
}

export interface LaunchSpec {
  command: string; args: string[]; env: Record<string, string>;
  config?: { mode?: string; model?: string; effort?: string };   // set in this order (§7 step 5); mode: Codex only
  requireAuth?: { kind: string; detail?: string };              // Claude (§7 step 4)
  sessionMeta?: Record<string, unknown>;                         // credit lane only
}

export interface AgentAdapter {
  id: AgentId;
  isClient(clientName: string): boolean;
  find(bin: string): Promise<{ version: string } | { error: string }>; // error: why detection failed
  readUsage(bin: string): Promise<UsageReading>;     // never throws
  launch(lane: Lane, cwd: string, bin: string): Promise<LaunchSpec>;
  classifyFailure(f: WorkerFailure): "quota" | "failed";
  quotaRateLimit?(rateLimit: unknown): boolean;      // Claude only: a live rate-limit notice that ends the run as quota (§10 step 6)
}

export interface WorkerFailure {
  code?: number; message: string; data?: unknown;   // message: the agent's own error text
  stderr?: string;                       // the worker's stderr tail (§7 step 1); shown in the error, never classified
  rateLimit?: unknown;                   // last _claude/rateLimit (Claude)
  auth?: string;                         // authStatus label when requireAuth did not match
  notOffered?: { model: string; effort?: string };   // effort set: that effort is missing
}
export type WorkerOutcome =             // a run ends with a stop reason or a failure, never both
  | { stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"; failure?: never }
  | { failure: WorkerFailure; stopReason?: never };
export type WorkerRun = WorkerOutcome & {
  reply: string; costUsd?: number; sessionId: string;
  model?: string; effort?: string;       // what ran (§7 step 5)
  offered?: string[];                    // the session's `model` option values, when it has one
  prompted: boolean;                     // session/prompt was sent (§13 settle)
};

// MCP tool contract
export interface DelegateInput { tasks: DelegateTask[] }             // 1..8, run concurrently
export interface DelegateTask {
  prompt: string;                        // sent verbatim
  cwd: string;                           // absolute path of an existing directory; need not be a git repo
  tier: number;                          // 1..N, a floor on the tier list
  description?: string;                  // ≤ 80 chars, one line; default: the prompt's first non-empty line cut to 80
  agents?: AgentId[];                    // allowlist of agents; schmear picks the subscription
  session?: string;                      // TaskResult.session from an earlier call
}
export interface TaskResult {
  description: string;
  status: "done" | "failed" | "cancelled" | "no_quota";
  provider?: AgentId; model?: string; effort?: string;
  session?: string;                      // base64url JSON {agent, key, model, effort, tier (the number the lane ran at, under that call's list), sessionId, cwd, costUsd (the run's cumulative cost, when reported)}, `.`, base64url HMAC-SHA256 of the JSON part (§10)
  costUsd?: number;                      // a resumed run: its cost less the handle's costUsd (§13)
  reply: string; notes: string[]; error?: string;
}

// ~/.config/schmear/config.json: `z.infer` of `ConfigSchema` in src/state.ts (§11), which has this shape
export type Config = {
  version: 1;
  agents: Partial<Record<AgentId, { consent: boolean; path: string; overageOff?: true }>>;  // path non-empty; overageOff required for codex, grok, agy
  tiers?: string[][];                    // replaces DEFAULT_TIERS whole (§9.1)
  reserve?: Partial<Record<AgentId, number>>;   // per-driver reserve fraction (§9.2)
  credits?: CreditPoolConfig;            // the claude-credits lane's pool (§13)
};
export interface CreditPoolConfig {
  grantUsd: number; cycleDay: number;    // cycleDay 1..31, clamped to the month's last day
  keyCommand: string[]; taskCapUsd: number; overageOff: true;
}
```

## 7. ACP client (`src/acp.ts`)

ACP v1 (`protocolVersion` 1), newline-delimited JSON-RPC on stdio. Schema: `@agentclientprotocol/sdk` 2.9.1 `schema/v1/schema.json`.

`runWorker(spec: LaunchSpec, cwd: string, prompt: string, opts: { agent: AgentId; signal: AbortSignal; onRateLimit?(rl: unknown, cancel: () => void): void; resume?: string; openTimeoutMs?: number; permit(req: RequestPermissionRequest, turn: AbortSignal): Promise<RequestPermissionResponse> }): Promise<WorkerRun>`

1. Spawn `spec.command spec.args` with `spec.env` and `cwd`, as the leader of its own process group (`detached: true`); keep the last 4 KB of stderr as `failure.stderr`, apart from `failure.message`. From spawn until the `session/prompt` request is sent (steps 3–5), the run has `opts.openTimeoutMs` (default `OPEN_TIMEOUT_MS` = 120 000); on expiry it ends as a failure "<agent> did not open a session within 120 s" and the child is torn down as in step 8. The prompt itself is unbounded.
2. SDK stable app API `client({name: "schmear"})`. `session/request_permission` → `opts.permit(params, turn.signal)`, where `turn` is an `AbortController` aborted on every exit (steps 7–8), which withdraws a prompt still open in the driver; ACP requires `cancelled` for every request pending at `session/cancel` (`schema.json:6691`). `fs/*` and `terminal/*` stay unregistered. Keep the last `_auth/status_update` (claude-agent-acp).
3. `initialize {protocolVersion: 1, clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false}, clientInfo}`. Never `authenticate`; a later `-32000` becomes "log in with the <opts.agent> CLI".
4. `session/new {cwd, mcpServers: []}` (plus `_meta: spec.sessionMeta`). With `spec.requireAuth`, the last `authStatus` received by the time `session/new` returns must match, else the run ends with `failure.auth` and no prompt (R24). With `opts.resume` (the session id), send `session/resume {sessionId, cwd, mcpServers: []}` (plus the same `_meta`, so a resumed credit session keeps its budget stop) when `agentCapabilities.sessionCapabilities.resume`, else `session/load` (same params) when `agentCapabilities.loadSession`, else fail "<agent> agent cannot resume a session"; `WorkerRun.sessionId` is `opts.resume`, and `requireAuth` and step 5 apply as for a new session. History `session/load` replays is not part of the reply.
5. For each of `spec.config.mode`, `.model`, `.effort` that is set, in that order: find the option of category `mode`, `model` or `thought_level` in the latest `configOptions` (from `session/new`, then from each `session/set_config_option` response, since effort values depend on the model, R33) and set it. A missing option or value ends the run before the prompt: with no `mode` or `model` option, as a failure `config option category "<category>" is not available`; for a model the option lacks, with `failure.notOffered = {model}`; for the effort, with `failure.notOffered = {model, effort}`; the failure message lists the option's values; for a mode the option lacks, as a failure "invalid mode <value>; available: …". Once the session is open, every returned `WorkerRun` (success, failure, `notOffered`) carries `offered` = the `model` option's values when it has one (§10 step 5). Then record `WorkerRun.model` = the current value of the `model` option and `WorkerRun.effort` = the current value of the `thought_level` option; with no `thought_level` option, the effort is `session/new`'s `models.availableModels[modelId = models.currentModelId]._meta.reasoningEffort` (Grok, R33).
6. `session/prompt` with the prompt unchanged (`session/update` is handled directly: the SDK's `ActiveSession` cannot wrap a resumed session). From the prompt's start until it returns its `stopReason`: append `agent_message_chunk` text; `WorkerRun.prompted` is true from just before the request is sent; on `usage_update` with `currency === "USD"`, `WorkerRun.costUsd` is the maximum `cost.amount` seen; pass `_meta["_claude/rateLimit"]` to `onRateLimit`.
7. Abort (`opts.signal`, or `cancel()` from `onRateLimit`): `session/cancel`, then abort `turn`; wait up to 10 s for `stopReason: "cancelled"`, then SIGTERM, then SIGKILL 5 s later.
8. Every exit path: abort `turn`, end stdin, SIGTERM the child's process group if the child is alive, SIGKILL the group 5 s later unless the child has exited, and return only after it exits. The child's exit SIGKILLs whatever it left in the group (the vendor CLI, MCP servers). The child exiting fails the run even while a grandchild holds its stdout open.

## 8. Agent adapters

**Permission policy** (`src/agents/permit.ts`, the same for every agent): `permit(req, turn, ctx: { who: string; ask?: Ask; note(text: string): void }): Promise<RequestPermissionResponse>`, with `who` = `<agent> worker on '<description>'`.

- With `ask`: `ask("<who> asks: <toolCall.title ?? "a tool call"> (<kind ?? "other">[: <paths>])", req.options, turn)`, where paths are `toolCall.locations[].path` and `content[]` `diff` paths, comma-separated, shown only when present. An optionId → `{outcome: {outcome: "selected", optionId}}`.
- No `ask` (a driver without form elicitation), `undefined`, or a throw → rejected, and the worker continues, as a headless native CLI does (R31). A throw while `turn` is live adds the note "permission prompt failed: <message>; rejected".
- Rejected = the `reject_once` option with optionId `decline` if listed (codex-acp's "continue without it"), else the first `reject_once`, else the `cancelled` outcome. Once `turn` has aborted, the answer is `cancelled`.
- Which requests arrive is each CLI's choice under its own mode: Claude and agy ask for edits in `default` mode (R5); Codex asks only to leave its sandbox (R5, R6, R7); Grok sent none for edits or MCP calls (R5, R23); agy asks for every MCP call (R23).

### 8.1 Claude (`src/agents/claude.ts`)

- **Detect:** `claude` on PATH, and `claude auth status --json` (worker env) reports `loggedIn: true`, `authMethod: "claude.ai"`, no `apiKeySource` (R16, R24).
- **Billing gate:** `launch()` sets `requireAuth` `{kind: "account"}`, or `{kind: "api_key", detail: "ANTHROPIC_API_KEY"}` on the credit lane. An `apiKeyHelper`, settings `ANTHROPIC_API_KEY` or a managed key outranks the claude.ai login and arrives as `api_key`; a third-party provider as `external`/`gateway` (`hide-claude-auth.js:55–103` as mapped by `auth-status.js:228–268`).
- **Usage, primary (token-free, R34):** spawn `<bin> --output-format stream-json --verbose --input-format stream-json --strict-mcp-config --settings {"disableAllHooks":true}` with `workerEnv()` and cwd = the state dir, and write two lines: `{"type":"control_request","request_id":"i","request":{"subtype":"initialize"}}` and `{"type":"control_request","request_id":"u","request":{"subtype":"get_usage","skip_behaviors":true}}`. Read stdout until the `control_response` whose `response.request_id` is `u`, then end stdin and SIGTERM; 15 s timeout. The reader `readClaudeUsage(bin)` only spawns and collects the parsed stdout messages; the pure `parseClaudeUsage(messages, now)` maps them. No user message is written, so no inference runs. The answer is `SDKControlGetUsageResponse` (claude-agent-sdk 0.3.330 `sdk.d.ts:4621–4720`). `--strict-mcp-config` keeps the user's MCP servers from starting; `disableAllHooks` keeps the user's SessionStart hooks from running (R34 saw them fire without it; R36 saw none with it): any `system`/`hook_started` message adds the warning "Claude usage read ran your hooks".
  - `subtype: "success"` with `rate_limits_available !== true` or `rate_limits: null` → unreadable: "Claude reports no plan limits for this login".
  - No answer, a spawn error, a timeout, or `subtype: "error"` → unreadable with that reason. The method is marked experimental and may be renamed (§18).
- **Pools** (`utilization` is 0–100 used, `resets_at` ISO; a null window or null utilization is skipped):
  - `claude` {keys: [claude]}: `five_hour` (short, 5 h); `seven_day` (period, 168 h), else `seven_day_oauth_apps`. No period window → unreadable.
  - `claude-opus` {keys: [claude], models: [opus]} from `seven_day_opus`; `claude-sonnet` {keys: [claude], models: [sonnet]} from `seven_day_sonnet`.
  - Each `model_scoped` row (R34: `Fable`) → pool `claude-<name lowercased>` with `keys: [claude]` and `models: [<name lowercased>]` when that is a Claude model value (`haiku|sonnet|opus|fable`); otherwise `models` undefined, so it bounds every Claude lane, plus the warning "unknown Claude model window '<name>'".
  - `extra_usage.is_enabled` → warning "Claude extra usage is on: a task that crosses the limit may bill your card. schmear cancels a task as soon as Claude reports overage, but cannot stop the request in flight."
  - Claude Code's statusline JSON also carries these windows, but it exists only when the user has a statusline, so it is not used.
- **Launch:** `process.execPath` with claude-agent-acp's `bin["claude-agent-acp"]`, resolved through its `package.json`; no `--hide-claude-auth` ([Decisions](#decisions)). Env `CLAUDE_CODE_EXECUTABLE=<bin>` (R1b). No mode, no sandbox option: the CLI runs with the user's default mode and sandbox settings (R26 argv). Model and effort through config options (values `haiku|sonnet|opus|fable`, effort `low…max`, R33).
- **Quota signal:** `session/prompt` `-32603` with `data.errorKind === "billing_error"`, or `"rate_limit"` with `data.rateLimit.status === "rejected"` → `quota`; a bare `rate_limit` is a transient 429 → `failed` (`result-end.js:9–12`). Live watch: `_claude/rateLimit` with `status === "rejected"`, `isUsingOverage` or `overageInUse` → cancel at once and classify `quota` (`sdk.d.ts:6237–6250`). Not live-triggered.
- **Policy evidence:** claude-agent-acp spawns `CLAUDE_CODE_EXECUTABLE` with `{...process.env}` and the CLI's own auth chain (`claude-cli.js:19–27`, `acp-agent.js:7637–7646`). `--hide-claude-auth` refuses Free/Pro/Max/Team subscription billing (`hide-claude-auth.js:1–9, 105–116`). The Agent SDK overview says: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." Risk sentence, shown in the Claude consent prompt and in `docs/safety.md`: "Claude workers run your own `claude` binary on your claude.ai login through Anthropic's Agent SDK, without the adapter's `--hide-claude-auth` flag. Anthropic restricts third-party use of subscription logins and may restrict your account or this route."

### 8.2 Codex (`src/agents/codex.ts`)

- **Detect:** `codex` on PATH, `--version` succeeds, and `readCodexUsage` returns `rateLimits.planType` in the ChatGPT subscription set (`free|go|plus|pro|team|business|enterprise|edu`, matching `codex-acp` 2.9.0 `PLAN_DISPLAY_NAMES`, `dist/index.js:49020–49029`); a `planType` outside that set (or missing/null) fails `find()` naming the plan.
- **Usage (token-free, R13):** spawn `<bin> -s read-only -a never app-server`; `initialize`, `initialized`, `account/rateLimits/read`; kill after the reply; 15 s timeout. Map `rateLimits.primary`/`.secondary` `{usedPercent, windowDurationMins, resetsAt (epoch s)}`: `windowDurationMins ≤ 1440` → short, else period with `periodHours = windowDurationMins / 60`. The pool comes from `rateLimits` only. Every other `rateLimitsByLimitId` entry (an id other than `rateLimits.limitId`, default `codex`; codex-acp treats them as separately named limits, `dist/index.js:39253–39270`) becomes the warning "Codex reports another limit '<id>'; not used for routing". The reader `readCodexUsage(bin)` spawns and returns the raw result; the pure `parseCodexUsage(raw, now)` maps it. `spendControlReached === true` or a non-null `rateLimitReachedType` → every window `remaining` 0.
- **Pool:** `codex` {keys: [codex]}. Codex `credits` can pay past the limit, so consent requires `overageOff`.
- **Launch:** `process.execPath` with codex-acp's `bin["codex-acp"]`; env `CODEX_PATH=<bin>` (R2b). `config.mode` = `codexMode()` of `config/read {cwd}` from `<bin> app-server` (called as `docs/probes/codex_mcp_names.py` does; values at `result.config.*`; 15 s timeout), mapping `(sandbox_mode ?? "workspace-write", approval_policy ?? "on-request", approvals_reviewer ?? "user")`, because codex-acp otherwise starts every session in `agent` mode (`index.js:43383–43395`, R27). A triple no mode has fails the task naming it, `${CODEX_HOME:-~/.codex}/config.toml`, and `sandbox_mode`, `approval_policy`, `approvals_reviewer` and `default_permissions`; a set `default_permissions` leaves `mode` unset.

  | sandbox_mode, approval_policy, approvals_reviewer | codex-acp mode (`index.js:43254–43307`) |
  |---|---|
  | `read-only`, `on-request`, `user` | `read-only` |
  | `workspace-write`, `on-request`, `user` | `workspace-write` |
  | `workspace-write`, `on-request`, `auto_review` | `agent` |
  | `danger-full-access`, `never`, `user` | `agent-full-access` |

  Model and effort through config options (`reasoning_effort` category `thought_level`; `ultra` is never used, R33). The model list depends on the user's codex version; §10 step 5 handles a missing model or effort.
- **Quota signal:** `-32603` with `data.codexErrorInfo === "usageLimitExceeded"` → `quota`; `rateLimitExceeded` → `failed` (`index.js:40781–40784`). Not live-triggered.

### 8.3 Grok (`src/agents/grok.ts`)

- **Detect:** `grok` on PATH, and `initialize` on `grok agent stdio` succeeds.
- **Usage** (CodexBar's pipeline exactly, [Decisions](#decisions); [CodexBar `docs/grok.md`](https://github.com/steipete/CodexBar/blob/94cc400e1b190f444e2a4d1910c2d63cfbb47e9f/docs/grok.md) lines 20, 34–125, 153–161, 176–186). `readGrokUsage(bin, deps)` runs the steps below with the token reader and HTTP injected as `deps`; the pure `parseGrokCredits(json, now)` (shared by ACP and the CLI proxy) and `parseGrokProto(bytes, now)` map the answers. The usage text names the step that produced the reading (`acp`, `grok.com`, `cli-proxy`).
  1. **ACP** (token-free): spawn `<bin> --no-auto-update agent stdio`, `initialize`, `_x.ai/billing {}`. `parseGrokCredits`: `config.creditUsagePercent`, else `onDemandUsed.val / onDemandCap.val × 100` when the cap is above 0 (CodexBar's CLI-proxy rule), gives one period window `remaining = 1 − p/100`; reset and duration from `config.currentPeriod.{start,end}` when `currentPeriod.end` is present, else `billingPeriodStart/End`; missing, invalid, reversed or future start → unreadable "Grok billing period unknown". A parseable period without either value is unknown usage: go to step 2 (R14 is this case).
  2. **grok.com retry** (only for unknown usage): the token is `key` of the `${GROK_HOME:-~/.grok}/auth.json` entry under `https://auth.x.ai::<client-id>`, else `https://accounts.x.ai/sign-in`, read in memory per check; missing or past `expires_at` → unreadable without the call. POST the gRPC-web frame `00 00 00 00 02 08 00` (`GetGrokCreditsConfigRequest{exclude_legacy_monthly_usage: false}`) to `https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` with `Authorization: Bearer <token>`, `Content-Type: application/grpc-web+proto`, `X-Grpc-Web: 1`, no cookies, a 6 s budget. Accept gRPC-web frames (flag byte `0x00` data, `0x80` trailers, 4-byte big-endian length) or a raw protobuf body; an HTTP error or non-zero `grpc-status` → unreadable. `parseGrokProto` decodes only the schema-declared messages, field numbers from the grok.com billing descriptor (`cdn.grok.com/_next/static/chunks/32g78bk5hhe1q.js`, read 2026-11-21): `GetGrokCreditsConfigResponse` 1 `config`; `GrokCreditsConfig` 1 `credit_usage_percent` (float), 7 `product_usage` (repeated `ProductUsage` {2 `usage_percent` float}), 8 `current_period` (`UsagePeriod` {1 `type` enum: 1 MONTHLY, 2 WEEKLY; 2 `start`, 3 `end` Timestamp {1 seconds}}); other length-delimited fields are skipped as opaque. Field number 0, an unknown wire type, truncation or a varint over 10 bytes makes the response incomplete. Adopt only a wire `credit_usage_percent`, or an implicit zero (`remaining = 1`) from a complete response with a WEEKLY or MONTHLY `current_period` containing now and no percentage field anywhere. The ACP (or proxy) period and plan stay authoritative for reset and duration. Otherwise unreadable: "Grok reports no usage percent".
  3. **ACP `-32601` (method not found)** (other ACP errors, spawn errors and timeouts are failures): the CLI proxy `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` with the same token rules, `Authorization: Bearer <token>`, `x-xai-token-auth: xai-grok-cli`, `Accept: application/json`, parsed by `parseGrokCredits`; unknown usage → step 2; a proxy failure → unreadable.
  - The token is never written, refreshed, logged or sent anywhere else ([Decisions](#decisions)).
- **Pool:** `grok` {keys: [grok]}. Prepaid balance and on-demand spend can pay past the limit (R14), so consent requires `overageOff`.
- **Spend guard** (schmear's, not part of CodexBar's read; the window is unchanged): `grokSpendOn(billing)` reads `config.onDemandCap.val` and `config.prepaidBalance.val` (USD cents, `{}` = 0; [CodexBar `docs/grok.md`](https://github.com/steipete/CodexBar/blob/94cc400e1b190f444e2a4d1910c2d63cfbb47e9f/docs/grok.md) lines 210, 377–379). Either above 0 → the reading gets `error: "grok on-demand or prepaid spend is on (on-demand cap $X, prepaid balance $Y)"` (the non-zero ones), so `usage` shows it `skipped` and the router never routes Grok, whatever `overageOff` says.
- **Launch:** `<bin> --no-auto-update agent stdio`. No mode option exists (R3). Env `GROK_CONFIG={"models":{"default":"<model>","default_reasoning_effort":"<effort>"}}` (`~/.grok/docs/user-guide/05-configuration.md:30–33`), since Grok has no effort config option (R33), and `config.model` only. Checked live: the tiers test passed for Grok (R41).
- **MCP:** Grok loads the user's MCP servers and calls them through `search_tool`/`use_tool` without a permission request (R23).
- **Quota signal (assumption):** an error message matching `/usage limit|rate.?limit|quota|credits?/i` → `quota` (R17 strings).

### 8.4 Antigravity (`src/agents/agy.ts`)

Google consumer Gemini runs through Antigravity: Google shut off Gemini CLI OAuth for individual, AI Pro and Ultra accounts on 2026-06-18.

- **Detect:** `agy` on PATH.
- **Usage (R12; [CodexBar `docs/antigravity.md`](https://github.com/steipete/CodexBar/blob/e6edfb87d5bcdcd942de8b11d111d6c132ee392e/docs/antigravity.md) lines 55–67, 93):** `readAgyUsage(bin)` checks `AGY_CLI_DISABLE_AUTO_UPDATE=true <bin> --version` (3 s timeout) for agy ≥ 1.1.11 (below that fails naming the version without calling `/usage`), installs failing `open` and `xdg-open` launchers in a private temp dir, prepends that dir to `PATH`, sets `BROWSER` to the failing launcher (failing before start if setup fails), runs `AGY_CLI_DISABLE_AUTO_UPDATE=true <bin> -p /usage --output-format json` in that dir (90 s timeout, 1 MiB output limit), and removes the dir after the subprocess exits. The pure `parseAgyUsage(raw, now)` requires `status === "SUCCESS"` and `num_turns === 0`, and maps `command.data.groups[].buckets[] {window: "weekly"|"5h", remaining_fraction, reset_time, disabled?}`; disabled buckets skipped; `weekly` → period 168 h, `5h` → short 5 h.
- **Pools** (group → pool; model-tiers.md §2):

  | agy group | Pool | keys |
  |---|---|---|
  | `Gemini Models` | `agy-gemini` | `[agy-gemini, agy-argon]` (Argon draws on both) |
  | `Gemini 4 Argon` | `agy-argon` | `[agy-argon]` |
  | `Claude and GPT models` | `agy-3p` | `[agy-3p]` |

  Unknown groups become a warning. Antigravity can continue on paid AI credits after a limit and schmear cannot read that setting (R10), so consent requires `overageOff`.
- **Launch:** `<bin> acp`, env `AGY_CLI_DISABLE_AUTO_UPDATE=true`, no mode, no `--sandbox`. Model and effort through config options (`thought_level`). The registry's `agy-acp-server` fails auth (R4b).
- **Quota signal (assumption):** an error message matching `/quota|limit reached|exhausted|RESOURCE_EXHAUSTED|\b429\b/i` → `quota`.

## 9. Tiers and router

### 9.1 Tier list (`src/tiers.ts`)

- `DEFAULT_TIERS: string[][]` is the default list; its ratings, sources and rule are `docs/research/model-tiers.md` §3. A tier is a list of `lane:model@effort` entries; index 0 is tier 1, the weakest. The default has four tiers (Haiku, Sonnet, Opus and Fable at reference effort `medium`); tier 4 is Fable only. Assumptions accepted as stated there: the Codex entries at `max` effort, and Grok's effort set at launch through `GROK_CONFIG`.
- `parseTiers(raw: unknown): TierList` throws one of these messages (`<t>` is 1-based):
  - not an array, empty, a tier not an array, a non-string entry → `tiers must be a non-empty list of tiers, each a non-empty list of "key:model@effort" strings`
  - `tier <t> is empty`
  - `tier <t> entry "<e>": expected "key:model@effort"` (the entry must match `/^([^:@\s]+):([^@\s]+)@([^@\s]+)$/`)
  - `tier <t> entry "<e>": unknown lane key "<k>" (one of claude, codex, grok, agy-gemini, agy-argon, agy-3p, claude-credits)`
  - `tier <t> entry "<e>": <key>:<model> is listed twice in this tier`

  The same `key:model` in different tiers is allowed (the default does it).
- `candidates(tier: number, tiers: TierList, offered: Offered): Lane[]`: for `t` = the task's tier … N, each tier's entries in list order; per `key:model` only its lowest `t`; a model absent from `offered[key]`, when that list is known (§11: younger than 24 h), is dropped. Key → agent: `agy-*` → `agy`, else the key. The returned order is: exact tier first, then each higher tier, list order within a tier. The tier is a floor: no candidate has `tier` below the task's. A lane is `{id: "<key>:<model>", agent, key, tier: t, model, effort}`.
- **Config** (`~/.config/schmear/config.json`) gains two optional top-level fields, both kept by `init` (which rebuilds only `agents`):
  - `tiers: string[][]` replaces `DEFAULT_TIERS` whole: no merge, one representation, and the default is itself a config value. Entry `"<lane key>:<model>@<effort>"`; lane keys `claude`, `codex`, `grok`, `agy-gemini`, `agy-argon`, `agy-3p`, `claude-credits`; model and effort are the provider's own option values. A credit pool spends only through `claude-credits:` entries.
  - `reserve: { [agent]: number }`: the fraction of each period window held back on that agent's pools while it is the driver, waived in the last 2 h before reset. Default 0.05; the 2% floor still holds (§9.2).

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

  `readConfig` validates both as part of `ConfigSchema` (§11) and throws `malformed config <path>: <message>`: `tiers` through `parseTiers`; `reserve` must be an object whose keys are agent ids (`reserve: unknown agent "<id>"`) and whose values are finite with `0 ≤ r < 1` (`reserve.<id> must be a fraction from 0 to 1, e.g. 0.05 for 5%`). A bad config is never replaced by the default: `serve` refuses to start, and `delegate`, `usage` and `init` report the error (§12).

### 9.2 Router (`src/router.ts`, pure)

Constants, not configurable: `FLOOR` 0.02, `WAIVER_H` 2, `TIE` 0.05, `MIN_H` 0.1. `RESERVE` 0.05 is the default of `Config.reserve`. They generalize a weekly-only rule (pace = usable × 168 / hours to reset; the highest pace wins; a 5% tie band; a 5% Claude reserve waived in the last 2 h before reset) to any window, and from a Claude-only reserve to the driver's agent. `route()` does not know about tiers: each task arrives with its candidate lanes.

```ts
export function route(input: {
  now: number; driver: AgentId | null; readings: UsageReading[]; config: Config;
  exclude: Set<string>;     // lane ids or lane keys excluded for this call
  tasks: Lane[][];          // per task, its candidate lanes in candidates() order
}): { assignments: (Lane | null)[]; pools: PoolRow[] }
// PoolRow: { id, agent, pace: number | null, status: "ok" | `out: ${string}` | `skipped: ${string}` }
```

1. **Normalize.** A window with `resetsAt ≤ now` is `remaining 1, resetsAt null`. `hoursLeft = resetsAt ? (resetsAt − now)/3.6e6 : periodHours`.
2. **Threshold.** `max(config.reserve?.[pool.agent] ?? RESERVE, FLOOR)` when the window is `period`, the pool's agent is the driver's, the pool is not a credit pool, and `hoursLeft > WAIVER_H`; else `FLOOR`. The floor applies to short windows too.
3. **Pool out** when any window has `remaining − threshold ≤ 0`, or when it has no window.
4. **Pool pace** = min over `period` windows (all windows when none) of `(remaining − threshold) × periodHours / max(hoursLeft, MIN_H)`. A weekly pool gives `usable × 168 / hours_left`.
5. **Candidates** come in per task: a fresh task gets `candidates(tier, tiers, offered)` limited to routable agents and its `agents` allowlist (§10), a resumed task its handle's one lane. Eligible: the lane's agent has `consent`, `overageOff` for codex, grok and agy, and a reading without error; a candidate's pools are its agent's pools whose `keys` include its key and whose `models` is undefined or includes its model; its own pool (the pool whose id is its key) is among them, none is out, and neither its id nor its key is in `exclude`. A lane whose own pool has no reading is out. Lane pace = min pool pace.
6. **Pick and split.** Per task, in order: `best` = highest eligible pace; band = eligible lanes with `pace ≥ best × (1 − TIE)`. Sort the band by load ascending, then tier ascending (so the exact tier wins, and a tier-1 task never reaches Fable while Sonnet is in the band), then lanes whose agent is not the driver's (the driver also spends its own pool), then pace descending, then id; the first is the pick. The pick adds 1 to the count of each of its pools. A lane's load is the most assignments so far in this call on any one of its pools, so a batch spreads over every band lane, lanes that share a pool count together, and a lane outside the band never gets a task. A single task is unchanged (all loads 0). Other processes' tasks are not counted (§18).
7. No eligible candidate → `null` (`no_quota`).

Required table-driven tests: a weekly pool gives `usable × 168 / hours_left`; the reserve applies only to the driver's pools and is waived at `hoursLeft ≤ 2`; `reserve.claude: 0.2` outs a 15% Claude pool when Claude drives and not when Codex drives; `reserve.claude: 0` leaves the floor; the floor holds in the waiver window; a 5 h window at 2% outs the pool; a 30-day window (R13 shape); `seven_day_opus` at 0 outs `claude:opus` but not `claude:sonnet`; an unknown-model Claude window bounds every Claude lane; agy-argon takes the minimum of two pools; a tier-2 task never gets a tier-1 lane, and in the band the exact tier beats a higher tier with more pace; the driver's lane sorts after another provider's in the band; missing consent or `overageOff`, error readings and `exclude` remove lanes; an empty candidate list gives `null`; a batch of 3 over 3 disjoint-pool band lanes gets 3 distinct lanes; a lane at pace < best × 0.95 gets no batch task; with `claude:haiku` and `claude:sonnet` (one pool) and `grok:grok-4.7` all in the band, a batch of 3 gets haiku, grok, haiku; two tier-1 tasks when the Claude pool leads never split onto another Claude model; tasks at different tiers alternate across disjoint pools in the band; windows built with `window(98, …)` (floor) and `window(95, …)` (driver reserve) are out; an agy-argon lane is not eligible when the reading has no `agy-argon` pool.

## 10. Delegate flow (`src/delegate.ts`)

`delegate(input: DelegateInput, ctx: { driver: AgentId | null; signal: AbortSignal; ask?: Ask }, adapters): Promise<TaskResult[]>`

1. **Routing setup, then validate.** `loadRouting` reads the config (a malformed one throws `malformed config <path>: …`, §9.1), builds the tier list with `parseTiers(config.tiers ?? DEFAULT_TIERS)` and reads the offered file of every key in the list whose agent is routable; it reads no usage. Then validate (any failure is a tool error naming the task index): 1–8 tasks; `prompt` non-empty; `cwd` absolute and `fs.stat` says directory; `tier` an integer from 1 to N, else `tasks[i]: tier must be an integer from 1 to <N>`; `description` one line ≤ 80 chars (default per §6); `agents` non-empty, each an agent id with an adapter, else `tasks[i]: unknown agent: <x>`; `session` decodes, and a task's `tier` is at most the handle's, else `tasks[i]: session ran tier N; tier M needs a new session`; a `session` already given by an earlier task of the call, else `tasks[j]: session already resumed by tasks[i]` (two workers would resume one transcript at once).
   A handle is signed: `<base64url JSON>.<base64url HMAC-SHA256>` under a per-install 32-byte key in `S/secret` (hex, mode 0600, written atomically on first use). Decoding checks the HMAC with `timingSafeEqual` before parsing, then the fields with a zod schema; any failure is `tasks[i]: session is not a handle from an earlier result`. Why: the handle carries the cost a resumed credit run settles against (§13) and the lane it resumes, so an edited one could settle $0 or run a model outside the tier list. A handle from another install, or from before its key was replaced, is rejected the same way.
2. **Readings.** Only for the distinct agents of all tasks' candidate lanes, in parallel, `state.usage(agent, () => adapter.readUsage(path), USAGE_ROUTE_MS)`: a reading younger than 5 min (a failed one, 60 s) is served from the cache (§11).
3. **Lane.** The fresh tasks go to one `route()` call (the batch split) with an empty `exclude`, each with `candidates(task.tier, tiers, offered)` limited to routable agents and its `agents` allowlist. A task with `session` routes alone with one candidate, the handle's `(key, model, effort)` at the handle's tier, recomputed on every call so a list edit never re-rates a handle; if that lane is out → `no_quota`. Every reroute recomputes the task's candidates, so a newly written offered list applies. The task's `cwd` must equal the handle's after `path.resolve` (a session is found per directory), else tool error `tasks[i]: a resumed task runs in its session's cwd <handle cwd>`.
4. **Run, per task concurrently.** `null` → `no_quota` with the §9.2 pool summary in `error`. Else `adapter.launch(lane, task.cwd, bin)` (bin: `Config.agents[agent].path`), then `runWorker(spec, task.cwd, task.prompt, {agent, signal: ctx.signal, permit: (req, turn) => permit(req, turn, {who, ask: ctx.ask, note}), onRateLimit})`.
5. **Offered models and model or effort not offered.** After every `runWorker` that returns `WorkerRun.offered` (the session's `model` option values), write them to `S/offered/<lane key>.json` (the lane's key, so `claude-credits` never hides a model from `claude`) and use them for later candidates; a failed write adds the note "<lane key> offered list write failed: <message>" and the run's result stands. On `failure.notOffered` add the lane id to `exclude` and re-route, with the note "<model>[ at <effort>] not offered by <agent>; ran <lane id>"; a missing effort drops only that lane for this call. No candidate left → `no_quota`, with the error `no lane for tier <t>; pools: …`.
6. **Quota outcome** (`classifyFailure` → `quota`; or the overage watch fired, i.e. `onRateLimit` saw `adapter.quotaRateLimit?.(rateLimit)` (an optional member only Claude implements) and cancelled): add the lane id to the call's `exclude`; re-read the agent's usage with `maxAgeMs` 0, which also refreshes the shared cache; re-route this task with the note "rerouted from <lane id>: quota". `failure.auth` set: the auth belongs to the account, so add the lane key to `exclude` and re-route with the note "rerouted from <lane id>: would bill <failure.auth>", without touching the reading. No lane left → `no_quota`. Classifiers match `message` and structured fields, never `stderr`: a quota misread as a failure returns `failed`, which the driver can retry, while a failure misread as quota re-runs the prompt in the same cwd.
7. **Other outcomes.** `ctx.signal` aborted → `cancelled`. Else `done` only for `end_turn`; any other stop reason → `failed` with note "worker stopped: <stopReason>"; a failure → `failed` with `error` = the message plus the last 20 stderr lines, at most 2,048 characters (over that, the first 1,024 and last 1,023 around `…`). A throw anywhere in one task's run makes that task `failed` with the error message and its notes so far; the batch's other tasks still return. Results carry `provider`, `WorkerRun.model`, `WorkerRun.effort` and `costUsd`.
8. **Output cap.** Replies total at most 60,000 chars (Claude Code's default MCP output limit is 25,000 tokens); each task gets an equal share, an over-long reply keeping its first and last halves around `[… N chars omitted …]`.
9. **Cancel.** The host's `notifications/cancelled` aborts `ctx.signal`; every running worker is cancelled (§7 step 7).

## 11. Shared state (`src/state.ts`, ledger in `src/credit.ts`)

`S = ${XDG_STATE_HOME:-~/.local/state}/schmear`, `C = ${XDG_CONFIG_HOME:-~/.config}/schmear/config.json`. Every write is atomic (`<file>.<pid>.<8 hex>.tmp`, then `rename`); JSONL appends use `O_APPEND`, one `write` per line. schmear creates its own directories with mode 0700 and its own files (S, C) with 0600, since they hold `keyCommand`, binary paths, quota levels and ledger spend; a rewritten host config keeps its existing mode.

`readConfig()` parses C with one zod `ConfigSchema` (`Config` is its `z.infer`): `version` the literal 1; `agents` keyed by agent id, each `{consent: boolean, path: non-empty string, overageOff?: true}`; `tiers` checked by `parseTiers` (§9.1) and `reserve` as a record of agent ids to fractions in [0, 1), both with their own messages; `credits` checked only as an object (its fields are checked per read, §13, so an invalid pool skips only its lane); any other top-level key is rejected, so a typo is never silently ignored. A missing C reads as `{version: 1, agents: {}}`; any failure throws `malformed config <C>: <first issue path>: <message>` (no path for `tiers` and `reserve` messages, which name their field).

| Path | Content | Rule |
|---|---|---|
| `S/usage/<agent>.json` | last `UsageReading`, error readings included | `usage(agent, read, maxAgeMs)` serves it when younger than `maxAgeMs`, else reads and caches (error readings too): 5 min for routing (`USAGE_ROUTE_MS`), 60 s for `usage` and `init` (`USAGE_SHOW_MS`), and never more than 60 s for a failed reading; a quota outcome rereads with 0, which also hands other processes the fresh reading; duplicate refreshes are harmless |
| `S/offered/<lane key>.json` | `{fetchedAt, models: string[]}` from the last run's `model` option values | written after every run from `WorkerRun.offered` (§10 step 5); `candidates()` drops models absent from it; a list older than 24 h is ignored |
| `S/secret` | 32 random bytes as hex: the key that signs session handles (§10) | created on first use, mode 0600, by exclusive link so concurrent processes agree on one key; never rewritten |
| `S/ledger/claude-credits.jsonl` | `{at, taskId, kind: "reserve" \| "settle" \| "exhausted", usd}` | append-only, no lock: `O_APPEND` gives every process the same line order, and the replay (§13) judges each line only by the lines before it; readers skip a trailing partial line and throw `ledger line <n>: <field>` on a complete one that is not JSON or fails the zod line schema (`at` finite, `taskId` a non-empty string, `kind` one of the three, `usd` finite ≥ 0; `not an object` for a non-object) |

Why 5 min for routing: 5 minutes is under 2% of a 5-hour window and 0.05% of a week, and a stale reading that is wrong self-corrects: the floor and each vendor's overage-off refusal bound the run, and a quota outcome rereads. A failed reading keeps its agent out of routing, so nothing would reread it: it is served 60 s at most. A background refresh was rejected: it would leave `agy -p /usage` children running past the server's exit (§14 "Children are killed on every exit path").

## 12. MCP server and host registration

`src/server.ts`:

- `createServer(adapters): Promise<McpServer>` reads the config once at start and builds the tier list with `parseTiers(config.tiers ?? DEFAULT_TIERS)`; an invalid config rejects, so `serve` exits 1 with `schmear: malformed config …`. The schema and description are fixed for the process; routing re-reads the config on every call, so a list edited after start applies to routing, validation and `usage` at once (a tier above a shrunk list's N is refused), and the description and the schema's bound refresh when the host restarts schmear. `serve` connects it to `StdioServerTransport`; tests use `InMemoryTransport.createLinkedPair()` with adapters whose `launch()` runs `test/fake-agent.ts`. `registerTool(name, {title, description, inputSchema, annotations}, cb)`.
- **Driver:** `server.server.getClientVersion()?.name` through each adapter's `isClient`: exact `claude-code`, `codex-mcp-client`, `antigravity-client`; prefix `grok-shell-` (R8). Unknown → `null`, no reserve.
- **Worker mode:** `SCHMEAR_WORKER === "1"` → `delegate` is not registered.
- **Permission prompts:** when `getClientCapabilities()?.elicitation?.form` is set (a bare `elicitation: {}` reads as form; all four hosts declare it, R31), `ask` = `elicitInput({mode: "form", message, requestedSchema: {type: "object", required: ["option"], properties: {option: {type: "string", title: "Permission", enum: <optionIds>, enumNames: <names>}}}}, {signal, timeout: 86_400_000})`, returning `content.option` on `accept`, else undefined. The timeout matches init's host timeouts; the SDK default of 60 s would reject a prompt the user is still reading.
- **`delegate`:** input schema is the zod form of `DelegateInput` (`tasks.min(1).max(8)`, `tier` an integer from 1 to N for the list's N, `agents` an optional non-empty array of agent ids (`claude`, `codex`, `grok`, `agy`); a lane matches when its agent is listed, so the subscription stays schmear's pick). There is no `effort` field; a driver that still sends one has it stripped by zod and the task routes by tier. Annotations `{readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true}`. Result: one plain-text block; per task a `## <description>` line, then `key: value` lines for `status`, `provider`, `model`, `effort`, `session`, `cost`, `notes`, `error` (only those set), a blank line, then the reply.
- **Description** (load-bearing; `delegateDescription(tiers)` builds it from the effective list):
  "Hand self-contained coding subtasks to other AI coding agents running on the user's subscriptions; schmear picks the agent whose quota is most at risk of expiring unused. Tasks in one call run in parallel. Each task runs in the cwd you give it, and tasks given the same cwd share that directory: isolate tasks that could conflict yourself, for example in separate git worktrees. The prompt is sent verbatim; the worker sees nothing else from you. tier is the minimum model strength, from 1 (weakest) to <N>: a task runs on a model of its tier or a stronger one, so give harder work, or work that needs more thinking, a higher tier. Models by tier: 1 <m>, <m>; 2 <m>; …; <N> <m>. Pass a result's session to continue that subagent. agents limits a task to these agents (claude, codex, grok, agy); schmear still picks the subscription. Status no_quota means no subscription has quota left for the task: do it yourself."
  Each tier lists its distinct model names in list order (default tier 1: `haiku, gpt-5.6-terra, grok-4.7, gemini-4-hydrogen, gemini-4-argon, claude-sonnet-5-5`).
- **Instructions** (sent only when `delegate` is registered, so not in worker mode): `new McpServer(info, { instructions: INSTRUCTIONS })` with exactly:
  "schmear hands subtasks to AI coding agents on the user's other subscriptions, spending the quota most at risk of expiring unused before its reset; your own subscription keeps a reserve. Use delegate for any self-contained subtask you would give a subagent: research, a review, tests, a scoped change. Write each prompt so the worker needs nothing else from you. Put independent subtasks in one delegate call; they run in parallel. Give each task the lowest tier that can do it well. The usage tool shows each subscription's quota and the lane each tier would take."
- **`usage`:** no input, `{readOnlyHint: true}`. Text: the detected driver; per agent its pools with each window's remaining and reset, or `skipped: <reason>`, plus warnings; per pool `pace` and status, and `next: tier t → <lane id> (<effort>)` for t = 1..N, each from one `route()` call holding one task; then, when any, one line `not offered: <entry>@<effort> (tier <t>), …` naming each distinct list entry whose model is absent from its key's known offered list, at its lowest tier; each routed credit pool as its own block (§13). Every routable agent's usage is read with `USAGE_SHOW_MS`. `schmear usage` prints the same text. An invalid config makes the tool a tool error and `schmear usage` and `init` print it and exit 1.
- Logs to stderr only. On stdin close, SIGTERM or SIGINT: cancel running tasks, exit.

Registration by `init`. Every entry runs `[<node>, <abs dist/cli.js>, "serve"]`, where `<node>` is `node` on PATH when its `realpath` equals `process.execPath` (so Homebrew's unversioned symlink survives upgrades) and otherwise `process.execPath`; init refuses to run from an npx cache path (`/_npx/`). add-mcp is not used: its Codex and stdio transforms drop timeout fields (`add-mcp` 2.6.1 `dist/chunk-JZK2SME6.js:1029–1062, 1236–1254`).

| Host | Write | Timeout key | Default without it | Parallel calls (R8) |
|---|---|---|---|---|
| Claude Code | `claude mcp add-json -s user schmear '{"type":"stdio","command":…,"args":[…],"timeout":86400000}'` | `timeout` ms; at ≥1000 it also floors the 30 min stdio idle timeout | about 28 h, aborted after 30 min idle (R11) | serial; concurrent with `readOnlyHint` |
| Codex | append `[mcp_servers.schmear]` with `command`, `args`, `tool_timeout_sec = 86400`, `env_vars = ["SCHMEAR_WORKER"]` to `${CODEX_HOME:-~/.codex}/config.toml`; no `default_tools_approval_mode`, so Codex applies its own approval policy to `delegate`, and one the user added (R17) is a user key init keeps | `tool_timeout_sec` | 60 s per docs; a 75 s call succeeded (R9) | serial; concurrent with `readOnlyHint` |
| Grok | append `[mcp_servers.schmear]` with `command`, `args`, `tool_timeout_sec = 86400` to `${GROK_HOME:-~/.grok}/config.toml` | `tool_timeout_sec` | 6000 s (R11) | concurrent |
| Antigravity | JSON merge `mcpServers.schmear = {command, args, timeoutSeconds: 86400}` into `~/.gemini/config/mcp_config.json` | `timeoutSeconds` | 180 s (R10; the user-level file is unverified) | serial |

- Parse the target first (`smol-toml`, `JSON.parse`, `claude mcp get schmear`). An entry equal on the keys init writes is left alone, so user keys (`env`, `disabled`, `enabled = false`, `startup_timeout_sec`, a `[mcp_servers.schmear.env]` subtable) never make it differ; a differing one gets only init's keys rewritten, every other key, line and comment kept (Claude: remove then add; TOML: each init key's line, as text) and is reported "updated in <host>". A new TOML table is appended as text; JSON is rewritten atomically. Writes go through a symlinked config to its target.
- Claude: `claude mcp get` shows the entry Claude uses; one whose `Scope:` is not user is not the user entry, so init registers at user scope and warns that the other scope's entry shadows it.
- Each host registers independently: a failure prints `<host>: not registered (<msg>)`, the other hosts still register, the list below still prints, and init exits 1.
- An agent whose `find(bin)` fails prints `<id>: <bin> failed detection (<error>)` and is not offered as a worker.
- Afterwards init runs `claude mcp get schmear`, `codex mcp list`, `grok mcp list`, `agy mcp list` and prints each outcome, and stores each binary's absolute path in `Config.agents[id].path`; `serve` never resolves PATH.
- Consent: one question per provider naming what is read, plus the overage confirmation (§8.2–8.4) and the Claude risk sentence (§8.1). `--yes` answers only the Codex, Grok and Antigravity consent questions: Claude's consent needs a typed `yes`, each overage confirmation a typed `y` or `yes`. A stored Claude `consent: true` or `overageOff: true` is kept without asking again, so a later `init --yes` with no input cannot drop it.

## 13. Credit pools

Facts: `docs/research/api-credits.md`.

| Vendor | v1 status |
|---|---|
| Anthropic | Max $100 / Ultra $200 per billing cycle, opt-in through a linked Console org, expiring each cycle, spendable through the Agent SDK with that org's API key. Therefore claude-agent-acp with `ANTHROPIC_API_KEY`. The only credit lane in v1. |
| Google | $10–$100 Cloud credits monthly, only through a Gemini API key or Vertex, never agy. Needs a new worker (`gemini --acp`) with no verified cost signal: Deferred. |
| OpenAI | Pro/Business credits exclude Codex, and no worker here spends them. Ruled out for v1. |
| xAI | None. |

Design:

- **Pool.** `{id: "claude-credits", agent: "claude", keys: ["claude-credits"], windows: [{kind: "period", remaining: left/grant, resetsAt: next cycleDay 00:00 UTC, periodHours: hours from the previous to the next cycle start}]}`. Cycles start at midnight UTC on `cycleDay` (clamped to the month's last day), so the process timezone never moves the boundary.
- **Replay.** `left` comes from replaying the ledger in file order. Each line belongs to the cycle holding the largest `at` among the lines up to it, so cycles are contiguous file segments and membership depends only on file content. A segment starts at `grant − Σ carried`; a `reserve` is valid iff no `exhausted` came before it in the segment, `usd > 0` and `usd ≤ left − FLOOR × grant`, and then `left −= usd` and it is open; an invalid `reserve` is void. A `settle` does `left −= usd` and, if its task has an open reservation, gives that back and closes it. An `exhausted` line makes `left` 0 until the cycle ends. `carried` is the previous segment's open reservations when that segment is the immediately preceding cycle, else nothing: a reservation open at the boundary counts against the new cycle, and its settle after the boundary charges its full cost there. A segment passes on only the open reservations reserved inside it, never ones it inherited, so a reservation carries across one boundary at most. A reader in a cycle with no line yet starts from what the last segment carries into it; a reader whose clock is behind the file's last segment uses that segment.
- **Config.** `Config.credits` (§6) is the pool: one optional object, no id, since `claude-credits` is the only credit lane; a second credit lane would be a `version: 2` config. `overageOff: true` has the same meaning as the agents' key.
- **Lane.** Key `claude-credits`: the pool is spent only through `claude-credits:` entries of the tier list (the default holds one per Claude model); for that lane key delegate calls `openCreditRun(Config.credits, spec, signal)` (`credit.ts`), which reads the key, reserves B and returns the launch with the key in its `spec.env` and a `settle(run, costUsd)` step that writes the run's ledger lines and says whether the pool stopped the run; or `"quota"` (B ≤ 0), or a note that excludes the lane key; it draws only on the `claude-credits` pool. No vendor exposes a balance read, so the only meter is local, against the grant the user confirmed.
- **Reading.** `credit.ts` builds the pool as its own `UsageReading` (`agent: "claude"`, `fetchedAt: now`) from config and ledger, so an unreadable Claude subscription reading never blocks the credit lane. Before the ledger, the pool config is checked (`grantUsd` finite > 0; `taskCapUsd` finite, 0 < cap ≤ grant; `cycleDay` an integer 1–31); a failing field gives the error reading `credit pool config invalid: <field>`. A ledger that cannot be read or fails the §11 line check gives `credit ledger unreadable: <message>`. Either way the pool has no windows, so `usage` shows it skipped and every other lane still routes.
- **Spend path.**
  - Before launch: replay, then `B = min(left − FLOOR × grant, taskCapUsd)`. `B ≤ 0` → a quota outcome (§10 step 6). Else append `{kind: "reserve", usd: B}`, replay again, and use B once its reservation is open (carried across a boundary counts); if another line landed first and voided it, repeat with the same task id. Concurrent tasks and batch splits never over-commit.
  - Run `keyCommand` per task, before the reservation, and keep stdout in memory. A failing or empty key command adds the lane key `claude-credits` to the call's `exclude` and re-routes with the note "claude-credits key command failed: <argv[0]> exit <code>" (or "printed no key"); nothing is reserved and the note never holds the command's output.
  - A reserve that cannot be written (or read back) does the same with the note "claude-credits ledger write failed: <errno code or message>". A `settle` or `exhausted` append that fails after the run adds the note "claude-credits ledger write failed after the run: …" and the task's own result stands; its reservation then stays counted.
  - Worker env = the §14 stripped env plus `ANTHROPIC_API_KEY=<key>`; the key outranks the OAuth login (api-credits.md "Ranking"). Every shell command the worker runs inherits the key; `docs/guide.md` says so.
  - `sessionMeta.claudeCode.options.maxBudgetUsd = B`. The SDK stops with `error_max_budget_usd` only after a turn exceeds the budget (`sdk.d.ts:2069–2073`), so one turn can overshoot B; `FLOOR × grant` is the margin for that turn. That stop reaches the client as the message "Reached maximum budget ($B)", or, on a result without `is_error`, as stop reason `max_turn_requests` with no error (`result-end.js:31–58`); schmear sets no turn limit, so that stop reason is the budget stop too. With `B < taskCapUsd` the pool, not the task, set the budget: the run settles as usual, adds `claude-credits` to `exclude`, and takes §10 step 6. With `B = taskCapUsd` it is the task's own budget and stays `failed`.
  - At finish, append `{kind: "settle", usd: <maximum usage_update.cost.amount>}`. The cost is the SDK's `total_cost_usd`, which the SDK calls an estimate, not a billing statement (`sdk.d.ts:6275`); the Console spend limit is the hard stop. It is cumulative per query, so keep the maximum, never sum: a crash reporting 0 after $3 settles 3. A resumed session continues from the total its transcript saved, so a resumed run settles `max(0, cost − handle.costUsd)` (absent: 0) and the new handle carries the new cumulative cost: a $4 task resumed for $1 settles 4, then 1. A prompted task with no cost reported gets no `settle`, and its `B` stays counted. A run whose `session/prompt` was never sent (abort, resume rejected, `notOffered`, auth mismatch) settles 0.
  - Overshoot: the budget can overshoot by one turn per concurrently running credit task; the vendor's stop at the balance (confirmed no overage, Console spend limit) bounds it. A running credit worker is not stopped by another task's `exhausted`, because the vendor refuses turns past the balance.
- **Absolute stop.** (a) No reservation at or below the floor. (b) The SDK budget stops the task inside the run. (c) The vendor's exhaustion error (`errorKind: "billing_error"`; "credit balance is too low") appends `exhausted`, then takes §10 step 6. (d) init requires `overageOff`, and routing checks it: a pool without `overageOff: true` is never routed, reserved or spent, because the vendor falls through to purchased credits or auto-reload only if the user enabled them, and schmear cannot read that; init recommends a dedicated Console workspace whose spend limit equals the grant. The lane never falls back to anything else.
- **init** offers the credit lane when the Claude lane is detected (init does not infer the plan) and asks for the grant, cycle day, per-task cap, key command (`docs/guide.md` example: `["security","find-generic-password","-s","schmear-anthropic","-w"]`), and the confirmation.

## 14. Edge cases and constraints

### Worker environment (`workerEnv(extra?, base = process.env)`)

1. Copy `base` and delete every variable that changes an agent's auth or billing route: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD`, `CLAUDE_CODE_USE_MANTLE`, `CLAUDE_CODE_USE_GATEWAY`, `ANTHROPIC_AWS_API_KEY`, `ANTHROPIC_FOUNDRY_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`, `MODEL_PROVIDER`, `CODEX_CONFIG`, `DEFAULT_AUTH_REQUEST`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`, `XAI_API_KEY`, `GROK_CODE_XAI_API_KEY`, `GROK_AUTH`, `GROK_MODELS_BASE_URL`, `GROK_XAI_API_BASE_URL`, `GROK_CLI_CHAT_PROXY_BASE_URL`. An exported `ANTHROPIC_API_KEY` would silently move a subscription run onto API credits.
2. Set `SCHMEAR_WORKER=1` and the adapter's variables. Only a credit lane gets a key back (§13).
3. Detection and usage commands run with the same env, so they report what workers use.

### Worker parity

Workers have the default tools, MCP servers, skills and plugins their CLI has when used directly in the same cwd, under its own permission mode and sandbox. schmear adds or removes none, sets the codex-acp mode matching the Codex config, sets model and effort, and strips the variables above. The parity live test (`test/live/parity.test.ts`, fixture from `docs/probes/parity_fixture.sh`) runs the worker through the adapter's own `launch()` and the native reference in the same fixture checkout, comparing CLI records only (model self-reports are not evidence, R23):

| Agent | Native reference | Worker | Compared |
|---|---|---|---|
| claude | `claude -p --output-format stream-json --verbose` `system/init`, and the hook log | the worker CLI's `system/init`, captured with `docs/probes/tee_exec.sh` as `bin` | permissionMode, output_style, apiKeySource, agents, skills, slash_commands, plugins, non-MCP tools, MCP servers by name and source, loaded instruction files |
| codex | app-server `thread/start {cwd}`, `skills/list`, MCP startup names | codex-acp's app-server traffic via `tee_exec.sh` as `CODEX_PATH`; skills and MCP names from a direct app-server replaying the captured `thread/start` params | approvalPolicy, approvalsReviewer, sandbox, instructionSources, skills, MCP names; overrides equal the three below |
| grok | `grok inspect --json` | `grok inspect --json` with the worker env (`agent stdio` reports no inventory, R28) | projectTrusted, projectInstructions, skills, mcpServers, hooks, plugins |
| agy | `agy -p /skills --output-format json`; the fixture's workspace logger started by a one-turn `agy -p` prompt (`/skills` starts none, R37) | the same logger started by the `agy acp` worker | skills, MCP servers started |

Inventories that fill in during startup are read until two reads 1 s apart agree, at most 30 s (R27). The test sets `PK_TEE_REAL`/`PK_TEE_LOG` under its temp dir and deletes the logs afterwards; it never writes user-level config. Every other difference fails the test unless listed; an unlisted difference is reported, never added by the implementer.

| Agent | Known difference | Why accepted |
|---|---|---|
| all | the stripped variables; the model and effort schmear sets | [Decisions](#decisions) |
| claude | MCP servers can be `pending` at the first turn, so their prompts are not yet in `slash_commands`; `-p` waits (R26, R37) | the interactive CLI also connects in the background; compare names and sources, and skip the prompts of servers pending in the worker |
| claude | the SDK entrypoint omits built-in plugin `cc-plugin-easel` and adds `SendToProject`, `SendToProjectContext`, skill `send-to-project`; `-p` drops `EnterPlanMode`/`ExitPlanMode` (R26, R26b) | the CLI's own per-entrypoint behavior |
| claude | `AskUserQuestion` is disallowed (`acp-agent.js:7581`); `-p` lacks it too | Claude Code removes it from its own subagents (code.claude.com/docs/en/sub-agents) |
| codex | codex-acp's `thread/start` overrides: `visualize:visualize` disabled, the session root trusted, `features.cwd_relative_turn_diffs=false` (R27; `index.js:43999–44011`) | adapter options; trusting the root also trusts a cwd the user never trusted (§18) |

### Recursion guard

Workers load the user's MCP config, which includes schmear after init; a worker-side server must not offer `delegate`. Claude, agy and Grok pass the worker env to the MCP servers they spawn; Codex only for variables in `env_vars` (R18; init writes it). clientInfo cannot tell a driver from a worker (R18).

### Safety

There is no OS-level guarantee and no confinement. A worker does not inherit the driver's sandbox or permission mode: its CLI's own mode and sandbox decide what it may do, in any cwd the driver names, so a read-only driver can get files written and commands run through `delegate`. A Codex worker trusts its cwd (codex-acp marks every session root trusted), so a repository's `.codex/config.toml`, MCP server commands included, takes effect without Codex's trust prompt. What a worker asks goes to the driver's user, and with nobody to answer every request is rejected (R31). Tasks given the same cwd share it. Workers can call the user's MCP tools. The recursion guard prevents accidental delegation loops; it is not a security boundary, since a worker with a shell can unset `SCHMEAR_WORKER` or run another CLI directly. `docs/safety.md` says all of this.

### Usage and quota

- **Unreadable** (missing binary, logged out, expired token, missing scope, endpoint error, timeout, no percent) → an error reading; the agent is skipped and `usage` shows why. schmear never writes or refreshes a token and never runs inference to read usage.
- **Overage overrun.** The floor is a margin, not a meter. Claude reports overage live and schmear cancels (§8.1); Codex, Grok and Antigravity do not, so their lanes need `overageOff`, which only a typed init answer sets (§12). Grok's billing shows its on-demand cap and prepaid balance, so a non-zero one also skips Grok (§8.3 spend guard).
- **Quota failure mid-task** → exclude the lane for the call, re-read, re-route (§10 step 6); an `agents` allowlist bounds the reroute. A transient 429 is `failed`.

### Hosts and processes

- Tasks in a batch ask independently, so several prompts can be open at once; the host's tool-call timer keeps running while one waits (R31).
- "Allow always" reaches the agent, which keeps it its own way, as natively.
- A user who registers schmear by hand without the §12 timeouts gets the host default (Codex 60 s, Antigravity 180 s); the snippets in `docs/guide.md` include them.
- Workers and agy's `/usage` read run in their own process groups (`leadGroup` in `src/util.ts`); the whole group is killed on every exit path, including schmear's own shutdown: closing stdin, SIGTERM or SIGINT aborts every call, and schmear's exit SIGKILLs every group still running. If schmear is SIGKILLed, the groups survive it: being detached, they also get no signal from the terminal or the host.

### Platform

- Workers run the user's own `claude` and `codex` (R1b, R2b), so their home-directory state is never written by a newer bundled version.
- Node ≥22.18; macOS and Linux; Windows is out of scope. The adapters pull about 724 MB of optional platform binaries, which `--omit=optional` skips.

## 15. Project

- **Name** `schmear` (npm and GitHub 404 on 2026-11-22). **License** MIT. **Layout** one package.
- **CI** (`.github/workflows/ci.yml`): push to main and pull requests, `contents: read`, `ubuntu-latest` and `macos-latest` × Node `22.18.0` (the engines floor), `22.x`, `24.x`, `26.x`; `npm ci && npm run build`, `node dist/cli.js --version`, `npm run check` (60 s per-test timeout). Actions are pinned to commit SHAs; Dependabot (`.github/dependabot.yml`) proposes npm and action updates weekly. Live tests never run in CI.
- **Dependencies**: `npm-shrinkwrap.json` ships in the tarball, so a global install gets the tested tree.
- **Release** (`.github/workflows/release.yml`): triggered by a `v*` tag after `npm version <x>` and a CHANGELOG entry. The workflow's top-level `permissions` is empty. Job `publish` runs in the `release` environment with `{contents: read, id-token: write}`; after checkout it fails unless `v<package.json version>` equals the tag. Then: Node 24, an exact npm 11 pin, `npm ci && npm run check && npm publish --provenance --access public` through npm trusted publishing. Job `github-release` then runs `gh release create $TAG --generate-notes` with `contents: write` only. The owner claims the npm name, binds the trusted publisher to the `release` environment, and requires a reviewer on it.
- **Community files**: `SECURITY.md` (private vulnerability reporting), `CONTRIBUTING.md`, `CHANGELOG.md` (Keep a Changelog; names what counts as breaking), `.github/ISSUE_TEMPLATE/bug.yml`.
- **User docs**: `README.md` (pitch and quickstart), `docs/guide.md` (reference) and `docs/safety.md` (threat model, vendor terms, Claude disclosure). Every fact is checked against src/ and this spec; the §8.1 risk sentence appears in `docs/safety.md`.

## 16. Verification

| When | Check |
|---|---|
| Every change | `npm run check` |
| Before the release tag | `npm run check && node --test test/live/*.test.ts` on macOS with all four agents logged in; Linux CI green once a remote exists |

Live commands need the agents logged in, skip agents not installed, and obey the money guard: a live test spends subscription quota on tiny read-only prompts only, and runs only when `test/live/guard.ts` shows every pool of every agent it can route to above 5% remaining, else it skips with the reason. Anything that spends API credits or could charge a card (the credit-lane live check) is run by the owner.

A live failure caused by a vendor change is fixed by re-running the matching probe in `docs/probes/`, not by loosening a test.

## 17. Out of scope

- A daemon, a background service, a web UI, telemetry, process pooling.
- Any non-ACP launcher; Windows.
- Worktrees, branches, commits, merges or any git operation; adding text to a prompt; read-only enforcement. The driver owns these.
- A per-task wall-clock limit inside schmear; host cancel governs.
- Google and OpenAI credit lanes; an `uninstall` command; editing vendor overage settings.
- Writing, refreshing or caching any vendor token.
- CodexBar's other Grok surfaces: browser cookies, limit-reset coupons, `/v1/settings` plan enrichment, team principals.

## 18. Deferred

### Post-v1 (each needs a vendor change, a field observation, or spend the user runs)

- Cross-process batch split: two drivers delegating at once can pick the same lane, since only the call's own assignments are counted.
- Claude `limits[]` rows that get_usage's allowlist hides from `model_scoped`, and a `model_scoped` that is absent because the answer was cached.
- Claude OAuth usage fallback (CodexBar path) if get_usage is removed or fails in the field.
- Codex limits other than `rateLimits` (other `rateLimitsByLimitId` ids) are warnings, not routed on; map them once one is observed.
- Not fixed (decision: no upstream report): a withdrawn permission prompt can stay on screen in clients built on `@modelcontextprotocol/sdk` 1.32.2: `Protocol._oncancel` returns early on a falsy `requestId`, and the server's first elicitation has id 0 (`dist/esm/shared/protocol.js:174`). The server sends `notifications/cancelled` and ignores a late answer.
- Elicitations from MCP servers inside a worker are not relayed (claude-agent-acp handles them itself, `acp-agent.js:26`).
- Where "allow always" persists for Codex exec-policy and network amendments, Grok and agy.
- codex-acp's three `thread/start` overrides (§14) need an adapter option to undo; trusting the session root trusts a cwd the user never trusted.
- Codex settings the mode cannot carry: every codex-acp mode turns workspace network access off, and the merged `config/read` view omitted the project layer (R27).
- Mid-task overage detection for Codex (`account/rateLimits/updated` is consumed inside codex-acp, `index.js:40326`) and Antigravity.
- Grok and Antigravity quota signals over ACP: replace message matching with the observed error shape once an exhaustion is seen.
- The `cancelled` fallback for a request with no `reject_once` option may stop the agent's turn rather than skip one action.
- MCP tasks (async tool calls) and progress notifications for hosts that advertise them.
- Re-rate the non-Claude tier entries when AA or Epoch publish missing per-effort scores (model-tiers.md §5).
- Config-defined new lane keys or agy group-to-pool maps; short-window (5 h) capacity in pace; burn-rate forecasting; second accounts per provider.
- Re-probe the Codex and Grok model and effort lists on paid plans and rate any model they add (model-tiers.md:32, :45 came from free plans).
- `usage` cannot name an entry whose effort the model lacks; it is found when it runs.
- The tool description and the schema's tier bound refresh only when the host restarts schmear.
- A custom list without `claude-credits:` entries never spends a configured credit pool, and `usage` does not say so.
- The default list is the `medium` column of model-tiers.md's ratings, so no default tier runs a model above medium effort (for example Opus@high between tiers 3 and 4); a finer default ladder needs per-effort ratings (model-tiers.md §5). Users can add such tiers in config.
- Live verification on Linux.
- A reply joins a worker's separate agent messages with no separator (R36); join them with a blank line once ACP marks message boundaries.
- A forward clock step stamps a ledger line in the next cycle and opens that cycle early for every process; bounded by the Console workspace spend limit equal to the grant (§13 d).
- Two processes holding different `grantUsd`/`cycleDay` during a re-init can each judge their own reserve valid; bounded by the Console workspace spend limit equal to the grant (§13 d).
- The Grok spend guard (§8.3) reads a missing `onDemandCap` or `prepaidBalance` as 0; the typed overage answer stays the primary gate.
- The interactive permission-prompt check at each driver (deferred past v1, decided 2026-11-21).
- The credit key command (`keyCommand`) has no timeout, so a Keychain GUI prompt blocks its task until the host's timeout; and an empty `keyCommand` array is not rejected by `poolConfigError`.
- A torn ledger append followed by another append leaves one invalid complete line, which skips the credit pool (fail-closed) until the line is removed by hand.
- Init's TOML rewrite drops a trailing comment on one of its own key lines, and a quoted key (`"command" = …`) makes it refuse with "edit it by hand"; a dangling symlinked config is replaced by a regular file.
- While a local or project Claude entry shadows the user entry, every init run removes and re-adds the user entry.
- A grandchild of an agy usage probe that calls `setsid` escapes the process-group kill (bounded by the 90 s timeout; CodexBar's environment-marker sweep is not built).
- Claude's usage probe omits CodexBar's `remoteControlAtStartup:false`; Codex has no `account/read` plan fallback and no automatic credits check like Grok's.
- A task allowed only `claude-credits` still runs Claude's `get_usage` probe, since credit readings are refreshed inside the Claude read.
- A resumed credit run settles its cost net of the handle's, which under-counts if the SDK's resumed total omits earlier turns (bounded by the Console spend limit; unverified).
- A permission prompt still open at teardown is withdrawn only after the worker exits (up to 5 s when it ignores SIGTERM).
- Antigravity's user-level `timeoutSeconds` (§12) is unverified live: an Antigravity driver may cut `delegate` at 180 s.

## 19. Research log

Setup:
- `B=<probe dir>`, `P=docs/probes`. Adapters were installed into their own new empty directories under `$B/adapters/` (`claude-agent-acp@0.109.1`, `codex-acp@2.9.0`, registry `antigravity-acp` 1.5.2, and `npm pack` of `@agentclientprotocol/sdk@2.9.1`, `@modelcontextprotocol/sdk@1.32.2`, `add-mcp@2.6.1`).
- Fixtures from `sh $P/make_fixture.sh <dir>`: `README.md` first line `PINEAPPLE`, `AGENTS.md` `KIWI`, `CLAUDE.md` `LIME`, `GEMINI.md` `PLUM`, `.grok/rules` `FIG`, `.agents/rules` `PEAR`, `.claude/rules` `DATE`. `acp_probe.py` prompts: `rules` (list the codewords), `task` (reply with README's first line), `cancel` (long task cancelled after 2 s).
- macOS arm64, Node 26.12.1, claude 2.1.330, codex-cli 0.147.0, agy 1.5.14, grok 1.0.77. No credential value was printed into any log below.

**R1: Claude via claude-agent-acp 0.109.1: PASS.** `python3 -I $P/acp_probe.py claude $B/repo-claude … -- node $B/adapters/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`
```
initialize ok protocolVersion=1 agentInfo={"name": "@agentclientprotocol/claude-agent-acp", "title": "Claude Agent", "version": "0.109.1"}
configOption id=mode category=mode current=auto values=['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']
prompt[rules] reply='LIME DATE'
prompt[task] reply='PINEAPPLE'
prompt[cancel] stopReason=cancelled
```

**R1b: Claude with the user's binary: PASS.** `CLAUDE_CODE_EXECUTABLE=$(command -v claude)` (2.1.330): `prompt[custom] reply='PINEAPPLE'`.

**R2: Codex via codex-acp 2.9.0 (bundled codex 0.171): PASS.**
```
configOption id=mode category=mode current=agent values=['read-only', 'workspace-write', 'agent', 'agent-full-access']
prompt[rules] reply='KIWI'
prompt[task] reply='I’ll read only `README.md` and return its first line.PINEAPPLE'
prompt[cancel] stopReason=cancelled
```

**R2b: Codex with the user's binary: PASS.** `CODEX_PATH=$(command -v codex)` (0.147.0): `prompt[custom] reply='OK'`; stderr `failed to load models cache: missing field supports_parallel_tool_calls`, a cache the bundled 0.171 wrote in R2. This is why workers run the user's binary.

**R3: Grok via `grok --no-auto-update agent stdio` 1.0.77: PASS.** `agentCapabilities={"loadSession": true, …, "sessionCapabilities": {"list": {}, "resume": {}, "close": {}}}`; `prompt[rules] reply='NONE'`; `prompt[task]` … `PINEAPPLE`; `prompt[cancel] stopReason=cancelled`.

**R4: Antigravity via `agy acp` 1.5.14: PASS.** `configOption id=mode … values=['default', 'accept-edits', 'auto', 'plan']`; `prompt[rules] reply='KIWI PLUM PEAR'`; `prompt[task] reply='PINEAPPLE'`; `prompt[cancel] stopReason=cancelled`.

**R4b: Registry `antigravity-acp` 1.5.2: FAIL.** `session/new` → `-32000 Authentication required`; with `--auth=oauth-personal` and browser-refusing shims: `authenticate > 60s` (it wanted a browser OAuth).

**R5: Edit requests** (prompt "create inside.txt" then "create ../logs/outside-<label>.txt"; the probe allowed an edit only inside cwd).

| Run | Agent and setup | Result |
|---|---|---|
| `wclaude` | Claude, mode `default` | `request_permission kind=edit title='Write inside.txt' -> allow_once`; outside `-> reject_once` |
| `wcodex` | Codex, mode `workspace-write` | no permission requests; outside reply `DENIED` |
| `wgrok` | Grok | no permission requests; both files created |
| `wagy` | agy, mode `default` | `request_permission kind=edit title='File inside.txt' -> allow_once`; outside `-> reject_once` |

**R6: Codex shell inside its sandbox** (`scodex`, `workspace-write`): no permission requests; the outside write failed `zsh:1: operation not permitted`.

**R7: Codex escalation** (`rocodex`, mode `read-only`): `request_permission kind=execute title='echo OK > inside.txt' options=['allow_once', 'allow_always', 'reject_once'] -> allow_once`; both files created: approving a Codex request runs the command outside its sandbox.

**R8: MCP hosts as clients** (`sh $P/host_mcp_probe.sh <host> parallel …`; seconds from the first call start).

| Host | `clientInfo` (protocol) | Without `readOnlyHint` | With `readOnlyHint` |
|---|---|---|---|
| Claude Code 2.1.330 | `{"name": "claude-code", …}` (2025-11-25) | A 0.0–5.0, B 5.4–10.5: serial | A 0.0–5.0, B 0.3–5.3: concurrent |
| Codex 0.147.0 | `{"name": "codex-mcp-client", …}` (2025-06-18) | serial | concurrent |
| Grok 1.0.77 | `{"name": "grok-shell-probe", …}` (2025-11-25); server `brokerx` saw `grok-shell-brokerx` | concurrent | not run |
| Antigravity | `{"name": "antigravity-client", "version": "v1.0.0"}` (2025-11-25) | A 0.0–5.0, B 6.8–11.8: serial | not run |

**R9: Codex tool timeout.** `timeout:75`: the call succeeded after 75.0 s; the documented default is 60 s, so init sets it regardless.

**R10: Antigravity tool timeout and settings.** `timeout:330`: cancelled at +180.0 s; with `"timeoutSeconds":400` in `.agents/mcp_config.json`, a 200 s call succeeded. `agy -p … --settings` rejects `mcpServers` and `useAiCredits` ("unknown setting").

**R11: Claude Code and Grok timeouts (docs).** code.claude.com/docs/en/mcp "Time limits on MCP tool calls": about 28 h per call, 30 min idle for stdio, a per-server `timeout` ≥ 1000 floors the idle timeout. `~/.grok/docs/user-guide/07-mcp-servers.md:34`: `tool_timeout_sec` default 6000.

**R12: Antigravity usage.** `AGY_CLI_DISABLE_AUTO_UPDATE=true agy -p /usage --output-format json`: `status SUCCESS`, `num_turns 0`, zero tokens.
```
Gemini Models	Weekly Limit Remaining	84%	2026-11-28T10:20:26Z
Gemini Models	Five Hour Limit Remaining	99%	2026-11-22T00:37:11Z
Claude and GPT models	Weekly Limit Remaining	0%	2026-11-25T01:20:13Z
Claude and GPT models	Five Hour Limit Remaining	disabled
Gemini 4 Argon	Gemini 4 Argon Weekly Limit	91%	2026-11-28T10:19:13Z
```
Bucket fields: `id`, `name`, `description`, `window`, `remaining_fraction`, `reset_time`, `disabled`. The exhausted bucket reads "If on a supported paid plan, you can use AI credits in the interim".

**R13: Codex rate limits, token-free.** `python3 -I $P/codex_ratelimits.py "$(command -v codex)"`: result keys `rateLimitResetCredits`, `rateLimits`, `rateLimitsByLimitId`; `rateLimits` keys `credits`, `individualLimit`, `limitId`, `limitName`, `planType` (a Free-plan account returned `free`), `primary`, `rateLimitReachedType`, `secondary`, `spendControlReached`; `primary: {'usedPercent': 83, 'windowDurationMins': 43200, 'resetsAt': 1795892366}`, `secondary: None`.

**R14: Grok billing over ACP.** `python3 -I $P/grok_billing_keys.py`: `{"config": {"currentPeriod": {"type", "start", "end"}, "onDemandCap": {"val"}, "onDemandUsed": {"val"}, "prepaidBalance": {"val"}, "isUnifiedBillingUser", "billingPeriodStart", "billingPeriodEnd"}, "subscription_tier"}`; `subscription_tier: <tier> | creditUsagePercent: None | currentPeriod: {'type': 'USAGE_PERIOD_TYPE_WEEKLY', 'start': '2026-11-15T00:00:00+00:00', 'end': '2026-11-22T00:00:00+00:00'}`.


**R16: Login state.** `claude auth status --json`: `loggedIn: True, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: <plan>`. `codex login status`: `Logged in using ChatGPT`.

**R17: Binary strings.** grok 1.0.77: `rate_limited`, `is_rate_limited`, `RetryState::Exhausted`. codex 0.147.0: `env_vars`, `tool_timeout_sec`, `default_tools_approval_mode`.

**R18: Env inheritance into worker-spawned MCP servers.** A marker in the adapter's env reached `mcp_logger.py` for claude, agy and grok, not codex. Worker-side clientInfo: `antigravity-client`, `grok-shell-probe`, the same names a driver sends.

**R21: Source reads.** claude-agent-acp 0.109.1 `dist/claude-cli.js:19–27`; `dist/v1/acp-agent.js:26, 4870, 5110–5127, 7581, 7637–7646`; `dist/result-end.js:9–12`; `dist/hide-claude-auth.js:1–9, 55–103, 105–116`; `dist/auth-status.js:1–30, 228–268`; `dist/session-effort.js:82–121`. claude-agent-sdk 0.3.330 `sdk.d.ts:2069–2073, 3378–3396, 4609–4720, 6237–6250, 6275`. codex-acp 2.9.0 `dist/index.js:40326, 40781–40784, 43254–43307, 43383–43395, 43999–44011, 46468, 48851–48873, 58113–58115`. `@agentclientprotocol/sdk` 2.9.1 `dist/v1/stable/bindings.d.ts:188–231, 616–640`, `schema/v1/schema.json:6691`. `@modelcontextprotocol/sdk` 1.32.2 `dist/esm/server/index.d.ts:121–125`, `mcp.d.ts:161–168`, `index.js:340–372`, `types.js:335–345`, `shared/protocol.js:8`. add-mcp 2.6.1 `dist/chunk-JZK2SME6.js:1029–1062, 1236–1254`.

**R23: MCP servers in workers.** `sh $P/a1_fixture.sh <dir> <logdir>` declares a logger per agent config file. Claude's `.mcp.json` and Codex's `.codex/config.toml` loggers started in workers; the Codex model replied `NONE` to "list your MCP servers" with servers loaded (MCP tools are deferred), so only logger logs count. MCP calls ("Call the MCP tool probe_sleep…"): Grok `tool_call title='search_tool'`, `title='use_tool'`, `permissions seen: []`; agy `request_permission kind=other title='Run mcp_probe_probe_sleep' options=['allow_once', 'reject_once']`, the same with `readOnlyHint`.

**R24: Claude billing identity.** Probe without a prompt: `_auth/status_update keys=['account', 'kind', 'label'] kind=account label=Claude <plan>` at +0.3 s and +0.7 s, before `session/new ok`.

**R26: Claude parity.** `sh $P/parity_fixture.sh $B/par/repo $B/par/logs`; native `claude -p --output-format stream-json --verbose "Reply with exactly: OK"`; worker `acp_probe.py` with `CLAUDE_CODE_EXECUTABLE=$P/tee_exec.sh`; `python3 -I $P/parity_claude.py …`:
```
model, permissionMode (auto), output_style, apiKeySource, agents: equal
tools: native-only ListMcpResourcesTool, ReadMcpResourceTool, ReadMcpResourceDirTool and every mcp__* tool; worker-only EnterPlanMode, ExitPlanMode, SendToProject, SendToProjectContext; AskUserQuestion in neither
mcp_servers: same names and sources; worker statuses pending where native connected
skills: worker-only send-to-project | plugins: native-only 1 built-in
worker CLI argv: --tools=default --setting-sources=user,project,local --disallowedTools=AskUserQuestion --permission-prompt-tool=stdio --permission-mode=auto --allow-dangerously-skip-permissions
```
R26b: `CLAUDE_CODE_ENTRYPOINT=sdk-ts claude -p`: the built-in plugin is gone.

**R27: Codex parity.** `python3 -I $P/parity_codex.py live "$(command -v codex)" <repo> --trust` against codex-acp run with `CODEX_PATH=$P/tee_exec.sh`:
```
native: gpt-5.6-terra | on-request | reviewer user | workspaceWrite | instructionSources [<repo>/AGENTS.md] | skills pk-par-skill +16 | mcp pk_par_codex +5
worker: gpt-5.6-terra | on-request | reviewer auto_review | workspaceWrite | effort medium | instructionSources [<repo>/AGENTS.md] | skills pk-par-skill +20 | mcp +5
worker thread/start config: {"features":{"cwd_relative_turn_diffs":false},"skills":{"config":[{"name":"visualize:visualize","enabled":false}]},"projects":{"<wt>":{"trust_level":"trusted"}}}
```
The four extra skills were plugin skills still loading; read 3 s later the sets matched. Merged `config/read`: `approval_policy`, `approvals_reviewer`, `sandbox_mode`, `default_permissions` all null; the project layer was absent from it.

**R28: Grok inventory.** `grok inspect --json` in the checkout: `projectTrusted false | project layer .grok/config.toml | instructions 1 | hooks 2`. `agent stdio` `session/new` returns `_meta {currentWorkingDirectory, isGitRepo, gitRoot, …}`, model and effort data, and no command list.

**R29: agy parity.** `agy -p /skills --output-format json` (`num_turns 0`) lists 8 skills including `pk-par-skill`. The ignored workspace logger `pk_par_agy` logged `initialize` from `antigravity-client` for `agy -p` and for an `agy acp` worker in the same checkout. `/rules` and `/memory` go to the model (`num_turns 1`).

**R31: Elicitation.** Every host declares form elicitation: `claude-code` `{form: {}, url: {}}`; `codex-mcp-client` `{form: {}, url: {}}`; `grok-shell-*` `{form: {schemaValidation: true}, url: {}}`; `antigravity-client` `{form: {}, url: {}}`. `host_mcp_probe.sh <host> elicit:0[:2]` (a form `elicitation/create` with a titled enum mid-call): `claude -p` → `cancel` at once; with an `Elicitation` hook that accepts after 3 s → `{"action": "accept", "content": {"option": "allow_once"}}`, two at once both answered; with server `timeout` 5000 and the hook sleeping 8 s → `notifications/cancelled` at 5.0 s, so the tool timer runs during a wait. `codex exec` → `decline`; `grok -p` and `agy -p` → `cancel`, at once. Interactive rendering is a deferred user check (§18).

**R33: Tier controls** (2026-11-21; full tables and grid in `docs/research/model-tiers.md`; raw output in `$B/tiers/out/`). `T=$B/tiers`; `$P/config_probe.py` sends `initialize`, `session/new`, `session/close` and never a prompt, in a fresh `git init` dir:
```
CLAUDE_CODE_EXECUTABLE=$(command -v claude) python3 -I $P/config_probe.py claude $T/run $T/out -- node $B/adapters/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js
CODEX_PATH=$(command -v codex) python3 -I $P/config_probe.py codex $T/run $T/out -- node $B/adapters/codex-acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js
python3 -I $P/config_probe.py grok $T/run $T/out -- grok --no-auto-update agent stdio
AGY_CLI_DISABLE_AUTO_UPDATE=true python3 -I $P/config_probe.py agy $T/run $T/out -- agy acp
```
- claude: `model` values include `haiku`, `sonnet`, `opus`, `fable` (current `opus`); `effort` (category `thought_level`) `default, low, medium, high, xhigh, max`, varying with the model.
- codex: `model` `gpt-5.6-terra`, `gpt-5.6-luna`; `reasoning_effort` (`thought_level`) `low … max, ultra`; Luna has no `ultra`.
- grok: `model` current `grok-4.6`, options only `grok-4.7`; no effort option; `models.availableModels[grok-4.7]._meta` `reasoningEffort: "high"`, `reasoningEfforts` `xhigh, high, medium, low`.
- agy: `model` `gemini-4-neon` (current), `gemini-4-argon`, `gemini-4-hydrogen`, two orchestrators, `gemini-3.8-flash`, `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-oss-120b-medium`; `thought_level` `low, medium, high, xhigh`; per-model efforts from the suffixed `models` ids.
- The grid (`$P/grid.py`, AA Intelligence Index v5.0.1 per effort) is model-tiers.md §3–4.

**R34: Claude `get_usage`, token-free: PASS.** `python3 -I $P/claude_get_usage.py "$(command -v claude)" $B/getusage/run` (claude 2.1.330; sends `initialize` and `get_usage {skip_behaviors: true}` over stream-json, no user message, reads no credential):
```
argv: --output-format stream-json --verbose --input-format stream-json --strict-mcp-config
+0.3s message type=system subtype=hook_started
+0.3s message type=system subtype=hook_started
+0.5s message type=system subtype=hook_response
+0.6s control_response request_id=init subtype=success
+0.7s control_response request_id=usage subtype=success
keys: ['behaviors', 'rate_limits', 'rate_limits_available', 'session', 'subscription_type']
subscription_type: <plan> | rate_limits_available: True
rate_limits keys: ['amber_cistern', …, 'cedar_ember', …, 'extra_usage', 'five_hour', …, 'limits', …, 'model_scoped', …, 'seven_day', 'seven_day_breakdown', 'seven_day_cowork', 'seven_day_oauth_apps', 'seven_day_omelette', 'seven_day_opus', 'seven_day_sonnet', …]
  five_hour: None
  seven_day: {'utilization': 6, 'resets_at': '2026-11-28T21:00:00.575560+00:00'}
  seven_day_oauth_apps: None
  seven_day_opus: None
  seven_day_sonnet: None
  model_scoped: {'display_name': 'Fable', 'utilization': 4, 'resets_at': '2026-11-28T21:00:00.575720+00:00'}
  extra_usage: {'is_enabled': False}
behaviors is null: True | exit 143 | 1.5s
```
The user's SessionStart hooks ran (`hook_started`); exit 143 is the probe's SIGTERM.

**R35: grok.com billing call: NOT RUN.** A probe that reads `~/.grok/auth.json` in memory and POSTs `GetGrokCreditsConfig` was denied by the session's auto-mode classifier before it was written or run ("Permission for this action was denied … [Unauthorized Access]"). No file was written and no request sent. Live verification of §8.3 steps 2–3 is a user-run step.

**R36: live readers and route: PASS** (2026-11-21). `XDG_CONFIG_HOME=$T XDG_STATE_HOME=$T node dist/cli.js usage` with Claude, Codex and agy consented (Grok left out, R35): Claude `claude` 7d 91% and `claude-fable` 7d 95% from get_usage with no hooks warning; Codex `codex` 30d 10%; agy `agy-gemini` 7d 74% / 5h 100%, `agy-argon` 7d 37%, `agy-3p` 7d 0%; the agy and Claude numbers match an independent statusline reading taken the same minute. `node --test --test-name-pattern='route: (claude|codex|agy) ' test/live/route.test.ts`: 3/3 done with `PINEAPPLE`, each under the guard. Codex's reply was "I’ll check the file.PINEAPPLE": separate agent messages are joined with no separator.

**R37: live parity: PASS** (2026-11-21). `node --test --test-name-pattern='parity: (claude|codex|agy) ' test/live/parity.test.ts`, Grok left out (R35). Codex equal on model `gpt-5.6-terra`, `on-request`, `user`, `workspaceWrite`, `AGENTS.md`, 21 skills, MCP names, and the three listed overrides. Claude equal on model, `auto`, output style, `apiKeySource: none`, agents, plugins, MCP servers, instruction files; first run differed on six slash commands from one of the user's MCP servers, the rerun showed three user MCP servers `pending` in the worker's `system/init` and `connected` under `-p`. agy: first run differed on `pk_par_agy` started (worker only), because `agy -p /skills` starts no MCP server; with a one-turn native prompt both started it, skills equal.

**R38: live tiers: PASS** (2026-11-21). `node --test --test-name-pattern='tiers: (claude|codex|agy) ' test/live/tiers.test.ts`, tier 1 effort low pinned, `agy-3p` cells `null`, Grok left out (R35): Claude `haiku` at `low`, Codex `gpt-5.6-luna` at `max`, agy `gemini-4-hydrogen` at `low`, each reported as expected. Codex's 30-day pool fell from 10% to 7% across the R36–R38 live runs (route, parity, tiers), about 1% per one-turn task at `max` effort.

**R39: live routing: PASS** (2026-11-21). `npm run build && node --test --test-name-pattern=routing test/live/routing.test.ts`, `clientInfo.name: "claude-code"`, Claude, Codex and agy consented, no `overageOff` confirmed, Grok left out (R35): Codex and agy pools listed as `skipped: overage not confirmed off`; Claude `pace 0.87` served vs `0.90` from the CLI (the 5% driver reserve); `next: tier 1 → claude:haiku (medium)`; the routed task ran on `claude` / `haiku`, `status: done`, `PINEAPPLE`. One `schmear usage` run earlier saw `agy /usage timed out after 30000 ms`; the rerun answered in 11 s.

**R40: live resume: PASS for Claude** (2026-11-21). `node --test --test-name-pattern=resume test/live/resume.test.ts`: Claude turn 1 `OK` with a `session:` handle (`claude:haiku` at `low`), turn 2 resumed in the same cwd answered `MANGO` and returned a handle; the account check after `session/resume` passed. Codex and agy skipped (overage not confirmed off), Grok left out (R35).

**R41: live init and the live suite: PASS** (2026-11-21; Codex credits, Grok on-demand/prepaid and Antigravity AI credits confirmed off; Grok usage read approved). Real `node dist/cli.js init --yes` (Claude consent typed, credit lane declined) registered schmear in Claude Code (`claude mcp get`: Connected), Codex, Grok and Antigravity. Grok usage: source step grok.com, `grok` 7d 100% left, guard (§8.3) clear. `SCHMEAR_LIVE_OVERAGE_OFF=codex,grok,agy SCHMEAR_LIVE_GROK=1 node --test test/live/*.test.ts`: parity and resume PASS for all four (Grok's first live runs); route and tiers PASS for Claude, Grok, agy (Codex skipped by the guard once its pool fell to 5%); nested PASS for Claude, Grok, agy, and Codex replied `mcp__schmear__usage` (the run's regex missed host-prefixed names, since fixed); routing PASS with tier 1 → `grok:grok-4.7`, the first live cross-provider pick.

## Main unresolved uncertainty

Every Codex and Grok tier entry rests on one aggregate index with most per-effort scores missing, from free-plan probes (model-tiers.md §5); Claude's primary usage read is an experimental SDK method; and the shape of Anthropic's exhausted-credit error is untested live.
