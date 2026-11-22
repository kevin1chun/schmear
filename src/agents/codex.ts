import { homedir } from "node:os";
import { join } from "node:path";
import { workerEnv } from "../acp.ts";
import type { AgentAdapter, Lane, LaunchSpec, UsageReading, Window, WorkerFailure } from "../types.ts";
import { errorMessage, isRecord, PACKAGE_VERSION, unreadable, versionLine } from "../util.ts";
import { lineExchange, resolvePackageBin, window } from "./shared.ts";

const RPC_TIMEOUT_MS = 15_000;

/** ChatGPT subscription plans (`codex-acp` 2.9.0 `PLAN_DISPLAY_NAMES`, `dist/index.js:49020-49029`). */
const SUBSCRIPTION_PLANS = new Set(["free", "go", "plus", "pro", "team", "business", "enterprise", "edu"]);

/** Codex user config path (`${CODEX_HOME:-~/.codex}/config.toml`). */
export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
}

/** Maps Codex's effective permission triple to the codex-acp mode that reproduces it (spec 8.2, R27). */
export function codexMode(
  sandboxMode: string,
  approvalPolicy: string,
  approvalsReviewer: string,
  configFile = codexConfigPath(),
): string {
  const triple = `${sandboxMode}/${approvalPolicy}/${approvalsReviewer}`;
  switch (triple) {
    case "read-only/on-request/user":
      return "read-only";
    case "workspace-write/on-request/user":
      return "workspace-write";
    case "workspace-write/on-request/auto_review":
      return "agent";
    case "danger-full-access/never/user":
      return "agent-full-access";
    default:
      throw new Error(
        `no codex-acp mode for sandbox_mode=${sandboxMode}, approval_policy=${approvalPolicy}, approvals_reviewer=${approvalsReviewer}; in ${configFile}, set sandbox_mode, approval_policy and approvals_reviewer to a supported combination or set default_permissions`,
      );
  }
}

/** One JSON-RPC call to `<bin> <args>` (initialize, initialized, then `method`); kills the process after the reply. */
async function codexRpc(
  bin: string,
  args: string[],
  method: string,
  params: unknown,
  env: Record<string, string>,
): Promise<unknown> {
  const rpc = (m: Record<string, unknown>): string => JSON.stringify({ jsonrpc: "2.0", ...m });
  const outcome = await lineExchange(
    bin,
    args,
    {
      env,
      timeoutMs: RPC_TIMEOUT_MS,
      start: [
        rpc({
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "schmear", version: PACKAGE_VERSION } },
        }),
      ],
    },
    (line, send) => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        throw new Error("codex app-server sent a line that is not JSON");
      }
      if (!isRecord(msg) || (msg.id !== 1 && msg.id !== 2)) {
        return undefined;
      }
      if (isRecord(msg.error)) {
        throw new Error(`codex app-server error: ${String(msg.error.message)}`);
      }
      if (msg.id === 1) {
        send(rpc({ method: "initialized" }));
        send(rpc({ id: 2, method, params }));
        return undefined;
      }
      return { value: msg.result };
    },
  );
  if (outcome.status === "timeout") {
    throw new Error(`codex app-server did not answer ${method} within ${RPC_TIMEOUT_MS} ms`);
  }
  if (outcome.status === "closed") {
    throw new Error(`codex app-server exited before answering ${method}`);
  }
  return outcome.value;
}

/** `config/read {cwd}` from `<bin> app-server`: the merged config Codex would load for cwd. */
async function readCodexConfig(
  bin: string,
  cwd: string,
  env: Record<string, string>,
): Promise<Record<string, unknown>> {
  const result = await codexRpc(bin, ["app-server"], "config/read", { cwd }, env);
  const config = isRecord(result) ? result.config : undefined;
  if (!isRecord(config)) {
    throw new Error("codex config/read reply has no result.config");
  }
  return config;
}

/** Raw `account/rateLimits/read` result (spec 8.2, R13); token-free. */
export function readCodexUsage(bin: string): Promise<unknown> {
  return codexRpc(
    bin,
    ["-s", "read-only", "-a", "never", "app-server"],
    "account/rateLimits/read",
    null,
    workerEnv(),
  );
}

function codexWindow(raw: unknown, name: string, reached: boolean): Window | string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (!isRecord(raw)) {
    return `Codex ${name} window is not an object`;
  }
  const { usedPercent, windowDurationMins, resetsAt } = raw;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    return `Codex ${name} window has no numeric usedPercent`;
  }
  if (typeof windowDurationMins !== "number" || !(windowDurationMins > 0)) {
    return `Codex ${name} window has no positive windowDurationMins`;
  }
  const kind = windowDurationMins <= 1440 ? "short" : "period";
  const resetsAtMs = typeof resetsAt === "number" ? resetsAt * 1000 : null;
  return window(reached ? 100 : usedPercent, resetsAtMs, kind, windowDurationMins / 60);
}

/** Maps the `account/rateLimits/read` result to a reading (spec 8.2): the pool comes from `rateLimits` only. */
export function parseCodexUsage(raw: unknown, now: number): UsageReading {
  const limits = isRecord(raw) ? raw.rateLimits : undefined;
  if (!isRecord(limits)) {
    return unreadable("codex", "Codex rate-limit reply has no rateLimits", [], now);
  }
  const reached =
    limits.spendControlReached === true ||
    (limits.rateLimitReachedType !== undefined && limits.rateLimitReachedType !== null);
  const windows: Window[] = [];
  for (const name of ["primary", "secondary"]) {
    const w = codexWindow(limits[name], name, reached);
    if (typeof w === "string") {
      return unreadable("codex", w, [], now);
    }
    if (w) {
      windows.push(w);
    }
  }
  if (windows.length === 0) {
    return unreadable("codex", "Codex reports no rate-limit window", [], now);
  }
  const warnings: string[] = [];
  const ownId = typeof limits.limitId === "string" ? limits.limitId : "codex";
  const byId = isRecord(raw) ? raw.rateLimitsByLimitId : undefined;
  for (const id of isRecord(byId) ? Object.keys(byId) : []) {
    if (id !== ownId) {
      warnings.push(`Codex reports another limit '${id}'; not used for routing`);
    }
  }
  return {
    agent: "codex",
    fetchedAt: now,
    pools: [{ id: "codex", agent: "codex", keys: ["codex"], windows }],
    warnings,
  };
}

/** Config values can be structured (a granular approval_policy); name them as JSON. */
function configString(value: unknown, fallback: string): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Undefined for a subscription plan, else why the plan fails detection. */
function codexPlanError(plan: unknown): string | undefined {
  if (typeof plan === "string" && SUBSCRIPTION_PLANS.has(plan.trim().toLowerCase())) {
    return undefined;
  }
  const label = JSON.stringify(plan) ?? "missing";
  return `Codex plan ${label} does not bill a ChatGPT subscription`;
}

export const codexAdapter: AgentAdapter = {
  id: "codex",

  isClient(clientName: string): boolean {
    return clientName === "codex-mcp-client";
  },

  async find(bin: string): Promise<{ version: string } | { error: string }> {
    let version: string;
    let raw: unknown;
    try {
      version = await versionLine(bin, workerEnv());
      raw = await readCodexUsage(bin);
    } catch (err) {
      return { error: errorMessage(err) };
    }
    const limits = isRecord(raw) ? raw.rateLimits : undefined;
    if (!isRecord(limits)) {
      return { error: "Codex rate-limit reply has no rateLimits" };
    }
    const planError = codexPlanError(limits.planType);
    return planError ? { error: planError } : { version };
  },

  async readUsage(bin: string): Promise<UsageReading> {
    try {
      return parseCodexUsage(await readCodexUsage(bin), Date.now());
    } catch (err) {
      return unreadable("codex", errorMessage(err));
    }
  },

  async launch(lane: Lane, cwd: string, bin: string): Promise<LaunchSpec> {
    const env = workerEnv({ CODEX_PATH: bin });
    const config = await readCodexConfig(bin, cwd, env);
    const spec: LaunchSpec = {
      command: process.execPath,
      args: [resolvePackageBin("@agentclientprotocol/codex-acp", "codex-acp")],
      env,
      config: { model: lane.model, effort: lane.effort },
    };
    if (config.default_permissions === undefined || config.default_permissions === null) {
      spec.config = {
        mode: codexMode(
          configString(config.sandbox_mode, "workspace-write"),
          configString(config.approval_policy, "on-request"),
          configString(config.approvals_reviewer, "user"),
          codexConfigPath(env),
        ),
        ...spec.config,
      };
    }
    return spec;
  },

  classifyFailure(f: WorkerFailure): "quota" | "failed" {
    if (f.code === -32603 && isRecord(f.data) && f.data.codexErrorInfo === "usageLimitExceeded") {
      return "quota";
    }
    return "failed";
  },
};
