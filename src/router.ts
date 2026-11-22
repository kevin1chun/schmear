import type { AgentId, Config, Lane, Pool, UsageReading } from "./types.ts";

export const FLOOR = 0.02;
const RESERVE = 0.05;
const WAIVER_H = 2;
const TIE = 0.05;
const MIN_H = 0.1;

export interface PoolRow {
  id: string;
  agent: AgentId;
  pace: number | null;
  status: "ok" | `out: ${string}` | `skipped: ${string}`;
}

/** Every agent but Claude has an overage setting schmear cannot read, so its owner confirms it off (§12). */
export const needsOverageOff = (agent: AgentId): agent is Exclude<AgentId, "claude"> => agent !== "claude";

const pct = (x: number) => `${Math.round(x * 100)}%`;

function skipReason(r: UsageReading, config: Config): string | undefined {
  const a = config.agents[r.agent];
  if (!a?.consent) return "no consent";
  if (needsOverageOff(r.agent) && !a.overageOff) return "overage not confirmed off";
  return r.error;
}

function poolRow(pool: Pool, now: number, driver: AgentId | null, credit: boolean, reserve: number): PoolRow {
  let out = pool.windows.length === 0 ? "no window" : undefined;
  let pace = Infinity;
  let periodPace = Infinity;
  for (const w of pool.windows) {
    const [remaining, resetsAt] =
      w.resetsAt !== null && w.resetsAt <= now ? [1, null] : [w.remaining, w.resetsAt];
    const hoursLeft = resetsAt !== null ? (resetsAt - now) / 3.6e6 : w.periodHours;
    const threshold =
      w.kind === "period" && pool.agent === driver && !credit && hoursLeft > WAIVER_H ? reserve : FLOOR;
    if (remaining - threshold <= 0)
      out ??= `${w.kind} window ${pct(remaining)} left, threshold ${pct(threshold)}`;
    const p = ((remaining - threshold) * w.periodHours) / Math.max(hoursLeft, MIN_H);
    pace = Math.min(pace, p);
    if (w.kind === "period") periodPace = Math.min(periodPace, p);
  }
  if (out) return { id: pool.id, agent: pool.agent, pace: null, status: `out: ${out}` };
  return {
    id: pool.id,
    agent: pool.agent,
    pace: periodPace < Infinity ? periodPace : pace,
    status: "ok",
  };
}

type Scored = { lane: Lane; pace: number; pools: Set<string> };

function pick(lanes: Scored[], driver: AgentId | null, load: (l: Scored) => number): Scored | undefined {
  if (lanes.length === 0) return undefined;
  const best = Math.max(...lanes.map((l) => l.pace));
  const band = lanes.filter((l) => l.pace >= best * (1 - TIE));
  band.sort(
    (a, b) =>
      load(a) - load(b) ||
      a.lane.tier - b.lane.tier ||
      Number(b.lane.agent !== driver) - Number(a.lane.agent !== driver) ||
      b.pace - a.pace ||
      (a.lane.id < b.lane.id ? -1 : a.lane.id > b.lane.id ? 1 : 0),
  );
  return band[0];
}

/** Pure: assigns each task the lane whose pools most need spending (§9.2). */
export function route(input: {
  now: number;
  driver: AgentId | null;
  readings: UsageReading[];
  config: Config;
  exclude: Set<string>; // lane ids or lane keys
  tasks: Lane[][]; // per task, its candidate lanes in candidates() order
}): { assignments: (Lane | null)[]; pools: PoolRow[] } {
  const { now, driver, readings, config } = input;
  const pools: PoolRow[] = [];
  const usable: { pool: Pool; pace: number | null }[] = [];
  for (const r of readings) {
    const skip = skipReason(r, config);
    if (r.pools.length === 0 && skip) {
      pools.push({ id: r.agent, agent: r.agent, pace: null, status: `skipped: ${skip}` });
    }
    for (const p of r.pools) {
      const credit = config.credits !== undefined && p.id === "claude-credits";
      const reserve = Math.max(config.reserve?.[p.agent] ?? RESERVE, FLOOR);
      const row = poolRow(p, now, driver, credit, reserve);
      if (skip) {
        pools.push({ ...row, pace: null, status: `skipped: ${skip}` });
      } else {
        pools.push(row);
        usable.push({ pool: p, pace: row.pace });
      }
    }
  }

  const counts = new Map<string, number>(); // assignments per pool id in this call
  const load = (l: Scored) => Math.max(...[...l.pools].map((id) => counts.get(id) ?? 0));
  const assignments = input.tasks.map((candidates) => {
    const eligible: Scored[] = [];
    for (const lane of candidates) {
      if (input.exclude.has(lane.id) || input.exclude.has(lane.key)) continue;
      const own = usable.filter(
        ({ pool: p }) =>
          p.agent === lane.agent && p.keys.includes(lane.key) && (!p.models || p.models.includes(lane.model)),
      );
      const paces = own.flatMap((u) => (u.pace === null ? [] : [u.pace]));
      // A lane needs its own pool; shared pools alone (agy-gemini for agy-argon) do not make it eligible.
      if (!own.some((u) => u.pool.id === lane.key) || paces.length < own.length) continue;
      eligible.push({ lane, pace: Math.min(...paces), pools: new Set(own.map((u) => u.pool.id)) });
    }
    const chosen = pick(eligible, driver, load);
    if (!chosen) return null;
    for (const id of chosen.pools) counts.set(id, (counts.get(id) ?? 0) + 1);
    return chosen.lane;
  });
  return { assignments, pools };
}
