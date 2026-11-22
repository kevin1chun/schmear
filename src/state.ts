import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parseTiers } from "./tiers.ts";
import {
  AGENT_IDS,
  type AgentId,
  type Config,
  type CreditPoolConfig,
  type LaneKey,
  type UsageReading,
} from "./types.ts";
import { errorMessage, isRecord } from "./util.ts";

export const USAGE_SHOW_MS = 60_000; // the usage tool and init
export const USAGE_ROUTE_MS = 300_000; // delegate routing
const OFFERED_TTL_MS = 24 * 3_600_000;
const AGENT_ID_SET: ReadonlySet<string> = new Set(AGENT_IDS);

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "schmear");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "schmear", "config.json");
}

/**
 * `mode` keeps a rewritten host config's permissions (it can hold secrets); schmear's own files default to 0600 and
 * the directories it creates to 0700. Renames onto the symlink's target, so a dotfile manager's symlink stays a symlink.
 */
export async function writeAtomic(path: string, data: string, mode = 0o600): Promise<void> {
  const target = await realpath(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      return path;
    }
    throw err;
  });
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, target);
}

function usagePath(agent: AgentId): string {
  return join(stateDir(), "usage", `${agent}.json`);
}

/** The cached reading when younger than maxAgeMs (a failed one at most USAGE_SHOW_MS), else read() cached (failed ones too); 0 always reads. */
export async function usage(
  agent: AgentId,
  read: () => Promise<UsageReading>,
  maxAgeMs: number,
  now = Date.now(),
): Promise<UsageReading> {
  if (maxAgeMs > 0) {
    try {
      const cached = JSON.parse(await readFile(usagePath(agent), "utf8")) as UsageReading;
      // A failed reading never routes, so no quota outcome would reread it.
      const maxAge = cached.error === undefined ? maxAgeMs : Math.min(maxAgeMs, USAGE_SHOW_MS);
      if (now - cached.fetchedAt < maxAge) {
        return cached;
      }
    } catch {
      // missing or unreadable cache: reread
    }
  }
  const reading = await read();
  await writeAtomic(usagePath(agent), JSON.stringify(reading));
  return reading;
}

function offeredPath(key: LaneKey): string {
  return join(stateDir(), "offered", `${key}.json`);
}

/** The models the lane key offered at its last run; undefined when unknown or older than 24 h. */
export async function readOffered(key: LaneKey, now = Date.now()): Promise<string[] | undefined> {
  try {
    const { fetchedAt, models } = JSON.parse(await readFile(offeredPath(key), "utf8")) as {
      fetchedAt: number;
      models: string[];
    };
    return now - fetchedAt < OFFERED_TTL_MS ? models : undefined;
  } catch {
    return undefined;
  }
}

export async function writeOffered(key: LaneKey, models: string[], now = Date.now()): Promise<void> {
  await writeAtomic(offeredPath(key), JSON.stringify({ fetchedAt: now, models }));
}

const AgentConfigSchema = z.object({
  consent: z.boolean(),
  path: z.string().min(1),
  overageOff: z.literal(true).optional(), // required for codex, grok, agy
});

/** ~/.config/schmear/config.json. `credits` is checked only as an object here: an invalid pool skips only its lane (§13). */
export const ConfigSchema = z
  .strictObject({
    version: z.literal(1),
    agents: z.partialRecord(z.enum(AGENT_IDS), AgentConfigSchema),
    tiers: z.custom<string[][]>().optional(), // replaces DEFAULT_TIERS whole (§9.1)
    reserve: z.custom<Partial<Record<AgentId, number>>>().optional(), // per-driver reserve fraction (§9.2)
    credits: z
      .custom<CreditPoolConfig>((v) => isRecord(v) && !Array.isArray(v), "must be an object")
      .optional(), // §13
  })
  .superRefine(({ tiers, reserve }, ctx) => {
    // Root-level issues, so their messages print without a path prefix.
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (tiers !== undefined) {
      try {
        parseTiers(tiers);
      } catch (err) {
        fail(errorMessage(err));
      }
    }
    if (reserve === undefined) return;
    if (!isRecord(reserve) || Array.isArray(reserve)) return fail("reserve must be an object");
    for (const [id, value] of Object.entries(reserve)) {
      if (!AGENT_ID_SET.has(id)) return fail(`reserve: unknown agent "${id}"`);
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) {
        return fail(`reserve.${id} must be a fraction from 0 to 1, e.g. 0.05 for 5%`);
      }
    }
  });

export async function readConfig(): Promise<Config> {
  const path = configPath();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, agents: {} };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`malformed config ${path}: ${errorMessage(err)}`);
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const [issue] = result.error.issues;
    const at = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    throw new Error(`malformed config ${path}: ${at}${issue.message}`);
  }
  return result.data;
}
