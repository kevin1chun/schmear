import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { workerEnv } from "../src/acp.ts";
import { window } from "../src/agents/shared.ts";
import { encodeSession } from "../src/delegate.ts";
import { createServer, INSTRUCTIONS, usageText } from "../src/server.ts";
import { writeOffered } from "../src/state.ts";
import type { AgentAdapter, AgentId, LaneKey, LaunchSpec, UsageReading } from "../src/types.ts";
import type { FakeAgentLog, FakeAgentScript } from "./fake-agent.ts";

// Keep the user's real schmear config and state out of these tests.
const xdg = mkdtempSync(join(tmpdir(), "schmear-server-xdg-"));
process.env.XDG_CONFIG_HOME = xdg;
process.env.XDG_STATE_HOME = xdg;
after(() => rmSync(xdg, { recursive: true, force: true }));
// delegate routes by config: one consented Claude with the fake binary path.
mkdirSync(join(xdg, "schmear"));
writeFileSync(
  join(xdg, "schmear", "config.json"),
  JSON.stringify({ version: 1, agents: { claude: { consent: true, path: "/fake/bin/claude" } } }),
);

const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.ts", import.meta.url));

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "schmear-server-test-"));
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function makeFakeAdapter(
  scriptForTask: (callIndex: number) => FakeAgentScript,
  id: AgentId = "claude",
  readUsage: AgentAdapter["readUsage"] = async () => ({
    agent: id,
    fetchedAt: 0,
    pools: [{ id, agent: id, keys: [id as LaneKey], windows: [window(50, null, "period", 168)] }],
    warnings: [],
  }),
): AgentAdapter {
  let callIndex = 0;
  return {
    id,
    isClient: (name) => name === "claude-code",
    async find() {
      return { path: `/fake/bin/${id}`, version: "1.0.0" };
    },
    async launch(): Promise<LaunchSpec> {
      const script = scriptForTask(callIndex++);
      return {
        command: process.execPath,
        args: [FAKE_AGENT, JSON.stringify(script)],
        env: workerEnv(),
      };
    },
    readUsage,
    classifyFailure() {
      return "failed";
    },
  };
}

async function withClientServer<T>(
  adapters: Partial<Record<AgentId, AgentAdapter>>,
  fn: (client: Client, server: Awaited<ReturnType<typeof createServer>>) => Promise<T>,
  onElicit?: (
    params: ElicitRequest["params"],
    signal: AbortSignal,
    requestId: string | number,
  ) => Promise<ElicitResult>,
): Promise<T> {
  const server = await createServer(adapters);
  const client = new Client(
    { name: "claude-code", version: "1.0.0" },
    onElicit ? { capabilities: { elicitation: { form: {} } } } : undefined,
  );
  if (onElicit) {
    client.setRequestHandler(ElicitRequestSchema, (req, extra) =>
      onElicit(req.params, extra.signal, extra.requestId),
    );
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client, server);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

async function waitForLog(
  logFile: string,
  done: (log: FakeAgentLog) => boolean,
): Promise<FakeAgentLog | undefined> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const log = JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog;
      if (done(log)) return log;
    } catch {
      // not written yet, or caught mid-write
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

function firstTextContent(result: Awaited<ReturnType<Client["callTool"]>>): string {
  assert.ok("content" in result && Array.isArray(result.content));
  const block = result.content[0];
  assert.ok(block && block.type === "text");
  return block.text;
}

/** Runs `fn` with `config` written to a fresh config dir and a fresh state dir. */
async function withConfig<T>(config: unknown, fn: () => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const prev = { config: process.env.XDG_CONFIG_HOME, state: process.env.XDG_STATE_HOME };
    process.env.XDG_CONFIG_HOME = dir;
    process.env.XDG_STATE_HOME = dir;
    try {
      mkdirSync(join(dir, "schmear"));
      writeFileSync(join(dir, "schmear", "config.json"), JSON.stringify(config));
      return await fn();
    } finally {
      for (const [name, value] of [
        ["XDG_CONFIG_HOME", prev.config],
        ["XDG_STATE_HOME", prev.state],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
}

/** The properties of the delegate tool's task schema. */
function taskProperties(
  tool: { inputSchema: { properties?: unknown } } | undefined,
): Record<string, { minimum?: number; maximum?: number }> {
  assert.ok(tool);
  const tasks = (
    tool.inputSchema.properties as Record<
      string,
      { items: { properties: Record<string, { minimum?: number; maximum?: number }> } }
    >
  ).tasks;
  return tasks?.items.properties ?? {};
}

const claudeConfig = { version: 1, agents: { claude: { consent: true, path: "/fake/bin/claude" } } };

/** The handle a fake-agent run in `cwd` returns (the Claude tier-1 lane, the fake's first session). */
const handle = (cwd: string, costUsd?: number): Promise<string> =>
  encodeSession({
    agent: "claude",
    key: "claude",
    model: "haiku",
    effort: "medium",
    tier: 1,
    sessionId: "fake-session-1",
    cwd,
    ...(costUsd !== undefined ? { costUsd } : {}),
  });

describe("createServer", () => {
  it("registers the delegate and usage tools with their annotations", async () => {
    const adapter = makeFakeAdapter(() => ({ reply: "ok" }));
    await withClientServer({ claude: adapter }, async (client) => {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        ["delegate", "usage"],
      );
      const [delegateTool, usageTool] = tools;
      assert.deepEqual(delegateTool?.annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
      assert.deepEqual(usageTool?.annotations, { readOnlyHint: true });
    });
  });

  it("pins the delegate input schema from listTools", async () => {
    await withClientServer({ claude: makeFakeAdapter(() => ({ reply: "ok" })) }, async (client) => {
      const [delegateTool] = (await client.listTools()).tools;
      assert.deepEqual(delegateTool?.inputSchema, {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        required: ["tasks"],
        properties: {
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              type: "object",
              required: ["prompt", "cwd", "tier"],
              properties: {
                prompt: { type: "string", minLength: 1 },
                cwd: {
                  type: "string",
                  minLength: 1,
                  description: "Absolute path of an existing directory the worker runs in.",
                },
                tier: { type: "integer", minimum: 1, maximum: 4 },
                description: {
                  type: "string",
                  minLength: 1,
                  maxLength: 80,
                  description: "Short single-line label for the task (defaults to the prompt's first line).",
                },
                agents: {
                  type: "array",
                  minItems: 1,
                  description: "Limit this task to these agents; schmear picks the subscription.",
                  items: {
                    type: "string",
                    enum: ["claude", "codex", "grok", "agy"],
                  },
                },
                session: {
                  type: "string",
                  minLength: 1,
                  description: "Session handle from an earlier result to continue that subagent.",
                },
              },
            },
          },
        },
      });
    });
  });

  it("states a configured list's tiers and bounds the tier schema by it", async () => {
    const tiers = [["claude:sonnet@low", "codex:gpt-5.6-terra@medium"], ["claude:opus@high"]];
    await withConfig({ ...claudeConfig, tiers }, async () => {
      await withClientServer({ claude: makeFakeAdapter(() => ({ reply: "ok" })) }, async (client) => {
        const [delegateTool] = (await client.listTools()).tools;
        assert.match(delegateTool?.description ?? "", /from 1 \(weakest\) to 2:/);
        assert.match(delegateTool?.description ?? "", /Models by tier: 1 sonnet, gpt-5\.6-terra; 2 opus\./);
        const { tier } = taskProperties(delegateTool);
        assert.equal(tier.maximum, 2);
        assert.equal(tier.minimum, 1);
      });
    });
  });

  it("sends INSTRUCTIONS with delegate and none in worker mode", async () => {
    const adapters = { claude: makeFakeAdapter(() => ({ reply: "ok" })) };
    await withClientServer(adapters, async (client) => {
      assert.equal(client.getInstructions(), INSTRUCTIONS);
    });
    process.env.SCHMEAR_WORKER = "1";
    try {
      await withClientServer(adapters, async (client) => {
        assert.equal(client.getInstructions(), undefined);
      });
    } finally {
      delete process.env.SCHMEAR_WORKER;
    }
  });

  it("refuses to start on an invalid config, and the usage tool errors when the config goes bad later", async () => {
    const adapters = { claude: makeFakeAdapter(() => ({ reply: "ok" })) };
    await withConfig({ ...claudeConfig, tiers: [["claude:haiku"]] }, async () => {
      await assert.rejects(
        createServer(adapters),
        /malformed config .*config\.json: tier 1 entry "claude:haiku": expected "key:model@effort"/,
      );
    });
    await withConfig(claudeConfig, async () => {
      await withClientServer(adapters, async (client) => {
        writeFileSync(
          join(process.env.XDG_CONFIG_HOME as string, "schmear", "config.json"),
          JSON.stringify({ ...claudeConfig, reserve: { claude: 2 } }),
        );
        const result = await client.callTool({ name: "usage", arguments: {} });
        assert.equal(result.isError, true);
        assert.match(firstTextContent(result), /malformed config .*: reserve\.claude must be a fraction/);
      });
    });
  });

  it("usage prints next for tiers 1..N and the entries the account does not offer", async () => {
    const tiers = [
      ["claude:haiku@low", "claude:opus@high"],
      ["claude:opus@high", "claude:fable@medium"],
    ];
    await withConfig({ ...claudeConfig, tiers }, async () => {
      await writeOffered("claude", ["haiku"]);
      const text = await usageText({ claude: makeFakeAdapter(() => ({ reply: "ok" })) }, null);
      assert.ok(
        text.endsWith(
          [
            "next: tier 1 → claude:haiku (low)",
            "next: tier 2 → none",
            "not offered: claude:opus@high (tier 1), claude:fable@medium (tier 2)",
          ].join("\n"),
        ),
        text,
      );
    });
  });

  it("usage prints pools with pace and status, skipped agents, warnings, and the next lane per tier", async () => {
    await withTempDir(async (dir) => {
      const prev = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = dir;
      const now = Date.UTC(2026, 10, 21, 12, 0, 0);
      mock.timers.enable({ apis: ["Date"], now });
      try {
        mkdirSync(join(dir, "schmear"));
        writeFileSync(
          join(dir, "schmear", "config.json"),
          JSON.stringify({
            version: 1,
            agents: {
              claude: { consent: true, path: "/fake/claude" },
              codex: { consent: true, path: "/fake/codex", overageOff: true },
              grok: { consent: true, path: "/fake/grok", overageOff: true },
              agy: { consent: true, path: "/fake/agy", overageOff: true },
            },
          }),
        );
        const fixed =
          (r: Omit<UsageReading, "fetchedAt" | "warnings"> & { warnings?: string[] }) =>
          async (bin: string): Promise<UsageReading> => {
            assert.equal(bin, `/fake/${r.agent}`);
            return { fetchedAt: 0, warnings: [], ...r };
          };
        const hours = (h: number) => now + h * 3.6e6;
        const script = () => ({ reply: "ok" });
        const adapters = {
          claude: makeFakeAdapter(
            script,
            "claude",
            fixed({
              agent: "claude",
              warnings: ["extra usage is enabled"],
              pools: [
                {
                  id: "claude",
                  agent: "claude",
                  keys: ["claude"],
                  windows: [window(38, hours(3), "short", 5), window(60, null, "period", 168)],
                },
                {
                  id: "claude-opus",
                  agent: "claude",
                  keys: ["claude"],
                  models: ["opus"],
                  windows: [window(97, null, "period", 168)],
                },
                {
                  id: "claude-sonnet",
                  agent: "claude",
                  keys: ["claude"],
                  models: ["sonnet"],
                  windows: [window(0, null, "period", 168)],
                },
              ],
            }),
          ),
          codex: makeFakeAdapter(
            script,
            "codex",
            fixed({
              agent: "codex",
              pools: [
                { id: "codex", agent: "codex", keys: ["codex"], windows: [window(10, null, "period", 168)] },
              ],
            }),
          ),
          grok: makeFakeAdapter(
            script,
            "grok",
            fixed({
              agent: "grok",
              source: "grok.com",
              pools: [
                {
                  id: "grok",
                  agent: "grok",
                  keys: ["grok"],
                  windows: [window(75, hours(360), "period", 720)],
                },
              ],
            }),
          ),
          agy: makeFakeAdapter(
            script,
            "agy",
            fixed({ agent: "agy", pools: [], error: "agy is not logged in" }),
          ),
        };
        const next = [
          "next: tier 1 → codex:gpt-5.6-terra (max)",
          "next: tier 2 → codex:gpt-5.6-terra (max)",
          "next: tier 3 → claude:fable (medium)",
          "next: tier 4 → claude:fable (medium)",
        ].join("\n");
        await withClientServer(adapters, async (client) => {
          const result = await client.callTool({ name: "usage", arguments: {} });
          assert.notEqual(result.isError, true);
          assert.equal(
            firstTextContent(result),
            [
              "driver: claude",
              "",
              [
                "## claude",
                `pool claude: short 5h 62% left, resets ${new Date(hours(3)).toISOString()}; period 7d 40% left, reset unknown | pace 0.35 | ok`,
                "pool claude-opus [opus]: period 7d 3% left, reset unknown | pace - | out: period window 3% left, threshold 5%",
                "pool claude-sonnet [sonnet]: period 7d 100% left, reset unknown | pace 0.95 | ok",
                "warning: extra usage is enabled",
              ].join("\n"),
              "",
              "## codex\npool codex: period 7d 90% left, reset unknown | pace 0.88 | ok",
              "",
              [
                "## grok",
                "source: grok.com",
                `pool grok: period 30d 25% left, resets ${new Date(hours(360)).toISOString()} | pace 0.46 | ok`,
              ].join("\n"),
              "",
              "## agy\nskipped: agy is not logged in",
              "",
              next,
            ].join("\n"),
          );
        });
        // The CLI passes no driver: Claude's pool loses the 5% reserve (pace 0.38, not 0.35).
        const cli = await usageText(adapters, null);
        assert.ok(cli.startsWith("driver: unknown\n"));
        assert.match(cli, /pool claude: .* \| pace 0\.38 \| ok/);
      } finally {
        mock.timers.reset();
        if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prev;
      }
    });
  });

  it("skips agents without consent or a config entry without reading them", async () => {
    await withTempDir(async (dir) => {
      const prev = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = dir;
      try {
        mkdirSync(join(dir, "schmear"));
        writeFileSync(
          join(dir, "schmear", "config.json"),
          JSON.stringify({ version: 1, agents: { agy: { consent: false, path: "/fake/agy" } } }),
        );
        const unread = async () => assert.fail("readUsage called without consent");
        const adapters = {
          claude: makeFakeAdapter(() => ({ reply: "ok" }), "claude", unread),
          agy: makeFakeAdapter(() => ({ reply: "ok" }), "agy", unread),
        };
        assert.equal(
          await usageText(adapters, null),
          [
            "driver: unknown",
            "",
            "## claude\nskipped: not configured",
            "",
            "## agy\nskipped: no consent",
            "",
            [1, 2, 3, 4].map((t) => `next: tier ${t} → none`).join("\n"),
          ].join("\n"),
        );
      } finally {
        if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prev;
      }
    });
  });

  it("lists only usage in worker mode", async () => {
    process.env.SCHMEAR_WORKER = "1";
    try {
      await withClientServer({ claude: makeFakeAdapter(() => ({ reply: "ok" })) }, async (client) => {
        const { tools } = await client.listTools();
        assert.deepEqual(
          tools.map((t) => t.name),
          ["usage"],
        );
      });
    } finally {
      delete process.env.SCHMEAR_WORKER;
    }
  });

  it("delegates a task through fake-agent and returns the §12 plain-text result", async () => {
    // A run offering a model writes the offered list, so it gets its own state dir.
    await withConfig(claudeConfig, () =>
      withTempDir(async (dir) => {
        const adapter = makeFakeAdapter(() => ({
          reply: "PINEAPPLE",
          configOptions: [
            {
              id: "m",
              name: "m",
              category: "model",
              type: "select",
              currentValue: "opus",
              options: [{ value: "opus", name: "opus" }],
            },
            {
              id: "e",
              name: "e",
              category: "thought_level",
              type: "select",
              currentValue: "high",
              options: [{ value: "high", name: "high" }],
            },
          ],
          usageUpdates: [{ used: 1, size: 2, cost: { amount: 0.0123, currency: "USD" } }],
        }));
        await withClientServer({ claude: adapter }, async (client) => {
          const result = await client.callTool({
            name: "delegate",
            arguments: {
              tasks: [
                {
                  prompt: "Return first line of README.md",
                  cwd: dir,
                  tier: 1,
                  agents: ["claude"],
                  description: "Read README",
                },
              ],
            },
          });

          assert.notEqual(result.isError, true);
          assert.equal(
            firstTextContent(result),
            `## Read README\nstatus: done\nprovider: claude\nmodel: opus\neffort: high\nsession: ${await handle(dir, 0.0123)}\ncost: $0.0123\n\nPINEAPPLE`,
          );
        });
      }),
    );
  });

  it("returns tool errors for invalid input, naming the task index for validation failures", async () => {
    await withTempDir(async (dir) => {
      const adapter = makeFakeAdapter(() => ({ reply: "ok" }));
      await withClientServer({ claude: adapter }, async (client) => {
        const call = (tasks: unknown[]) => client.callTool({ name: "delegate", arguments: { tasks } });
        const ok = { prompt: "p", cwd: dir, tier: 1, agents: ["claude"] };

        assert.equal((await call([])).isError, true);
        assert.equal((await call(Array.from({ length: 9 }, () => ok))).isError, true);
        assert.equal((await call([{ ...ok, tier: 5 }])).isError, true);
        assert.equal((await call([{ ...ok, description: "x".repeat(81) }])).isError, true);
        assert.equal((await call([{ ...ok, agents: [] }])).isError, true);

        for (const bad of [
          { ...ok, agents: ["claude", "codex"] },
          { ...ok, cwd: "relative" },
          { ...ok, cwd: join(dir, "missing") },
        ]) {
          const result = await call([ok, bad]);
          assert.equal(result.isError, true);
          assert.match(firstTextContent(result), /tasks\[1\]/);
        }
      });
    });
  });

  it("cancels the running worker when the MCP call is cancelled via extra.signal", async () => {
    await withTempDir(async (dir) => {
      const logFile = join(dir, "cancel-log.json");
      const adapter = makeFakeAdapter(() => ({
        sleepMs: 10_000,
        reply: "never",
        logFile,
      }));

      await withClientServer({ claude: adapter }, async (client) => {
        const controller = new AbortController();
        const call = client.callTool(
          {
            name: "delegate",
            arguments: {
              tasks: [{ prompt: "sleep", cwd: dir, tier: 1, agents: ["claude"] }],
            },
          },
          undefined,
          { signal: controller.signal },
        );
        assert.ok(await waitForLog(logFile, (l) => l.promptCalled));
        controller.abort();
        await assert.rejects(call);
        assert.ok(await waitForLog(logFile, (l) => l.cancelled));
      });
    });
  });

  it("cancels running tasks when the server connection closes", async () => {
    await withTempDir(async (dir) => {
      const logFile = join(dir, "close-log.json");
      const adapter = makeFakeAdapter(() => ({
        sleepMs: 10_000,
        reply: "never",
        logFile,
      }));

      const server = await createServer({ claude: adapter });
      const client = new Client({ name: "claude-code", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const pendingCall = client.callTool({
        name: "delegate",
        arguments: {
          tasks: [{ prompt: "sleep", cwd: dir, tier: 1, agents: ["claude"] }],
        },
      });
      pendingCall.catch(() => {});

      assert.ok(await waitForLog(logFile, (l) => l.promptCalled));
      await server.close();
      await client.close();
      assert.ok(await waitForLog(logFile, (l) => l.cancelled));
    });
  });

  describe("permission prompts", () => {
    const options = [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" as const },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" as const },
    ];
    const asking = (logFile: string, extra: FakeAgentScript = {}): FakeAgentScript => ({
      reply: "ok",
      logFile,
      permissionRequests: [{ toolCall: { toolCallId: "t1", title: "Edit a.ts", kind: "edit" }, options }],
      ...extra,
    });
    const task = (dir: string) => ({
      name: "delegate",
      arguments: {
        tasks: [{ prompt: "p", cwd: dir, tier: 1, agents: ["claude"], description: "Edit file" }],
      },
    });
    const chosen = (log: FakeAgentLog | undefined) => {
      const outcome = log?.permissionOutcomes[0]?.outcome;
      return outcome?.outcome === "selected" ? outcome.optionId : outcome?.outcome;
    };

    it("asks the client by form elicitation and passes an accepted optionId to the worker", async () => {
      await withTempDir(async (dir) => {
        const logFile = join(dir, "log.json");
        const asked: ElicitRequest["params"][] = [];
        await withClientServer(
          { claude: makeFakeAdapter(() => asking(logFile)) },
          async (client) => {
            const result = await client.callTool(task(dir));
            assert.match(firstTextContent(result), /^## Edit file\nstatus: done\n/);
          },
          async (params) => {
            asked.push(params);
            return { action: "accept", content: { option: "allow_once" } };
          },
        );
        assert.equal(asked.length, 1);
        assert.equal(asked[0]?.message, "claude worker on 'Edit file' asks: Edit a.ts (edit)");
        assert.ok(asked[0] && "requestedSchema" in asked[0]);
        assert.deepEqual(asked[0].requestedSchema, {
          type: "object",
          required: ["option"],
          properties: {
            option: {
              type: "string",
              title: "Permission",
              enum: ["allow_once", "reject_once"],
              enumNames: ["Allow once", "Reject"],
            },
          },
        });
        assert.equal(chosen(await waitForLog(logFile, (l) => l.permissionOutcomes.length > 0)), "allow_once");
      });
    });

    it("rejects on decline and the task still ends done", async () => {
      await withTempDir(async (dir) => {
        const logFile = join(dir, "log.json");
        await withClientServer(
          { claude: makeFakeAdapter(() => asking(logFile)) },
          async (client) => {
            const text = firstTextContent(await client.callTool(task(dir)));
            assert.equal(
              text,
              `## Edit file\nstatus: done\nprovider: claude\nsession: ${await handle(dir)}\n\nok`,
            );
          },
          async () => ({ action: "decline" }),
        );
        assert.equal(
          chosen(await waitForLog(logFile, (l) => l.permissionOutcomes.length > 0)),
          "reject_once",
        );
      });
    });

    it("rejects without eliciting when the client lacks form elicitation", async () => {
      await withTempDir(async (dir) => {
        const logFile = join(dir, "log.json");
        await withClientServer({ claude: makeFakeAdapter(() => asking(logFile)) }, async (client, server) => {
          const elicit = mock.method(server.server, "elicitInput");
          const text = firstTextContent(await client.callTool(task(dir)));
          assert.equal(
            text,
            `## Edit file\nstatus: done\nprovider: claude\nsession: ${await handle(dir)}\n\nok`,
          );
          assert.equal(elicit.mock.callCount(), 0);
        });
        assert.equal(
          chosen(await waitForLog(logFile, (l) => l.permissionOutcomes.length > 0)),
          "reject_once",
        );
      });
    });

    it("withdraws an open prompt when the tool call is cancelled", async () => {
      await withTempDir(async (dir) => {
        const logFile = join(dir, "log.json");
        const controller = new AbortController();
        const asked: Array<string | number> = [];
        await withClientServer(
          { claude: makeFakeAdapter(() => asking(logFile)) },
          async (client) => {
            // Read the withdrawal off the wire: the SDK client ignores a cancel for request id 0
            // (`if (!requestId) return`), and this prompt is the server's first request.
            const transport = client.transport as NonNullable<Client["transport"]>;
            const receive = transport.onmessage;
            let withdrawn!: (id: unknown) => void;
            const cancelled = new Promise((resolve) => {
              withdrawn = resolve;
            });
            transport.onmessage = (message, extra) => {
              if ("method" in message && message.method === "notifications/cancelled") {
                withdrawn(message.params?.requestId);
              }
              receive?.(message, extra);
            };
            const call = client.callTool(task(dir), undefined, { signal: controller.signal });
            await assert.rejects(call);
            assert.deepEqual([await cancelled], asked);
            assert.ok(await waitForLog(logFile, (l) => l.cancelled));
          },
          (_params, _signal, requestId) => {
            asked.push(requestId);
            controller.abort();
            return new Promise<ElicitResult>(() => {});
          },
        );
      });
    });
  });
});
