import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  type GrokDeps,
  type GrokToken,
  grokDeps,
  grokSpendOn,
  parseGrokCredits,
  parseGrokProto,
  readGrokUsage,
} from "../src/agents/grok.ts";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const HOUR = 3_600_000;
const TOKEN = "test-token";
const GROK_COM = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const PROXY = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const WITH_PERCENT = fixture("grok-billing-percent.json");
const NO_PERCENT = fixture("grok-billing-no-percent.json");
const ON_DEMAND = fixture("grok-proxy-on-demand.json");

// Hand-built protobuf encoder for the grok.com billing messages (spec 8.3 field numbers).
const varint = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
};
const tag = (no: number, wire: number): number[] => varint(no * 8 + wire);
const len = (no: number, body: number[]): number[] => [...tag(no, 2), ...varint(body.length), ...body];
const vint = (no: number, v: number): number[] => [...tag(no, 0), ...varint(v)];
const f32 = (no: number, v: number): number[] => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, true);
  return [...tag(no, 5), ...b];
};
const ts = (no: number, ms: number): number[] => len(no, vint(1, ms / 1000));
const WEEKLY = 2;
const MONTHLY = 1;
const period = (type: number, start: number, end: number): number[] =>
  len(8, [...vint(1, type), ...ts(2, start), ...ts(3, end)]);
const response = (...config: number[][]): number[] => len(1, config.flat());
const frame = (flag: number, body: number[]): number[] => [
  flag,
  (body.length >>> 24) & 0xff,
  (body.length >>> 16) & 0xff,
  (body.length >>> 8) & 0xff,
  body.length & 0xff,
  ...body,
];
const ascii = (s: string): number[] => [...new TextEncoder().encode(s)];
const grpcWeb = (payload: number[], status = 0): Uint8Array<ArrayBuffer> =>
  new Uint8Array([
    ...frame(0x00, payload),
    ...frame(0x80, ascii(`grpc-status:${status}\r\ngrpc-message:\r\n`)),
  ]);

const WEEK_START = Date.parse("2026-11-16T00:00:00Z");
const WEEK_END = Date.parse("2026-11-23T00:00:00Z");
const ACTIVE_WEEK = period(WEEKLY, WEEK_START, WEEK_END);

describe("parseGrokCredits", () => {
  it("reads creditUsagePercent with the current period's reset and duration", () => {
    assert.deepEqual(parseGrokCredits(WITH_PERCENT, NOW), {
      usedPercent: 40,
      resetsAt: WEEK_END,
      periodHours: 168,
    });
  });

  it("reports unknown usage for a period without a percent (R14)", () => {
    assert.deepEqual(parseGrokCredits(NO_PERCENT, NOW), {
      usedPercent: null,
      resetsAt: WEEK_END,
      periodHours: 168,
    });
  });

  it("falls back to on-demand used over cap and the billing period", () => {
    assert.deepEqual(parseGrokCredits(ON_DEMAND, NOW), {
      usedPercent: 25,
      resetsAt: Date.parse("2026-12-01T00:00:00Z"),
      periodHours: 720,
    });
  });

  it("is unreadable without a valid period", () => {
    assert.deepEqual(parseGrokCredits({ config: { creditUsagePercent: 10 } }, NOW), {
      error: "Grok billing period unknown",
    });
    const future = {
      config: {
        creditUsagePercent: 10,
        currentPeriod: { start: "2026-11-20T00:00:00Z", end: "2026-11-27T00:00:00Z" },
      },
    };
    assert.deepEqual(parseGrokCredits(future, NOW), { error: "Grok billing period unknown" });
  });

  it("does not mix currentPeriod.end with billingPeriodStart/End duration", () => {
    const billingBounds = {
      billingPeriodStart: "2026-11-01T00:00:00Z",
      billingPeriodEnd: "2026-12-01T00:00:00Z",
    };
    for (const currentPeriod of [
      { end: "2026-11-23T00:00:00Z" },
      { start: "not-a-date", end: "2026-11-23T00:00:00Z" },
      { start: "2026-11-24T00:00:00Z", end: "2026-11-23T00:00:00Z" },
      { start: "2026-11-20T00:00:00Z", end: "2026-11-23T00:00:00Z" },
    ]) {
      assert.deepEqual(
        parseGrokCredits({ config: { creditUsagePercent: 40, currentPeriod, ...billingBounds } }, NOW),
        { error: "Grok billing period unknown" },
      );
    }
    assert.deepEqual(
      parseGrokCredits(
        {
          config: {
            creditUsagePercent: 40,
            currentPeriod: { start: "2026-11-16T00:00:00Z" },
            ...billingBounds,
          },
        },
        NOW,
      ),
      {
        usedPercent: 40,
        resetsAt: Date.parse("2026-12-01T00:00:00Z"),
        periodHours: 720,
      },
    );
  });
});

describe("grokSpendOn", () => {
  it("names a non-zero on-demand cap or prepaid balance in USD", () => {
    assert.equal(grokSpendOn(ON_DEMAND), "grok on-demand or prepaid spend is on (on-demand cap $20.00)");
    assert.equal(grokSpendOn(NO_PERCENT), "grok on-demand or prepaid spend is on (prepaid balance $3.50)");
    const both = { config: { onDemandCap: { val: 1000 }, prepaidBalance: { val: 1446 } } };
    assert.equal(
      grokSpendOn(both),
      "grok on-demand or prepaid spend is on (on-demand cap $10.00, prepaid balance $14.46)",
    );
  });

  it("is off when both are zero or an empty Cent", () => {
    assert.equal(grokSpendOn(WITH_PERCENT), undefined);
    assert.equal(grokSpendOn({ config: { onDemandCap: {}, prepaidBalance: {} } }), undefined);
  });
});

describe("parseGrokProto", () => {
  it("reads a wire credit_usage_percent from a gRPC-web frame", () => {
    const result = parseGrokProto(grpcWeb(response(f32(1, 12.5), ACTIVE_WEEK)), NOW);
    assert.deepEqual(result, {
      usedPercent: 12.5,
      implicitZero: false,
      period: { type: WEEKLY, start: WEEK_START, end: WEEK_END },
    });
  });

  it("reads a raw protobuf body", () => {
    const result = parseGrokProto(new Uint8Array(response(f32(1, 80))), NOW);
    assert.deepEqual(result, { usedPercent: 80, implicitZero: false, period: null });
  });

  it("validates an implicit zero from a complete response with an active period", () => {
    const opaque = len(20, [0x00, 0xff, 0xff]);
    const result = parseGrokProto(grpcWeb(response(opaque, ACTIVE_WEEK)), NOW);
    assert.deepEqual(result, {
      usedPercent: 0,
      implicitZero: true,
      period: { type: WEEKLY, start: WEEK_START, end: WEEK_END },
    });
    const monthly = period(MONTHLY, Date.parse("2026-11-01T00:00:00Z"), Date.parse("2026-12-01T00:00:00Z"));
    assert.deepEqual(parseGrokProto(grpcWeb(response(monthly)), NOW), {
      usedPercent: 0,
      implicitZero: true,
      period: {
        type: MONTHLY,
        start: Date.parse("2026-11-01T00:00:00Z"),
        end: Date.parse("2026-12-01T00:00:00Z"),
      },
    });
  });

  it("is unknown when the period does not contain now, is unspecified, another percent is present, or a percent is NaN", () => {
    const past = period(WEEKLY, WEEK_START - 7 * 24 * HOUR, WEEK_START);
    const unspecified = period(0, WEEK_START, WEEK_END);
    const product = len(7, f32(2, 30));
    const nanCredit = f32(1, Number.NaN);
    const nanProduct = len(7, f32(2, Number.NaN));
    for (const body of [
      response(past),
      response(unspecified),
      response(product, ACTIVE_WEEK),
      response(nanCredit, ACTIVE_WEEK),
      response(nanProduct, ACTIVE_WEEK),
      [],
    ]) {
      assert.deepEqual(parseGrokProto(grpcWeb(body), NOW), { error: "Grok reports no usage percent" });
    }
  });

  it("treats malformed responses as incomplete", () => {
    const cases: Array<[string, number[]]> = [
      ["field number 0", response([0x00, 0x01], ACTIVE_WEEK)],
      ["overflowing varint", response(ACTIVE_WEEK, [0x10, ...new Array(10).fill(0xff), 0x01])],
      ["unknown wire type", response(ACTIVE_WEEK, [...tag(9, 3)])],
      ["truncated", response(ACTIVE_WEEK).slice(0, -2)],
      ["wrong wire type for a declared field", response(vint(1, 5), ACTIVE_WEEK)],
    ];
    for (const [name, body] of cases) {
      const result = parseGrokProto(grpcWeb(body), NOW);
      assert.ok("error" in result && result.error.includes("incomplete"), name);
    }
  });

  it("is unreadable on a non-zero grpc-status trailer", () => {
    assert.deepEqual(parseGrokProto(grpcWeb(response(f32(1, 5)), 16), NOW), {
      error: "grok.com grpc-status 16",
    });
  });
});

describe("readGrokUsage", () => {
  const dir = mkdtempSync(join(tmpdir(), "schmear-grok-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => mock.timers.enable({ apis: ["Date"], now: NOW }));
  afterEach(() => mock.timers.reset());

  /** A fake `grok` answering `initialize`, then `_x.ai/billing {}` with `billing` or a JSON-RPC error. */
  function fakeGrok(
    name: string,
    billing: { result: unknown } | { error: { code: number; message: string } },
  ) {
    const bin = join(dir, name);
    writeFileSync(
      bin,
      `#!${process.execPath}
const args = process.argv.slice(2).join(" ");
if (args !== "--no-auto-update agent stdio") process.exit(2);
const reply = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") reply({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (msg.method === "_x.ai/billing" && JSON.stringify(msg.params) === "{}") reply({ id: msg.id, ...${JSON.stringify(billing)} });
  else if (msg.id !== undefined) reply({ id: msg.id, error: { code: -32601, message: "unexpected " + msg.method } });
});
`,
    );
    chmodSync(bin, 0o755);
    return bin;
  }
  const acpPercent = fakeGrok("grok-percent", { result: WITH_PERCENT });
  const acpNoPercent = fakeGrok("grok-no-percent", { result: NO_PERCENT });
  const acpError = fakeGrok("grok-error", { error: { code: -32601, message: "Method not found" } });
  const acpMethodMissingOtherMsg = fakeGrok("grok-method-missing-alt", {
    error: { code: -32601, message: "extension unavailable" },
  });
  const acpAuthError = fakeGrok("grok-auth-error", {
    error: { code: -32603, message: "Authentication required to fetch billing data." },
  });

  interface Call {
    url: string;
    init: RequestInit;
  }
  function stub(
    routes: Record<string, () => Response>,
    token: GrokToken | null = { token: TOKEN, expiresAt: NOW + HOUR },
  ) {
    const calls: Call[] = [];
    let tokenReads = 0;
    const deps: GrokDeps = {
      readToken: async () => {
        tokenReads++;
        return token;
      },
      fetch: async (input, init = {}) => {
        const url = String(input);
        calls.push({ url, init });
        const route = routes[url];
        assert.ok(route, `unexpected fetch ${url}`);
        return route();
      },
    };
    return { deps, calls, tokenReads: () => tokenReads };
  }
  const protoResponse = (body: Uint8Array<ArrayBuffer>, init?: ResponseInit) =>
    new Response(body, { headers: { "content-type": "application/grpc-web+proto" }, ...init });

  function assertTokenOnlyInAuthorization(calls: Call[]): void {
    for (const { url, init } of calls) {
      const headers = new Headers(init.headers);
      assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(headers.has("cookie"), false);
      assert.equal(init.credentials, "omit");
      headers.delete("authorization");
      const rest = JSON.stringify({ url, headers: [...headers], body: String(init.body ?? "") });
      assert.equal(rest.includes(TOKEN), false);
    }
  }

  it("uses the ACP percent without reading the token", async () => {
    const s = stub({});
    const reading = await readGrokUsage(acpPercent, s.deps);
    assert.equal(reading.error, undefined);
    assert.equal(reading.source, "acp");
    assert.deepEqual(reading.pools, [
      {
        id: "grok",
        agent: "grok",
        keys: ["grok"],
        windows: [{ kind: "period", remaining: 0.6, resetsAt: WEEK_END, periodHours: 168 }],
      },
    ]);
    assert.equal(s.calls.length, 0);
    assert.equal(s.tokenReads(), 0);
  });

  it("adopts a grok.com wire percent with the ACP period", async () => {
    const otherWeek = period(WEEKLY, WEEK_START + HOUR, WEEK_END + HOUR);
    const s = stub({ [GROK_COM]: () => protoResponse(grpcWeb(response(f32(1, 30), otherWeek))) });
    const reading = await readGrokUsage(acpNoPercent, s.deps);
    assert.equal(reading.error, "grok on-demand or prepaid spend is on (prepaid balance $3.50)");
    assert.equal(reading.source, "grok.com");
    assert.deepEqual(reading.pools[0].windows, [
      { kind: "period", remaining: 0.7, resetsAt: WEEK_END, periodHours: 168 },
    ]);
    assert.equal(s.calls.length, 1);
    const { init } = s.calls[0];
    assert.equal(init.method, "POST");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("content-type"), "application/grpc-web+proto");
    assert.equal(headers.get("x-grpc-web"), "1");
    assert.deepEqual([...(init.body as Uint8Array)], [0, 0, 0, 0, 2, 8, 0]);
    assert.ok(init.signal instanceof AbortSignal);
    assertTokenOnlyInAuthorization(s.calls);
    assert.equal(JSON.stringify(reading).includes(TOKEN), false);
  });

  it("adopts a grok.com implicit zero", async () => {
    const s = stub({ [GROK_COM]: () => protoResponse(new Uint8Array(response(ACTIVE_WEEK))) });
    const reading = await readGrokUsage(acpNoPercent, s.deps);
    assert.equal(reading.source, "grok.com");
    assert.equal(reading.pools[0].windows[0].remaining, 1);
    assertTokenOnlyInAuthorization(s.calls);
  });

  it("is unreadable on a malformed grok.com response or a period not containing now", async () => {
    const past = period(WEEKLY, WEEK_START - 7 * 24 * HOUR, WEEK_START);
    for (const body of [response([0x00, 0x01], ACTIVE_WEEK), response(past)]) {
      const s = stub({ [GROK_COM]: () => protoResponse(grpcWeb(body)) });
      const reading = await readGrokUsage(acpNoPercent, s.deps);
      assert.deepEqual(reading.pools, []);
      assert.match(reading.error ?? "", /^Grok reports no usage percent/);
      assertTokenOnlyInAuthorization(s.calls);
    }
  });

  it("is unreadable on a grok.com HTTP error or grpc-status header", async () => {
    for (const res of [
      () => new Response("denied", { status: 403 }),
      () => protoResponse(new Uint8Array(), { headers: { "grpc-status": "16" } }),
    ]) {
      const reading = await readGrokUsage(acpNoPercent, stub({ [GROK_COM]: res }).deps);
      assert.deepEqual(reading.pools, []);
      assert.match(reading.error ?? "", /grok\.com (HTTP 403|grpc-status 16)$/);
    }
  });

  it("is unreadable without the call when the token is missing or expired", async () => {
    for (const token of [null, { token: TOKEN, expiresAt: NOW - 1 }]) {
      const s = stub({}, token);
      const reading = await readGrokUsage(acpNoPercent, s.deps);
      assert.deepEqual(reading.pools, []);
      assert.match(reading.error ?? "", /grok\.com retry skipped: (no Grok login token|.*expired)/);
      assert.equal(s.calls.length, 0);
      assert.equal(JSON.stringify(reading).includes(TOKEN), false);
    }
  });

  it("falls back to the CLI proxy only on JSON-RPC -32601, regardless of message", async () => {
    for (const bin of [acpError, acpMethodMissingOtherMsg]) {
      const s = stub({ [PROXY]: () => Response.json(ON_DEMAND) });
      const reading = await readGrokUsage(bin, s.deps);
      assert.equal(reading.error, "grok on-demand or prepaid spend is on (on-demand cap $20.00)");
      assert.equal(reading.source, "cli-proxy");
      assert.deepEqual(reading.pools[0].windows, [
        { kind: "period", remaining: 0.75, resetsAt: Date.parse("2026-12-01T00:00:00Z"), periodHours: 720 },
      ]);
      assert.equal(s.calls.length, 1);
      const headers = new Headers(s.calls[0].init.headers);
      assert.equal(headers.get("x-xai-token-auth"), "xai-grok-cli");
      assert.equal(headers.get("accept"), "application/json");
      assertTokenOnlyInAuthorization(s.calls);
    }
  });

  it("does not fall back to the CLI proxy on other RPC or spawn errors", async () => {
    for (const bin of [acpAuthError, join(dir, "missing-grok")]) {
      const s = stub({});
      const reading = await readGrokUsage(bin, s.deps);
      assert.deepEqual(reading.pools, []);
      assert.match(reading.error ?? "", /^Grok ACP billing failed:/);
      assert.equal(s.calls.length, 0);
      assert.equal(s.tokenReads(), 0);
    }
  });

  it("retries grok.com when the CLI proxy has no percent, reading the token once", async () => {
    const s = stub({
      [PROXY]: () => Response.json(NO_PERCENT),
      [GROK_COM]: () => protoResponse(grpcWeb(response(f32(1, 50)))),
    });
    const reading = await readGrokUsage(acpError, s.deps);
    assert.equal(reading.source, "grok.com");
    assert.equal(reading.pools[0].windows[0].remaining, 0.5);
    assert.deepEqual(
      s.calls.map((c) => c.url),
      [PROXY, GROK_COM],
    );
    assert.equal(s.tokenReads(), 1);
    assertTokenOnlyInAuthorization(s.calls);
  });

  it("is unreadable when ACP and the CLI proxy both fail", async () => {
    const s = stub({ [PROXY]: () => new Response("", { status: 500 }) });
    const reading = await readGrokUsage(acpError, s.deps);
    assert.deepEqual(reading.pools, []);
    assert.match(reading.error ?? "", /Method not found.*CLI proxy HTTP 500/);
    const noToken = stub({}, null);
    const skipped = await readGrokUsage(acpError, noToken.deps);
    assert.match(skipped.error ?? "", /CLI proxy skipped: no Grok login token/);
    assert.equal(noToken.calls.length, 0);
  });
});

describe("default Grok token reader", () => {
  const home = mkdtempSync(join(tmpdir(), "schmear-grok-home-"));
  const prev = process.env.GROK_HOME;
  beforeEach(() => {
    process.env.GROK_HOME = home;
  });
  after(() => {
    if (prev === undefined) {
      delete process.env.GROK_HOME;
    } else {
      process.env.GROK_HOME = prev;
    }
    rmSync(home, { recursive: true, force: true });
  });
  const write = (text: string) => writeFileSync(join(home, "auth.json"), text);

  it("returns null without an auth file", async () => {
    rmSync(join(home, "auth.json"), { force: true });
    assert.equal(await grokDeps.readToken(), null);
  });

  it("prefers the auth.x.ai entry over the legacy sign-in entry", async () => {
    write(
      JSON.stringify({
        "https://accounts.x.ai/sign-in": { key: "legacy-test-token", expires_at: "2026-11-20T00:00:00Z" },
        "https://auth.x.ai::client-id": { key: TOKEN, expires_at: "2026-11-26T00:00:00Z" },
      }),
    );
    assert.deepEqual(await grokDeps.readToken(), {
      token: TOKEN,
      expiresAt: Date.parse("2026-11-26T00:00:00Z"),
    });
    write(
      JSON.stringify({
        "https://accounts.x.ai/sign-in": { key: "legacy-test-token", expires_at: 1795000000 },
      }),
    );
    assert.deepEqual(await grokDeps.readToken(), { token: "legacy-test-token", expiresAt: 1795000000_000 });
  });

  it("reads ~/.grok when GROK_HOME is empty", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "schmear-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    process.env.GROK_HOME = "";
    try {
      mkdirSync(join(fakeHome, ".grok"));
      writeFileSync(
        join(fakeHome, ".grok", "auth.json"),
        JSON.stringify({ "https://auth.x.ai::id": { key: TOKEN } }),
      );
      assert.deepEqual(await grokDeps.readToken(), { token: TOKEN, expiresAt: undefined });
    } finally {
      process.env.HOME = prevHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("keeps the file's text out of a parse error", async () => {
    write(`{"https://auth.x.ai::client-id": {"key": "${TOKEN}"`);
    await assert.rejects(grokDeps.readToken(), (err: Error) => !err.message.includes(TOKEN));
  });
});
