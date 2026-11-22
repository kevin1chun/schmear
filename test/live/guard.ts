import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adapters } from "../../src/agents/index.ts";
import type { AgentId, Config } from "../../src/types.ts";
import { findExecutableOnPath } from "../../src/util.ts";

const MIN_REMAINING = 0.05;

// SCHMEAR_LIVE_OVERAGE_OFF=codex,agy lists the agents whose overage the user confirmed off;
// SCHMEAR_LIVE_GROK=1 includes grok (its usage read opens ~/.grok/auth.json).
const overageOff = () => new Set((process.env.SCHMEAR_LIVE_OVERAGE_OFF ?? "").split(",").filter(Boolean));

/** The agent's binary on PATH and its detected version, or why detection failed. */
export async function detect(agent: AgentId): Promise<{ path: string; version: string } | { error: string }> {
  const path = await findExecutableOnPath(agent);
  if (!path) return { error: `${agent} not found on PATH` };
  const found = await adapters[agent].find(path);
  return "error" in found ? found : { path, ...found };
}

/**
 * Writes `<parent>/config/schmear/config.json` consenting every installed agent (grok only with
 * SCHMEAR_LIVE_GROK=1), `overageOff` only for the confirmed ones, merged with `extra`.
 * `configHome` is the XDG_CONFIG_HOME to point at.
 */
export async function liveConfig(
  parent: string,
  extra: Partial<Config> = {},
): Promise<{ configHome: string; config: Config }> {
  const off = overageOff();
  const agents: Config["agents"] = {};
  for (const adapter of Object.values(adapters)) {
    if (adapter.id === "grok" && process.env.SCHMEAR_LIVE_GROK !== "1") continue;
    const found = await detect(adapter.id);
    if ("error" in found) continue;
    agents[adapter.id] = {
      consent: true,
      path: found.path,
      ...(off.has(adapter.id) ? { overageOff: true as const } : {}),
    };
  }
  const config: Config = { ...extra, version: 1, agents };
  const configHome = join(parent, "config");
  mkdirSync(join(configHome, "schmear"), { recursive: true });
  writeFileSync(join(configHome, "schmear", "config.json"), JSON.stringify(config));
  return { configHome, config };
}

const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;

/** Money guard: a skip reason, or null when every window of every pool of the agent is above 5% remaining. `log` gets the usage checked. */
export async function guard(agent: AgentId, log: (line: string) => void = () => {}): Promise<string | null> {
  const adapter = adapters[agent];
  const found = await detect(agent);
  if ("error" in found) return `${agent} failed detection: ${found.error}`;
  // Grok's usage read opens ~/.grok/auth.json: only the user opts in to that.
  if (agent === "grok" && process.env.SCHMEAR_LIVE_GROK !== "1")
    return "grok left out (set SCHMEAR_LIVE_GROK=1)";
  if (agent !== "claude" && !overageOff().has(agent)) {
    return `${agent} overage not confirmed off (set SCHMEAR_LIVE_OVERAGE_OFF)`;
  }
  const reading = await adapter.readUsage(found.path);
  if (reading.error) return `${agent} usage unreadable: ${reading.error}`;
  for (const pool of reading.pools) {
    if (pool.windows.length === 0) return `${agent} pool ${pool.id} has no window`;
    log(`${pool.id}: ${pool.windows.map((w) => `${w.kind} ${pct(w.remaining)}`).join(", ")}`);
    for (const w of pool.windows) {
      if (w.remaining <= MIN_REMAINING) {
        return `${agent} pool ${pool.id} ${w.kind} window at ${pct(w.remaining)} remaining`;
      }
    }
  }
  return null;
}
