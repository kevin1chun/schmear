import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { window } from "../src/agents/shared.ts";
import { type PoolRow, route } from "../src/router.ts";
import { agentOf, candidates, DEFAULT_TIERS, parseTiers } from "../src/tiers.ts";
import type { AgentId, Config, Lane, LaneKey, Pool, UsageReading, Window } from "../src/types.ts";

const NOW = Date.UTC(2026, 10, 21);
const H = 3.6e6;
const DEFAULT = parseTiers(DEFAULT_TIERS);

const lane = (key: LaneKey, model: string, tier = 1, effort = "medium"): Lane => ({
  id: `${key}:${model}`,
  agent: agentOf(key),
  key,
  tier,
  model,
  effort,
});
/** Tier 1 on claude and codex, model "m": equal tiers so only pace and driver decide. */
const FLAT: Lane[] = [lane("claude", "m"), lane("codex", "m")];

const week = (remaining: number, hours: number): Window => ({
  kind: "period",
  remaining,
  resetsAt: NOW + hours * H,
  periodHours: 168,
});
const short = (remaining: number): Window => ({
  kind: "short",
  remaining,
  resetsAt: NOW + 3 * H,
  periodHours: 5,
});
const pool = (agent: AgentId, windows: Window[], extra: Partial<Pool> = {}): Pool => ({
  id: agent,
  agent,
  keys: [agent as Pool["keys"][number]],
  windows,
  ...extra,
});
const reading = (agent: AgentId, ...pools: Pool[]): UsageReading => ({
  agent,
  fetchedAt: NOW,
  pools,
  warnings: [],
});
const config = (...agents: AgentId[]): Config => ({
  version: 1,
  agents: Object.fromEntries(agents.map((a) => [a, { consent: true, path: `/bin/${a}`, overageOff: true }])),
});

function run(o: {
  readings: UsageReading[];
  driver?: AgentId | null;
  config?: Config;
  exclude?: string[];
  tasks?: Lane[][];
}) {
  const r = route({
    now: NOW,
    driver: o.driver ?? null,
    readings: o.readings,
    config: o.config ?? config(...o.readings.map((x) => x.agent)),
    exclude: new Set(o.exclude),
    tasks: o.tasks ?? [FLAT],
  });
  return { ids: r.assignments.map((l) => l?.id ?? null), pools: r.pools };
}
const rowOf = (pools: PoolRow[], id: string) => pools.find((p) => p.id === id);
/** The threshold a row's pace implies: pace = (remaining − threshold) × scale. */
const thresholdOf = (r: PoolRow | undefined, remaining: number, scale: number) =>
  Math.round((remaining - (r?.pace ?? Number.NaN) / scale) * 1e6) / 1e6;

describe("route: pools", () => {
  it("a weekly pool gives usable × 168 / hours_left", () => {
    // usable = remaining − 0.05 driver reserve
    const { pools } = run({
      driver: "claude",
      readings: [reading("claude", pool("claude", [short(0.8), week(0.5, 84)]))],
    });
    const r = rowOf(pools, "claude");
    assert.equal(r?.status, "ok");
    assert.ok(Math.abs((r?.pace ?? 0) - (0.45 * 168) / 84) < 1e-9);
  });

  it("the reserve applies only to the driver's pools and is waived at hoursLeft ≤ 2", () => {
    const readings = [
      reading("claude", pool("claude", [week(0.5, 2.5)])),
      reading("codex", pool("codex", [week(0.5, 2.5)])),
    ];
    const threshold = (driver: AgentId | null, rs = readings) =>
      Object.fromEntries(
        run({ driver, readings: rs }).pools.map((p) => [p.id, thresholdOf(p, 0.5, 168 / 2.5)]),
      );
    assert.deepEqual(threshold("claude"), { claude: 0.05, codex: 0.02 });
    assert.deepEqual(threshold("codex"), { claude: 0.02, codex: 0.05 });
    assert.deepEqual(threshold(null), { claude: 0.02, codex: 0.02 });
    const waived = run({ driver: "claude", readings: [reading("claude", pool("claude", [week(0.5, 2)]))] });
    assert.equal(thresholdOf(rowOf(waived.pools, "claude"), 0.5, 168 / 2), 0.02);
  });

  it("reserve.claude: 0.2 outs a 15% Claude pool when Claude drives and not when Codex drives", () => {
    const readings = [reading("claude", pool("claude", [week(0.15, 100)]))];
    const cfg: Config = { ...config("claude"), reserve: { claude: 0.2 } };
    const whenClaude = run({ driver: "claude", readings, config: cfg });
    assert.deepEqual(whenClaude.ids, [null]);
    assert.match(String(rowOf(whenClaude.pools, "claude")?.status), /^out: /);
    const whenCodex = run({ driver: "codex", readings, config: cfg });
    assert.deepEqual(whenCodex.ids, ["claude:m"]);
    assert.equal(rowOf(whenCodex.pools, "claude")?.status, "ok");
  });

  it("reserve.claude: 0 leaves the floor", () => {
    const cfg: Config = { ...config("claude"), reserve: { claude: 0 } };
    const at = (remaining: number) =>
      run({
        driver: "claude",
        readings: [reading("claude", pool("claude", [week(remaining, 100)]))],
        config: cfg,
      });
    assert.deepEqual(at(0.02).ids, [null]);
    assert.match(String(rowOf(at(0.02).pools, "claude")?.status), /^out: /);
    const ok = at(0.03);
    assert.deepEqual(ok.ids, ["claude:m"]);
    assert.equal(thresholdOf(rowOf(ok.pools, "claude"), 0.03, 1.68), 0.02);
  });

  it("the floor holds in the waiver window", () => {
    const at = (remaining: number) =>
      run({ driver: "claude", readings: [reading("claude", pool("claude", [week(remaining, 1)]))] });
    assert.match(String(rowOf(at(0.02).pools, "claude")?.status), /^out: /);
    assert.deepEqual(at(0.02).ids, [null]);
    assert.deepEqual(at(0.03).ids, ["claude:m"]);
  });

  it("a 5 h window at 2% outs the pool", () => {
    const { ids, pools } = run({
      readings: [reading("claude", pool("claude", [short(0.02), week(0.9, 100)]))],
    });
    assert.equal(rowOf(pools, "claude")?.pace, null);
    assert.match(String(rowOf(pools, "claude")?.status), /^out: short window/);
    assert.deepEqual(ids, [null]);
  });

  it("a 30-day window (R13 shape)", () => {
    // usedPercent 83, windowDurationMins 43200, reset in 240 h
    const w: Window = { kind: "period", remaining: 0.17, resetsAt: NOW + 240 * H, periodHours: 720 };
    const r = rowOf(run({ readings: [reading("codex", pool("codex", [w]))] }).pools, "codex");
    assert.ok(Math.abs((r?.pace ?? 0) - (0.15 * 720) / 240) < 1e-9);
  });

  it("a window past its reset reads as full", () => {
    const w: Window = { kind: "period", remaining: 0, resetsAt: NOW - H, periodHours: 168 };
    const r = rowOf(run({ readings: [reading("claude", pool("claude", [w]))] }).pools, "claude");
    assert.ok(Math.abs((r?.pace ?? 0) - 0.98) < 1e-9);
  });

  it("a window resetting exactly at now reads as full", () => {
    const w: Window = { kind: "period", remaining: 0, resetsAt: NOW, periodHours: 168 };
    const r = rowOf(run({ readings: [reading("claude", pool("claude", [w]))] }).pools, "claude");
    assert.ok(Math.abs((r?.pace ?? 0) - 0.98) < 1e-9);
  });

  it("the driver's reserve holds on the period window only: a short window at 4% still routes", () => {
    const { ids, pools } = run({
      driver: "claude",
      readings: [reading("claude", pool("claude", [short(0.04), week(0.5, 100)]))],
    });
    assert.equal(rowOf(pools, "claude")?.status, "ok");
    assert.deepEqual(ids, ["claude:m"]);
  });

  it("the driver's reserve skips the pool of config.credits", () => {
    const creditPool = pool("claude", [week(0.5, 100)], { id: "claude-credits", keys: ["claude-credits"] });
    const threshold = (credits: Config["credits"]) =>
      thresholdOf(
        rowOf(
          run({
            driver: "claude",
            readings: [reading("claude", creditPool)],
            config: { ...config("claude"), credits },
          }).pools,
          "claude-credits",
        ),
        0.5,
        1.68,
      );
    const cfg = {
      grantUsd: 100,
      cycleDay: 1,
      keyCommand: ["true"],
      taskCapUsd: 10,
      overageOff: true as const,
    };
    assert.equal(threshold(cfg), 0.02);
    assert.equal(threshold(undefined), 0.05);
  });
});

describe("route: candidates", () => {
  const claude = (...extra: Pool[]) => reading("claude", pool("claude", [week(0.6, 100)]), ...extra);

  it("seven_day_opus at 0 outs claude:opus but not claude:sonnet", () => {
    const opus = pool("claude", [week(0, 100)], { id: "claude-opus", models: ["opus"] });
    const { ids } = run({
      readings: [claude(opus)],
      tasks: [candidates(3, DEFAULT, {}), candidates(2, DEFAULT, {})],
    });
    assert.deepEqual(ids, ["claude:fable", "claude:sonnet"]);
  });

  it("an unknown-model Claude window bounds every Claude lane", () => {
    const unknown = pool("claude", [week(0.01, 100)], { id: "claude-mystery" });
    const { ids } = run({
      readings: [claude(unknown)],
      tasks: [candidates(1, DEFAULT, {}), candidates(2, DEFAULT, {}), candidates(4, DEFAULT, {})],
    });
    assert.deepEqual(ids, [null, null, null]);
  });

  it("agy-argon takes the minimum of two pools", () => {
    const lanes = [lane("agy-argon", "argon"), lane("codex", "m")];
    const agy = (gemini: number, argon: number) =>
      reading(
        "agy",
        pool("agy", [week(gemini, 100)], { id: "agy-gemini", keys: ["agy-gemini", "agy-argon"] }),
        pool("agy", [week(argon, 100)], { id: "agy-argon", keys: ["agy-argon"] }),
      );
    const codex = reading("codex", pool("codex", [week(0.5, 100)]));
    assert.deepEqual(run({ tasks: [lanes], readings: [agy(0.9, 0.2), codex] }).ids, ["codex:m"]);
    assert.deepEqual(run({ tasks: [lanes], readings: [agy(0.2, 0.9), codex] }).ids, ["codex:m"]);
    assert.deepEqual(run({ tasks: [lanes], readings: [agy(0.9, 0.8), codex] }).ids, ["agy-argon:argon"]);
  });

  it("a tier-2 task never gets a tier-1 lane", () => {
    const { ids } = run({ readings: [claude()], tasks: [candidates(2, DEFAULT, {})] });
    assert.deepEqual(ids, ["claude:sonnet"]);
  });

  it("in the band the exact tier beats a higher tier with more pace; outside it pace wins", () => {
    const lanes = [lane("claude", "hi", 3), lane("codex", "ex", 2)];
    const at = (claudeLeft: number) =>
      run({
        tasks: [lanes],
        readings: [
          reading("claude", pool("claude", [week(claudeLeft, 100)])),
          reading("codex", pool("codex", [week(0.5, 100)])),
        ],
      }).ids;
    assert.deepEqual(at(0.51), ["codex:ex"]);
    assert.deepEqual(at(0.6), ["claude:hi"]);
  });

  it("the driver's lane sorts after another provider's in the band", () => {
    const readings = [
      reading("claude", pool("claude", [week(0.53, 1)])),
      reading("codex", pool("codex", [week(0.52, 1)])),
    ];
    assert.deepEqual(run({ readings, driver: "claude" }).ids, ["codex:m"]);
    assert.deepEqual(run({ readings, driver: null }).ids, ["claude:m"]);
  });
});

describe("route: removals", () => {
  const readings = [
    reading("claude", pool("claude", [week(0.3, 100)])),
    reading("codex", pool("codex", [week(0.9, 100)])),
  ];

  it("codex leads when nothing removes it", () => {
    assert.deepEqual(run({ readings }).ids, ["codex:m"]);
  });

  it("missing consent", () => {
    const c = config("claude", "codex");
    c.agents.codex = { consent: false, path: "/bin/codex", overageOff: true };
    const { ids, pools } = run({ readings, config: c });
    assert.deepEqual(ids, ["claude:m"]);
    assert.equal(rowOf(pools, "codex")?.status, "skipped: no consent");
    assert.equal(rowOf(pools, "codex")?.pace, null);
  });

  it("missing overageOff", () => {
    const c = config("claude", "codex");
    c.agents.codex = { consent: true, path: "/bin/codex" };
    assert.deepEqual(run({ readings, config: c }).ids, ["claude:m"]);
  });

  it("an error reading", () => {
    const err: UsageReading = { ...reading("codex"), error: "codex app-server timed out" };
    const { ids, pools } = run({ readings: [readings[0] as UsageReading, err] });
    assert.deepEqual(ids, ["claude:m"]);
    assert.equal(rowOf(pools, "codex")?.status, "skipped: codex app-server timed out");
  });

  it("exclude by lane id and by lane key", () => {
    assert.deepEqual(run({ readings, exclude: ["codex:m"] }).ids, ["claude:m"]);
    assert.deepEqual(run({ readings, exclude: ["codex"] }).ids, ["claude:m"]);
  });

  it("empty candidate list gives null", () => {
    const { ids } = run({ readings, tasks: [[], [lane("claude", "m")]] });
    assert.deepEqual(ids, [null, "claude:m"]);
  });
});

describe("route: batch split", () => {
  it("a batch of 3 over 3 disjoint-pool band lanes gets 3 distinct lanes", () => {
    const lanes = [lane("claude", "m"), lane("codex", "m"), lane("grok", "m")];
    const readings = [
      reading("claude", pool("claude", [week(0.51, 100)])),
      reading("codex", pool("codex", [week(0.52, 100)])),
      reading("grok", pool("grok", [week(0.5, 100)])),
    ];
    const { ids } = run({ readings, tasks: [lanes, lanes, lanes] });
    assert.deepEqual(ids, ["codex:m", "claude:m", "grok:m"]);
  });

  it("a lane at pace < best × 0.95 gets no batch task", () => {
    // codex pace 0.50*1.68 = 0.84; 0.84 * 0.95 = 0.798; claude pace 0.47*1.68 = 0.7896 < 0.798
    const readings = [
      reading("claude", pool("claude", [week(0.49, 100)])),
      reading("codex", pool("codex", [week(0.52, 100)])),
    ];
    const { ids } = run({ readings, tasks: [FLAT, FLAT, FLAT] });
    assert.deepEqual(ids, ["codex:m", "codex:m", "codex:m"]);
  });

  it("a lane exactly at best × 0.95 is in the band", () => {
    // At 84 h: codex pace (0.52 − 0.02) × 168 / 84 = 1, claude (0.495 − 0.02) × 168 / 84 = 0.95 exactly in floats.
    const readings = [
      reading("claude", pool("claude", [week(0.495, 84)])),
      reading("codex", pool("codex", [week(0.52, 84)])),
    ];
    const { ids } = run({ readings, tasks: [FLAT, FLAT] });
    assert.deepEqual(ids, ["codex:m", "claude:m"]);
  });

  it("with claude:haiku, claude:sonnet (one pool) and grok:grok-4.7 in the band, a batch of 3 gets haiku, grok, haiku", () => {
    const lanes = [lane("claude", "haiku", 1), lane("claude", "sonnet", 2), lane("grok", "grok-4.7", 1)];
    const readings = [
      reading("claude", pool("claude", [week(0.5, 100)])),
      reading("grok", pool("grok", [week(0.5, 100)])),
    ];
    const { ids } = run({ readings, tasks: [lanes, lanes, lanes] });
    assert.deepEqual(ids, ["claude:haiku", "grok:grok-4.7", "claude:haiku"]);
  });

  it("two tier-1 tasks when the Claude pool leads never split onto another Claude model", () => {
    const t1 = candidates(1, DEFAULT, {});
    const { ids } = run({
      readings: [reading("claude", pool("claude", [week(0.9, 100)]))],
      tasks: [t1, t1],
    });
    assert.deepEqual(ids, ["claude:haiku", "claude:haiku"]);
  });

  it("tasks at different tiers alternate across disjoint pools in the band", () => {
    const readings = [
      reading("codex", pool("codex", [window(50, NOW + 100 * H, "period", 168)])),
      reading("claude", pool("claude", [window(49, NOW + 100 * H, "period", 168)])),
    ];
    const { ids } = run({
      readings,
      tasks: [candidates(1, DEFAULT, {}), candidates(2, DEFAULT, {})],
    });
    assert.deepEqual(ids, ["claude:haiku", "codex:gpt-5.6-terra"]);
  });
});

describe("route: thresholds through window()", () => {
  const single = (w: Window, driver: AgentId | null = null) => {
    const r = run({ driver, readings: [reading("claude", pool("claude", [w]))] });
    return { id: r.ids[0], status: rowOf(r.pools, "claude")?.status };
  };

  it("98% used is at the floor: out on a short window, a weekly, and a weekly in the waiver window", () => {
    for (const [w, driver] of [
      [window(98, NOW + 3 * H, "short", 5), null],
      [window(98, NOW + 100 * H, "period", 168), null],
      [window(98, NOW + H, "period", 168), "claude"],
    ] as const) {
      const r = single(w, driver);
      assert.equal(r.id, null);
      assert.match(String(r.status), /^out: /);
    }
  });

  it("95% used is at the driver reserve: out", () => {
    const r = single(window(95, NOW + 100 * H, "period", 168), "claude");
    assert.equal(r.id, null);
    assert.match(String(r.status), /^out: /);
  });

  it("a pool with no window is out", () => {
    const { ids, pools } = run({
      readings: [reading("claude", pool("claude", [])), reading("codex", pool("codex", [week(0.3, 100)]))],
    });
    assert.deepEqual(ids, ["codex:m"]);
    assert.equal(rowOf(pools, "claude")?.status, "out: no window");
  });
});

describe("route: own pool", () => {
  it("an agy-argon lane is not eligible when the reading has no agy-argon pool", () => {
    const gemini = pool("agy", [week(0.9, 100)], { id: "agy-gemini", keys: ["agy-gemini", "agy-argon"] });
    const agyLanes = candidates(1, DEFAULT, {}).filter((l) => l.agent === "agy");
    const { ids } = run({
      readings: [reading("agy", gemini)],
      exclude: ["agy-gemini:gemini-4-hydrogen"],
      tasks: [agyLanes],
    });
    assert.deepEqual(ids, [null]);
  });
});
