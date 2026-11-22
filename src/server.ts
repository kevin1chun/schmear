import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { delegate, loadRouting, MAX_DESCRIPTION_CHARS, MAX_TASKS } from "./delegate.ts";
import type { PoolRow } from "./router.ts";
import { readConfig, USAGE_SHOW_MS } from "./state.ts";
import { DEFAULT_TIERS, parseTiers } from "./tiers.ts";
import {
  AGENT_IDS,
  type AgentAdapter,
  type AgentId,
  type Ask,
  type TaskResult,
  type TierList,
  type UsageReading,
  type Window,
} from "./types.ts";
import { errorMessage, PACKAGE_VERSION } from "./util.ts";

export const INSTRUCTIONS =
  "schmear hands subtasks to AI coding agents on the user's other subscriptions, spending the quota most at risk of expiring unused before its reset; your own subscription keeps a reserve. Use delegate for any self-contained subtask you would give a subagent: research, a review, tests, a scoped change. Write each prompt so the worker needs nothing else from you. Put independent subtasks in one delegate call; they run in parallel. Give each task the lowest tier that can do it well. The usage tool shows each subscription's quota and the lane each tier would take.";

function delegateDescription(tiers: TierList): string {
  const models = tiers
    .map((tier, i) => `${i + 1} ${[...new Set(tier.map((e) => e.model))].join(", ")}`)
    .join("; ");
  return `Hand self-contained coding subtasks to other AI coding agents running on the user's subscriptions; schmear picks the agent whose quota is most at risk of expiring unused. Tasks in one call run in parallel. Each task runs in the cwd you give it, and tasks given the same cwd share that directory: isolate tasks that could conflict yourself, for example in separate git worktrees. The prompt is sent verbatim; the worker sees nothing else from you. tier is the minimum model strength, from 1 (weakest) to ${tiers.length}: a task runs on a model of its tier or a stronger one, so give harder work, or work that needs more thinking, a higher tier. Models by tier: ${models}. Pass a result's session to continue that subagent. agents limits a task to these agents (claude, codex, grok, agy); schmear still picks the subscription. Status no_quota means no subscription has quota left for the task: do it yourself.`;
}

const delegateInputSchema = (maxTier: number) => ({
  tasks: z
    .array(
      z.object({
        prompt: z.string().min(1),
        cwd: z.string().min(1).describe("Absolute path of an existing directory the worker runs in."),
        tier: z.number().int().min(1).max(maxTier),
        description: z
          .string()
          .min(1)
          .max(MAX_DESCRIPTION_CHARS)
          .optional()
          .describe("Short single-line label for the task (defaults to the prompt's first line)."),
        agents: z
          .array(z.enum(AGENT_IDS))
          .min(1)
          .optional()
          .describe("Limit this task to these agents; schmear picks the subscription."),
        session: z
          .string()
          .min(1)
          .optional()
          .describe("Session handle from an earlier result to continue that subagent."),
      }),
    )
    .min(1)
    .max(MAX_TASKS),
});

function formatTaskResults(results: TaskResult[]): string {
  return results
    .map((r) => {
      const fields: [string, string | undefined][] = [
        ["status", r.status],
        ["provider", r.provider],
        ["model", r.model],
        ["effort", r.effort],
        ["session", r.session],
        ["cost", r.costUsd === undefined ? undefined : `$${r.costUsd.toFixed(4)}`],
        ["notes", r.notes.length > 0 ? r.notes.join("; ") : undefined],
        ["error", r.error],
      ];
      const lines = [
        `## ${r.description}`,
        ...fields.flatMap(([k, v]) => (v === undefined ? [] : [`${k}: ${v}`])),
      ];
      if (r.reply.length > 0) lines.push("", r.reply);
      return lines.join("\n");
    })
    .join("\n\n");
}

function formatWindow(w: Window): string {
  const hours = Number(w.periodHours.toFixed(1));
  const span = hours >= 24 && hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
  const reset = w.resetsAt === null ? "reset unknown" : `resets ${new Date(w.resetsAt).toISOString()}`;
  return `${w.kind} ${span} ${Math.round(w.remaining * 100)}% left, ${reset}`;
}

function formatReading(reading: UsageReading, rows: Map<string, PoolRow>): string[] {
  const lines: string[] = [];
  if (reading.source !== undefined) {
    lines.push(`source: ${reading.source}`);
  }
  if (reading.error !== undefined) {
    lines.push(`skipped: ${reading.error}`);
  }
  for (const pool of reading.pools) {
    const models = pool.models ? ` [${pool.models.join(", ")}]` : "";
    const row = rows.get(pool.id);
    const verdict = row ? ` | pace ${row.pace === null ? "-" : row.pace.toFixed(2)} | ${row.status}` : "";
    lines.push(`pool ${pool.id}${models}: ${pool.windows.map(formatWindow).join("; ")}${verdict}`);
  }
  for (const warning of reading.warnings) {
    lines.push(`warning: ${warning}`);
  }
  return lines;
}

/** The `usage` tool's text (§12): the driver, per consented agent its pools with pace and status or why it is skipped, each routed credit pool, then the lane each tier's next task would take and the list entries the account does not offer. */
export async function usageText(
  adapters: Partial<Record<AgentId, AgentAdapter>>,
  driver: AgentId | null,
): Promise<string> {
  const { config, tiers, offered, routable, readings, credits, read, lanes, routeTasks } =
    await loadRouting(adapters);
  await Promise.all(routable.map((id) => read(id, USAGE_SHOW_MS)));
  const none = new Set<string>();
  const rows = new Map(routeTasks(driver, none, []).pools.map((row) => [row.id, row]));
  const blocks = Object.values(adapters).map((adapter): string => {
    const entry = config.agents[adapter.id];
    const reading = readings.get(adapter.id);
    let lines: string[];
    if (!entry) {
      lines = ["skipped: not configured"];
    } else if (!entry.consent) {
      lines = ["skipped: no consent"];
    } else {
      lines = formatReading(reading as UsageReading, rows); // read for every consented agent
    }
    return [`## ${adapter.id}`, ...lines].join("\n");
  });
  for (const [id, reading] of credits) {
    blocks.push([`## ${id}`, ...formatReading(reading, rows)].join("\n"));
  }
  // One route() call per tier holding one task, so the batch split never changes a line.
  const next = tiers.map((_, i) => {
    const lane = routeTasks(driver, none, [lanes(i + 1)]).assignments[0];
    return `next: tier ${i + 1} → ${lane ? `${lane.id} (${lane.effort})` : "none"}`;
  });
  const missing = new Set<string>();
  const missed = tiers.flatMap((tier, i) =>
    tier.flatMap(({ key, model, effort }) => {
      const id = `${key}:${model}`;
      if (offered[key]?.includes(model) !== false || missing.has(id)) return [];
      missing.add(id);
      return [`${id}@${effort} (tier ${i + 1})`];
    }),
  );
  if (missed.length > 0) {
    next.push(`not offered: ${missed.join(", ")}`);
  }
  return [`driver: ${driver ?? "unknown"}`, ...blocks, next.join("\n")].join("\n\n");
}

function detectDriver(server: McpServer, adapters: Partial<Record<AgentId, AgentAdapter>>): AgentId | null {
  const clientName = server.server.getClientVersion()?.name;
  if (!clientName) {
    return null;
  }
  for (const adapter of Object.values(adapters)) {
    if (adapter?.isClient(clientName)) {
      return adapter.id;
    }
  }
  return null;
}

// Matches init's host timeouts; the SDK default of 60 s would reject a prompt the user is still reading.
const ASK_TIMEOUT_MS = 86_400_000;

/** §12 permission prompts: a form elicitation per request, or none when the client lacks form elicitation. */
function formAsk(server: McpServer): Ask | undefined {
  if (!server.server.getClientCapabilities()?.elicitation?.form) {
    return undefined;
  }
  return async (message, options, signal) => {
    const result = await server.server.elicitInput(
      {
        mode: "form",
        message,
        requestedSchema: {
          type: "object",
          required: ["option"],
          properties: {
            option: {
              type: "string",
              title: "Permission",
              enum: options.map((o) => o.optionId),
              enumNames: options.map((o) => o.name),
            },
          },
        },
      },
      { signal, timeout: ASK_TIMEOUT_MS },
    );
    const option = result.content?.option;
    return result.action === "accept" && typeof option === "string" ? option : undefined;
  };
}

export async function createServer(adapters: Partial<Record<AgentId, AgentAdapter>>): Promise<McpServer> {
  const tiers = parseTiers((await readConfig()).tiers ?? DEFAULT_TIERS);
  const delegating = process.env.SCHMEAR_WORKER !== "1";
  const info = { name: "schmear", version: PACKAGE_VERSION };
  const shutdownController = new AbortController();
  const activeCalls = new Set<Promise<unknown>>();
  // Closing aborts every running delegate call and waits for its workers to exit.
  const server = new (class extends McpServer {
    override async close(): Promise<void> {
      shutdownController.abort();
      await Promise.allSettled(activeCalls);
      await super.close();
    }
  })(info, delegating ? { instructions: INSTRUCTIONS } : undefined);
  server.server.onclose = () => shutdownController.abort();

  // A worker's own schmear must not delegate again: that would loop work across agents.
  if (delegating) {
    server.registerTool(
      "delegate",
      {
        title: "Delegate tasks",
        description: delegateDescription(tiers),
        inputSchema: delegateInputSchema(tiers.length),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (args, extra) => {
        const signal = AbortSignal.any([extra.signal, shutdownController.signal]);
        const driver = detectDriver(server, adapters);
        const run = delegate(args, { driver, signal, ask: formAsk(server) }, adapters);
        activeCalls.add(run);
        try {
          const results = await run;
          return {
            content: [{ type: "text", text: formatTaskResults(results) }],
          };
        } finally {
          activeCalls.delete(run);
        }
      },
    );
  }

  server.registerTool(
    "usage",
    {
      title: "Subscription usage",
      description:
        "Show each consented agent's subscription pools with every window's remaining quota and reset time, each pool's pace and status, and the lane the next task of each tier would take, or why an agent is skipped.",
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [{ type: "text", text: await usageText(adapters, detectDriver(server, adapters)) }],
    }),
  );

  return server;
}

export async function serveStdio(adapters: Partial<Record<AgentId, AgentAdapter>>): Promise<void> {
  const server = await createServer(adapters);
  const transport = new StdioServerTransport();

  server.server.onerror = (error) => {
    process.stderr.write(`schmear server error: ${error.message}\n`);
  };

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void (async () => {
      try {
        await server.close();
      } catch (error) {
        process.stderr.write(`schmear shutdown error: ${errorMessage(error)}\n`);
      } finally {
        process.exit(0);
      }
    })();
  };

  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await server.connect(transport);
}
