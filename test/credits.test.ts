import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { workerEnv } from "../src/acp.ts";
import { claudeAdapter } from "../src/agents/claude.ts";
import {
  appendLedger,
  creditReading,
  cycle,
  type LedgerLine,
  readLedger,
  replay,
  reserveCredit,
} from "../src/credit.ts";
import { decodeSession, delegate, encodeSession } from "../src/delegate.ts";
import { route } from "../src/router.ts";
import { usageText } from "../src/server.ts";
import { configPath, readOffered, stateDir, writeAtomic } from "../src/state.ts";
import { candidates, DEFAULT_TIERS, parseTiers } from "../src/tiers.ts";
import type { AgentAdapter, Config, CreditPoolConfig, DelegateTask, Lane, TaskResult } from "../src/types.ts";
import type { FakeAgentLog, FakeAgentScript } from "./fake-agent.ts";

const run = promisify(execFile);
const H = 3.6e6;
const POOL: CreditPoolConfig = {
  grantUsd: 100,
  cycleDay: 31,
  keyCommand: ["true"],
  taskCapUsd: 60,
  overageOff: true,
};
const utc = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);
const line = (at: number, taskId: string, kind: LedgerLine["kind"], usd: number): LedgerLine => ({
  at,
  taskId,
  kind,
  usd,
});
const ledgerFile = () => join(stateDir(), "ledger", "claude-credits.jsonl");
const remaining = async (pool: CreditPoolConfig, now?: number) =>
  (await creditReading(pool, now)).pools[0]?.windows[0]?.remaining;

let dir: string;
const saved = process.env.XDG_STATE_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "schmear-credits-"));
  process.env.XDG_STATE_HOME = dir;
});

afterEach(() => {
  if (saved === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = saved;
  }
});

/** Runs `body` (with `s` = credit.ts) in `n` processes started at the same instant; their stdouts. */
async function inChildren(n: number, body: string): Promise<string[]> {
  const credit = new URL("../src/credit.ts", import.meta.url).href;
  const code = `const s = await import(${JSON.stringify(credit)});
    await new Promise((r) => setTimeout(r, ${Date.now() + 500} - Date.now()));
    ${body}`;
  const outs = await Promise.all(
    Array.from({ length: n }, () =>
      run(process.execPath, ["--input-type=module", "-e", code], { env: process.env }),
    ),
  );
  return outs.map((o) => o.stdout.trim());
}

describe("cycle", () => {
  it("clamps day 31 to a 30-day month's last day", () => {
    assert.deepEqual(cycle(31, utc(2026, 4, 30, 10)), { start: utc(2026, 4, 30), end: utc(2026, 5, 31) });
    assert.deepEqual(cycle(31, utc(2026, 4, 29, 23)), { start: utc(2026, 3, 31), end: utc(2026, 4, 30) });
  });

  it("clamps to February's last day, 28 or 29 in a leap year", () => {
    assert.deepEqual(cycle(30, utc(2027, 2, 15)), { start: utc(2027, 1, 30), end: utc(2027, 2, 28) });
    assert.deepEqual(cycle(30, utc(2028, 2, 15)), { start: utc(2028, 1, 30), end: utc(2028, 2, 29) });
    assert.deepEqual(cycle(31, utc(2028, 2, 29, 1)), { start: utc(2028, 2, 29), end: utc(2028, 3, 31) });
  });

  it("starts at midnight UTC whatever the process timezone, and crosses the year", () => {
    const tz = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    try {
      assert.deepEqual(cycle(5, utc(2026, 12, 5)), { start: utc(2026, 12, 5), end: utc(2027, 1, 5) });
      // 05:00 on Jan 5 in Tokyo, still Jan 4 in UTC
      assert.deepEqual(cycle(5, utc(2027, 1, 4, 20)), { start: utc(2026, 12, 5), end: utc(2027, 1, 5) });
    } finally {
      if (tz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = tz;
      }
    }
  });
});

describe("replay", () => {
  const replayed = (lines: LedgerLine[], carried = new Map<string, number>()) => {
    const { left, open } = replay(lines, 100, carried);
    return { left, open: Object.fromEntries(open) };
  };

  it("voids a reserve the earlier lines leave no room for", () => {
    assert.deepEqual(replayed([line(0, "a", "reserve", 60), line(0, "b", "reserve", 60)]), {
      left: 40,
      open: { a: 60 },
    });
    assert.deepEqual(replayed([line(0, "a", "reserve", 60), line(0, "b", "reserve", 38)]), {
      left: 2,
      open: { a: 60, b: 38 },
    });
    // 39 fits in what is left (40) but would cross the floor.
    assert.deepEqual(replayed([line(0, "a", "reserve", 60), line(0, "b", "reserve", 39)]), {
      left: 40,
      open: { a: 60 },
    });
  });

  it("a settle replaces its reservation; one without a valid reservation charges in full", () => {
    assert.deepEqual(
      replayed([
        line(0, "a", "reserve", 60),
        line(0, "b", "reserve", 60),
        line(0, "a", "settle", 7),
        line(0, "b", "settle", 5),
      ]),
      { left: 88, open: {} },
    );
  });

  it("exhausted leaves 0 and voids later reserves", () => {
    assert.deepEqual(
      replayed([line(0, "a", "reserve", 10), line(0, "x", "exhausted", 0), line(0, "b", "reserve", 1)]),
      {
        left: 0,
        open: { a: 10 },
      },
    );
  });

  it("counts carried reservations first and passes on only the ones reserved in its lines", () => {
    const carried = () => new Map([["a", 95]]);
    assert.deepEqual(replayed([line(0, "b", "reserve", 10)], carried()), { left: 5, open: {} });
    assert.deepEqual(replayed([line(0, "b", "reserve", 1), line(0, "a", "settle", 3)], carried()), {
      left: 96,
      open: { b: 1 },
    });
  });
});

describe("readLedger", () => {
  it("skips a trailing partial line and throws on a malformed complete one", async () => {
    await appendLedger(line(1, "a", "reserve", 10));
    await appendFile(ledgerFile(), '{"at":2,"taskId":"b","ki');
    assert.deepEqual(await readLedger(), [line(1, "a", "reserve", 10)]);
    await appendFile(ledgerFile(), "\n");
    await assert.rejects(readLedger(), { message: "ledger line 2: not JSON" });
    await rm(ledgerFile());
    await appendFile(ledgerFile(), '{"at":1,');
    assert.deepEqual(await readLedger(), []);
  });

  it("names the first invalid field of a complete line", async () => {
    for (const [text, field] of [
      ["null", "not an object"],
      ['{"at":"1","taskId":"a","kind":"settle","usd":1}', "at"],
      ['{"at":1,"taskId":"","kind":"settle","usd":1}', "taskId"],
      ['{"at":1,"taskId":"a","kind":"refund","usd":1}', "kind"],
      ['{"at":1,"taskId":"a","kind":"settle","usd":null}', "usd"],
      ['{"at":1,"taskId":"a","kind":"settle","usd":-1}', "usd"],
    ]) {
      await rm(ledgerFile(), { force: true });
      await appendLedger(line(1, "a", "reserve", 10));
      await appendFile(ledgerFile(), `${text}\n`);
      await assert.rejects(readLedger(), { message: `ledger line 2: ${field}` });
    }
  });
});

describe("creditReading", () => {
  const now = utc(2026, 11, 21, 12);

  it("skips the pool on a line without `at` instead of restoring the grant", async () => {
    await appendLedger(line(utc(2026, 11, 1), "a", "reserve", 50));
    await appendLedger(line(utc(2026, 11, 1), "a", "settle", 90));
    await appendFile(ledgerFile(), '{"taskId":"z","kind":"settle","usd":0}\n');
    const r = await creditReading(POOL, now);
    assert.equal(r.error, "credit ledger unreadable: ledger line 3: at");
    assert.deepEqual(r.pools[0]?.windows, []);
  });

  it("skips the pool on an invalid config, before any ledger read or reserve", async () => {
    const { taskCapUsd: _, ...noCap } = POOL;
    for (const [pool, field] of [
      [noCap, "taskCapUsd"],
      [{ ...POOL, taskCapUsd: 0 }, "taskCapUsd"],
      [{ ...POOL, taskCapUsd: 101 }, "taskCapUsd"],
      [{ ...POOL, grantUsd: Number.NaN }, "grantUsd"],
      [{ ...POOL, cycleDay: 0 }, "cycleDay"],
      [{ ...POOL, cycleDay: 1.5 }, "cycleDay"],
    ] as [CreditPoolConfig, string][]) {
      const r = await creditReading(pool, now);
      assert.equal(r.error, `credit pool config invalid: ${field}`);
      assert.deepEqual(r.pools, [
        { id: "claude-credits", agent: "claude", keys: ["claude-credits"], windows: [] },
      ]);
    }
    assert.equal(existsSync(ledgerFile()), false);
  });

  it("carries an unsettled reservation across one cycle boundary only", async () => {
    await appendLedger(line(utc(2026, 1, 15), "jan", "reserve", 50));
    await appendLedger(line(utc(2026, 2, 15), "feb", "settle", 1));
    assert.equal(await remaining(POOL, utc(2026, 2, 20)), 0.49);
    await appendLedger(line(utc(2026, 3, 15), "mar", "settle", 1));
    assert.equal(await remaining(POOL, utc(2026, 3, 20)), 0.99);
    assert.equal(await remaining(POOL, utc(2026, 4, 15)), 1);
  });

  it("subtracts this cycle's settles and open reservations; a settle replaces its reservation", async () => {
    await appendLedger(line(utc(2026, 10, 30), "old", "settle", 50)); // previous cycle
    await appendLedger(line(utc(2026, 11, 1), "a", "reserve", 10));
    await appendLedger(line(utc(2026, 11, 1), "a", "settle", 7));
    await appendLedger(line(utc(2026, 11, 2), "killed", "reserve", 20)); // no settle: stands
    const r = await creditReading(POOL, now);
    const { start, end } = cycle(31, now);
    assert.deepEqual(r, {
      agent: "claude",
      fetchedAt: now,
      warnings: [],
      pools: [
        {
          id: "claude-credits",
          agent: "claude",
          keys: ["claude-credits"],
          windows: [{ kind: "period", remaining: 0.73, resetsAt: end, periodHours: (end - start) / H }],
        },
      ],
    });
    assert.equal(start, utc(2026, 10, 31));
    assert.equal(end, utc(2026, 11, 30));
  });

  it("an exhausted line makes remaining 0 until the cycle ends", async () => {
    await appendLedger(line(utc(2026, 11, 3), "a", "exhausted", 0));
    assert.equal(await remaining(POOL, now), 0);
    assert.equal(await remaining(POOL, utc(2026, 11, 30, 1)), 1);
  });

  it("a reservation open at the cycle start counts against the new cycle until its settle", async () => {
    const start = utc(2026, 10, 31);
    await appendLedger(line(start - 60_000, "x", "reserve", 98));
    assert.equal(await remaining(POOL, start + 60_000), 0.02);
    await appendLedger(line(start + 60_000, "x", "settle", 5));
    assert.equal(await remaining(POOL, start + 120_000), 0.95);
  });

  it("puts a reserve stamped before the cycle start but appended after a later line in the new cycle", async () => {
    const start = utc(2026, 10, 31);
    await appendLedger(line(start + 1_000, "a", "reserve", 60));
    await appendLedger(line(start - 1_000, "b", "reserve", 60)); // void here, so its settle gives nothing back
    await appendLedger(line(start + 2_000, "b", "settle", 0));
    assert.equal(await remaining(POOL, start + 60_000), 0.4);
  });

  it("a reader whose clock is behind the latest line's cycle uses that cycle", async () => {
    const start = utc(2026, 10, 31);
    await appendLedger(line(start + 1_000, "a", "reserve", 10));
    assert.equal(await remaining(POOL, start - 60_000), 0.9);
  });

  it("carries nothing across a gap of two cycles", async () => {
    await appendLedger(line(utc(2026, 9, 15), "a", "reserve", 50));
    assert.equal(await remaining(POOL, now), 1);
    await appendLedger(line(utc(2026, 11, 1), "b", "reserve", 10));
    assert.equal(await remaining(POOL, now), 0.9);
  });

  it("gives the router a credit lane with pace, and outs it when exhausted", async () => {
    const config: Config = {
      version: 1,
      agents: { claude: { consent: true, path: "/bin/claude" } },
      credits: POOL,
    };
    const routeAt = async () =>
      route({
        now,
        driver: "claude",
        readings: [await creditReading(POOL, now)],
        config,
        exclude: new Set(),
        tasks: [candidates(2, parseTiers(DEFAULT_TIERS), {})],
      });
    await appendLedger(line(utc(2026, 11, 1), "a", "settle", 50));
    const ok = await routeAt();
    assert.equal(ok.assignments[0]?.id, "claude-credits:sonnet");
    assert.equal(ok.assignments[0]?.agent, "claude");
    const { start, end } = cycle(31, now);
    assert.ok(Math.abs((ok.pools[0]?.pace ?? 0) - ((0.5 - 0.02) * (end - start)) / (end - now)) < 1e-9);
    await appendLedger(line(utc(2026, 11, 2), "b", "exhausted", 0));
    const out = await routeAt();
    assert.equal(out.assignments[0], null);
    assert.match(String(out.pools[0]?.status), /^out: /);
  });
});

describe("reserveCredit", () => {
  it("reserves min(remaining − floor, taskCapUsd), and nothing at or below the floor", async () => {
    assert.equal(await reserveCredit(POOL, "a"), 60);
    assert.equal(await reserveCredit(POOL, "b"), 38);
    assert.ok((await reserveCredit(POOL, "c")) <= 0);
    assert.deepEqual(
      (await readLedger()).map((l) => [l.taskId, l.kind, l.usd]),
      [
        ["a", "reserve", 60],
        ["b", "reserve", 38],
      ],
    );
  });

  it("reserves once when a cycle boundary passes between the reserve and its read-back", async () => {
    const { end } = cycle(POOL.cycleDay, Date.now());
    let calls = 0;
    const now = mock.method(Date, "now", () => (calls++ === 0 ? end - 1 : end + 1));
    try {
      assert.equal(await reserveCredit(POOL, "a"), 60);
    } finally {
      now.mock.restore();
    }
    assert.deepEqual(
      (await readLedger()).map((l) => [l.taskId, l.kind]),
      [["a", "reserve"]],
    );
  });

  it("gives B ≤ 0 just after the cycle start while a 98 reservation from just before it is open", async () => {
    const pool = { ...POOL, taskCapUsd: 98 };
    const { start } = cycle(pool.cycleDay, Date.now());
    await appendLedger(line(start - 60_000, "x", "reserve", 98));
    assert.ok((await reserveCredit(pool, "y")) <= 0);
  });

  it("concurrent processes never reserve more than remaining − floor", async () => {
    const got = (
      await inChildren(
        6,
        `console.log(await s.reserveCredit(${JSON.stringify({ ...POOL, taskCapUsd: 30 })}, String(process.pid)));`,
      )
    )
      .map(Number)
      .sort((a, b) => b - a);
    assert.deepEqual(got, [30, 30, 30, 8, 0, 0]);
    assert.ok(Math.abs(((await remaining(POOL)) ?? 1) - 0.02) < 1e-9);
  });
});

describe("credit spend path", () => {
  const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.ts", import.meta.url));
  const KEY = "sk-test-credit-key";
  const keyCommand = [process.execPath, "-e", `process.stdout.write(${JSON.stringify(`${KEY}\n`)})`];
  const savedConfig = process.env.XDG_CONFIG_HOME;

  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = join(dir, "config");
  });

  afterEach(() => {
    if (savedConfig === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedConfig;
    }
  });

  /** A claude fake on a consented config with the credit pool; the subscription pool has `claudeLeft` left, in `claudeWindow` when given. */
  async function setup(o: {
    pool?: Partial<CreditPoolConfig>;
    claudeLeft?: number;
    claudeWindow?: { resetsAt: number; periodHours: number };
    script?: (lane: Lane, n: number) => FakeAgentScript;
    setModel?: boolean;
  }) {
    const pool: CreditPoolConfig = { ...POOL, keyCommand, ...o.pool };
    const config: Config = {
      version: 1,
      agents: { claude: { consent: true, path: "/fake/bin/claude" } },
      credits: pool,
    };
    await writeAtomic(configPath(), JSON.stringify(config));
    const launched: Lane[] = [];
    const logFiles: string[] = [];
    const adapter: AgentAdapter = {
      id: "claude",
      isClient: () => false,
      find: async () => ({ error: "not used" }),
      readUsage: async () => ({
        agent: "claude",
        fetchedAt: Date.now(),
        warnings: [],
        pools: [
          {
            id: "claude",
            agent: "claude",
            keys: ["claude"],
            windows: [
              {
                kind: "period",
                remaining: o.claudeLeft ?? 0.5,
                resetsAt: null,
                periodHours: 168,
                ...o.claudeWindow,
              },
            ],
          },
        ],
      }),
      async launch(lane) {
        const n = launched.push(lane) - 1;
        const logFile = join(dir, `worker-${n}.json`);
        logFiles.push(logFile);
        const script: FakeAgentScript = { reply: "ok", logFile, ...o.script?.(lane, n) };
        return {
          command: process.execPath,
          args: [FAKE_AGENT, JSON.stringify(script)],
          env: workerEnv(),
          ...(o.setModel ? { config: { model: lane.model } } : {}),
        };
      },
      classifyFailure: claudeAdapter.classifyFailure,
      quotaRateLimit: claudeAdapter.quotaRateLimit,
    };
    const workerLog = (n: number) => JSON.parse(readFileSync(logFiles[n] as string, "utf8")) as FakeAgentLog;
    return { pool, adapters: { claude: adapter }, launched, logFiles, workerLog };
  }

  const tasks = (n: number): DelegateTask[] =>
    Array.from({ length: n }, () => ({ prompt: "p", cwd: dir, tier: 1 }) as DelegateTask);
  const noAbort = () => ({ driver: null, signal: new AbortController().signal });
  /** Waits until the first worker's log satisfies `done`. */
  const untilLogged = async (logFiles: string[], done: (log: FakeAgentLog) => boolean) => {
    const logged = () => {
      const f = logFiles[0];
      return f !== undefined && existsSync(f) && done(JSON.parse(readFileSync(f, "utf8")) as FakeAgentLog);
    };
    while (!logged()) await sleep(20);
  };
  const ledger = async () => (await readLedger()).map((l) => [l.kind, l.usd]);
  const leaksKey = async (results: TaskResult[]) =>
    JSON.stringify(results).includes(KEY) ||
    (await readFile(ledgerFile(), "utf8").catch(() => "")).includes(KEY);

  it("reserves B, sends it as maxBudgetUsd with the key, and settles the last reported cost", async () => {
    const { adapters, launched, workerLog } = await setup({
      script: () => ({
        usageUpdates: [
          { used: 1, size: 9, cost: { amount: 0.1, currency: "USD" } },
          { used: 2, size: 9, cost: { amount: 0.25, currency: "USD" } },
        ],
      }),
    });
    const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(results[0]?.status, "done");
    assert.equal(results[0]?.costUsd, 0.25);
    assert.equal(launched[0]?.id, "claude-credits:haiku");
    assert.deepEqual(workerLog(0).sessionMeta, { claudeCode: { options: { maxBudgetUsd: 60 } } });
    assert.equal(workerLog(0).apiKey, KEY);
    assert.deepEqual(await ledger(), [
      ["reserve", 60],
      ["settle", 0.25],
    ]);
    const [reserve, settle] = await readLedger();
    assert.equal(reserve?.taskId, settle?.taskId);
    assert.equal(await remaining(POOL), 0.9975);
    assert.equal(await leaksKey(results), false);
  });

  it("leaves a killed task's reservation standing when it reported no cost", async () => {
    const { adapters, logFiles } = await setup({ script: () => ({ sleepMs: 10_000 }) });
    const abort = new AbortController();
    const pending = delegate({ tasks: tasks(1) }, { driver: null, signal: abort.signal }, adapters);
    await untilLogged(logFiles, (log) => log.promptCalled);
    abort.abort();
    const results = await pending;
    assert.equal(results[0]?.status, "cancelled");
    assert.deepEqual(await ledger(), [["reserve", 60]]);
    assert.equal(await remaining(POOL), 0.4);
  });

  for (const [name, error] of [
    ["billing_error", { code: -32603, message: "billing", data: { errorKind: "billing_error" } }],
    ["credit balance is too low", { code: -32603, message: "Your credit balance is too low" }],
  ] as const) {
    it(`${name} settles, writes exhausted, then reroutes to the subscription without the key`, async () => {
      const { adapters, launched, workerLog } = await setup({
        script: (lane) =>
          lane.key === "claude-credits"
            ? { usageUpdates: [{ used: 1, size: 9, cost: { amount: 0.5, currency: "USD" } }], error }
            : { reply: "sub" },
      });
      const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
      assert.equal(results[0]?.status, "done");
      assert.equal(results[0]?.reply, "sub");
      assert.deepEqual(results[0]?.notes, ["rerouted from claude-credits:haiku: quota"]);
      assert.deepEqual(
        launched.map((l) => l.id),
        ["claude-credits:haiku", "claude:haiku"],
      );
      assert.deepEqual(await ledger(), [
        ["reserve", 60],
        ["settle", 0.5],
        ["exhausted", 0],
      ]);
      assert.equal(await remaining(POOL), 0);
      assert.equal(workerLog(1).apiKey, undefined);
      assert.equal(workerLog(1).sessionMeta, undefined);
      assert.equal(await leaksKey(results), false);
    });
  }

  it("takes B ≤ 0 at reserve time as a quota outcome", async () => {
    const { adapters, logFiles } = await setup({
      pool: { taskCapUsd: 98 },
      claudeLeft: 0,
      script: () => ({ usageUpdates: [{ used: 1, size: 9, cost: { amount: 1, currency: "USD" } }] }),
    });
    const results = await delegate({ tasks: tasks(2) }, noAbort(), adapters);
    assert.deepEqual(results.map((r) => r.status).sort(), ["done", "no_quota"]);
    const refused = results.find((r) => r.status === "no_quota");
    assert.deepEqual(refused?.notes, ["rerouted from claude-credits:haiku: quota"]);
    // launch() runs before the reservation, but only one worker spawned
    assert.deepEqual(logFiles.map((f) => existsSync(f)).sort(), [false, true]);
    // the refused task's reserve may land as a void line; only the settled one counts
    assert.deepEqual((await ledger()).at(-1), ["settle", 1]);
    assert.equal(await remaining(POOL), 0.99);
  });

  // claude-agent-acp sends the stop as an error, or, when the result is not `is_error`, as `max_turn_requests`.
  const stops: [string, (usd: number) => Partial<FakeAgentScript>][] = [
    [
      "error",
      (usd) => ({ error: { code: -32603, message: `Internal error: Reached maximum budget ($${usd})` } }),
    ],
    ["max_turn_requests", () => ({ stopReason: "max_turn_requests" })],
  ];
  for (const [form, stop] of stops) {
    const budgetStop = (usd: number): Partial<FakeAgentScript> => ({
      usageUpdates: [{ used: 1, size: 9, cost: { amount: usd + 0.25, currency: "USD" } }],
      ...stop(usd),
    });

    it(`takes a budget stop (${form}) as a quota outcome when the pool clipped B below the cap`, async () => {
      await appendLedger(line(Date.now(), "old", "settle", 50));
      const { adapters, launched } = await setup({
        script: (lane) => (lane.key === "claude-credits" ? budgetStop(48) : { reply: "sub" }),
      });
      const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
      assert.equal(results[0]?.status, "done");
      assert.equal(results[0]?.reply, "sub");
      assert.deepEqual(results[0]?.notes, ["rerouted from claude-credits:haiku: quota"]);
      assert.deepEqual(
        launched.map((l) => l.id),
        ["claude-credits:haiku", "claude:haiku"],
      );
      assert.deepEqual(await ledger(), [
        ["settle", 50],
        ["reserve", 48],
        ["settle", 48.25],
      ]);
    });

    it(`keeps a budget stop (${form}) at the task cap failed`, async () => {
      const { adapters, launched } = await setup({ script: () => budgetStop(60) });
      const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
      assert.equal(results[0]?.status, "failed");
      assert.deepEqual(
        launched.map((l) => l.id),
        ["claude-credits:haiku"],
      );
      assert.deepEqual(await ledger(), [
        ["reserve", 60],
        ["settle", 60.25],
      ]);
    });
  }

  it("reroutes past a failing key command without its output, reserving nothing", async () => {
    const { adapters, launched, workerLog } = await setup({
      pool: {
        keyCommand: [
          process.execPath,
          "-e",
          "process.stdout.write('sk-out-leak'); process.stderr.write('sk-err-leak'); process.exit(3)",
        ],
      },
    });
    const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(results[0]?.status, "done");
    assert.deepEqual(results[0]?.notes, [`claude-credits key command failed: ${process.execPath} exit 3`]);
    assert.doesNotMatch(JSON.stringify(results), /leak/);
    assert.deepEqual(
      launched.map((l) => l.id),
      ["claude-credits:haiku", "claude:haiku"],
    );
    assert.equal(workerLog(1).apiKey, undefined);
    assert.deepEqual(await ledger(), []);
  });

  it("reroutes to the subscription when the reserve cannot be written", async () => {
    const { adapters, launched, workerLog } = await setup({});
    await appendLedger(line(utc(2020, 1, 1), "old", "settle", 1));
    await chmod(ledgerFile(), 0o444);
    const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(results[0]?.status, "done");
    assert.deepEqual(results[0]?.notes, ["claude-credits ledger write failed: EACCES"]);
    assert.deepEqual(
      launched.map((l) => l.id),
      ["claude-credits:haiku", "claude:haiku"],
    );
    assert.equal(workerLog(1).apiKey, undefined);
  });

  it("keeps the task done with a note when the settle cannot be written", async () => {
    const { adapters, logFiles } = await setup({
      script: () => ({
        sleepMs: 1_000,
        usageUpdates: [{ used: 1, size: 9, cost: { amount: 2, currency: "USD" } }],
      }),
    });
    const pending = delegate({ tasks: tasks(1) }, noAbort(), adapters);
    await untilLogged(logFiles, (log) => log.promptCalled);
    await chmod(ledgerFile(), 0o444);
    const results = await pending;
    assert.equal(results[0]?.status, "done");
    assert.equal(results[0]?.reply, "ok");
    assert.deepEqual(results[0]?.notes, ["claude-credits ledger write failed after the run: EACCES"]);
    assert.deepEqual(await ledger(), [["reserve", 60]]);
  });

  it("an unreadable ledger skips the credit pool alone; the subscription still routes and usage says why", async () => {
    const { adapters, launched } = await setup({});
    await mkdir(join(stateDir(), "ledger"), { recursive: true });
    await appendFile(ledgerFile(), "not json\n");
    const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(results[0]?.status, "done");
    assert.deepEqual(
      launched.map((l) => l.id),
      ["claude:haiku"],
    );
    const text = await usageText(adapters, null);
    assert.match(text, /## claude-credits\nskipped: credit ledger unreadable: /);
    assert.match(text, /pool claude: .* \| ok/);
  });

  it("settles 0 for a credit run that ended before the prompt (model not offered)", async () => {
    const offered: NonNullable<FakeAgentScript["configOptions"]> = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "sonnet",
        options: [{ value: "sonnet", name: "sonnet" }],
      },
    ];
    const { adapters, launched } = await setup({
      setModel: true,
      script: () => ({
        configOptions: offered,
        usageUpdates: [{ used: 1, size: 9, cost: { amount: 2, currency: "USD" } }],
      }),
    });
    const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(results[0]?.status, "done");
    assert.deepEqual(
      launched.map((l) => l.id),
      ["claude-credits:haiku", "claude-credits:sonnet"],
    );
    assert.deepEqual(await ledger(), [
      ["reserve", 60],
      ["settle", 0],
      ["reserve", 60],
      ["settle", 2],
    ]);
    assert.equal(await remaining(POOL), 0.98);
    assert.deepEqual(await readOffered("claude-credits"), ["sonnet"]);
    assert.equal(await readOffered("claude"), undefined);
  });

  it("settles the maximum cost reported, not a lower last one", async () => {
    const { adapters } = await setup({
      script: () => ({
        usageUpdates: [
          { used: 1, size: 9, cost: { amount: 3, currency: "USD" } },
          { used: 2, size: 9, cost: { amount: 0, currency: "USD" } },
        ],
        error: { code: -32603, message: "crashed" },
      }),
    });
    const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(results[0]?.status, "failed");
    assert.deepEqual(await ledger(), [
      ["reserve", 60],
      ["settle", 3],
    ]);
  });

  it("settles 0 for a credit run aborted before its prompt was sent", async () => {
    const { adapters, logFiles } = await setup({ script: () => ({ stallNew: true }) });
    const abort = new AbortController();
    const pending = delegate({ tasks: tasks(1) }, { driver: null, signal: abort.signal }, adapters);
    await untilLogged(logFiles, (log) => log.sessionCalls.includes("new"));
    abort.abort();
    const results = await pending;
    assert.equal(results[0]?.status, "cancelled");
    assert.deepEqual(await ledger(), [
      ["reserve", 60],
      ["settle", 0],
    ]);
  });

  it("settles 0 for a credit resume the agent rejects", async () => {
    const { adapters, launched } = await setup({
      script: () => ({
        advertiseResume: true,
        error: { stage: "session_resume", code: -32603, message: "gone" },
      }),
    });
    const session = await encodeSession({
      agent: "claude",
      key: "claude-credits",
      model: "haiku",
      effort: "medium",
      tier: 1,
      sessionId: "old",
      cwd: dir,
    });
    const results = await delegate(
      { tasks: [{ ...tasks(1)[0], session } as DelegateTask] },
      noAbort(),
      adapters,
    );
    assert.equal(results[0]?.status, "failed");
    assert.equal(launched[0]?.id, "claude-credits:haiku");
    assert.deepEqual(await ledger(), [
      ["reserve", 60],
      ["settle", 0],
    ]);
  });

  it("settles a resume's own spend: the session's saved total is not charged again", async () => {
    // The fake reports the cumulative total, as the SDK does for a resumed session: $4, then $4 + $1.
    const { adapters } = await setup({
      script: (_lane, n) => ({
        advertiseResume: true,
        usageUpdates: [{ used: 1, size: 9, cost: { amount: n === 0 ? 4 : 5, currency: "USD" } }],
      }),
    });
    const [first] = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(first?.costUsd, 4);
    assert.equal((await decodeSession(first?.session ?? ""))?.costUsd, 4);
    const resumed = { ...tasks(1)[0], session: first?.session } as DelegateTask;
    const [second] = await delegate({ tasks: [resumed] }, noAbort(), adapters);
    assert.equal(second?.status, "done");
    assert.equal(second?.costUsd, 1);
    assert.equal((await decodeSession(second?.session ?? ""))?.costUsd, 5);
    assert.deepEqual(await ledger(), [
      ["reserve", 60],
      ["settle", 4],
      ["reserve", 60],
      ["settle", 1],
    ]);
    assert.equal(await remaining(POOL), 0.95);
  });

  it("never routes or reserves on a pool without overageOff", async () => {
    const { pool, adapters, launched } = await setup({});
    const { overageOff: _, ...unconfirmed } = pool;
    await writeAtomic(
      configPath(),
      JSON.stringify({
        version: 1,
        agents: { claude: { consent: true, path: "/fake/bin/claude" } },
        credits: unconfirmed,
      }),
    );
    const results = await delegate({ tasks: tasks(1) }, noAbort(), adapters);
    assert.equal(results[0]?.status, "done");
    assert.deepEqual(
      launched.map((l) => l.id),
      ["claude:haiku"],
    );
    assert.equal(existsSync(ledgerFile()), false);
  });

  it("gives the key only to the credit-lane worker of a batch", async () => {
    const parent = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-parent-env";
    try {
      // The subscription window mirrors the credit cycle, so at 100% left both lanes have the same pace
      // whatever the date and a batch of two spreads over them (the router splits only inside the tie band).
      const { start, end } = cycle(POOL.cycleDay, Date.now());
      const { adapters, launched, workerLog } = await setup({
        claudeLeft: 1,
        claudeWindow: { resetsAt: end, periodHours: (end - start) / H },
      });
      const results = await delegate({ tasks: tasks(2) }, noAbort(), adapters);
      assert.deepEqual(
        results.map((r) => r.status),
        ["done", "done"],
      );
      assert.deepEqual(
        launched.map((l) => l.id),
        ["claude-credits:haiku", "claude:haiku"],
      );
      assert.equal(workerLog(0).apiKey, KEY);
      assert.equal(workerLog(1).apiKey, undefined);
      assert.equal(workerLog(1).sessionMeta, undefined);
      assert.equal(await leaksKey(results), false);
    } finally {
      if (parent === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = parent;
      }
    }
  });

  it("claude launch requires the API key auth on a credit lane and the account otherwise", async () => {
    const lane: Lane = {
      id: "claude:haiku",
      agent: "claude",
      key: "claude",
      tier: 1,
      model: "haiku",
      effort: "low",
    };
    const credit: Lane = {
      ...lane,
      id: "claude-credits:haiku",
      key: "claude-credits",
    };
    assert.deepEqual((await claudeAdapter.launch(lane, dir, "/fake/claude")).requireAuth, {
      kind: "account",
    });
    const spec = await claudeAdapter.launch(credit, dir, "/fake/claude");
    assert.deepEqual(spec.requireAuth, { kind: "api_key", detail: "ANTHROPIC_API_KEY" });
    assert.equal(spec.env.ANTHROPIC_API_KEY, undefined);
  });
});
