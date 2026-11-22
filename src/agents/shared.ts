import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Window } from "../types.ts";
import { endChild } from "../util.ts";

export function resolvePackageBin(pkgName: string, binName: string): string {
  const req = createRequire(import.meta.url);
  const pkgPath = req.resolve(`${pkgName}/package.json`);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const relBin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binName];
  if (!relBin) {
    throw new Error(`${pkgName} package.json is missing bin['${binName}']`);
  }
  return join(dirname(pkgPath), relBin);
}

export function window(
  usedPercent: number,
  resetsAt: number | null,
  kind: Window["kind"],
  periodHours: number,
): Window {
  // NaN would pass the router's out check and then empty its tie band, so an unreadable value counts as out.
  if (!Number.isFinite(usedPercent)) {
    return { kind, remaining: 0, resetsAt, periodHours };
  }
  // (100 − used) / 100, not 1 − used / 100: 98% used must give exactly 0.02, or a pool at the floor routes.
  return { kind, remaining: Math.min(1, Math.max(0, (100 - usedPercent) / 100)), resetsAt, periodHours };
}

type Exchange<T> = { status: "reply"; value: T } | { status: "timeout" } | { status: "closed" };

/**
 * Spawns `bin`, writes the `start` lines, and feeds each stdout line to `onLine` until it returns a reply.
 * `onLine` may `send` more lines or throw to fail. Rejects when the spawn fails; the child is always ended
 * with stdin closed, SIGTERM, then SIGKILL if it outlives the grace period.
 */
export function lineExchange<T>(
  bin: string,
  args: string[],
  opts: { env: Record<string, string>; cwd?: string; timeoutMs: number; start: string[] },
  onLine: (line: string, send: (line: string) => void) => { value: T } | undefined,
): Promise<Exchange<T>> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout });
    const send = (line: string): void => {
      child.stdin.write(`${line}\n`);
    };
    let done = false;
    const finish = (outcome: Exchange<T> | Error): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      endChild(child);
      if (outcome instanceof Error) {
        reject(outcome);
      } else {
        resolve(outcome);
      }
    };
    const timer = setTimeout(() => finish({ status: "timeout" }), opts.timeoutMs);
    child.on("error", finish);
    child.on("close", () => finish({ status: "closed" }));
    child.stdin.on("error", () => {}); // child gone early: the close event reports it
    lines.on("line", (line) => {
      try {
        const reply = onLine(line, send);
        if (reply) {
          finish({ status: "reply", value: reply.value });
        }
      } catch (err) {
        finish(err as Error);
      }
    });
    for (const line of opts.start) {
      send(line);
    }
  });
}
