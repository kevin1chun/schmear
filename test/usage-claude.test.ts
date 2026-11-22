import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseClaudeUsage, readClaudeUsage } from "../src/agents/claude.ts";

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
const fixture = async (name: string): Promise<Json[]> =>
  JSON.parse(await readFile(fixturePath(name), "utf8"));
// biome-ignore lint/suspicious/noExplicitAny: fixtures are edited by path; the parser checks their shape
type Json = Record<string, any>;
const NOW = Date.parse("2026-11-21T12:00:00Z");
const WEEK_RESET = Date.parse("2026-11-28T21:00:00.575560+00:00");
const EXTRA_WARNING_START = "Claude extra usage is on";

/** The `rate_limits` object of a cloned usage fixture, for editing. */
const limitsOf = (messages: Json[]): Json => messages[1]?.response.response.rate_limits;

describe("parseClaudeUsage", () => {
  it("maps seven_day and model_scoped Fable when five_hour is null", async () => {
    const reading = parseClaudeUsage(await fixture("claude-usage"), NOW);
    assert.deepEqual(reading, {
      agent: "claude",
      fetchedAt: NOW,
      warnings: [],
      pools: [
        {
          id: "claude",
          agent: "claude",
          keys: ["claude"],
          windows: [{ kind: "period", remaining: 0.63, resetsAt: WEEK_RESET, periodHours: 168 }],
        },
        {
          id: "claude-fable",
          agent: "claude",
          keys: ["claude"],
          models: ["fable"],
          windows: [
            {
              kind: "period",
              remaining: 0.88,
              resetsAt: Date.parse("2026-11-28T21:00:00.575720+00:00"),
              periodHours: 168,
            },
          ],
        },
      ],
    });
  });

  it("maps five_hour, opus and sonnet windows, falls back to seven_day_oauth_apps, warns on extra usage", async () => {
    const messages = await fixture("claude-usage");
    const limits = limitsOf(messages);
    limits.five_hour = { utilization: 30, resets_at: "2026-11-21T15:00:00+00:00" };
    limits.seven_day = null;
    limits.seven_day_oauth_apps = { utilization: 50, resets_at: "2026-11-27T00:00:00+00:00" };
    limits.seven_day_opus = { utilization: 100, resets_at: null };
    limits.seven_day_sonnet = { utilization: null, resets_at: "2026-11-27T00:00:00+00:00" };
    limits.extra_usage = { is_enabled: true, monthly_limit: 100, used_credits: 1, utilization: 1 };
    const reading = parseClaudeUsage(messages, NOW);
    assert.equal(reading.error, undefined);
    assert.deepEqual(
      reading.pools.map((p) => [p.id, p.models, p.windows.map((w) => [w.kind, w.remaining, w.periodHours])]),
      [
        [
          "claude",
          undefined,
          [
            ["short", 0.7, 5],
            ["period", 0.5, 168],
          ],
        ],
        ["claude-opus", ["opus"], [["period", 0, 168]]],
        ["claude-fable", ["fable"], [["period", 0.88, 168]]],
      ],
    );
    assert.equal(reading.pools[0]?.windows[0]?.resetsAt, Date.parse("2026-11-21T15:00:00Z"));
    assert.equal(reading.pools[1]?.windows[0]?.resetsAt, null);
    assert.equal(reading.warnings.length, 1);
    assert.ok(reading.warnings[0]?.startsWith(EXTRA_WARNING_START));
  });

  it("leaves an unknown model_scoped window unscoped with a warning", async () => {
    const messages = await fixture("claude-usage");
    limitsOf(messages).model_scoped = [{ display_name: "Quasar", utilization: 20, resets_at: null }];
    const reading = parseClaudeUsage(messages, NOW);
    const quasar = reading.pools.find((p) => p.id === "claude-quasar");
    assert.deepEqual(quasar?.keys, ["claude"]);
    assert.equal(quasar?.models, undefined);
    assert.deepEqual(reading.warnings, ["unknown Claude model window 'quasar'"]);
  });

  it("does not duplicate a pool a model_scoped row repeats", async () => {
    const messages = await fixture("claude-usage");
    const limits = limitsOf(messages);
    limits.seven_day_opus = { utilization: 10, resets_at: null };
    limits.model_scoped = [{ display_name: "Opus", utilization: 99, resets_at: null }];
    const opus = parseClaudeUsage(messages, NOW).pools.filter((p) => p.id === "claude-opus");
    assert.equal(opus.length, 1);
    assert.equal(opus[0]?.windows[0]?.remaining, 0.9);
  });

  it("is unreadable without a weekly window", async () => {
    const messages = await fixture("claude-usage");
    limitsOf(messages).seven_day = null;
    const reading = parseClaudeUsage(messages, NOW);
    assert.equal(reading.error, "Claude reports no weekly limit");
    assert.deepEqual(reading.pools, []);
  });

  it("is unreadable when rate_limits_available is false", async () => {
    const reading = parseClaudeUsage(await fixture("claude-unavailable"), NOW);
    assert.equal(reading.error, "Claude reports no plan limits for this login");
    assert.deepEqual(reading.pools, []);
  });

  it("is unreadable on subtype error, with the reason", async () => {
    const reading = parseClaudeUsage(await fixture("claude-error"), NOW);
    assert.equal(reading.error, "Claude get_usage failed: Unknown control request subtype: get_usage");
  });

  it("is unreadable without a `u` answer", async () => {
    const [init] = await fixture("claude-usage");
    assert.equal(parseClaudeUsage([init, "junk", null], NOW).error, "Claude get_usage gave no answer");
    assert.equal(parseClaudeUsage([], NOW).error, "Claude get_usage gave no answer");
  });

  it("adds the hooks warning for a hook_started message, also on an unreadable read", async () => {
    const hook = { type: "system", subtype: "hook_started", hook_name: "SessionStart" };
    const ok = parseClaudeUsage([hook, ...(await fixture("claude-usage"))], NOW);
    assert.equal(ok.error, undefined);
    assert.deepEqual(ok.warnings, ["Claude usage read ran your hooks"]);
    const bad = parseClaudeUsage([hook, ...(await fixture("claude-error"))], NOW);
    assert.ok(bad.error);
    assert.deepEqual(bad.warnings, ["Claude usage read ran your hooks"]);
  });
});

describe("readClaudeUsage", () => {
  const FAKE = fileURLToPath(new URL("./fake-claude.ts", import.meta.url));
  const saved = { state: process.env.XDG_STATE_HOME };
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "schmear-claude-"));
    process.env.XDG_STATE_HOME = join(dir, "state");
    process.env.FAKE_CLAUDE_LOG = join(dir, "log");
    delete process.env.FAKE_CLAUDE_OUT;
  });

  afterEach(() => {
    if (saved.state === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = saved.state;
    }
    delete process.env.FAKE_CLAUDE_LOG;
    delete process.env.FAKE_CLAUDE_OUT;
  });

  const readLog = async (): Promise<{
    header: { args: string[]; cwd: string; pid: number };
    lines: unknown[];
  }> => {
    const [header, ...lines] = (await readFile(join(dir, "log"), "utf8")).trim().split("\n");
    return { header: JSON.parse(header ?? ""), lines: lines.map((l) => JSON.parse(l)) };
  };

  it("runs the §8.1 command in the state dir, writes only the two control requests and parses the answer", async () => {
    process.env.FAKE_CLAUDE_OUT = fixturePath("claude-usage");
    const reading = await readClaudeUsage(FAKE);
    assert.equal(reading.error, undefined);
    assert.deepEqual(
      reading.pools.map((p) => p.id),
      ["claude", "claude-fable"],
    );
    const { header, lines } = await readLog();
    assert.deepEqual(header.args, [
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--strict-mcp-config",
      "--settings",
      '{"disableAllHooks":true}',
    ]);
    assert.equal(header.cwd, await realpath(join(dir, "state", "schmear")));
    assert.deepEqual(lines, [
      { type: "control_request", request_id: "i", request: { subtype: "initialize" } },
      { type: "control_request", request_id: "u", request: { subtype: "get_usage", skip_behaviors: true } },
    ]);
  });

  it("reports the reason when claude answers with an error", async () => {
    process.env.FAKE_CLAUDE_OUT = fixturePath("claude-error");
    const reading = await readClaudeUsage(FAKE);
    assert.match(reading.error ?? "", /get_usage failed/);
  });

  it("is unreadable on timeout and SIGTERMs the child", async () => {
    const reading = await readClaudeUsage(FAKE, 2000);
    assert.equal(reading.error, "Claude get_usage timed out after 2 s");
    assert.deepEqual(reading.pools, []);
    const { pid } = (await readLog()).header;
    const deadline = Date.now() + 3000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 25));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false);
  });

  it("is unreadable when the binary cannot be spawned", async () => {
    const reading = await readClaudeUsage(join(dir, "missing"));
    assert.match(reading.error ?? "", /^Claude get_usage could not start: /);
  });
});
