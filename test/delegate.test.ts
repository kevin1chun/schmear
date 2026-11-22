import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { workerEnv } from "../src/acp.ts";
import { agyAdapter } from "../src/agents/agy.ts";
import { claudeAdapter } from "../src/agents/claude.ts";
import { decodeSession, delegate, encodeSession, formatFailureError } from "../src/delegate.ts";
import { configPath, stateDir, writeOffered } from "../src/state.ts";
import type {
  AgentAdapter,
  AgentId,
  Config,
  DelegateTask,
  Lane,
  LaneKey,
  LaunchSpec,
  SessionHandle,
  UsageReading,
} from "../src/types.ts";
import type { FakeAgentLog, FakeAgentScript } from "./fake-agent.ts";

const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.ts", import.meta.url));

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "schmear-delegate-test-"));
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

let xdgDir: string;
const savedXdg = { state: process.env.XDG_STATE_HOME, config: process.env.XDG_CONFIG_HOME };

beforeEach(() => {
  xdgDir = mkdtempSync(join(tmpdir(), "schmear-delegate-xdg-"));
  process.env.XDG_STATE_HOME = join(xdgDir, "state");
  process.env.XDG_CONFIG_HOME = join(xdgDir, "config");
});

afterEach(() => {
  for (const [name, value] of [
    ["XDG_STATE_HOME", savedXdg.state],
    ["XDG_CONFIG_HOME", savedXdg.config],
  ] as const) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  rmSync(xdgDir, { recursive: true, force: true });
});

const task = (cwd: string, prompt = "p", extra: Partial<DelegateTask> = {}): DelegateTask => ({
  prompt,
  cwd,
  tier: 1,
  agents: ["claude"],
  ...extra,
});

const KEYS: Record<AgentId, LaneKey[]> = {
  claude: ["claude"],
  codex: ["codex"],
  grok: ["grok"],
  agy: ["agy-gemini", "agy-argon", "agy-3p"],
};

/** One pool on every lane key of the agent, with one weekly window. */
function reading(id: AgentId, remaining: number, resetsAt: number | null = null): UsageReading {
  return {
    agent: id,
    fetchedAt: Date.now(),
    pools: [
      { id, agent: id, keys: KEYS[id], windows: [{ kind: "period", remaining, resetsAt, periodHours: 168 }] },
    ],
    warnings: [],
  };
}

const consented = (id: AgentId): NonNullable<Config["agents"][AgentId]> => ({
  consent: true,
  path: `/fake/bin/${id}`,
  ...(id === "claude" ? {} : { overageOff: true as const }),
});

function writeConfig(agents: Config["agents"], extra: Partial<Config> = {}): void {
  mkdirSync(join(xdgDir, "config", "schmear"), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ version: 1, agents, ...extra }));
}

beforeEach(() => writeConfig({ claude: consented("claude") }));

function cacheReading(r: UsageReading): void {
  mkdirSync(join(stateDir(), "usage"), { recursive: true });
  writeFileSync(join(stateDir(), "usage", `${r.agent}.json`), JSON.stringify(r));
}

function makeFakeAdapter(opts: {
  id?: AgentId;
  scriptForTask: (lane: Lane, cwd: string, bin: string, callIndex: number) => FakeAgentScript;
  onLaunch?: (lane: Lane, cwd: string, bin: string) => void;
  /** Ask the fake for the lane's model and effort, as a real adapter's launch() does. */
  setConfig?: boolean;
  /** The reading for the nth readUsage call; default 50% left. */
  usage?: (callIndex: number, bin: string) => UsageReading;
  classifyFailure?: AgentAdapter["classifyFailure"];
  quotaRateLimit?: AgentAdapter["quotaRateLimit"];
}): AgentAdapter {
  let callIndex = 0;
  let usageIndex = 0;
  const id = opts.id ?? "claude";
  return {
    id,
    isClient: () => false,
    async find() {
      throw new Error("delegate must take the binary from the config");
    },
    async launch(lane: Lane, cwd: string, bin: string): Promise<LaunchSpec> {
      opts.onLaunch?.(lane, cwd, bin);
      const script = opts.scriptForTask(lane, cwd, bin, callIndex++);
      return {
        command: process.execPath,
        args: [FAKE_AGENT, JSON.stringify(script)],
        env: workerEnv(),
        ...(opts.setConfig ? { config: { model: lane.model, effort: lane.effort } } : {}),
      };
    },
    async readUsage(bin: string): Promise<UsageReading> {
      return opts.usage ? opts.usage(usageIndex++, bin) : reading(id, 0.5);
    },
    classifyFailure: opts.classifyFailure ?? (() => "failed"),
    quotaRateLimit: opts.quotaRateLimit,
  };
}

describe("delegate validation", () => {
  const ctx = { driver: null, signal: new AbortController().signal };
  const adapter = makeFakeAdapter({ scriptForTask: () => ({ reply: "ok" }) });
  const run = (tasks: DelegateTask[]) => delegate({ tasks }, ctx, { claude: adapter });

  it("names the task index for a bad cwd", async () => {
    await withTempDir(async (dir) => {
      await assert.rejects(run([task("relative/path")]), /tasks\[0\].*absolute/);
      await assert.rejects(run([task(dir), task(join(dir, "missing"))]), /tasks\[1\].*existing directory/);
      await assert.rejects(run([task(join(dir, "missing"))]), /existing directory/);
    });
  });

  it("accepts a task without agents and rejects an unknown allowlist entry", async () => {
    await withTempDir(async (dir) => {
      const { agents: _, ...noAgents } = task(dir);
      assert.equal((await run([noAgents]))[0]?.status, "done");
      await assert.rejects(
        run([task(dir, "p", { agents: ["claude", "codex"] })]),
        /tasks\[0\]: unknown agent: codex/,
      );
    });
  });

  it("validates whitespace prompt, tier above list length, and multiline description", async () => {
    await withTempDir(async (dir) => {
      await assert.rejects(run([task(dir, "  \n ")]), /tasks\[0\].*prompt/);
      await assert.rejects(
        run([task(dir, "p", { tier: 5 })]),
        /^Error: tasks\[0\]: tier must be an integer from 1 to 4$/,
      );
      await assert.rejects(run([task(dir, "p", { description: "a\nb" })]), /single/);
    });
  });
});

const noAbort = () => ({ driver: null, signal: new AbortController().signal });

const modelAndEffort: NonNullable<FakeAgentScript["configOptions"]> = [
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
];

describe("delegate execution", () => {
  it("sends the prompt verbatim, runs in a non-git dir, and rejects permission requests", async () => {
    await withTempDir(async (dir) => {
      const logFile = join(dir, "perm.json");
      const prompt = "  Read README.md\n\n  and reply.  \n\t\u00e9\n";
      const seenLaunches: Array<{ lane: Lane; cwd: string; bin: string }> = [];

      writeConfig({ claude: { ...consented("claude"), path: "/opt/fake/claude" } });
      const usageBins: string[] = [];
      const adapter = makeFakeAdapter({
        usage: (_i, bin) => {
          usageBins.push(bin);
          return reading("claude", 0.5);
        },
        onLaunch: (lane, cwd, bin) => seenLaunches.push({ lane, cwd, bin }),
        scriptForTask: () => ({
          reply: "PINEAPPLE",
          logFile,
          configOptions: modelAndEffort,
          usageUpdates: [{ used: 1, size: 2, cost: { amount: 0.5, currency: "USD" } }],
          permissionRequests: [
            {
              toolCall: { toolCallId: "tc-1", kind: "read", title: "Read README.md" },
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "reject", name: "Reject", kind: "reject_once" },
              ],
            },
          ],
        }),
      });

      const results = await delegate({ tasks: [task(dir, prompt)] }, noAbort(), { claude: adapter });

      assert.deepEqual(results, [
        {
          description: "Read README.md",
          status: "done",
          provider: "claude",
          model: "opus",
          effort: "high",
          session: await encodeSession({
            agent: "claude",
            key: "claude",
            model: "haiku",
            effort: "medium",
            tier: 1,
            sessionId: "fake-session-1",
            cwd: dir,
            costUsd: 0.5,
          }),
          costUsd: 0.5,
          reply: "PINEAPPLE",
          notes: [],
        },
      ]);

      assert.equal(seenLaunches.length, 1);
      assert.equal(seenLaunches[0]?.bin, "/opt/fake/claude");
      assert.deepEqual(usageBins, ["/opt/fake/claude"]);
      assert.deepEqual(seenLaunches[0]?.lane, {
        id: "claude:haiku",
        agent: "claude",
        key: "claude",
        tier: 1,
        model: "haiku",
        effort: "medium",
      });
      assert.equal(seenLaunches[0]?.cwd, dir);

      const log = JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog;
      assert.equal(log.promptText, prompt);
      assert.deepEqual(log.permissionOutcomes, [{ outcome: { outcome: "selected", optionId: "reject" } }]);
    });
  });

  it("defaults description to the prompt's first non-empty line cut to 80 chars", async () => {
    await withTempDir(async (dir) => {
      const adapter = makeFakeAdapter({ scriptForTask: () => ({ reply: "ok" }) });
      const results = await delegate(
        {
          tasks: [
            task(dir, `\n  \n  ${"x".repeat(100)}\nsecond`),
            task(dir, "first\nsecond", { description: "given" }),
          ],
        },
        noAbort(),
        { claude: adapter },
      );
      assert.equal(results[0]?.description, "x".repeat(80));
      assert.equal(results[1]?.description, "given");
    });
  });

  it("uses the description in the permission prompt's who", async () => {
    await withTempDir(async (dir) => {
      const adapter = makeFakeAdapter({
        scriptForTask: () => ({
          reply: "ok",
          permissionRequests: [
            {
              toolCall: { toolCallId: "tc-1", kind: "execute", title: "Run ls" },
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "reject", name: "Reject", kind: "reject_once" },
              ],
            },
          ],
        }),
      });
      const asked: string[] = [];
      await delegate(
        { tasks: [task(dir, "p", { description: "Add tests" })] },
        {
          ...noAbort(),
          ask: async (message) => {
            asked.push(message);
            return "allow";
          },
        },
        { claude: adapter },
      );
      assert.deepEqual(asked, ["claude worker on 'Add tests' asks: Run ls (execute)"]);
    });
  });

  it("routes only to configured agents with consent", async () => {
    await withTempDir(async (dir) => {
      const launched: AgentId[] = [];
      const fake = (id: AgentId) =>
        makeFakeAdapter({
          id,
          onLaunch: (lane) => launched.push(lane.agent),
          scriptForTask: () => ({ reply: "ok" }),
        });
      writeConfig({
        claude: { ...consented("claude"), consent: false },
        grok: consented("grok"),
      });
      const adapters = { claude: fake("claude"), codex: fake("codex"), grok: fake("grok") };
      const [result] = await delegate(
        { tasks: [task(dir, "p", { agents: undefined })] },
        noAbort(),
        adapters,
      );
      assert.equal(result?.provider, "grok");
      assert.deepEqual(launched, ["grok"]);
    });
  });

  it("gives no_quota naming the tier, reading no usage, when the allowlist has no lane", async () => {
    await withTempDir(async (dir) => {
      writeConfig({ claude: consented("claude"), codex: consented("codex") });
      let reads = 0;
      const fake = (id: AgentId) =>
        makeFakeAdapter({
          id,
          scriptForTask: () => ({ reply: "unreachable" }),
          usage: () => {
            reads++;
            return reading(id, 0.5);
          },
        });
      const t = task(dir, "hi", { agents: ["codex"], tier: 3 });

      const [result] = await delegate({ tasks: [t] }, noAbort(), {
        claude: fake("claude"),
        codex: fake("codex"),
      });

      assert.equal(result?.status, "no_quota");
      assert.equal(result?.provider, undefined);
      assert.equal(result?.error, "no lane for tier 3; pools: none");
      assert.equal(reads, 0);
    });
  });

  it("writes the run's offered models", async () => {
    await withTempDir(async (dir) => {
      const adapter = makeFakeAdapter({
        scriptForTask: () => ({ reply: "ok", configOptions: modelAndEffort }),
      });
      const [result] = await delegate({ tasks: [task(dir)] }, noAbort(), { claude: adapter });
      assert.equal(result?.status, "done");
      const saved = JSON.parse(readFileSync(join(stateDir(), "offered", "claude.json"), "utf8")) as {
        models: string[];
      };
      assert.deepEqual(saved.models, ["opus"]);
    });
  });

  it("runs tasks concurrently and preserves result order", async () => {
    await withTempDir(async (dir) => {
      const adapter = makeFakeAdapter({
        scriptForTask: (_lane, _ctx, _bin, idx) => ({
          sleepMs: 1000,
          reply: `reply-${idx}`,
        }),
      });

      const started = Date.now();
      const results = await delegate(
        { tasks: [task(dir, "p0"), task(dir, "p1"), task(dir, "p2")] },
        noAbort(),
        { claude: adapter },
      );
      const elapsed = Date.now() - started;

      assert.equal(results.length, 3);
      assert.deepEqual(
        results.map((r) => [r.description, r.status, r.reply]),
        [
          ["p0", "done", "reply-0"],
          ["p1", "done", "reply-1"],
          ["p2", "done", "reply-2"],
        ],
      );
      // Serial takes over 3 s; concurrent takes about 1 s, so 2 s leaves room for a loaded machine.
      assert.ok(elapsed < 2000, `expected concurrent execution, took ${elapsed}ms`);
    });
  });

  it("fails only the task whose adapter throws; the batch's other task returns", async () => {
    await withTempDir(async (dir) => {
      const other = join(dir, "other");
      mkdirSync(other);
      const adapter = makeFakeAdapter({
        scriptForTask: (_lane, cwd) =>
          cwd === dir ? { error: { stage: "prompt", code: -32603, message: "boom" } } : { reply: "ok" },
        classifyFailure: () => {
          throw new Error("adapter bug");
        },
      });
      const results = await delegate({ tasks: [task(dir, "p0"), task(other, "p1")] }, noAbort(), {
        claude: adapter,
      });
      assert.deepEqual(
        results.map((r) => [r.description, r.status, r.error, r.reply]),
        [
          ["p0", "failed", "adapter bug", ""],
          ["p1", "done", undefined, "ok"],
        ],
      );
    });
  });

  it("formats worker failures with last 20 stderr lines capped at 2,048 characters", async () => {
    await withTempDir(async (dir) => {
      const stderrLines = Array.from({ length: 30 }, (_, i) => `stderr-line-${i + 1}`);
      const adapter = makeFakeAdapter({
        scriptForTask: () => ({
          stderr: `${stderrLines.join("\n")}\n`,
          error: { stage: "prompt", code: -32603, message: "boom" },
        }),
      });

      const results = await delegate({ tasks: [task(dir)] }, noAbort(), { claude: adapter });

      assert.equal(results[0]?.status, "failed");
      const err = results[0]?.error ?? "";
      assert.ok(err.startsWith("boom\n"));
      assert.ok(!err.includes("stderr-line-10\n"));
      assert.ok(err.includes("stderr-line-11"));
      assert.ok(err.includes("stderr-line-30"));
      assert.ok(err.length <= 2048);
    });

    // Also verify the character cap directly on huge stderr lines.
    const huge = Array.from({ length: 20 }, (_, i) => `L${i}:${"x".repeat(200)}`).join("\n");
    const formatted = formatFailureError("top-error", huge);
    assert.ok(formatted.startsWith("top-error\n"));
    assert.equal(formatted.length, 2048);
    assert.ok(formatted.includes("…"));
    assert.ok(formatted.includes("L19:"));
  });

  it("classifies on the agent's message, not its stderr, and still shows the stderr tail", async () => {
    await withTempDir(async (dir) => {
      const stderr = "2026-11-21T10:00:07.429Z checking quota";
      const adapter = makeFakeAdapter({
        classifyFailure: agyAdapter.classifyFailure,
        scriptForTask: () => ({
          stderr: `${stderr}\n`,
          error: { stage: "prompt", code: -32603, message: "boom" },
        }),
      });
      const [result] = await delegate({ tasks: [task(dir)] }, noAbort(), { claude: adapter });
      assert.equal(result?.status, "failed");
      assert.equal(result?.error, `boom\n${stderr}`);
    });
  });

  it("marks a worker's own non-end_turn stop failed with a note", async () => {
    await withTempDir(async (dir) => {
      for (const stopReason of ["cancelled", "max_tokens"] as const) {
        const adapter = makeFakeAdapter({ scriptForTask: () => ({ reply: "partial", stopReason }) });
        const [result] = await delegate({ tasks: [task(dir)] }, noAbort(), { claude: adapter });
        assert.equal(result?.status, "failed");
        assert.deepEqual(result?.notes, [`worker stopped: ${stopReason}`]);
        assert.equal(result?.reply, "partial");
        assert.equal(result?.error, undefined);
      }
    });
  });

  it("cancels running tasks when signal aborts", async () => {
    await withTempDir(async (dir) => {
      const controller = new AbortController();
      const adapter = makeFakeAdapter({
        scriptForTask: () => ({ sleepMs: 10_000, reply: "never" }),
      });

      const timer = setTimeout(() => controller.abort(), 150);
      try {
        const results = await delegate(
          { tasks: [task(dir)] },
          { driver: null, signal: controller.signal },
          { claude: adapter },
        );
        assert.equal(results[0]?.status, "cancelled");
        assert.deepEqual(results[0]?.notes, []);
      } finally {
        clearTimeout(timer);
      }
    });
  });

  it("caps total reply length at 60,000 chars using equal shares with omission marker", async () => {
    await withTempDir(async (dir) => {
      // Single over-long reply
      const singleAdapter = makeFakeAdapter({
        scriptForTask: () => ({
          reply: `HEAD${"a".repeat(70_000)}TAIL`,
        }),
      });
      const single = await delegate({ tasks: [task(dir)] }, noAbort(), { claude: singleAdapter });
      const singleReply = single[0]?.reply ?? "";
      assert.ok(singleReply.length <= 60_000);
      assert.ok(singleReply.startsWith("HEAD"));
      assert.ok(singleReply.endsWith("TAIL"));
      assert.match(singleReply, /\[… \d+ chars omitted …\]/);

      // Multi-task batch: 1 short + 2 over-long (total > 60,000) -> equal share 20,000 each
      const replies = ["short reply", `A1${"x".repeat(35_000)}Z1`, `A2${"y".repeat(35_000)}Z2`];
      const batchAdapter = makeFakeAdapter({
        scriptForTask: (_lane, _ctx, _bin, idx) => ({ reply: replies[idx] ?? "" }),
      });
      const batch = await delegate({ tasks: [task(dir), task(dir), task(dir)] }, noAbort(), {
        claude: batchAdapter,
      });
      assert.equal(batch[0]?.reply, "short reply");
      assert.ok((batch[1]?.reply.length ?? 0) <= 20_000);
      assert.ok((batch[2]?.reply.length ?? 0) <= 20_000);
      assert.ok(batch[1]?.reply.startsWith("A1"));
      assert.ok(batch[1]?.reply.endsWith("Z1"));
      assert.match(batch[1]?.reply ?? "", /\[… \d+ chars omitted …\]/);
      const sum = batch.reduce((acc, r) => acc + r.reply.length, 0);
      assert.ok(sum <= 60_000);

      // Batch under 60,000 total is not truncated even if one task exceeds 30,000
      const underReplies = ["short", "z".repeat(45_000)];
      const underAdapter = makeFakeAdapter({
        scriptForTask: (_lane, _ctx, _bin, idx) => ({ reply: underReplies[idx] ?? "" }),
      });
      const under = await delegate({ tasks: [task(dir), task(dir)] }, noAbort(), { claude: underAdapter });
      assert.equal(under[0]?.reply, "short");
      assert.equal(under[1]?.reply.length, 45_000);
    });
  });
});

describe("model and effort selection", () => {
  const select = (
    id: string,
    options: string[],
    current = options[0] ?? "",
  ): NonNullable<FakeAgentScript["configOptions"]>[number] =>
    ({
      id,
      name: id,
      category: id === "model" ? "model" : "thought_level",
      type: "select",
      currentValue: current,
      options: options.map((value) => ({ value, name: value })),
    }) as NonNullable<FakeAgentScript["configOptions"]>[number];
  const offering = (models: string[], efforts: string[]): FakeAgentScript => ({
    reply: "ok",
    configOptions: [select("model", models), select("effort", efforts)],
  });
  const offeredFile = () => join(stateDir(), "offered", "claude.json");

  it("runs the next candidate when a model is missing, and records the offered list", async () => {
    await withTempDir(async (dir) => {
      const lanes: string[] = [];
      const adapter = makeFakeAdapter({
        setConfig: true,
        onLaunch: (lane) => lanes.push(lane.id),
        scriptForTask: () => offering(["sonnet", "opus"], ["medium"]),
      });
      const [result] = await delegate({ tasks: [task(dir)] }, noAbort(), { claude: adapter });
      assert.equal(result?.status, "done");
      assert.deepEqual(lanes, ["claude:haiku", "claude:sonnet"]);
      assert.deepEqual(result?.notes, ["haiku not offered by claude; ran claude:sonnet"]);
      const saved = JSON.parse(readFileSync(offeredFile(), "utf8")) as {
        fetchedAt: number;
        models: string[];
      };
      assert.deepEqual(saved.models, ["sonnet", "opus"]);
      assert.ok(Date.now() - saved.fetchedAt < 60_000);
    });
  });

  it("skips a lane whose effort is missing and records the offered list", async () => {
    await withTempDir(async (dir) => {
      const lanes: string[] = [];
      const adapter = makeFakeAdapter({
        setConfig: true,
        onLaunch: (lane) => lanes.push(lane.id),
        scriptForTask: (lane) => offering(["haiku", "sonnet"], lane.model === "haiku" ? ["low"] : ["medium"]),
      });
      const [result] = await delegate({ tasks: [task(dir)] }, noAbort(), { claude: adapter });
      assert.equal(result?.status, "done");
      assert.deepEqual(lanes, ["claude:haiku", "claude:sonnet"]);
      assert.deepEqual(result?.notes, ["haiku at medium not offered by claude; ran claude:sonnet"]);
      assert.deepEqual((JSON.parse(readFileSync(offeredFile(), "utf8")) as { models: string[] }).models, [
        "haiku",
        "sonnet",
      ]);
    });
  });

  it("keeps a finished run's reply when the offered list cannot be written", async () => {
    await withTempDir(async (dir) => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(join(stateDir(), "offered"), "");
      const adapter = makeFakeAdapter({
        setConfig: true,
        scriptForTask: () => offering(["haiku"], ["medium"]),
      });
      const [result] = await delegate({ tasks: [task(dir)] }, noAbort(), { claude: adapter });
      assert.equal(result?.status, "done");
      assert.equal(result?.reply, "ok");
      assert.equal(result?.notes.length, 1);
      assert.match(result?.notes[0] ?? "", /^claude offered list write failed: ENOTDIR/);
    });
  });

  it("gives no_quota, with the notes, when no candidate is left", async () => {
    await withTempDir(async (dir) => {
      const adapter = makeFakeAdapter({ setConfig: true, scriptForTask: () => offering(["x"], ["medium"]) });
      const [result] = await delegate({ tasks: [task(dir)] }, noAbort(), { claude: adapter });
      assert.equal(result?.status, "no_quota");
      assert.match(result?.error ?? "", /^no lane for tier 1; pools: /);
      assert.deepEqual(result?.notes, ["haiku not offered by claude"]);
    });
  });

  it("uses a fresh offered list and ignores one older than 24 h", async () => {
    await withTempDir(async (dir) => {
      const first = async () => {
        const lanes: string[] = [];
        const adapter = makeFakeAdapter({
          setConfig: true,
          onLaunch: (lane) => lanes.push(lane.id),
          scriptForTask: () => offering(["haiku", "sonnet", "opus"], ["medium"]),
        });
        await delegate({ tasks: [task(dir)] }, noAbort(), { claude: adapter });
        return lanes[0];
      };
      await writeOffered("claude", ["sonnet", "opus"]);
      assert.equal(await first(), "claude:sonnet");
      await writeOffered("claude", ["sonnet", "opus"], Date.now() - 25 * 3_600_000);
      assert.equal(await first(), "claude:haiku");
    });
  });

  it("asks the fake for the model a Config.tiers list names", async () => {
    await withTempDir(async (dir) => {
      writeConfig({ claude: consented("claude") }, { tiers: [["claude:custom@medium"]] });
      const logFile = join(dir, "log.json");
      const adapter = makeFakeAdapter({
        setConfig: true,
        scriptForTask: () => ({ ...offering(["custom"], ["medium"]), logFile }),
      });
      const [result] = await delegate({ tasks: [task(dir)] }, noAbort(), { claude: adapter });
      assert.equal(result?.status, "done");
      const log = JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog;
      assert.deepEqual(log.configSets, [
        { configId: "model", value: "custom" },
        { configId: "effort", value: "medium" },
      ]);
    });
  });
});

describe("routing", () => {
  const HOUR = 3_600_000;
  const ok = (): FakeAgentScript => ({ reply: "ok" });
  type Fixture = { usage?: (i: number) => UsageReading; script?: FakeAgentAdapterScript };
  type FakeAgentAdapterScript = (lane: Lane, callIndex: number) => FakeAgentScript;

  /** Fakes for the given agents, all consented, logging launched lane ids. */
  function setup(
    fixtures: Partial<
      Record<
        AgentId,
        Fixture & Pick<Parameters<typeof makeFakeAdapter>[0], "classifyFailure" | "quotaRateLimit">
      >
    >,
  ) {
    const ids = Object.keys(fixtures) as AgentId[];
    writeConfig(Object.fromEntries(ids.map((id) => [id, consented(id)])));
    const launched: string[] = [];
    const reads: AgentId[] = [];
    const adapters = Object.fromEntries(
      ids.map((id) => {
        const f = fixtures[id] ?? {};
        return [
          id,
          makeFakeAdapter({
            id,
            onLaunch: (lane) => launched.push(lane.id),
            scriptForTask: (lane, _cwd, _bin, i) => (f.script ? f.script(lane, i) : ok()),
            usage: (i) => {
              reads.push(id);
              return f.usage ? f.usage(i) : reading(id, 0.5);
            },
            ...(f.classifyFailure ? { classifyFailure: f.classifyFailure } : {}),
            quotaRateLimit: f.quotaRateLimit,
          }),
        ];
      }),
    ) as Partial<Record<AgentId, AgentAdapter>>;
    return { adapters, launched, reads };
  }
  const open = (cwd: string, extra: Partial<DelegateTask> = {}) =>
    task(cwd, "p", { agents: undefined, ...extra });

  it("sends the task to the highest pace", async () => {
    await withTempDir(async (dir) => {
      const { adapters, launched } = setup({
        claude: { usage: () => reading("claude", 0.3) },
        codex: { usage: () => reading("codex", 0.8) },
      });
      const [result] = await delegate({ tasks: [open(dir)] }, noAbort(), adapters);
      assert.equal(result?.status, "done");
      assert.equal(result?.provider, "codex");
      assert.deepEqual(launched, ["codex:gpt-5.6-terra"]);
    });
  });

  it("prefers the exact tier within the band over a higher tier with more pace", async () => {
    await withTempDir(async (dir) => {
      const { adapters, launched } = setup({
        claude: { usage: () => reading("claude", 0.5) },
        grok: { usage: () => reading("grok", 0.51) },
      });
      writeConfig(
        { claude: consented("claude"), grok: consented("grok") },
        { tiers: [["claude:haiku@medium"], ["grok:grok-4.7@medium"]] },
      );
      await delegate({ tasks: [open(dir)] }, noAbort(), adapters);
      assert.deepEqual(launched, ["claude:haiku"]);
    });
  });

  it("sorts the driver's provider last within the band", async () => {
    await withTempDir(async (dir) => {
      const fixtures = {
        claude: { usage: () => reading("claude", 0.54) },
        codex: { usage: () => reading("codex", 0.5) },
      };
      const asDriver = setup(fixtures);
      await delegate({ tasks: [open(dir)] }, { ...noAbort(), driver: "claude" }, asDriver.adapters);
      assert.deepEqual(asDriver.launched, ["codex:gpt-5.6-terra"]);

      rmSync(join(xdgDir, "state"), { recursive: true, force: true });
      const noDriver = setup(fixtures);
      await delegate({ tasks: [open(dir)] }, noAbort(), noDriver.adapters);
      assert.deepEqual(noDriver.launched, ["claude:haiku"]);
    });
  });

  it("spreads a batch over the tie band and never onto a lane outside it", async () => {
    await withTempDir(async (dir) => {
      const batch = async (claude: number) => {
        rmSync(join(xdgDir, "state"), { recursive: true, force: true });
        const { adapters } = setup({
          claude: { usage: () => reading("claude", claude) },
          codex: { usage: () => reading("codex", 0.5) },
        });
        const results = await delegate({ tasks: [open(dir), open(dir), open(dir)] }, noAbort(), adapters);
        return results.map((r) => r.provider);
      };
      assert.deepEqual(await batch(0.51), ["claude", "codex", "claude"]);
      assert.deepEqual(await batch(0.8), ["claude", "claude", "claude"]);
    });
  });

  it("holds the driver reserve except within 2 h of reset", async () => {
    await withTempDir(async (dir) => {
      const run = async (claudeResetsIn: number) => {
        rmSync(join(xdgDir, "state"), { recursive: true, force: true });
        const { adapters } = setup({
          claude: { usage: () => reading("claude", 0.04, Date.now() + claudeResetsIn) },
          codex: { usage: () => reading("codex", 0.5) },
        });
        const [result] = await delegate({ tasks: [open(dir)] }, { ...noAbort(), driver: "claude" }, adapters);
        return result?.provider;
      };
      assert.equal(await run(84 * HOUR), "codex");
      assert.equal(await run(1 * HOUR), "claude");
    });
  });

  it("excludes a lane after a quota failure, re-reads usage and reroutes with a note", async () => {
    await withTempDir(async (dir) => {
      const { adapters, launched, reads } = setup({
        claude: {
          usage: (i) => reading("claude", i === 0 ? 0.8 : 0),
          script: () => ({
            error: { code: -32603, message: "billing", data: { errorKind: "billing_error" } },
          }),
          classifyFailure: claudeAdapter.classifyFailure,
          quotaRateLimit: claudeAdapter.quotaRateLimit,
        },
        codex: { usage: () => reading("codex", 0.5) },
      });
      const [result] = await delegate({ tasks: [open(dir)] }, noAbort(), adapters);
      assert.equal(result?.status, "done");
      assert.equal(result?.provider, "codex");
      assert.deepEqual(launched, ["claude:haiku", "codex:gpt-5.6-terra"]);
      assert.deepEqual(result?.notes, ["rerouted from claude:haiku: quota"]);
      assert.deepEqual(reads.sort(), ["claude", "claude", "codex"]);
    });
  });

  it("keeps a lane out after its quota failure when the re-read still shows it routable", async () => {
    await withTempDir(async (dir) => {
      const quotaOnce = (agents: Partial<Record<AgentId, Fixture>>) =>
        setup({
          claude: {
            usage: () => reading("claude", 0.8),
            script: (_lane, i) =>
              i === 0
                ? { error: { code: -32603, message: "billing", data: { errorKind: "billing_error" } } }
                : ok(),
            classifyFailure: claudeAdapter.classifyFailure,
            quotaRateLimit: claudeAdapter.quotaRateLimit,
          },
          ...agents,
        });
      const withCodex = quotaOnce({ codex: { usage: () => reading("codex", 0.5) } });
      const [rerouted] = await delegate({ tasks: [open(dir)] }, noAbort(), withCodex.adapters);
      assert.equal(rerouted?.status, "done");
      assert.equal(withCodex.launched.length, 2);
      assert.notEqual(withCodex.launched[1], "claude:haiku");

      const alone = quotaOnce({});
      writeConfig({ claude: consented("claude") }, { tiers: [["claude:haiku@medium"]] });
      const [none] = await delegate({ tasks: [open(dir)] }, noAbort(), alone.adapters);
      assert.equal(none?.status, "no_quota");
      assert.deepEqual(alone.launched, ["claude:haiku"]);
    });
  });

  it("rereads a fresh cached reading on a quota outcome", async () => {
    await withTempDir(async (dir) => {
      const { adapters, launched, reads } = setup({
        claude: {
          usage: () => reading("claude", 0),
          script: () => ({
            error: { code: -32603, message: "billing", data: { errorKind: "billing_error" } },
          }),
          classifyFailure: claudeAdapter.classifyFailure,
          quotaRateLimit: claudeAdapter.quotaRateLimit,
        },
        codex: {},
      });
      cacheReading(reading("claude", 0.8));
      cacheReading(reading("codex", 0.5));
      const [result] = await delegate({ tasks: [open(dir)] }, noAbort(), adapters);
      assert.equal(result?.provider, "codex");
      assert.deepEqual(launched, ["claude:haiku", "codex:gpt-5.6-terra"]);
      assert.deepEqual(reads, ["claude"]);
    });
  });

  it("serves a cached reading up to 5 min old and rereads an older one", async () => {
    await withTempDir(async (dir) => {
      const reads = async (ageMin: number) => {
        const { adapters, reads } = setup({ claude: {} });
        cacheReading({ ...reading("claude", 0.5), fetchedAt: Date.now() - ageMin * 60_000 });
        await delegate({ tasks: [open(dir)] }, noAbort(), adapters);
        return reads.length;
      };
      assert.equal(await reads(4), 0);
      assert.equal(await reads(6), 1);
    });
  });

  it("reads usage only for agents with a candidate lane", async () => {
    await withTempDir(async (dir) => {
      const { adapters, launched, reads } = setup({ claude: {}, agy: {} });
      await delegate({ tasks: [task(dir)] }, noAbort(), adapters);
      assert.deepEqual(launched, ["claude:haiku"]);
      assert.deepEqual(reads, ["claude"]);
    });
  });

  it("limits a task to an agent, leaves its subscription to routing, and rejects a lane key", async () => {
    await withTempDir(async (dir) => {
      const agyPools = (): UsageReading => ({
        agent: "agy",
        fetchedAt: Date.now(),
        pools: KEYS.agy.map((key) => ({
          id: key,
          agent: "agy" as const,
          keys: [key],
          windows: [{ kind: "period" as const, remaining: 0.5, resetsAt: null, periodHours: 168 }],
        })),
        warnings: [],
      });
      const { adapters, launched } = setup({
        claude: { usage: () => reading("claude", 0.9) },
        agy: { usage: agyPools },
      });
      const [result] = await delegate({ tasks: [open(dir, { agents: ["agy"] })] }, noAbort(), adapters);
      assert.equal(result?.status, "done");
      assert.equal(launched.length, 1);
      assert.match(launched[0] ?? "", /^agy-/);
      await assert.rejects(
        delegate({ tasks: [open(dir, { agents: ["agy-3p" as AgentId] })] }, noAbort(), adapters),
        /^Error: tasks\[0\]: unknown agent: agy-3p$/,
      );
    });
  });

  it("refuses a tier above a configured list's length", async () => {
    await withTempDir(async (dir) => {
      const { adapters } = setup({ claude: {} });
      writeConfig(
        { claude: consented("claude") },
        { tiers: [["claude:haiku@medium"], ["claude:opus@high"]] },
      );
      await assert.rejects(
        delegate({ tasks: [task(dir, "p", { tier: 3 })] }, noAbort(), adapters),
        /^Error: tasks\[0\]: tier must be an integer from 1 to 2$/,
      );
    });
  });

  it("routes tier 10 of a 10-tier list", async () => {
    await withTempDir(async (dir) => {
      const { adapters, launched } = setup({ claude: {} });
      writeConfig(
        { claude: consented("claude") },
        { tiers: Array.from({ length: 10 }, (_, i) => [`claude:m${i + 1}@medium`]) },
      );
      const [result] = await delegate({ tasks: [task(dir, "p", { tier: 10 })] }, noAbort(), adapters);
      assert.equal(result?.status, "done");
      assert.deepEqual(launched, ["claude:m10"]);
      assert.equal((await decodeSession(result?.session ?? ""))?.tier, 10);
    });
  });

  it("keeps a bare rate_limit failed", async () => {
    await withTempDir(async (dir) => {
      const { adapters, launched } = setup({
        claude: {
          usage: () => reading("claude", 0.8),
          script: () => ({ error: { code: -32603, message: "429", data: { errorKind: "rate_limit" } } }),
          classifyFailure: claudeAdapter.classifyFailure,
          quotaRateLimit: claudeAdapter.quotaRateLimit,
        },
        codex: { usage: () => reading("codex", 0.5) },
      });
      const [result] = await delegate({ tasks: [open(dir)] }, noAbort(), adapters);
      assert.equal(result?.status, "failed");
      assert.equal(result?.provider, "claude");
      assert.deepEqual(launched, ["claude:haiku"]);
      assert.deepEqual(result?.notes, []);
    });
  });

  it("cancels on the Claude overage watch and reroutes", async () => {
    await withTempDir(async (dir) => {
      const logFile = join(dir, "overage.json");
      const { adapters, launched } = setup({
        claude: {
          usage: (i) => reading("claude", i === 0 ? 0.8 : 0),
          script: () => ({
            usageUpdates: [{ used: 1, size: 2, _meta: { "_claude/rateLimit": { isUsingOverage: true } } }],
            sleepMs: 10_000,
            reply: "never",
            logFile,
          }),
          classifyFailure: claudeAdapter.classifyFailure,
          quotaRateLimit: claudeAdapter.quotaRateLimit,
        },
        codex: { usage: () => reading("codex", 0.5) },
      });
      const [result] = await delegate({ tasks: [open(dir)] }, noAbort(), adapters);
      assert.equal(result?.status, "done");
      assert.equal(result?.provider, "codex");
      assert.deepEqual(launched, ["claude:haiku", "codex:gpt-5.6-terra"]);
      assert.deepEqual(result?.notes, ["rerouted from claude:haiku: quota"]);
      assert.equal((JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog).cancelled, true);
    });
  });

  /** A claude fake whose worker bills an API key while the launch requires the account. */
  const billsApiKey = (fixtures: Parameters<typeof setup>[0]) => {
    const fake = setup({
      ...fixtures,
      claude: {
        usage: () => reading("claude", 0.8),
        script: () => ({ authStatus: { kind: "api_key", label: "API key" }, reply: "x" }),
      },
    });
    const claude = fake.adapters.claude as AgentAdapter;
    const launch = claude.launch.bind(claude);
    claude.launch = async (...args) => ({ ...(await launch(...args)), requireAuth: { kind: "account" } });
    return fake;
  };

  it("reroutes a lane that would bill another auth", async () => {
    await withTempDir(async (dir) => {
      const { adapters } = billsApiKey({ codex: { usage: () => reading("codex", 0.5) } });
      const [result] = await delegate({ tasks: [open(dir)] }, noAbort(), adapters);
      assert.equal(result?.provider, "codex");
      assert.deepEqual(result?.notes, ["rerouted from claude:haiku: would bill API key"]);
    });
  });

  it("excludes every lane of the key after one auth mismatch, without re-reading usage", async () => {
    await withTempDir(async (dir) => {
      const { adapters, launched, reads } = billsApiKey({});
      const [result] = await delegate({ tasks: [open(dir)] }, noAbort(), adapters);
      assert.equal(result?.status, "no_quota");
      assert.deepEqual(launched, ["claude:haiku"]);
      assert.deepEqual(reads, ["claude"]);
      assert.deepEqual(result?.notes, ["rerouted from claude:haiku: would bill API key"]);
    });
  });

  it("gives no_quota when every lane is out", async () => {
    await withTempDir(async (dir) => {
      const { adapters, launched } = setup({
        claude: { usage: () => reading("claude", 0.01) },
        codex: { usage: () => reading("codex", 0.02) },
      });
      const [result] = await delegate({ tasks: [open(dir)] }, noAbort(), adapters);
      assert.equal(result?.status, "no_quota");
      assert.deepEqual(launched, []);
      assert.match(result?.error ?? "", /claude out: .*; codex out: /);
    });
  });

  it("gives no_quota after a quota failure leaves no lane", async () => {
    await withTempDir(async (dir) => {
      const { adapters, launched } = setup({
        claude: {
          usage: (i) => reading("claude", i === 0 ? 0.8 : 0),
          script: () => ({
            error: { code: -32603, message: "billing", data: { errorKind: "billing_error" } },
          }),
          classifyFailure: claudeAdapter.classifyFailure,
          quotaRateLimit: claudeAdapter.quotaRateLimit,
        },
      });
      const [result] = await delegate({ tasks: [open(dir)] }, noAbort(), adapters);
      assert.equal(result?.status, "no_quota");
      assert.deepEqual(launched, ["claude:haiku"]);
      assert.deepEqual(result?.notes, ["rerouted from claude:haiku: quota"]);
    });
  });
});

describe("resume", () => {
  const handleOf = (cwd: string, extra: Partial<SessionHandle> = {}): SessionHandle => ({
    agent: "claude",
    key: "claude",
    model: "sonnet",
    effort: "high",
    tier: 2,
    sessionId: "old-session",
    cwd,
    ...extra,
  });
  const resumeTask = async (cwd: string, h: SessionHandle | string, extra: Partial<DelegateTask> = {}) =>
    task(cwd, "continue", { session: typeof h === "string" ? h : await encodeSession(h), ...extra });
  const offering = (extra: FakeAgentScript = {}): FakeAgentScript => ({
    reply: "ok",
    configOptions: [
      {
        id: "model",
        name: "model",
        category: "model",
        type: "select",
        currentValue: "haiku",
        options: [
          { value: "haiku", name: "haiku" },
          { value: "sonnet", name: "sonnet" },
        ],
      },
      {
        id: "effort",
        name: "effort",
        category: "thought_level",
        type: "select",
        currentValue: "medium",
        options: [
          { value: "medium", name: "medium" },
          { value: "high", name: "high" },
        ],
      },
    ],
    ...extra,
  });

  it("resumes with session/resume, re-applies the handle's model and effort, and returns a fresh handle", async () => {
    await withTempDir(async (dir) => {
      const logFile = join(dir, "log.json");
      const launches: Array<{ lane: Lane; cwd: string }> = [];
      const adapter = makeFakeAdapter({
        setConfig: true,
        onLaunch: (lane, cwd) => launches.push({ lane, cwd }),
        scriptForTask: () => offering({ advertiseResume: true, logFile }),
      });
      // The task's tier 1 and default effort differ from the handle's lane: the handle's lane runs, at its own tier.
      const [result] = await delegate({ tasks: [await resumeTask(dir, handleOf(dir))] }, noAbort(), {
        claude: adapter,
      });
      assert.equal(result?.status, "done");
      assert.deepEqual(launches[0]?.lane, {
        id: "claude:sonnet",
        agent: "claude",
        key: "claude",
        tier: 2,
        model: "sonnet",
        effort: "high",
      });
      const log = JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog;
      assert.deepEqual(log.sessionCalls, ["resume:old-session"]);
      assert.deepEqual(log.configSets, [
        { configId: "model", value: "sonnet" },
        { configId: "effort", value: "high" },
      ]);
      assert.equal(log.promptText, "continue");
      assert.deepEqual(
        await decodeSession(result?.session ?? ""),
        handleOf(dir, { sessionId: "old-session" }),
      );
    });
  });

  it("uses session/load when resume is not advertised, and launches in the handle's cwd", async () => {
    await withTempDir(async (dir) => {
      const logFile = join(dir, "log.json");
      const cwds: string[] = [];
      const adapter = makeFakeAdapter({
        onLaunch: (_lane, cwd) => cwds.push(cwd),
        scriptForTask: () => ({ reply: "ok", advertiseLoad: true, logFile }),
      });
      const [result] = await delegate({ tasks: [await resumeTask(dir, handleOf(dir))] }, noAbort(), {
        claude: adapter,
      });
      assert.equal(result?.status, "done");
      assert.deepEqual(cwds, [dir]);
      assert.deepEqual((JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog).sessionCalls, [
        "load:old-session",
      ]);
    });
  });

  it("makes a tier above the session's a tool error", async () => {
    await withTempDir(async (dir) => {
      const adapter = makeFakeAdapter({ scriptForTask: () => ({ reply: "ok", advertiseResume: true }) });
      const handle = handleOf(dir, { model: "haiku", tier: 1 });
      await assert.rejects(
        delegate({ tasks: [await resumeTask(dir, handle, { tier: 3 })] }, noAbort(), { claude: adapter }),
        /^Error: tasks\[0\]: session ran tier 1; tier 3 needs a new session$/,
      );
    });
  });

  it("makes a cwd other than the session's a tool error", async () => {
    await withTempDir(async (dir) => {
      const other = join(dir, "other");
      mkdirSync(other);
      const cwds: string[] = [];
      const adapter = makeFakeAdapter({
        onLaunch: (_lane, cwd) => cwds.push(cwd),
        scriptForTask: () => ({ reply: "ok", advertiseResume: true }),
      });
      await assert.rejects(
        delegate({ tasks: [task(dir), await resumeTask(other, handleOf(dir))] }, noAbort(), {
          claude: adapter,
        }),
        new RegExp(`tasks\\[1\\]: a resumed task runs in its session's cwd ${dir}`),
      );
      const [result] = await delegate(
        { tasks: [await resumeTask(`${dir}/./other/..`, handleOf(dir))] },
        noAbort(),
        {
          claude: adapter,
        },
      );
      assert.equal(result?.status, "done");
      assert.deepEqual(cwds, [`${dir}/./other/..`]);
    });
  });

  it("gives no_quota with the pool summary and never reroutes when the lane is out", async () => {
    await withTempDir(async (dir) => {
      writeConfig({ claude: consented("claude"), codex: consented("codex") });
      const launched: string[] = [];
      const fake = (id: AgentId, remaining: number) =>
        makeFakeAdapter({
          id,
          onLaunch: (lane) => launched.push(lane.id),
          scriptForTask: () => ({ reply: "ok" }),
          usage: () => reading(id, remaining),
        });
      const adapters = { claude: fake("claude", 0.01), codex: fake("codex", 0.9) };
      const [result] = await delegate(
        { tasks: [await resumeTask(dir, handleOf(dir), { agents: undefined })] },
        noAbort(),
        adapters,
      );
      assert.equal(result?.status, "no_quota");
      assert.equal(result?.session, undefined);
      assert.match(result?.error ?? "", /^no lane for tier 1; pools: claude out: [^;]*$/);
      assert.deepEqual(launched, []);
    });
  });

  it("gives no_quota instead of a new session when the resumed run hits quota", async () => {
    await withTempDir(async (dir) => {
      writeConfig({ claude: consented("claude"), codex: consented("codex") });
      const launched: string[] = [];
      let reads = 0;
      const claude = makeFakeAdapter({
        onLaunch: (lane) => launched.push(lane.id),
        scriptForTask: () => ({
          advertiseResume: true,
          error: { code: -32603, message: "billing", data: { errorKind: "billing_error" } },
        }),
        usage: () => reading("claude", reads++ === 0 ? 0.8 : 0),
        classifyFailure: claudeAdapter.classifyFailure,
        quotaRateLimit: claudeAdapter.quotaRateLimit,
      });
      const codex = makeFakeAdapter({
        id: "codex",
        onLaunch: (lane) => launched.push(lane.id),
        scriptForTask: () => ({ reply: "ok" }),
        usage: () => reading("codex", 0.9),
      });
      const [result] = await delegate({ tasks: [await resumeTask(dir, handleOf(dir))] }, noAbort(), {
        claude,
        codex,
      });
      assert.equal(result?.status, "no_quota");
      assert.deepEqual(launched, ["claude:sonnet"]);
    });
  });

  it("runs its handle lane under a list that no longer holds it", async () => {
    await withTempDir(async (dir) => {
      writeConfig({ claude: consented("claude") }, { tiers: [["claude:haiku@medium"]] });
      const lanes: Lane[] = [];
      const adapter = makeFakeAdapter({
        onLaunch: (lane) => lanes.push(lane),
        scriptForTask: () => ({ reply: "ok", advertiseResume: true }),
      });
      const [result] = await delegate({ tasks: [await resumeTask(dir, handleOf(dir))] }, noAbort(), {
        claude: adapter,
      });
      assert.equal(result?.status, "done");
      assert.deepEqual(
        lanes.map((l) => [l.id, l.tier, l.effort]),
        [["claude:sonnet", 2, "high"]],
      );
    });
  });

  it("leaves resumed tasks out of the batch split", async () => {
    await withTempDir(async (dir) => {
      writeConfig({ claude: consented("claude"), codex: consented("codex") });
      const fake = (id: AgentId, remaining: number) =>
        makeFakeAdapter({ id, scriptForTask: () => ({ reply: "ok" }), usage: () => reading(id, remaining) });
      const open = (): DelegateTask => task(dir, "p", { agents: undefined });
      // Counted in the batch, the resumed task's Claude load would send the second fresh task to Claude.
      const results = await delegate(
        { tasks: [await resumeTask(dir, handleOf(dir)), open(), open()] },
        noAbort(),
        {
          claude: fake("claude", 0.51),
          codex: fake("codex", 0.5),
        },
      );
      assert.deepEqual(
        results.map((r) => r.provider),
        ["claude", "claude", "codex"],
      );
    });
  });

  it("makes a malformed handle a tool error naming the task index", async () => {
    await withTempDir(async (dir) => {
      const adapter = makeFakeAdapter({ scriptForTask: () => ({ reply: "ok" }) });
      const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
      const run = async (session: string) =>
        delegate({ tasks: [task(dir), await resumeTask(dir, session)] }, noAbort(), { claude: adapter });
      const good = handleOf(dir);
      await encodeSession(good);
      const key = Buffer.from(readFileSync(join(stateDir(), "secret"), "utf8"), "hex");
      // Signed with the install's key, so each case reaches the field checks.
      const signed = (v: unknown) =>
        `${b64(v)}.${createHmac("sha256", key).update(b64(v)).digest("base64url")}`;
      assert.deepEqual(await decodeSession(signed(good)), good);
      for (const bad of [
        "not a handle",
        b64(good),
        signed("string"),
        signed(null),
        signed({ ...good, sessionId: "" }),
        signed({ ...good, cwd: undefined }),
        signed({ ...good, key: "agy-gemini" }),
        signed({ ...good, tier: undefined }),
        signed({ ...good, tier: 0 }),
        signed({ ...good, tier: 1.5 }),
        signed({ ...good, tier: "2" }),
        signed({ ...good, costUsd: -1 }),
        signed({ ...good, costUsd: "1" }),
        signed({ ...good, key: "constructor", agent: "constructor" }),
        signed({ ...good, agent: "codex", key: "codex" }),
      ]) {
        await assert.rejects(run(bad), /tasks\[1\].*session/);
      }
    });
  });

  it("rejects a handle whose fields were edited after signing", async () => {
    await withTempDir(async (dir) => {
      const adapter = makeFakeAdapter({ scriptForTask: () => ({ reply: "ok" }) });
      const real = await encodeSession(handleOf(dir, { costUsd: 4 }));
      const [body, signature] = real.split(".");
      const fields = JSON.parse(Buffer.from(body ?? "", "base64url").toString("utf8")) as SessionHandle;
      const edited = `${Buffer.from(JSON.stringify({ ...fields, costUsd: 1e9 })).toString("base64url")}.${signature}`;
      assert.equal((await decodeSession(real))?.costUsd, 4);
      assert.equal(await decodeSession(edited), undefined);
      await assert.rejects(
        delegate({ tasks: [await resumeTask(dir, edited)] }, noAbort(), { claude: adapter }),
        /^Error: tasks\[0\]: session is not a handle from an earlier result$/,
      );
    });
  });

  it("keeps its signing key in a 0600 file and rejects a handle signed with another", async () => {
    await withTempDir(async (dir) => {
      const handle = await encodeSession(handleOf(dir));
      const secret = join(stateDir(), "secret");
      assert.equal(statSync(secret).mode & 0o777, 0o600);
      writeFileSync(secret, randomBytes(32).toString("hex"));
      assert.equal(await decodeSession(handle), undefined);
    });
  });

  it("creates one signing key when first uses race", async () => {
    await withTempDir(async (dir) => {
      const handles = await Promise.all([1, 2, 3, 4].map(() => encodeSession(handleOf(dir))));
      for (const h of handles) assert.notEqual(await decodeSession(h), undefined);
    });
  });

  it("rejects two tasks resuming one session", async () => {
    await withTempDir(async (dir) => {
      const adapter = makeFakeAdapter({ scriptForTask: () => ({ reply: "ok", advertiseResume: true }) });
      const session = await encodeSession(handleOf(dir));
      await assert.rejects(
        delegate(
          { tasks: [await resumeTask(dir, session), task(dir), await resumeTask(dir, session)] },
          noAbort(),
          { claude: adapter },
        ),
        /^Error: tasks\[2\]: session already resumed by tasks\[0\]$/,
      );
      // Another handle for the same session (a later result's, here one with a different cost) is the same session.
      const later = await encodeSession({ ...handleOf(dir), costUsd: 7 });
      await assert.rejects(
        delegate({ tasks: [await resumeTask(dir, session), await resumeTask(dir, later)] }, noAbort(), {
          claude: adapter,
        }),
        /^Error: tasks\[1\]: session already resumed by tasks\[0\]$/,
      );
    });
  });

  it("refuses a signing key that is not 32 bytes", async () => {
    await withTempDir(async (dir) => {
      const handle = await encodeSession(handleOf(dir));
      writeFileSync(join(stateDir(), "secret"), "");
      await assert.rejects(decodeSession(handle), /is not a 32-byte hex key/);
    });
  });
});
