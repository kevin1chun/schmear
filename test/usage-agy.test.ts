import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AGY_USAGE_TIMEOUT_MS, parseAgyUsage, parseAgyVersion, readAgyUsage } from "../src/agents/agy.ts";

const NOW = Date.parse("2026-11-28T00:00:00Z");
const fixturePath = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
type Json = {
  num_turns?: unknown;
  command: { data: { groups: { buckets: Record<string, unknown>[] }[] } };
};
const fixture = (name: string): Json => JSON.parse(readFileSync(fixturePath(name), "utf8"));
const FAKE_AGY = fileURLToPath(new URL("./fake-agy.ts", import.meta.url));

async function waitFor(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !ok(); i++) {
    await sleep(20);
  }
  assert.equal(ok(), true, "condition not met in time");
}

describe("parseAgyVersion", () => {
  it("extracts major.minor.patch from the first line", () => {
    assert.deepEqual(parseAgyVersion("1.5.14\n"), [1, 5, 14]);
    assert.deepEqual(parseAgyVersion("agy 1.1.11 (abc)\nextra"), [1, 1, 11]);
    assert.deepEqual(parseAgyVersion("v1.1.10-beta.1"), [1, 1, 10]);
    assert.equal(parseAgyVersion("unknown"), null);
    assert.equal(parseAgyVersion(""), null);
  });
});

describe("parseAgyUsage", () => {
  it("maps groups to pools and windows, skipping the disabled bucket", () => {
    const r = parseAgyUsage(fixture("agy-usage.json"), NOW);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.agent, "agy");
    assert.equal(r.fetchedAt, NOW);
    assert.deepEqual(
      r.pools.map((p) => [p.id, p.keys, p.windows.length]),
      [
        ["agy-gemini", ["agy-gemini", "agy-argon"], 2],
        ["agy-3p", ["agy-3p"], 1],
        ["agy-argon", ["agy-argon"], 1],
      ],
    );
    const [weekly, short] = r.pools[0].windows;
    assert.deepEqual(
      [weekly.kind, weekly.periodHours, weekly.resetsAt],
      ["period", 168, Date.parse("2026-12-05T08:00:00Z")],
    );
    assert.ok(Math.abs(weekly.remaining - 0.75) < 1e-9);
    assert.deepEqual(
      [short.kind, short.periodHours, short.resetsAt],
      ["short", 5, Date.parse("2026-11-29T03:00:00Z")],
    );
    assert.ok(Math.abs(short.remaining - 0.5) < 1e-9);
    assert.equal(r.pools[1].windows[0].remaining, 0);
  });

  it("warns on an unknown group and keeps the known ones", () => {
    const r = parseAgyUsage(fixture("agy-usage-unknown-group.json"), NOW);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.warnings, ['unknown agy usage group "Imagen Models"']);
    assert.deepEqual(
      r.pools.map((p) => p.id),
      ["agy-gemini"],
    );
  });

  it("is unreadable on a non-SUCCESS status", () => {
    const r = parseAgyUsage(fixture("agy-usage-error.json"), NOW);
    assert.match(r.error ?? "", /status "ERROR"/);
    assert.deepEqual(r.pools, []);
  });

  it("is unreadable when num_turns is not 0", () => {
    for (const turns of [1, 2, undefined, null, "0"]) {
      const raw = fixture("agy-usage.json");
      if (turns === undefined) {
        delete raw.num_turns;
      } else {
        raw.num_turns = turns;
      }
      const r = parseAgyUsage(raw, NOW);
      assert.match(r.error ?? "", /num_turns/, `turns=${String(turns)}`);
      assert.deepEqual(r.pools, []);
    }
  });

  it("is unreadable on malformed input", () => {
    const noGroups = { status: "SUCCESS", num_turns: 0, command: { data: {} } };
    const badRemaining = fixture("agy-usage.json");
    badRemaining.command.data.groups[0].buckets[0].remaining_fraction = "84%";
    const badReset = fixture("agy-usage.json");
    badReset.command.data.groups[0].buckets[0].reset_time = "soon";
    const onlyDisabled = fixture("agy-usage.json");
    onlyDisabled.command.data.groups = [
      {
        name: "Gemini Models",
        buckets: [{ window: "5h", remaining_fraction: 1, disabled: true }],
      },
    ] as unknown as Json["command"]["data"]["groups"];
    for (const raw of [null, "SUCCESS", {}, noGroups, badRemaining, badReset, onlyDisabled]) {
      const r = parseAgyUsage(raw, NOW);
      assert.ok(r.error, JSON.stringify(raw)?.slice(0, 60));
      assert.deepEqual(r.pools, []);
    }
  });

  it("warns on an unknown window and skips it", () => {
    const raw = fixture("agy-usage.json");
    raw.command.data.groups[0].buckets[1].window = "monthly";
    const r = parseAgyUsage(raw, NOW);
    assert.equal(r.error, undefined);
    assert.equal(r.pools[0].windows.length, 1);
    assert.match(r.warnings[0], /unknown agy usage window "monthly"/);
  });
});

describe("readAgyUsage", () => {
  async function run(env: Record<string, string>, timeoutMs?: number) {
    const prev = { ...process.env };
    Object.assign(process.env, env);
    try {
      return await readAgyUsage(FAKE_AGY, timeoutMs);
    } finally {
      for (const k of Object.keys(env)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  }

  function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "schmear-agy-test-"));
    return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  it("runs the usage command and parses its output", async () => {
    const r = await run({ FAKE_AGY_OUT: fixturePath("agy-usage.json") });
    assert.equal(r.error, undefined);
    assert.equal(r.pools.length, 3);
  });

  it("accepts agy 1.1.11 and rejects versions below 1.1.11 without calling /usage", async () => {
    await withTempDir(async (dir) => {
      const ok = await run({
        FAKE_AGY_VERSION: "1.1.11",
        FAKE_AGY_OUT: fixturePath("agy-usage.json"),
      });
      assert.equal(ok.error, undefined);
      assert.equal(ok.pools.length, 3);

      for (const version of ["1.1.10", "1.0.99", "0.9.5"]) {
        const log = join(dir, `log-${version}`);
        const r = await run({
          FAKE_AGY_VERSION: version,
          FAKE_AGY_LOG: log,
          FAKE_AGY_OUT: fixturePath("agy-usage.json"),
        });
        assert.match(r.error ?? "", new RegExp(version.replaceAll(".", "\\.")));
        assert.match(r.error ?? "", /1\.1\.11/);
        assert.deepEqual(r.pools, []);
        assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["--version"]);
      }

      const badLog = join(dir, "log-bad");
      const unreadable = await run({
        FAKE_AGY_VERSION: "unknown-build",
        FAKE_AGY_LOG: badLog,
        FAKE_AGY_OUT: fixturePath("agy-usage.json"),
      });
      assert.match(unreadable.error ?? "", /unknown-build/);
      assert.deepEqual(readFileSync(badLog, "utf8").trim().split("\n"), ["--version"]);

      const failLog = join(dir, "log-fail");
      const failed = await run({
        FAKE_AGY_VERSION_FAIL: "1",
        FAKE_AGY_LOG: failLog,
        FAKE_AGY_OUT: fixturePath("agy-usage.json"),
      });
      assert.match(failed.error ?? "", /--version failed/);
      assert.deepEqual(readFileSync(failLog, "utf8").trim().split("\n"), ["--version"]);
    });
  });

  it("installs failing browser launchers in a private probe dir and removes it on success and failure", async () => {
    await withTempDir(async (dir) => {
      const inspectOk = join(dir, "inspect-ok.json");
      const ok = await run({
        FAKE_AGY_INSPECT: inspectOk,
        FAKE_AGY_OUT: fixturePath("agy-usage.json"),
      });
      assert.equal(ok.error, undefined);
      const info = JSON.parse(readFileSync(inspectOk, "utf8")) as {
        cwd: string;
        pathHead: string;
        browser: string;
        browserDir: string;
        open: { status: number | null; error: string | null };
        xdgOpen: { status: number | null; error: string | null };
        browserExec: { status: number | null; error: string | null };
      };
      assert.equal(info.pathHead, info.cwd);
      assert.equal(info.browserDir, info.cwd);
      assert.equal(info.open.status, 1);
      assert.equal(info.xdgOpen.status, 1);
      assert.equal(info.browserExec.status, 1);
      assert.equal(existsSync(info.cwd), false);

      const inspectFail = join(dir, "inspect-fail.json");
      const failed = await run({
        FAKE_AGY_INSPECT: inspectFail,
        FAKE_AGY_FAIL: "1",
      });
      assert.match(failed.error ?? "", /agy \/usage failed/);
      assert.equal(failed.error?.includes("FAKE_AGY_SECRET_STDERR"), false);
      const failInfo = JSON.parse(readFileSync(inspectFail, "utf8")) as { cwd: string };
      assert.equal(existsSync(failInfo.cwd), false);
    });
  });

  it("does not run /usage if the browser guard cannot be installed", async () => {
    await withTempDir(async (dir) => {
      const notADir = join(dir, "not-a-dir");
      const log = join(dir, "log");
      writeFileSync(notADir, "x", "utf8");
      const r = await run({
        TMPDIR: notADir,
        FAKE_AGY_LOG: log,
        FAKE_AGY_OUT: fixturePath("agy-usage.json"),
      });
      assert.match(r.error ?? "", /browser guard failed/);
      assert.deepEqual(r.pools, []);
      assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["--version"]);
    });
  });

  it("reports a non-SUCCESS status as unreadable", async () => {
    const r = await run({ FAKE_AGY_OUT: fixturePath("agy-usage-error.json") });
    assert.match(r.error ?? "", /status "ERROR"/);
  });

  it("reports non-JSON output and a failing binary as unreadable", async () => {
    const notJson = await run({ FAKE_AGY_OUT: fileURLToPath(import.meta.url) });
    assert.match(notJson.error ?? "", /not JSON/);
    const missing = await readAgyUsage("/nonexistent/agy");
    assert.match(missing.error ?? "", /failed/);
  });

  it("reports a timeout as unreadable and cleans up the probe dir", async () => {
    await withTempDir(async (dir) => {
      const inspect = join(dir, "inspect-timeout.json");
      const r = await run({ FAKE_AGY_HANG: "1", FAKE_AGY_INSPECT: inspect }, 1000);
      assert.match(r.error ?? "", /timed out after 1000 ms/);
      const info = JSON.parse(readFileSync(inspect, "utf8")) as { cwd: string };
      assert.equal(existsSync(info.cwd), false);
    });
  });

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("ends at the timeout when agy ignores SIGTERM, and kills it", async () => {
    await withTempDir(async (dir) => {
      const pidFile = join(dir, "pid");
      const started = Date.now();
      const r = await run({ FAKE_AGY_HANG: "1", FAKE_AGY_IGNORE_TERM: "1", FAKE_AGY_PID: pidFile }, 1000);
      assert.match(r.error ?? "", /timed out after 1000 ms/);
      assert.ok(Date.now() - started < 2500, "read outlived its timeout");
      const pid = Number(readFileSync(pidFile, "utf8"));
      await waitFor(() => !alive(pid));
    });
  });

  it("returns promptly when agy exits leaving a background child holding stdout, and kills the child", async () => {
    await withTempDir(async (dir) => {
      const bgFile = join(dir, "bg-pid");
      const started = Date.now();
      const r = await run({ FAKE_AGY_BG_PID: bgFile, FAKE_AGY_OUT: fixturePath("agy-usage.json") }, 20_000);
      assert.equal(r.error, undefined);
      assert.equal(r.pools.length, 3);
      assert.ok(Date.now() - started < 5000, "read waited on the background child");
      const bg = Number(readFileSync(bgFile, "utf8"));
      await waitFor(() => !alive(bg));
    });
  });

  it("defaults to CodexBar's 90 s timeout", async () => {
    assert.equal(AGY_USAGE_TIMEOUT_MS, 90_000);
    await withTempDir(async (dir) => {
      const inspect = join(dir, "inspect-90s.json");
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        const pending = run({ FAKE_AGY_HANG: "1", FAKE_AGY_INSPECT: inspect });
        await waitFor(() => existsSync(inspect));
        mock.timers.tick(90_000);
        const r = await pending;
        assert.match(r.error ?? "", /timed out after 90000 ms/);
        const info = JSON.parse(readFileSync(inspect, "utf8")) as { cwd: string };
        assert.equal(existsSync(info.cwd), false);
      } finally {
        mock.timers.reset();
      }
    });
  });
});
