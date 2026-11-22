import { type ChildProcess, execFile } from "node:child_process";
import { constants, readFileSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentId, UsageReading } from "./types.ts";

export const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

export const DETECT_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 5_000;

export const execFileAsync = promisify(execFile);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const firstLine = (text: string): string => text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";

/** First line of `<bin> --version`; rejects when the command fails. */
export async function versionLine(bin: string, env: Record<string, string>): Promise<string> {
  const { stdout } = await execFileAsync(bin, ["--version"], { env, timeout: DETECT_TIMEOUT_MS });
  return firstLine(stdout);
}

/** The first executable file named `name` on PATH. */
export async function findExecutableOnPath(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = resolve(dir, name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // try next PATH entry
    }
  }
  return null;
}

/** A reading with no pools: the agent is skipped (fail closed). */
export const unreadable = (
  agent: AgentId,
  error: string,
  warnings: string[] = [],
  fetchedAt = Date.now(),
): UsageReading => ({ agent, fetchedAt, pools: [], error, warnings });

const groupLeaders = new WeakSet<ChildProcess>();
const liveGroups = new Set<ChildProcess>();
// A detached group gets no signal when schmear exits, so schmear's own exit ends the groups still running.
process.once("exit", () => {
  for (const child of liveGroups) signalChild(child, "SIGKILL");
});

/**
 * Marks a child spawned with `detached: true` as its process group's leader: `signalChild` and `endChild`
 * then signal the whole group, and the leader's exit SIGKILLs whatever it left in the group.
 */
export function leadGroup<T extends ChildProcess>(child: T): T {
  groupLeaders.add(child);
  liveGroups.add(child);
  child.once("exit", () => {
    liveGroups.delete(child);
    signalChild(child, "SIGKILL");
  });
  return child;
}

/** Signals the child, or its whole group when it leads one; a group already gone is ignored. */
export function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!groupLeaders.has(child)) {
    child.kill(signal);
    return;
  }
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // group already gone
  }
}

/** SIGTERM now, SIGKILL after the grace period if the child is still alive. */
export function endChild(child: ChildProcess): void {
  signalChild(child, "SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      signalChild(child, "SIGKILL");
    }
  }, KILL_GRACE_MS).unref();
}
