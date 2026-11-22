import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import {
  agent,
  ndJsonStream,
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type StopReason,
} from "@agentclientprotocol/sdk";

export interface FakeAgentScript {
  configOptions?: SessionConfigOption[];
  /** Config options a `set_config_option` response returns instead of the updated current ones. */
  configOptionsAfterSet?: SessionConfigOption[];
  /** Grok-style `models` block returned by `session/new`. */
  models?: {
    currentModelId: string;
    availableModels: Array<{ modelId: string; name: string; _meta?: Record<string, unknown> }>;
  };
  /** Advertise `agentCapabilities.sessionCapabilities.resume` / `agentCapabilities.loadSession`. */
  advertiseResume?: boolean;
  advertiseLoad?: boolean;
  /** Text `session/load` replays as an `agent_message_chunk` before it responds. */
  replayOnLoad?: string;
  authStatus?: { kind: string; label?: string; detail?: string };
  reply?: string | string[];
  permissionRequests?: Array<{
    toolCall: RequestPermissionRequest["toolCall"];
    options: RequestPermissionRequest["options"];
  }>;
  usageUpdates?: Array<{
    used: number;
    size: number;
    cost?: { amount: number; currency: string };
    _meta?: Record<string, unknown>;
  }>;
  error?: {
    stage?: "initialize" | "session_new" | "session_resume" | "set_config_option" | "prompt";
    code: number;
    message: string;
    data?: unknown;
  };
  /** Never answer `session/new` (after logging it). */
  stallNew?: boolean;
  /** Exit while the first permission request is unanswered. */
  exitWithPermissionPending?: boolean;
  /** Ignore SIGTERM and stdin close, like an adapter whose SIGTERM handler never finishes. */
  trapSigterm?: boolean;
  /** At `session/prompt`, start a grandchild that ignores SIGTERM and holds stdout. */
  grandchild?: boolean;
  /** At `session/prompt`, start the grandchild, then exit. */
  exitLeavingGrandchild?: boolean;
  sleepMs?: number;
  stopReason?: StopReason;
  stderr?: string;
  logFile?: string;
}

export interface FakeAgentLog {
  configSets: Array<{ configId: string; value: unknown }>;
  permissionOutcomes: RequestPermissionResponse[];
  promptCalled: boolean;
  /** Text of the received prompt blocks, concatenated. */
  promptText: string;
  cancelled: boolean;
  /** "new", "resume:<sessionId>" and "load:<sessionId>" in arrival order. */
  sessionCalls: string[];
  /** "set:<configId>", "cancel" and "permission:<outcome>" in arrival order. */
  events: string[];
  /** `_meta` of the last session/new, session/resume or session/load. */
  sessionMeta?: unknown;
  /** The worker's own `ANTHROPIC_API_KEY`. */
  apiKey?: string;
  pid: number;
  grandchildPid?: number;
}

function loadScript(arg: string): FakeAgentScript {
  const raw = arg.trimStart().startsWith("{") ? arg : readFileSync(arg, "utf8");
  return JSON.parse(raw) as FakeAgentScript;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write("fake-agent: missing script argument\n");
    process.exit(2);
  }
  const script = loadScript(arg);

  const log: FakeAgentLog = {
    configSets: [],
    permissionOutcomes: [],
    promptCalled: false,
    promptText: "",
    sessionCalls: [],
    cancelled: false,
    events: [],
    apiKey: process.env.ANTHROPIC_API_KEY,
    pid: process.pid,
  };

  if (script.trapSigterm) {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  }

  const writeLog = (): void => {
    if (script.logFile) {
      // Rename so a test polling the log never reads a truncated file.
      writeFileSync(`${script.logFile}.tmp`, JSON.stringify(log), "utf8");
      renameSync(`${script.logFile}.tmp`, script.logFile);
    }
  };

  const maybeThrow = (stage: NonNullable<FakeAgentScript["error"]>["stage"]): void => {
    if (script.error && (script.error.stage ?? "prompt") === stage) {
      if (script.stderr) {
        process.stderr.write(script.stderr);
      }
      throw new RequestError(script.error.code, script.error.message, script.error.data);
    }
  };

  let configOptions: SessionConfigOption[] = script.configOptions ?? [];
  let cancelSleep: (() => void) | undefined;

  const app = agent({ name: "fake-agent" })
    .onRequest("initialize", ({ params }) => {
      maybeThrow("initialize");
      writeLog();
      return {
        protocolVersion: params.protocolVersion,
        agentInfo: { name: "fake-agent", version: "0.0.0" },
        agentCapabilities: {
          ...(script.advertiseLoad ? { loadSession: true } : {}),
          ...(script.advertiseResume ? { sessionCapabilities: { resume: {} } } : {}),
        },
      };
    })
    .onRequest("session/new", async ({ params, client }) => {
      maybeThrow("session_new");
      log.sessionCalls.push("new");
      log.sessionMeta = params._meta;
      if (script.authStatus) {
        await client.notify("_auth/status_update", { authStatus: script.authStatus });
      }
      writeLog();
      if (script.stallNew) await new Promise(() => {});
      return {
        sessionId: "fake-session-1",
        configOptions,
        ...(script.models ? { models: script.models } : {}),
      };
    })
    .onRequest("session/resume", ({ params }) => {
      maybeThrow("session_resume");
      log.sessionCalls.push(`resume:${params.sessionId}`);
      log.sessionMeta = params._meta;
      writeLog();
      return { configOptions };
    })
    .onRequest("session/load", async ({ params, client }) => {
      log.sessionCalls.push(`load:${params.sessionId}`);
      log.sessionMeta = params._meta;
      if (script.replayOnLoad !== undefined) {
        await client.notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: script.replayOnLoad },
          },
        });
      }
      writeLog();
      return { configOptions };
    })
    .onRequest("session/set_config_option", ({ params }) => {
      maybeThrow("set_config_option");
      log.configSets.push({ configId: params.configId, value: params.value });
      log.events.push(`set:${params.configId}`);
      configOptions = configOptions.map((opt) => {
        if (opt.id !== params.configId) {
          return opt;
        }
        if (opt.type === "select" && typeof params.value === "string") {
          return { ...opt, currentValue: params.value };
        }
        if (opt.type === "boolean" && typeof params.value === "boolean") {
          return { ...opt, currentValue: params.value };
        }
        return opt;
      });
      if (script.configOptionsAfterSet) {
        configOptions = script.configOptionsAfterSet;
      }
      writeLog();
      return { configOptions };
    })
    .onRequest("session/prompt", async ({ params, client }) => {
      log.promptCalled = true;
      log.promptText = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
      writeLog();

      if (script.grandchild || script.exitLeavingGrandchild) {
        const grandchild = spawn(
          process.execPath,
          ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"],
          { stdio: ["ignore", "inherit", "ignore"] },
        );
        log.grandchildPid = grandchild.pid;
        writeLog();
        if (script.exitLeavingGrandchild) {
          process.exit(0);
        }
      }

      if (script.permissionRequests) {
        for (const req of script.permissionRequests) {
          if (script.exitWithPermissionPending) {
            void client
              .request("session/request_permission", {
                sessionId: params.sessionId,
                toolCall: req.toolCall,
                options: req.options,
              })
              .catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 200));
            process.exit(0);
          }
          const outcome = await client.request("session/request_permission", {
            sessionId: params.sessionId,
            toolCall: req.toolCall,
            options: req.options,
          });
          log.permissionOutcomes.push(outcome);
          log.events.push(`permission:${outcome.outcome.outcome}`);
          writeLog();
        }
      }

      if (script.usageUpdates) {
        for (const usage of script.usageUpdates) {
          await client.notify("session/update", {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "usage_update",
              ...usage,
            },
          });
        }
      }

      if (script.reply !== undefined) {
        const chunks = Array.isArray(script.reply) ? script.reply : [script.reply];
        for (const text of chunks) {
          await client.notify("session/update", {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          });
        }
      }

      maybeThrow("prompt");

      if (script.sleepMs && script.sleepMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            cancelSleep = undefined;
            resolve();
          }, script.sleepMs);
          cancelSleep = () => {
            clearTimeout(timer);
            cancelSleep = undefined;
            resolve();
          };
        });
      }

      writeLog();
      return {
        stopReason: log.cancelled ? "cancelled" : (script.stopReason ?? "end_turn"),
      };
    })
    .onNotification("session/cancel", () => {
      log.cancelled = true;
      log.events.push("cancel");
      writeLog();
      cancelSleep?.();
    });

  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );

  const conn = app.connect(stream);
  await conn.closed;
  writeLog();
}

void main();
