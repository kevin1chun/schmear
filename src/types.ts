import type { PermissionOption } from "@agentclientprotocol/sdk";
import type { z } from "zod";
import type { ConfigSchema } from "./state.ts";

export const AGENT_IDS = ["claude", "codex", "grok", "agy"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export const LANE_KEYS = [
  "claude",
  "codex",
  "grok",
  "agy-gemini",
  "agy-argon",
  "agy-3p",
  "claude-credits",
] as const;
export type LaneKey = (typeof LANE_KEYS)[number];

export interface Window {
  kind: "short" | "period"; // short: rolling ≤ 24 h; period: weekly, 30-day, cycle
  remaining: number; // fraction left, 0..1
  resetsAt: number | null; // epoch ms
  periodHours: number;
}

export interface Pool {
  id: string; // "claude", "claude-opus", "codex", "agy-gemini", ...
  agent: AgentId;
  keys: LaneKey[]; // lanes of these keys draw on it
  models?: string[]; // only lanes running one of these model values; undefined = every model
  windows: Window[];
}

export interface UsageReading {
  agent: AgentId;
  fetchedAt: number;
  pools: Pool[];
  error?: string; // set: the agent is skipped (unreadable, or a spend guard)
  warnings: string[];
  source?: string; // the step that produced the reading, when an agent has several (Grok)
}

/** A parsed tier-list entry `key:model@effort`; model and effort are the provider's own option values. */
export interface Entry {
  key: LaneKey;
  model: string;
  effort: string;
}
/** Weakest first: index 0 is tier 1. */
export type TierList = Entry[][];
/** Models each lane key's account offered at its last run; absent = unknown. */
export type Offered = Partial<Record<LaneKey, string[]>>;

export type Config = z.infer<typeof ConfigSchema>;

/** `Config.credits`: the `claude-credits` lane's pool (§13). */
export interface CreditPoolConfig {
  grantUsd: number;
  cycleDay: number; // 1..31, clamped to the month's last day
  keyCommand: string[];
  taskCapUsd: number;
  overageOff: true;
}

/** A way to spend a pool. */
export interface Lane {
  id: string; // `${key}:${model}`
  agent: AgentId;
  key: LaneKey;
  tier: number; // the tier of the entry that runs (≥ the task's)
  model: string;
  effort: string;
}

/** Asks the driver's user to pick one of a permission request's options (§12). Resolves to the chosen optionId, or undefined on decline or cancel; throws on error. */
export type Ask = (
  message: string,
  options: PermissionOption[],
  signal: AbortSignal,
) => Promise<string | undefined>;

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  requireAuth?: { kind: string; detail?: string };
  config?: { mode?: string; model?: string; effort?: string }; // set in this order (§7 step 5)
  sessionMeta?: Record<string, unknown>; // `_meta` of the session request (§7 step 4)
}

export interface WorkerFailure {
  code?: number;
  message: string; // the agent's own error text; classifiers match this, never stderr
  stderr?: string; // tail of the worker's stderr, shown in the task's error only
  data?: unknown;
  rateLimit?: unknown;
  auth?: string;
  notOffered?: { model: string; effort?: string }; // effort set: that effort is missing
}

export type WorkerOutcome =
  | { stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"; failure?: never }
  | { failure: WorkerFailure; stopReason?: never };

export type WorkerRun = WorkerOutcome & {
  reply: string;
  costUsd?: number;
  model?: string;
  effort?: string;
  offered?: string[]; // the session's `model` option values, when it has one
  sessionId: string;
  prompted: boolean; // session/prompt was sent
};

export interface AgentAdapter {
  id: AgentId;
  isClient(clientName: string): boolean;
  find(bin: string): Promise<{ version: string } | { error: string }>; // error: why detection failed, printed by init
  readUsage(bin: string): Promise<UsageReading>; // always reads (delegate.ts caches); never throws
  launch(lane: Lane, cwd: string, bin: string): Promise<LaunchSpec>;
  classifyFailure(f: WorkerFailure): "quota" | "failed";
  quotaRateLimit?(rateLimit: unknown): boolean; // a live rate-limit notice that ends the run as quota (§10 step 6)
}

export interface DelegateInput {
  tasks: DelegateTask[];
}

export interface DelegateTask {
  prompt: string;
  cwd: string;
  tier: number; // 1..N
  description?: string;
  agents?: AgentId[]; // schmear picks the subscription within these agents
  session?: string; // TaskResult.session from an earlier call
}

/** What `TaskResult.session` carries, base64url JSON (§6): the lane and ACP session a task continues. */
export interface SessionHandle {
  agent: AgentId;
  key: LaneKey;
  model: string;
  effort: string;
  tier: number; // the tier number the lane ran at, under that call's list
  sessionId: string;
  cwd: string;
  costUsd?: number; // the run's cumulative reported cost: a resumed Claude session reports its earlier turns too (sdk.d.ts:6275)
}

export interface TaskResult {
  description: string;
  status: "done" | "failed" | "cancelled" | "no_quota";
  provider?: AgentId;
  model?: string;
  effort?: string;
  session?: string;
  costUsd?: number; // a resumed run's own spend, net of its handle's costUsd
  reply: string;
  notes: string[];
  error?: string;
}
