import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { window } from "../src/agents/shared.ts";
import {
  configPath,
  readConfig,
  readOffered,
  stateDir,
  USAGE_ROUTE_MS,
  USAGE_SHOW_MS,
  usage,
  writeAtomic,
  writeOffered,
} from "../src/state.ts";
import type { UsageReading } from "../src/types.ts";

let dir: string;
const saved = { state: process.env.XDG_STATE_HOME, config: process.env.XDG_CONFIG_HOME };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "schmear-state-"));
  process.env.XDG_STATE_HOME = join(dir, "state");
  process.env.XDG_CONFIG_HOME = join(dir, "config");
});

afterEach(() => {
  for (const [name, value] of [
    ["XDG_STATE_HOME", saved.state],
    ["XDG_CONFIG_HOME", saved.config],
  ] as const) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("paths", () => {
  it("follow the XDG variables", () => {
    assert.equal(stateDir(), join(dir, "state", "schmear"));
    assert.equal(configPath(), join(dir, "config", "schmear", "config.json"));
  });

  it("fall back to ~/.local/state and ~/.config", () => {
    assert.match(stateDir({}), /\.local[/\\]state[/\\]schmear$/);
    assert.match(configPath({}), /\.config[/\\]schmear[/\\]config\.json$/);
  });
});

describe("writeAtomic", () => {
  it("creates parent dirs and leaves no tmp file", async () => {
    const path = join(dir, "a", "b", "file.json");
    await writeAtomic(path, "one");
    await writeAtomic(path, "two");
    assert.deepEqual(await readdir(join(dir, "a", "b")), ["file.json"]);
  });

  it("creates a new file 0600 in a new dir 0700, and keeps a given mode", async () => {
    await writeOffered("grok", ["a"]);
    assert.equal((await stat(join(stateDir(), "offered", "grok.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(stateDir(), "offered"))).mode & 0o777, 0o700);
    const host = join(dir, "host.toml");
    await writeAtomic(host, "x", 0o644);
    assert.equal((await stat(host)).mode & 0o777, 0o644);
  });
});

describe("usage cache", () => {
  const reading = (fetchedAt: number, error?: string): UsageReading => ({
    agent: "codex",
    fetchedAt,
    pools: [],
    warnings: [],
    ...(error ? { error } : {}),
  });

  it("hits under maxAgeMs, rereads at or over it, and 0 always reads", async () => {
    assert.equal(USAGE_SHOW_MS, 60_000);
    assert.equal(USAGE_ROUTE_MS, 300_000);

    let calls = 0;
    const read = async () => reading(1_000 + 100 * ++calls);

    await usage("codex", read, USAGE_SHOW_MS, 1_000);
    assert.equal(calls, 1);
    await usage("codex", read, USAGE_SHOW_MS, 60_000);
    assert.equal(calls, 1);
    await usage("codex", read, USAGE_SHOW_MS, 61_100);
    assert.equal(calls, 2);

    // 4 min later: still under USAGE_ROUTE_MS, then at it
    await usage("codex", read, USAGE_ROUTE_MS, 1_200 + 240_000);
    assert.equal(calls, 2);
    await usage("codex", read, USAGE_ROUTE_MS, 1_200 + USAGE_ROUTE_MS);
    assert.equal(calls, 3);

    // maxAgeMs = 0 always rereads and refreshes the cache
    const fresh = await usage("codex", read, 0, 1_300);
    assert.equal(calls, 4);
    assert.equal(fresh.fetchedAt, 1_400);
    assert.deepEqual(await usage("codex", read, USAGE_SHOW_MS, 1_400), fresh);
    assert.equal(calls, 4);
  });

  it("serves a failed reading at most USAGE_SHOW_MS, even to routing", async () => {
    let calls = 0;
    const read = async () => {
      calls++;
      return reading(10_000, "timed out");
    };
    await usage("grok", read, USAGE_ROUTE_MS, 10_000);
    await usage("grok", read, USAGE_ROUTE_MS, 10_000 + USAGE_SHOW_MS - 1);
    assert.equal(calls, 1);
    await usage("grok", read, USAGE_ROUTE_MS, 10_000 + USAGE_SHOW_MS);
    assert.equal(calls, 2);
  });

  it("caches error readings", async () => {
    let calls = 0;
    const read = async () => {
      calls++;
      return reading(5_000, "no login");
    };
    const first = await usage("codex", read, USAGE_SHOW_MS, 5_000);
    const second = await usage("codex", read, USAGE_SHOW_MS, 6_000);
    assert.equal(calls, 1);
    assert.equal(second.error, "no login");
    assert.deepEqual(second, first);
  });
});

describe("offered list", () => {
  it("is unknown when missing, readable within 24 h, and ignored after", async () => {
    assert.equal(await readOffered("grok", 1_000), undefined);
    await writeOffered("grok", ["a", "b"], 1_000);
    assert.deepEqual(await readOffered("grok", 1_000 + 24 * 3_600_000 - 1), ["a", "b"]);
    assert.equal(await readOffered("grok", 1_000 + 24 * 3_600_000), undefined);
  });

  it("is stored as {fetchedAt, models} under S/offered", async () => {
    await writeOffered("grok", ["a"], 5);
    assert.deepEqual(JSON.parse(await readFile(join(stateDir(), "offered", "grok.json"), "utf8")), {
      fetchedAt: 5,
      models: ["a"],
    });
  });
});

describe("readConfig", () => {
  it("returns an empty config when the file is missing", async () => {
    assert.deepEqual(await readConfig(), { version: 1, agents: {} });
  });

  it("reads a valid file with custom tiers and reserve", async () => {
    const config = {
      version: 1,
      agents: { codex: { consent: true, path: "/bin/codex", overageOff: true } },
      tiers: [["claude:sonnet@low", "codex:gpt-5.6-terra@medium"], ["claude:opus@high"]],
      reserve: { claude: 0, codex: 0.25 },
    };
    await mkdir(join(dir, "config", "schmear"), { recursive: true });
    await writeFile(configPath(), JSON.stringify(config));
    assert.deepEqual(await readConfig(), config);
  });

  it("throws naming the file when malformed", async () => {
    await mkdir(join(dir, "config", "schmear"), { recursive: true });
    await writeFile(configPath(), "{not json");
    await assert.rejects(readConfig(), (err: Error) => err.message.includes(configPath()));
    await writeFile(configPath(), JSON.stringify({ version: 2, agents: {} }));
    await assert.rejects(readConfig(), (err: Error) => err.message.includes(configPath()));
  });

  it("rejects a non-boolean consent, an overageOff other than true, an empty path, and an unknown key", async () => {
    await mkdir(join(dir, "config", "schmear"), { recursive: true });
    const path = configPath();
    const cases: [Record<string, unknown>, string][] = [
      [
        { agents: { claude: { consent: "false", path: "/bin/claude" } } },
        `malformed config ${path}: agents.claude.consent: Invalid input: expected boolean, received string`,
      ],
      [
        { agents: { codex: { consent: true, path: "/bin/codex", overageOff: "no" } } },
        `malformed config ${path}: agents.codex.overageOff: Invalid input: expected true`,
      ],
      [
        { agents: { codex: { consent: true, path: "" } } },
        `malformed config ${path}: agents.codex.path: Too small: expected string to have >=1 characters`,
      ],
      [{ agents: {}, creditPools: [] }, `malformed config ${path}: Unrecognized key: "creditPools"`],
      [{ agents: {}, credits: [] }, `malformed config ${path}: credits: must be an object`],
    ];
    for (const [extra, expected] of cases) {
      await writeFile(path, JSON.stringify({ version: 1, ...extra }));
      await assert.rejects(readConfig(), { message: expected });
    }
  });

  it("validates tiers and reserve with messages naming the file", async () => {
    await mkdir(join(dir, "config", "schmear"), { recursive: true });
    const path = configPath();
    const cases: [Record<string, unknown>, string][] = [
      [
        { tiers: { claude: {} } },
        `malformed config ${path}: tiers must be a non-empty list of tiers, each a non-empty list of "key:model@effort" strings`,
      ],
      [{ tiers: [[]] }, `malformed config ${path}: tier 1 is empty`],
      [
        { tiers: [["claude:haiku"]] },
        `malformed config ${path}: tier 1 entry "claude:haiku": expected "key:model@effort"`,
      ],
      [
        { tiers: [["bogus:haiku@medium"]] },
        `malformed config ${path}: tier 1 entry "bogus:haiku@medium": unknown lane key "bogus" (one of claude, codex, grok, agy-gemini, agy-argon, agy-3p, claude-credits)`,
      ],
      [
        { tiers: [["claude:haiku@low", "claude:haiku@high"]] },
        `malformed config ${path}: tier 1 entry "claude:haiku@high": claude:haiku is listed twice in this tier`,
      ],
      [{ reserve: 0.1 }, `malformed config ${path}: reserve must be an object`],
      [{ reserve: [] }, `malformed config ${path}: reserve must be an object`],
      [{ reserve: null }, `malformed config ${path}: reserve must be an object`],
      [{ reserve: { bogus: 0.1 } }, `malformed config ${path}: reserve: unknown agent "bogus"`],
      [
        { reserve: { claude: -0.01 } },
        `malformed config ${path}: reserve.claude must be a fraction from 0 to 1, e.g. 0.05 for 5%`,
      ],
      [
        { reserve: { claude: 1 } },
        `malformed config ${path}: reserve.claude must be a fraction from 0 to 1, e.g. 0.05 for 5%`,
      ],
      [
        { reserve: { claude: "0.05" } },
        `malformed config ${path}: reserve.claude must be a fraction from 0 to 1, e.g. 0.05 for 5%`,
      ],
    ];
    for (const [extra, expected] of cases) {
      await writeFile(path, JSON.stringify({ version: 1, agents: {}, ...extra }));
      await assert.rejects(readConfig(), { message: expected });
    }
  });
});

describe("window", () => {
  it("maps used percent to remaining and clamps to 0..1", () => {
    assert.deepEqual(window(25, 1_700_000_000_000, "short", 5), {
      kind: "short",
      remaining: 0.75,
      resetsAt: 1_700_000_000_000,
      periodHours: 5,
    });
    assert.equal(window(120, null, "period", 168).remaining, 0);
    assert.equal(window(-10, null, "period", 168).remaining, 1);
    assert.equal(window(0, null, "period", 168).resetsAt, null);
  });
});
