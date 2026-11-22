import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseCodexUsage, readCodexUsage } from "../src/agents/codex.ts";
import type { FakeAppServerScript } from "./fake-app-server.ts";

const NOW = 1_794_000_000_000;
// biome-ignore lint/suspicious/noExplicitAny: tests mutate nested fixture fields
const fixture = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), "utf8"));

describe("parseCodexUsage", () => {
  it("maps a 30-day primary to one period window and ignores a duplicate own limit", () => {
    const r = parseCodexUsage(fixture("codex-monthly"), NOW);
    assert.equal(r.error, undefined);
    assert.equal(r.fetchedAt, NOW);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.pools, [
      {
        id: "codex",
        agent: "codex",
        keys: ["codex"],
        windows: [{ kind: "period", remaining: 0.63, resetsAt: 1_795_000_000_000, periodHours: 720 }],
      },
    ]);
  });

  it("maps a short primary and a weekly secondary; another limit id warns and adds no window", () => {
    const r = parseCodexUsage(fixture("codex-two-limits"), NOW);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.warnings, ["Codex reports another limit 'codex_bengalfox'; not used for routing"]);
    assert.equal(r.pools.length, 1);
    const [short, weekly] = r.pools[0].windows;
    assert.deepEqual(short, { kind: "short", remaining: 0.88, resetsAt: 1_795_003_600_000, periodHours: 5 });
    assert.deepEqual(weekly, {
      kind: "period",
      remaining: 0.36,
      resetsAt: 1_795_500_000_000,
      periodHours: 168,
    });
  });

  it("treats windowDurationMins 1440 as short and 1441 as period", () => {
    const raw = fixture("codex-monthly");
    raw.rateLimits.primary.windowDurationMins = 1440;
    assert.equal(parseCodexUsage(raw, NOW).pools[0].windows[0].kind, "short");
    raw.rateLimits.primary.windowDurationMins = 1441;
    assert.equal(parseCodexUsage(raw, NOW).pools[0].windows[0].kind, "period");
  });

  it("uses rateLimits.limitId to decide which entry is another limit", () => {
    const raw = fixture("codex-two-limits");
    raw.rateLimits.limitId = "codex_bengalfox";
    assert.deepEqual(parseCodexUsage(raw, NOW).warnings, [
      "Codex reports another limit 'codex'; not used for routing",
    ]);
    delete raw.rateLimits.limitId;
    assert.equal(parseCodexUsage(raw, NOW).warnings.length, 1);
    delete raw.rateLimitsByLimitId;
    assert.deepEqual(parseCodexUsage(raw, NOW).warnings, []);
  });

  it("zeroes every window when spend control is reached", () => {
    const r = parseCodexUsage(fixture("codex-spend-reached"), NOW);
    assert.deepEqual(
      r.pools[0].windows.map((w) => w.remaining),
      [0],
    );
  });

  it("zeroes every window when rateLimitReachedType is set", () => {
    const raw = fixture("codex-two-limits");
    raw.rateLimits.rateLimitReachedType = "primary";
    const r = parseCodexUsage(raw, NOW);
    assert.deepEqual(
      r.pools[0].windows.map((w) => w.remaining),
      [0, 0],
    );
  });

  it("keeps a null resetsAt as null", () => {
    const raw = fixture("codex-monthly");
    raw.rateLimits.primary.resetsAt = null;
    assert.equal(parseCodexUsage(raw, NOW).pools[0].windows[0].resetsAt, null);
  });

  it("is unreadable, with a reason, for malformed replies", () => {
    const noWindows = fixture("codex-monthly");
    noWindows.rateLimits.primary = null;
    const badPercent = fixture("codex-monthly");
    badPercent.rateLimits.primary.usedPercent = "83";
    const badDuration = fixture("codex-monthly");
    badDuration.rateLimits.primary.windowDurationMins = 0;
    const badSecondary = fixture("codex-monthly");
    badSecondary.rateLimits.secondary = 5;
    const cases: [unknown, RegExp][] = [
      [null, /no rateLimits/],
      [{}, /no rateLimits/],
      [{ rateLimits: null }, /no rateLimits/],
      [noWindows, /no rate-limit window/],
      [badPercent, /primary window has no numeric usedPercent/],
      [badDuration, /primary window has no positive windowDurationMins/],
      [badSecondary, /secondary window is not an object/],
    ];
    for (const [raw, reason] of cases) {
      const r = parseCodexUsage(raw, NOW);
      assert.match(r.error ?? "", reason);
      assert.deepEqual(r.pools, []);
    }
  });
});

describe("readCodexUsage", () => {
  it("runs app-server read-only, initializes, returns the raw result and kills the process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schmear-codex-usage-"));
    try {
      const readFile = join(dir, "read.json");
      const script: FakeAppServerScript = {
        rateLimits: fixture("codex-monthly"),
        pidFile: join(dir, "pid"),
        readFile,
      };
      const scriptFile = join(dir, "script.json");
      writeFileSync(scriptFile, JSON.stringify(script), "utf8");
      const bin = join(dir, "codex");
      const server = fileURLToPath(new URL("./fake-app-server.ts", import.meta.url));
      writeFileSync(
        bin,
        `#!/bin/sh\nexec "${process.execPath}" "${server}" "$(cat "${scriptFile}")" "$@"\n`,
        "utf8",
      );
      chmodSync(bin, 0o755);
      assert.deepEqual(await readCodexUsage(bin), script.rateLimits);
      assert.deepEqual(JSON.parse(readFileSync(readFile, "utf8")), {
        initialized: true,
        args: ["-s", "read-only", "-a", "never", "app-server"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
