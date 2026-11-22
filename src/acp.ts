import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  type ClientApp,
  type ClientContext,
  client,
  type InitializeResponse,
  ndJsonStream,
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import type { AgentId, LaunchSpec, WorkerFailure, WorkerOutcome, WorkerRun } from "./types.ts";
import { endChild, errorMessage, isRecord, leadGroup, PACKAGE_VERSION } from "./util.ts";

const STDERR_LIMIT = 4096;
const CANCEL_GRACE_MS = 10_000;
export const OPEN_TIMEOUT_MS = 120_000;

export const STRIPPED_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "MODEL_PROVIDER",
  "CODEX_CONFIG",
  "DEFAULT_AUTH_REQUEST",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "XAI_API_KEY",
  "GROK_CODE_XAI_API_KEY",
  "GROK_AUTH",
  "GROK_MODELS_BASE_URL",
  "GROK_XAI_API_BASE_URL",
  "GROK_CLI_CHAT_PROXY_BASE_URL",
] as const;

export function workerEnv(
  extra?: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const key of STRIPPED_ENV_VARS) {
    delete env[key];
  }
  if (extra) {
    Object.assign(env, extra);
  }
  env.SCHMEAR_WORKER = "1";
  return env;
}

export interface RunWorkerOptions {
  agent: AgentId;
  signal: AbortSignal;
  onRateLimit?: (rateLimit: unknown, cancel: () => void) => void;
  /** Session id to resume (§7 step 4) instead of creating a session. */
  resume?: string;
  /** Limit from spawn until `session/prompt` is sent; defaults to `OPEN_TIMEOUT_MS`. */
  openTimeoutMs?: number;
  permit: (req: RequestPermissionRequest, turn: AbortSignal) => Promise<RequestPermissionResponse>;
}

interface AuthStatus {
  kind: string;
  label?: string;
  detail?: string;
}

function selectValues(option: SessionConfigOption): string[] {
  return option.type === "select"
    ? option.options.flatMap((item) =>
        "group" in item ? item.options.map((sub) => sub.value) : [item.value],
      )
    : [];
}

function currentValue(options: SessionConfigOption[], category: string): string | undefined {
  const option = options.find((opt) => opt.category === category);
  return option?.type === "select" ? option.currentValue : undefined;
}

/** Grok has no effort option; its effort is on the current model's `_meta` in `session/new`'s `models` block (R33). */
function modelsBlockEffort(newSession: unknown): string | undefined {
  const models = (
    newSession as {
      models?: {
        currentModelId?: unknown;
        availableModels?: Array<{ modelId?: unknown; _meta?: { reasoningEffort?: unknown } }>;
      };
    }
  ).models;
  const effort = models?.availableModels?.find((m) => m.modelId === models.currentModelId)?._meta
    ?.reasoningEffort;
  return typeof effort === "string" ? effort : undefined;
}

function isAuthStatus(value: unknown): value is AuthStatus {
  return isRecord(value) && typeof value.kind === "string";
}

interface AcpLaunch {
  /** Names the agent in the "agent exited" error. */
  agent: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  app?: ClientApp;
  /** Aborting it terminates the child early. */
  kill: AbortSignal;
}

/**
 * Spawns an ACP agent, connects, sends `initialize` and runs `op`; a failure (the spawn error first) goes to `fail` with the stderr tail.
 * Teardown ends stdin, ends the child's process group (`endChild`) and awaits the child's exit.
 */
export async function withAcp<T>(
  launch: AcpLaunch,
  op: (ctx: ClientContext, init: InitializeResponse) => Promise<T>,
  fail: (err: unknown, stderr: string) => T,
): Promise<T> {
  // Its own process group, so teardown also ends what the agent started (the vendor CLI, MCP servers).
  const child = leadGroup(
    spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    }),
  );

  // Prevent unhandled EPIPE when the child exits before stdin closes.
  child.stdin.on("error", () => {});

  let stderrBuf: Buffer = Buffer.alloc(0);
  child.stderr.on("data", (chunk: Buffer) => {
    const combined = stderrBuf.length === 0 ? chunk : Buffer.concat([stderrBuf, chunk]);
    stderrBuf =
      combined.length <= STDERR_LIMIT ? combined : combined.subarray(combined.length - STDERR_LIMIT);
  });

  const isChildAlive = (): boolean => child.exitCode === null && child.signalCode === null;

  let spawnError: Error | undefined;
  const childExited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", (err) => {
      spawnError = err;
      resolve();
    });
  });

  let ending = false;
  const terminate = (): void => {
    if (!isChildAlive() || ending) {
      return;
    }
    ending = true;
    endChild(child);
  };
  launch.kill.addEventListener("abort", terminate, { once: true });

  // A grandchild holding stdout keeps the stream open after the child dies, so pending requests would never settle.
  const exited = childExited.then((): never => {
    throw new Error(`${launch.agent} agent exited`);
  });

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  try {
    const connected = (launch.app ?? client({ name: "schmear" })).connectWith(stream, async (ctx) => {
      const init = await ctx.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: {
          name: "schmear",
          version: PACKAGE_VERSION,
        },
      });
      return op(ctx, init);
    });
    return await Promise.race([connected, exited]);
  } catch (err) {
    return fail(spawnError ?? err, stderrBuf.toString("utf8").trim());
  } finally {
    launch.kill.removeEventListener("abort", terminate);
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.end();
    }
    terminate();
    await childExited;
    child.stdout.destroy();
  }
}

export async function runWorker(
  spec: LaunchSpec,
  cwd: string,
  prompt: string,
  opts: RunWorkerOptions,
): Promise<WorkerRun> {
  const { agent } = opts;
  let lastAuthStatus: AuthStatus | undefined;
  let lastRateLimit: unknown;
  let sessionId = "";
  let reply = "";
  let costUsd: number | undefined;
  let prompted = false;
  let configOptions: SessionConfigOption[] = [];
  let blockEffort: string | undefined;
  let offered: string[] | undefined;
  let collecting = false;
  let cancelled = false;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let openTimedOut = false;

  const result = (outcome: WorkerOutcome): WorkerRun => {
    const model = currentValue(configOptions, "model");
    const effort = currentValue(configOptions, "thought_level") ?? blockEffort;
    return {
      ...outcome,
      reply,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(offered ? { offered } : {}),
      sessionId,
      prompted,
    };
  };

  if (opts.signal.aborted) {
    return result({ stopReason: "cancelled" });
  }

  const kill = new AbortController();
  const turn = new AbortController();

  let triggerCancel = (): void => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    turn.abort();
    kill.abort();
  };

  const onAbort = (): void => {
    triggerCancel();
  };
  opts.signal.addEventListener("abort", onAbort, { once: true });

  const openTimeoutMs = opts.openTimeoutMs ?? OPEN_TIMEOUT_MS;
  const openTimer = setTimeout(() => {
    if (!cancelled) {
      openTimedOut = true;
      kill.abort();
    }
  }, openTimeoutMs);

  const app = client({ name: "schmear" })
    .onRequest("session/request_permission", ({ params }) => opts.permit(params, turn.signal))
    .onNotification("session/update", ({ params }) => {
      // `session/load` replays history before it responds; only the prompt's own updates count.
      if (!collecting) {
        return;
      }
      const { update } = params;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        reply += update.content.text;
      } else if (update.sessionUpdate === "usage_update") {
        if (update.cost && update.cost.currency === "USD") {
          // Cumulative per query; a crash may report less than an earlier update (§13).
          costUsd = Math.max(costUsd ?? 0, update.cost.amount);
        }
        if (update._meta && "_claude/rateLimit" in update._meta) {
          lastRateLimit = update._meta["_claude/rateLimit"];
          opts.onRateLimit?.(lastRateLimit, triggerCancel);
        }
      }
    })
    .onNotification(
      "_auth/status_update",
      (params: unknown) => params,
      ({ params }) => {
        const status = isRecord(params) ? params.authStatus : undefined;
        if (isAuthStatus(status)) {
          lastAuthStatus = status;
        }
      },
    );

  const launch: AcpLaunch = {
    agent,
    command: spec.command,
    args: spec.args,
    env: spec.env,
    cwd,
    app,
    kill: kill.signal,
  };

  try {
    return await withAcp(
      launch,
      async (ctx, init): Promise<WorkerRun> => {
        // `agentCapabilities.sessionCapabilities.resume` (session/resume) is preferred over `agentCapabilities.loadSession` (session/load).
        const caps = init.agentCapabilities;
        const meta = spec.sessionMeta ? { _meta: spec.sessionMeta } : {};
        let opened: { configOptions?: SessionConfigOption[] | null };
        if (opts.resume === undefined) {
          const created = await ctx.request("session/new", { cwd, mcpServers: [], ...meta });
          sessionId = created.sessionId;
          opened = created;
        } else if (caps?.sessionCapabilities?.resume) {
          opened = await ctx.request("session/resume", {
            sessionId: opts.resume,
            cwd,
            mcpServers: [],
            ...meta,
          });
          sessionId = opts.resume;
        } else if (caps?.loadSession) {
          opened = await ctx.request("session/load", {
            sessionId: opts.resume,
            cwd,
            mcpServers: [],
            ...meta,
          });
          sessionId = opts.resume;
        } else {
          return result({ failure: { message: `${agent} agent cannot resume a session` } });
        }

        const openedSessionId = sessionId;
        triggerCancel = (): void => {
          if (cancelled) {
            return;
          }
          cancelled = true;
          // Abort `turn` only after the cancel is written, so pending permission requests are answered after it.
          void ctx
            .notify("session/cancel", { sessionId: openedSessionId })
            .catch(() => {})
            .then(() => turn.abort());
          cancelTimer = setTimeout(() => {
            kill.abort();
          }, CANCEL_GRACE_MS);
          cancelTimer.unref();
        };

        if (opts.signal.aborted) {
          triggerCancel();
          return result({ stopReason: "cancelled" });
        }

        if (spec.requireAuth) {
          const matchesKind = lastAuthStatus?.kind === spec.requireAuth.kind;
          const matchesDetail =
            spec.requireAuth.detail === undefined || lastAuthStatus?.detail === spec.requireAuth.detail;
          if (!matchesKind || !matchesDetail) {
            const authLabel = lastAuthStatus?.label ?? lastAuthStatus?.kind ?? "unknown";
            return result({
              failure: {
                message: `auth mismatch: expected ${spec.requireAuth.kind}${
                  spec.requireAuth.detail ? ` (${spec.requireAuth.detail})` : ""
                }, got ${authLabel}`,
                auth: authLabel,
              },
            });
          }
        }

        configOptions = opened.configOptions ?? [];
        blockEffort = modelsBlockEffort(opened);
        const modelOption = configOptions.find((opt) => opt.category === "model");
        if (modelOption) {
          offered = selectValues(modelOption);
        }

        const applyConfigByCategory = async (
          category: "mode" | "model" | "thought_level",
          desiredValue: string,
        ): Promise<WorkerFailure | null> => {
          const option = configOptions.find((opt) => opt.category === category);
          const allowed = option ? selectValues(option) : [];
          if (!option || !allowed.includes(desiredValue)) {
            const list = allowed.join(", ") || "(none)";
            if (!option && category !== "thought_level") {
              return { message: `config option category "${category}" is not available` };
            }
            if (category === "mode") {
              return { message: `invalid mode "${desiredValue}"; available: ${list}` };
            }
            if (category === "model") {
              return {
                message: `model "${desiredValue}" not offered (offered: ${list})`,
                notOffered: { model: desiredValue },
              };
            }
            const model = spec.config?.model ?? currentValue(configOptions, "model") ?? "";
            return {
              message: `effort "${desiredValue}" not offered for model "${model}" (offered: ${list})`,
              notOffered: { model, effort: desiredValue },
            };
          }
          const res = await ctx.request("session/set_config_option", {
            sessionId,
            configId: option.id,
            value: desiredValue,
          });
          if (res.configOptions) {
            configOptions = res.configOptions;
          }
          return null;
        };

        // Effort values depend on the model, so the effort lookup runs on the options the model's response returned.
        const wanted = [
          ["mode", spec.config?.mode],
          ["model", spec.config?.model],
          ["thought_level", spec.config?.effort],
        ] as const;
        for (const [category, value] of wanted) {
          if (value !== undefined) {
            const failure = await applyConfigByCategory(category, value);
            if (failure) {
              return result({ failure });
            }
          }
        }

        clearTimeout(openTimer);
        collecting = true;
        prompted = true;
        const response = await ctx.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        });
        return result({ stopReason: response.stopReason });
      },
      (err, stderr) => {
        if (openTimedOut) {
          return result({
            failure: {
              message: `${agent} did not open a session within ${openTimeoutMs / 1000} s`,
              ...(stderr ? { stderr } : {}),
            },
          });
        }
        if (cancelled && (!(err instanceof RequestError) || err.code === -32800)) {
          return result({ stopReason: "cancelled" });
        }
        const failure: WorkerFailure = {
          message: "",
          ...(stderr ? { stderr } : {}),
          ...(lastRateLimit !== undefined ? { rateLimit: lastRateLimit } : {}),
        };
        if (err instanceof RequestError) {
          failure.code = err.code;
          if (err.data !== undefined) {
            failure.data = err.data;
          }
          failure.message = err.code === -32000 ? `log in with the ${agent} CLI` : err.message;
        } else {
          failure.message = errorMessage(err);
        }
        return result({ failure });
      },
    );
  } finally {
    opts.signal.removeEventListener("abort", onAbort);
    turn.abort();
    clearTimeout(openTimer);
    clearTimeout(cancelTimer);
  }
}
