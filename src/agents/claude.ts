import { mkdir } from "node:fs/promises";
import { workerEnv } from "../acp.ts";
import { stateDir } from "../state.ts";
import type {
  AgentAdapter,
  Lane,
  LaunchSpec,
  Pool,
  UsageReading,
  Window,
  WorkerFailure,
  WorkerRun,
} from "../types.ts";
import {
  DETECT_TIMEOUT_MS,
  errorMessage,
  execFileAsync,
  isRecord,
  unreadable,
  versionLine,
} from "../util.ts";
import { lineExchange, resolvePackageBin, window } from "./shared.ts";

export function isClaudeQuotaRateLimit(rateLimit: unknown): boolean {
  if (!isRecord(rateLimit)) {
    return false;
  }
  return (
    rateLimit.status === "rejected" || rateLimit.isUsingOverage === true || rateLimit.overageInUse === true
  );
}

const USAGE_TIMEOUT_MS = 15_000;
const USAGE_ARGS = [
  "--output-format",
  "stream-json",
  "--verbose",
  "--input-format",
  "stream-json",
  "--strict-mcp-config",
  "--settings",
  '{"disableAllHooks":true}',
];
const USAGE_REQUESTS = [
  { type: "control_request", request_id: "i", request: { subtype: "initialize" } },
  { type: "control_request", request_id: "u", request: { subtype: "get_usage", skip_behaviors: true } },
].map((r) => JSON.stringify(r));
const CLAUDE_MODELS = ["haiku", "sonnet", "opus", "fable"];
const HOOKS_WARNING = "Claude usage read ran your hooks";
const EXTRA_USAGE_WARNING =
  "Claude extra usage is on: a task that crosses the limit may bill your card. schmear cancels a task as soon as Claude reports overage, but cannot stop the request in flight.";

function usedWindow(raw: unknown, kind: Window["kind"], periodHours: number): Window | null {
  if (!isRecord(raw) || typeof raw.utilization !== "number") {
    return null;
  }
  const resetsAt = typeof raw.resets_at === "string" ? Date.parse(raw.resets_at) : Number.NaN;
  return window(raw.utilization, Number.isNaN(resetsAt) ? null : resetsAt, kind, periodHours);
}

/** Maps the stream-json messages of a `get_usage` exchange (§8.1) to pools. */
export function parseClaudeUsage(messages: unknown[], now: number): UsageReading {
  const warnings: string[] = [];
  if (messages.some((m) => isRecord(m) && m.type === "system" && m.subtype === "hook_started")) {
    warnings.push(HOOKS_WARNING);
  }
  const unread = (error: string): UsageReading => unreadable("claude", error, warnings, now);

  let answer: Record<string, unknown> | undefined;
  for (const m of messages) {
    if (
      isRecord(m) &&
      m.type === "control_response" &&
      isRecord(m.response) &&
      m.response.request_id === "u"
    ) {
      answer = m.response;
    }
  }
  if (!answer) {
    return unread("Claude get_usage gave no answer");
  }
  if (answer.subtype !== "success") {
    const detail = typeof answer.error === "string" ? answer.error.slice(0, 200) : String(answer.subtype);
    return unread(`Claude get_usage failed: ${detail}`);
  }
  const body = answer.response;
  const limits = isRecord(body) && body.rate_limits_available === true ? body.rate_limits : null;
  if (!isRecord(limits)) {
    return unread("Claude reports no plan limits for this login");
  }

  const week =
    usedWindow(limits.seven_day, "period", 168) ?? usedWindow(limits.seven_day_oauth_apps, "period", 168);
  if (!week) {
    return unread("Claude reports no weekly limit");
  }
  const five = usedWindow(limits.five_hour, "short", 5);
  const pools: Pool[] = [
    { id: "claude", agent: "claude", keys: ["claude"], windows: five ? [five, week] : [week] },
  ];
  const addScoped = (name: string, w: Window | null): void => {
    const id = `claude-${name}`;
    if (!w || pools.some((p) => p.id === id)) {
      return;
    }
    const known = CLAUDE_MODELS.includes(name);
    if (!known) {
      warnings.push(`unknown Claude model window '${name}'`);
    }
    pools.push({ id, agent: "claude", keys: ["claude"], models: known ? [name] : undefined, windows: [w] });
  };
  addScoped("opus", usedWindow(limits.seven_day_opus, "period", 168));
  addScoped("sonnet", usedWindow(limits.seven_day_sonnet, "period", 168));
  if (Array.isArray(limits.model_scoped)) {
    for (const row of limits.model_scoped) {
      if (isRecord(row) && typeof row.display_name === "string") {
        addScoped(row.display_name.toLowerCase(), usedWindow(row, "period", 168));
      }
    }
  }
  if (isRecord(limits.extra_usage) && limits.extra_usage.is_enabled === true) {
    warnings.push(EXTRA_USAGE_WARNING);
  }
  return { agent: "claude", fetchedAt: now, pools, warnings };
}

/** Spawns `bin` for one token-free `get_usage` exchange (§8.1); never throws, never writes a user message. */
export async function readClaudeUsage(bin: string, timeoutMs = USAGE_TIMEOUT_MS): Promise<UsageReading> {
  const messages: unknown[] = [];
  let failure: string | undefined;
  try {
    const dir = stateDir();
    await mkdir(dir, { recursive: true });
    const outcome = await lineExchange(
      bin,
      USAGE_ARGS,
      { env: workerEnv(), cwd: dir, timeoutMs, start: USAGE_REQUESTS },
      (line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return undefined;
        }
        messages.push(message);
        const answered =
          isRecord(message) &&
          message.type === "control_response" &&
          isRecord(message.response) &&
          message.response.request_id === "u";
        return answered ? { value: undefined } : undefined;
      },
    );
    if (outcome.status === "timeout") {
      failure = `Claude get_usage timed out after ${timeoutMs / 1000} s`;
    }
  } catch (err) {
    failure = `Claude get_usage could not start: ${errorMessage(err)}`;
  }
  const reading = parseClaudeUsage(messages, Date.now());
  return failure ? { ...reading, pools: [], error: failure } : reading;
}

/** The env var a credit lane's key (§13) reaches the worker in. */
const CREDIT_KEY_ENV = "ANTHROPIC_API_KEY";

/** A credit lane's launch: its key in this spawn's env and the reserved budget B as the SDK's `maxBudgetUsd` (§13). */
export const creditSpec = (spec: LaunchSpec, key: string, budgetUsd: number): LaunchSpec => ({
  ...spec,
  env: { ...spec.env, [CREDIT_KEY_ENV]: key },
  sessionMeta: { claudeCode: { options: { maxBudgetUsd: budgetUsd } } },
});

/** The vendor's credit exhaustion error (§13 absolute stop c). */
export const creditExhausted = (f: WorkerFailure): boolean =>
  (isRecord(f.data) && f.data.errorKind === "billing_error") || /credit balance is too low/i.test(f.message);

/**
 * The SDK's `maxBudgetUsd` stop: claude-agent-acp sends the result's `errors` ("Reached maximum budget ($B)"), else its
 * subtype; without `is_error` it is stop reason `max_turn_requests`, which only a budget can cause, as schmear sets
 * no turn limit (result-end.js:31–58).
 */
export const budgetStopped = (run: WorkerRun): boolean =>
  run.failure
    ? /Reached maximum budget|error_max_budget_usd/.test(run.failure.message)
    : run.stopReason === "max_turn_requests";

export const claudeAdapter: AgentAdapter = {
  id: "claude",

  isClient(clientName: string): boolean {
    return clientName === "claude-code";
  },

  async find(bin: string): Promise<{ version: string } | { error: string }> {
    const env = workerEnv();
    let version: string;
    let status: unknown;
    try {
      const [line, auth] = await Promise.all([
        versionLine(bin, env),
        execFileAsync(bin, ["auth", "status", "--json"], { env, timeout: DETECT_TIMEOUT_MS }),
      ]);
      version = line;
      status = JSON.parse(auth.stdout);
    } catch (err) {
      return { error: errorMessage(err) };
    }
    if (!isRecord(status) || status.loggedIn !== true) {
      return { error: "claude is not logged in" };
    }
    if (status.authMethod !== "claude.ai") {
      return { error: `claude needs a claude.ai login, not ${JSON.stringify(status.authMethod)}` };
    }
    if (status.apiKeySource) {
      return {
        error: `claude uses an API key from ${JSON.stringify(status.apiKeySource)}, which workers would bill`,
      };
    }
    return { version };
  },

  readUsage(bin: string): Promise<UsageReading> {
    return readClaudeUsage(bin);
  },

  async launch(lane: Lane, _cwd: string, bin: string): Promise<LaunchSpec> {
    return {
      command: process.execPath,
      args: [resolvePackageBin("@agentclientprotocol/claude-agent-acp", "claude-agent-acp")],
      env: workerEnv({ CLAUDE_CODE_EXECUTABLE: bin }),
      config: { model: lane.model, effort: lane.effort },
      requireAuth:
        lane.key === "claude-credits" ? { kind: "api_key", detail: CREDIT_KEY_ENV } : { kind: "account" },
    };
  },

  quotaRateLimit: isClaudeQuotaRateLimit,

  classifyFailure(f: WorkerFailure): "quota" | "failed" {
    if (f.code === -32603 && isRecord(f.data)) {
      if (f.data.errorKind === "billing_error") {
        return "quota";
      }
      if (
        f.data.errorKind === "rate_limit" &&
        isRecord(f.data.rateLimit) &&
        f.data.rateLimit.status === "rejected"
      ) {
        return "quota";
      }
    }
    if (isClaudeQuotaRateLimit(f.rateLimit)) {
      return "quota";
    }
    return "failed";
  },
};
