import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { workerEnv } from "../acp.ts";
import type {
  AgentAdapter,
  Lane,
  LaneKey,
  LaunchSpec,
  Pool,
  UsageReading,
  Window,
  WorkerFailure,
} from "../types.ts";
import {
  errorMessage,
  firstLine,
  isRecord,
  leadGroup,
  signalChild,
  unreadable,
  versionLine,
} from "../util.ts";
import { window } from "./shared.ts";

const AGY_QUOTA_RE = /quota|limit reached|exhausted|RESOURCE_EXHAUSTED|\b429\b/i;
const AGY_MIN_VERSION = [1, 1, 11] as const;
const AGY_VERSION_TIMEOUT_MS = 3_000;
export const AGY_USAGE_TIMEOUT_MS = 90_000;
const AGY_USAGE_MAX_BYTES = 1024 * 1024;
const BROWSER_GUARD_SCRIPT = "#!/bin/sh\nexit 1\n";
const BROWSER_LAUNCHERS = ["open", "xdg-open"] as const;

export function parseAgyVersion(output: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(firstLine(output));
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionAtLeast(
  version: readonly [number, number, number],
  min: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== min[i]) {
      return version[i] > min[i];
    }
  }
  return true;
}

const errorLine = (err: unknown): string => firstLine(errorMessage(err));

async function installBrowserGuard(): Promise<{ dir: string; launcher: string }> {
  const dir = await mkdtemp(join(tmpdir(), "schmear-agy-usage-"));
  try {
    for (const name of BROWSER_LAUNCHERS) {
      const target = join(dir, name);
      await writeFile(target, BROWSER_GUARD_SCRIPT, "utf8");
      await chmod(target, 0o700);
    }
    return { dir, launcher: join(dir, BROWSER_LAUNCHERS[0]) };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// agy runs in its own process group: a timeout or overflow SIGKILLs the group and settles at once, and
// agy's exit reaps leftovers (detached MCP servers) so a background child cannot hold stdout open.
function runAgyCommand(
  bin: string,
  args: string[],
  opts: { cwd?: string; env: Record<string, string>; timeoutMs: number; label: string },
): Promise<{ stdout?: string; error?: string }> {
  return new Promise((resolve) => {
    const child = leadGroup(
      spawn(bin, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      }),
    );
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const done = (result: { stdout?: string; error?: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const abort = (error: string): void => {
      signalChild(child, "SIGKILL");
      done({ error });
    };

    const timer = setTimeout(
      () => abort(`${opts.label} timed out after ${opts.timeoutMs} ms`),
      opts.timeoutMs,
    );

    child.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > AGY_USAGE_MAX_BYTES) {
        abort(`${opts.label} output exceeded ${AGY_USAGE_MAX_BYTES} bytes`);
        return;
      }
      chunks.push(chunk);
    });

    child.on("error", (err) => {
      done({ error: `${opts.label} failed: ${errorLine(err)}` });
    });

    child.on("close", (code, signal) => {
      if (code !== 0) {
        done({ error: `${opts.label} failed: ${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}` });
        return;
      }
      done({ stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

const AGY_POOLS: Record<string, { id: string; keys: LaneKey[] }> = {
  "Gemini Models": { id: "agy-gemini", keys: ["agy-gemini", "agy-argon"] },
  "Gemini 4 Argon": { id: "agy-argon", keys: ["agy-argon"] },
  "Claude and GPT models": { id: "agy-3p", keys: ["agy-3p"] },
};
const AGY_WINDOWS: Record<string, { kind: Window["kind"]; hours: number }> = {
  weekly: { kind: "period", hours: 168 },
  "5h": { kind: "short", hours: 5 },
};

/** Maps the `agy -p /usage --output-format json` result (R12) to pools; an unreadable result sets `error`. */
export function parseAgyUsage(raw: unknown, now: number): UsageReading {
  const warnings: string[] = [];
  const pools: Pool[] = [];
  const fail = (error: string): UsageReading => unreadable("agy", error, warnings, now);

  if (!isRecord(raw) || raw.status !== "SUCCESS") {
    return fail(`agy /usage did not succeed: status ${JSON.stringify(isRecord(raw) ? raw.status : raw)}`);
  }
  if (raw.num_turns !== 0) {
    return fail(`agy /usage ran model turns: num_turns ${JSON.stringify(raw.num_turns)}`);
  }
  const data = isRecord(raw.command) && isRecord(raw.command.data) ? raw.command.data : null;
  if (!data || !Array.isArray(data.groups)) {
    return fail("agy /usage result has no command.data.groups");
  }

  for (const group of data.groups) {
    if (!isRecord(group) || typeof group.name !== "string" || !Array.isArray(group.buckets)) {
      return fail("agy /usage group is malformed");
    }
    const target = AGY_POOLS[group.name];
    if (!target) {
      warnings.push(`unknown agy usage group "${group.name}"`);
      continue;
    }
    const windows: Window[] = [];
    for (const bucket of group.buckets) {
      if (!isRecord(bucket)) {
        return fail(`agy /usage bucket in "${group.name}" is malformed`);
      }
      if (bucket.disabled === true) {
        continue;
      }
      const spec = typeof bucket.window === "string" ? AGY_WINDOWS[bucket.window] : undefined;
      if (!spec) {
        warnings.push(`unknown agy usage window ${JSON.stringify(bucket.window)} in "${group.name}"`);
        continue;
      }
      const fraction = bucket.remaining_fraction;
      const resetsAt =
        bucket.reset_time === undefined || bucket.reset_time === null
          ? null
          : typeof bucket.reset_time === "string"
            ? Date.parse(bucket.reset_time)
            : Number.NaN;
      if (typeof fraction !== "number" || !Number.isFinite(fraction) || Number.isNaN(resetsAt)) {
        return fail(`agy /usage ${bucket.window} bucket in "${group.name}" has an unreadable value`);
      }
      windows.push(window(100 * (1 - fraction), resetsAt, spec.kind, spec.hours));
    }
    if (windows.length > 0) {
      pools.push({ id: target.id, agent: "agy", keys: target.keys, windows });
    }
  }

  if (pools.length === 0) {
    return fail("agy /usage has no enabled buckets in a known group");
  }
  return { agent: "agy", fetchedAt: now, pools, warnings };
}

/** Never throws; `timeoutMs` exists so the timeout path is testable. */
export async function readAgyUsage(bin: string, timeoutMs = AGY_USAGE_TIMEOUT_MS): Promise<UsageReading> {
  const fail = (error: string): UsageReading => unreadable("agy", error);
  const env = workerEnv({ AGY_CLI_DISABLE_AUTO_UPDATE: "true" });

  const versionRun = await runAgyCommand(bin, ["--version"], {
    env,
    timeoutMs: AGY_VERSION_TIMEOUT_MS,
    label: "agy --version",
  });
  if (versionRun.error !== undefined) {
    return fail(versionRun.error);
  }
  const versionOut = versionRun.stdout ?? "";
  const version = parseAgyVersion(versionOut);
  if (!version) {
    const rawVersion = firstLine(versionOut) || "(empty)";
    return fail(`agy version ${JSON.stringify(rawVersion)} is unreadable; requires agy >= 1.1.11`);
  }
  if (!isVersionAtLeast(version, AGY_MIN_VERSION)) {
    return fail(`agy ${version.join(".")} is below 1.1.11; /usage requires agy >= 1.1.11`);
  }

  let guard: { dir: string; launcher: string };
  try {
    guard = await installBrowserGuard();
  } catch (err) {
    return fail(`agy /usage browser guard failed: ${errorLine(err)}`);
  }

  const pathWithGuard = env.PATH ? `${guard.dir}${delimiter}${env.PATH}` : guard.dir;
  let usageRun: { stdout?: string; error?: string };
  try {
    usageRun = await runAgyCommand(bin, ["-p", "/usage", "--output-format", "json"], {
      cwd: guard.dir,
      env: { ...env, PATH: pathWithGuard, BROWSER: guard.launcher },
      timeoutMs,
      label: "agy /usage",
    });
  } finally {
    await rm(guard.dir, { recursive: true, force: true }).catch(() => {});
  }
  if (usageRun.error !== undefined) {
    return fail(usageRun.error);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(usageRun.stdout ?? "");
  } catch {
    return fail("agy /usage output is not JSON");
  }
  return parseAgyUsage(raw, Date.now());
}

export const agyAdapter: AgentAdapter = {
  id: "agy",

  isClient(clientName: string): boolean {
    return clientName === "antigravity-client";
  },

  async find(bin: string): Promise<{ version: string } | { error: string }> {
    try {
      return { version: await versionLine(bin, workerEnv({ AGY_CLI_DISABLE_AUTO_UPDATE: "true" })) };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  },

  readUsage(bin: string): Promise<UsageReading> {
    return readAgyUsage(bin);
  },

  async launch(lane: Lane, _cwd: string, bin: string): Promise<LaunchSpec> {
    return {
      command: bin,
      args: ["acp"],
      env: workerEnv({ AGY_CLI_DISABLE_AUTO_UPDATE: "true" }),
      config: { model: lane.model, effort: lane.effort },
    };
  },

  classifyFailure(f: WorkerFailure): "quota" | "failed" {
    return AGY_QUOTA_RE.test(f.message) ? "quota" : "failed";
  },
};
