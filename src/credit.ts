import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { budgetStopped, creditExhausted, creditSpec } from "./agents/claude.ts";
import { FLOOR } from "./router.ts";
import { stateDir } from "./state.ts";
import type { CreditPoolConfig, LaunchSpec, UsageReading, WorkerRun } from "./types.ts";
import { errorMessage, execFileAsync } from "./util.ts";

const LedgerLineSchema = z.object({
  at: z.number(),
  taskId: z.string().min(1),
  kind: z.enum(["reserve", "settle", "exhausted"]),
  usd: z.number().min(0),
});
export type LedgerLine = z.infer<typeof LedgerLineSchema>;

/** The pool's id and lane key; `credits` in the config is the only credit pool. */
const ID = "claude-credits";

const ledgerPath = (): string => join(stateDir(), "ledger", `${ID}.jsonl`);

/** One `O_APPEND` write per line, so every reader sees the same line order. */
export async function appendLedger(line: LedgerLine): Promise<void> {
  await mkdir(dirname(ledgerPath()), { recursive: true, mode: 0o700 });
  await appendFile(ledgerPath(), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

/** Line `n` (1-based) parsed, or a throw naming the first invalid field. */
function ledgerLine(text: string, n: number): LedgerLine {
  let l: unknown;
  try {
    l = JSON.parse(text);
  } catch {
    throw new Error(`ledger line ${n}: not JSON`);
  }
  const result = LedgerLineSchema.safeParse(l);
  if (!result.success)
    throw new Error(`ledger line ${n}: ${String(result.error.issues[0].path[0] ?? "not an object")}`);
  return result.data;
}

/** Complete lines only (one still being written is skipped); an invalid complete line throws. */
export async function readLedger(): Promise<LedgerLine[]> {
  let text: string;
  try {
    text = await readFile(ledgerPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const end = text.lastIndexOf("\n");
  return end < 0
    ? []
    : text
        .slice(0, end)
        .split("\n")
        .map((l, i) => ledgerLine(l, i + 1));
}

/** The billing cycle holding `now`: midnight UTC on `cycleDay`, clamped to each month's last day. */
export function cycle(cycleDay: number, now: number): { start: number; end: number } {
  const at = (y: number, m: number) =>
    Date.UTC(y, m, Math.min(cycleDay, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()));
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = at(y, d.getUTCMonth()) > now ? d.getUTCMonth() - 1 : d.getUTCMonth();
  return { start: at(y, m), end: at(y, m + 1) };
}

/**
 * Replays ledger lines in file order. A reserve is valid only if it fits above the floor given the lines before it;
 * an invalid one is void. So every process agrees on the outcome without a lock. `carried`: reservations still open
 * at the end of the previous cycle, counted against this one. `open`: the reservations made in `lines` and not
 * settled, so a reservation is carried across one boundary at most.
 */
export function replay(
  lines: LedgerLine[],
  grantUsd: number,
  carried: Map<string, number>,
): { left: number; open: Map<string, number> } {
  let left = grantUsd;
  for (const usd of carried.values()) left -= usd;
  const held = new Map(carried);
  const open = new Map<string, number>();
  let exhausted = false;
  for (const l of lines) {
    if (l.kind === "reserve") {
      if (!exhausted && l.usd > 0 && l.usd <= left - FLOOR * grantUsd) {
        left -= l.usd;
        held.set(l.taskId, l.usd);
        open.set(l.taskId, l.usd);
      }
    } else if (l.kind === "settle") {
      left -= l.usd;
      const reserved = held.get(l.taskId);
      if (reserved !== undefined) {
        left += reserved;
        held.delete(l.taskId);
        open.delete(l.taskId);
      }
    } else {
      exhausted = true;
    }
  }
  return { left: exhausted ? 0 : left, open };
}

type Segment = { start: number; left: number; open: Map<string, number> };

/** The reservations a segment carries into the cycle starting at `start`: its open ones if that cycle follows it. */
function carriedInto(pool: CreditPoolConfig, prev: Segment | undefined, start: number): Map<string, number> {
  return prev !== undefined && cycle(pool.cycleDay, start - 1).start === prev.start ? prev.open : new Map();
}

/**
 * The replay of the ledger's last cycle. A line belongs to the cycle of the largest `at` up to it, so cycles are
 * contiguous file segments and membership depends only on file content.
 */
function lastSegment(pool: CreditPoolConfig, lines: LedgerLine[]): Segment | undefined {
  const segments: { start: number; lines: LedgerLine[] }[] = [];
  let maxAt = -Infinity;
  for (const l of lines) {
    maxAt = Math.max(maxAt, l.at);
    const start = cycle(pool.cycleDay, maxAt).start;
    let segment = segments.at(-1);
    if (segment?.start !== start) {
      segment = { start, lines: [] };
      segments.push(segment);
    }
    segment.lines.push(l);
  }
  let last: Segment | undefined;
  for (const { start, lines } of segments) {
    last = { start, ...replay(lines, pool.grantUsd, carriedInto(pool, last, start)) };
  }
  return last;
}

/** The ledger's state in the cycle holding `now`; a reader whose clock is behind the file's takes the last segment. */
async function creditLeft(
  pool: CreditPoolConfig,
  now: number,
): Promise<{ usd: number; open: Map<string, number>; start: number; end: number }> {
  const { start, end } = cycle(pool.cycleDay, now);
  const last = lastSegment(pool, await readLedger());
  if (last !== undefined && last.start >= start) return { usd: last.left, open: last.open, start, end };
  const { left, open } = replay([], pool.grantUsd, carriedInto(pool, last, start));
  return { usd: left, open, start, end };
}

/** The first field of a hand-edited pool config that the cycle and budget math cannot use. */
function poolConfigError({ grantUsd, taskCapUsd, cycleDay }: CreditPoolConfig): string | undefined {
  if (!(Number.isFinite(grantUsd) && grantUsd > 0)) return "grantUsd";
  if (!(Number.isFinite(taskCapUsd) && taskCapUsd > 0 && taskCapUsd <= grantUsd)) return "taskCapUsd";
  if (!(Number.isInteger(cycleDay) && cycleDay >= 1 && cycleDay <= 31)) return "cycleDay";
  return undefined;
}

/**
 * The credit pool as its own reading, so an unreadable subscription reading never blocks it (§13). An invalid pool
 * config or an unreadable ledger skips this pool alone; the pool stays, windowless, so the skip is reported under its
 * own id.
 */
export async function creditReading(pool: CreditPoolConfig, now = Date.now()): Promise<UsageReading> {
  const skipped = (error: string): UsageReading => ({
    agent: "claude",
    fetchedAt: now,
    warnings: [],
    error,
    pools: [{ id: ID, agent: "claude", keys: [ID], windows: [] }],
  });
  const invalid = poolConfigError(pool);
  if (invalid !== undefined) return skipped(`credit pool config invalid: ${invalid}`);
  let left: Awaited<ReturnType<typeof creditLeft>>;
  try {
    left = await creditLeft(pool, now);
  } catch (err) {
    return skipped(`credit ledger unreadable: ${errorMessage(err)}`);
  }
  const { usd, start, end } = left;
  return {
    agent: "claude",
    fetchedAt: now,
    warnings: [],
    pools: [
      {
        id: ID,
        agent: "claude",
        keys: [ID],
        windows: [
          {
            kind: "period",
            remaining: Math.max(0, usd / pool.grantUsd),
            resetsAt: end,
            periodHours: (end - start) / 3.6e6,
          },
        ],
      },
    ],
  };
}

/**
 * B = min(remaining − FLOOR × grant, taskCapUsd), appended as a reserve when > 0 and returned once the replay holds it
 * open; a reserve voided by a line that landed first is retried. B ≤ 0 is a quota outcome.
 */
export async function reserveCredit(pool: CreditPoolConfig, taskId: string): Promise<number> {
  for (;;) {
    const now = Date.now();
    const b = Math.min((await creditLeft(pool, now)).usd - FLOOR * pool.grantUsd, pool.taskCapUsd);
    if (b <= 0) return b;
    await appendLedger({ at: now, taskId, kind: "reserve", usd: b });
    // Read back at the reserve's own `now`: a cycle boundary crossed in between would hide it and reserve twice.
    if ((await creditLeft(pool, now)).open.has(taskId)) return b;
  }
}

/** The credit key: `keyCommand`'s stdout, run without a shell. The error names argv[0] and the exit only, never its output. */
async function readKey(command: string[], signal: AbortSignal): Promise<string> {
  const [file, ...args] = command;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(file as string, args, { signal, encoding: "utf8" }));
  } catch (err) {
    const { code, signal: killed } = err as { code?: unknown; signal?: unknown };
    const why = typeof code === "number" ? `exit ${code}` : String(killed ?? code);
    throw new Error(`${file} ${why}`);
  }
  const key = stdout.trim();
  if (!key) {
    throw new Error(`${file} printed no key`);
  }
  return key;
}

/** A failed ledger write as its errno code, else its message. */
const writeError = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? errorMessage(err);

/**
 * A credit lane's run (§13). `spec` carries the key and the reserved budget B; `settle` writes the run's ledger lines
 * and says whether the pool stopped it (then the key is dead for every model), with a note if a line failed to write.
 */
export interface CreditRun {
  spec: LaunchSpec;
  settle: (run: WorkerRun, costUsd: number | undefined) => Promise<{ stopped: boolean; note?: string }>;
}

/**
 * Reads the key, then reserves B. `"quota"`: B ≤ 0. `note`: the lane key cannot run this call. `cancelled`: the key
 * command was aborted.
 */
export async function openCreditRun(
  pool: CreditPoolConfig,
  spec: LaunchSpec,
  signal: AbortSignal,
): Promise<CreditRun | "quota" | { note: string } | { cancelled: string }> {
  let key: string;
  try {
    key = await readKey(pool.keyCommand, signal);
  } catch (err) {
    const message = errorMessage(err);
    return signal.aborted ? { cancelled: message } : { note: `${ID} key command failed: ${message}` };
  }
  const taskId = randomUUID();
  let budget: number;
  try {
    budget = await reserveCredit(pool, taskId);
  } catch (err) {
    return { note: `${ID} ledger write failed: ${writeError(err)}` };
  }
  if (budget <= 0) return "quota";
  const line = (kind: LedgerLine["kind"], usd: number) => appendLedger({ at: Date.now(), taskId, kind, usd });
  return {
    spec: creditSpec(spec, key, budget),
    settle: async (run, costUsd) => {
      const exhausted = run.failure !== undefined && creditExhausted(run.failure);
      // B below the cap: the pool, not the task, set the budget, so its stop is a quota outcome.
      const stopped = exhausted || (budget < pool.taskCapUsd && budgetStopped(run));
      // A prompted run without a cost leaves B counted.
      const spent = run.prompted ? costUsd : 0;
      try {
        if (spent !== undefined) await line("settle", spent);
        if (exhausted) await line("exhausted", 0);
      } catch (err) {
        // The reservation then stays counted.
        return { stopped, note: `${ID} ledger write failed after the run: ${writeError(err)}` };
      }
      return { stopped };
    },
  };
}
