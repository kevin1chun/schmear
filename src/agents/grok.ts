import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ClientContext, RequestError } from "@agentclientprotocol/sdk";
import { withAcp, workerEnv } from "../acp.ts";
import type { AgentAdapter, Lane, LaunchSpec, UsageReading, WorkerFailure } from "../types.ts";
import { DETECT_TIMEOUT_MS, errorMessage, isRecord, unreadable, versionLine } from "../util.ts";
import { window } from "./shared.ts";

const GROK_ARGS = ["--no-auto-update", "agent", "stdio"];
const GROK_QUOTA_RE = /usage limit|rate.?limit|quota|credits?/i;

const USAGE_TIMEOUT_MS = 15_000;
const GROK_COM_BUDGET_MS = 6_000;
const GROK_COM_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const CLI_PROXY_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
/** One gRPC-web data frame holding `GetGrokCreditsConfigRequest{exclude_legacy_monthly_usage: false}`. */
const GROK_COM_REQUEST = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x02, 0x08, 0x00]);
const NO_PERCENT = "Grok reports no usage percent";
const PERIOD_MONTHLY = 1;
const PERIOD_WEEKLY = 2;

/** Runs `op` on a `grok agent stdio` connection; rejects on a spawn error, timeout or JSON-RPC error. */
function withGrokAcp<T>(bin: string, timeoutMs: number, op: (ctx: ClientContext) => Promise<T>): Promise<T> {
  const kill = AbortSignal.timeout(timeoutMs);
  return withAcp({ agent: "grok", command: bin, args: GROK_ARGS, env: workerEnv(), kill }, op, (err) => {
    throw kill.aborted ? new Error(`grok agent stdio did not answer within ${timeoutMs} ms`) : err;
  });
}

export interface GrokToken {
  token: string;
  expiresAt?: number;
}
export interface GrokDeps {
  readToken(): Promise<GrokToken | null>;
  fetch: typeof fetch;
}

/** Credits answer of `_x.ai/billing` or the CLI proxy; `usedPercent` null = unknown usage (spec 8.3 step 1). */
type GrokCredits = { error: string } | { usedPercent: number | null; resetsAt: number; periodHours: number };

interface GrokProtoPeriod {
  type: number;
  start?: number;
  end?: number;
}
/** grok.com answer: a wire percent, or a validated implicit zero (`implicitZero`). */
type GrokProto =
  | { error: string }
  | { usedPercent: number; implicitZero: boolean; period: GrokProtoPeriod | null };

type GrokSource = "acp" | "grok.com" | "cli-proxy";

function isoMs(value: unknown): number | null {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
}

function num(value: unknown): number | null {
  const n =
    typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function parseGrokCredits(json: unknown, now: number): GrokCredits {
  const config = isRecord(json) && isRecord(json.config) ? json.config : {};
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : {};
  const currentEnd = isoMs(period.end);
  const [startValue, resetsAt] =
    currentEnd !== null
      ? [period.start, currentEnd]
      : [config.billingPeriodStart, isoMs(config.billingPeriodEnd)];
  const start = isoMs(startValue);
  if (start === null || resetsAt === null || start >= resetsAt || start > now) {
    return { error: "Grok billing period unknown" };
  }
  const cap = isRecord(config.onDemandCap) ? num(config.onDemandCap.val) : null;
  const used = isRecord(config.onDemandUsed) ? num(config.onDemandUsed.val) : null;
  const usedPercent =
    num(config.creditUsagePercent) ?? (cap !== null && cap > 0 && used !== null ? (used / cap) * 100 : null);
  return { usedPercent, resetsAt, periodHours: (resetsAt - start) / 3_600_000 };
}

/** A non-zero on-demand cap or prepaid balance (`Cent.val`, USD cents, https://github.com/steipete/CodexBar/blob/94cc400e1b190f444e2a4d1910c2d63cfbb47e9f/docs/grok.md) can bill past the plan, so the router skips Grok. */
export function grokSpendOn(json: unknown): string | undefined {
  const config = isRecord(json) && isRecord(json.config) ? json.config : {};
  const on: string[] = [];
  for (const [field, name] of [
    ["onDemandCap", "on-demand cap"],
    ["prepaidBalance", "prepaid balance"],
  ]) {
    const value = config[field];
    const cents = isRecord(value) ? num(value.val) : null;
    if (cents !== null && cents > 0) {
      on.push(`${name} $${(cents / 100).toFixed(2)}`);
    }
  }
  return on.length === 0 ? undefined : `grok on-demand or prepaid spend is on (${on.join(", ")})`;
}

interface ProtoField {
  no: number;
  wire: number;
  int: number;
  bytes: Uint8Array;
}

/** Splits one protobuf message into fields; throws on field number 0, an unknown wire type, truncation or a varint over 10 bytes. */
function protoFields(buf: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let pos = 0;
  const varint = (): number => {
    let value = 0;
    for (let i = 0; ; i++) {
      if (pos >= buf.length) {
        throw new Error("truncated varint");
      }
      const b = buf[pos++];
      if (i === 9 && b > 1) {
        throw new Error("varint overflows 64 bits");
      }
      value += (b & 0x7f) * 2 ** (7 * i);
      if (b < 0x80) {
        return value;
      }
    }
  };
  const take = (n: number): Uint8Array => {
    if (pos + n > buf.length) {
      throw new Error("truncated field");
    }
    pos += n;
    return buf.subarray(pos - n, pos);
  };
  while (pos < buf.length) {
    const tag = varint();
    const no = Math.floor(tag / 8);
    const wire = tag % 8;
    if (no === 0 || no > 0x1fffffff) {
      throw new Error(`invalid field number ${no}`);
    }
    if (wire === 0) {
      out.push({ no, wire, int: varint(), bytes: new Uint8Array() });
    } else if (wire === 1 || wire === 2 || wire === 5) {
      out.push({ no, wire, int: 0, bytes: take(wire === 1 ? 8 : wire === 5 ? 4 : varint()) });
    } else {
      throw new Error(`unknown wire type ${wire}`);
    }
  }
  return out;
}

function expectWire(f: ProtoField, wire: number): ProtoField {
  if (f.wire !== wire) {
    throw new Error(`field ${f.no} has wire type ${f.wire}`);
  }
  return f;
}

function protoFloat(f: ProtoField): number {
  const b = expectWire(f, 5).bytes;
  return new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true);
}

function timestampMs(buf: Uint8Array): number {
  let seconds = 0;
  for (const f of protoFields(buf)) {
    if (f.no === 1) {
      seconds = expectWire(f, 0).int;
    }
  }
  return seconds * 1000;
}

/** Data-frame payloads of a gRPC-web body, or the body itself when it is raw protobuf. */
function grpcWebPayload(bytes: Uint8Array): Uint8Array | { error: string } {
  if (bytes.length === 0 || (bytes[0] !== 0x00 && bytes[0] !== 0x80)) {
    return bytes;
  }
  const data: Uint8Array[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    if (pos + 5 > bytes.length) {
      throw new Error("truncated gRPC-web frame");
    }
    const flag = bytes[pos];
    const length = new DataView(bytes.buffer, bytes.byteOffset + pos + 1, 4).getUint32(0);
    if (pos + 5 + length > bytes.length) {
      throw new Error("truncated gRPC-web frame");
    }
    const body = bytes.subarray(pos + 5, pos + 5 + length);
    pos += 5 + length;
    if (flag === 0x00) {
      data.push(body);
    } else if (flag === 0x80) {
      const status = /grpc-status:\s*(\d+)/i.exec(new TextDecoder().decode(body))?.[1];
      if (status !== undefined && status !== "0") {
        return { error: `grok.com grpc-status ${status}` };
      }
    } else {
      throw new Error(`unknown gRPC-web frame flag ${flag}`);
    }
  }
  return Buffer.concat(data);
}

export function parseGrokProto(bytes: Uint8Array, now: number): GrokProto {
  let creditPercent: number | undefined;
  let productPercent = false;
  let period: GrokProtoPeriod | null = null;
  try {
    const payload = grpcWebPayload(bytes);
    if (!(payload instanceof Uint8Array)) {
      return payload;
    }
    for (const response of protoFields(payload)) {
      if (response.no !== 1) {
        continue;
      }
      for (const f of protoFields(expectWire(response, 2).bytes)) {
        if (f.no === 1) {
          creditPercent = protoFloat(f);
        } else if (f.no === 7) {
          for (const p of protoFields(expectWire(f, 2).bytes)) {
            if (p.no === 2) {
              protoFloat(p);
              productPercent = true;
            }
          }
        } else if (f.no === 8) {
          period ??= { type: 0 };
          for (const p of protoFields(expectWire(f, 2).bytes)) {
            if (p.no === 1) {
              period.type = expectWire(p, 0).int;
            } else if (p.no === 2) {
              period.start = timestampMs(expectWire(p, 2).bytes);
            } else if (p.no === 3) {
              period.end = timestampMs(expectWire(p, 2).bytes);
            }
          }
        }
      }
    }
  } catch (err) {
    return { error: `${NO_PERCENT}: grok.com response incomplete (${errorMessage(err)})` };
  }
  if (creditPercent !== undefined) {
    // A present but non-finite percent is unreadable, never the implicit zero below.
    return Number.isFinite(creditPercent)
      ? { usedPercent: creditPercent, implicitZero: false, period }
      : { error: NO_PERCENT };
  }
  const active =
    period !== null &&
    (period.type === PERIOD_WEEKLY || period.type === PERIOD_MONTHLY) &&
    period.start !== undefined &&
    period.end !== undefined &&
    period.start <= now &&
    now < period.end;
  if (active && !productPercent) {
    return { usedPercent: 0, implicitZero: true, period };
  }
  return { error: NO_PERCENT };
}

/** `expires_at` as epoch ms: an ISO string, or epoch seconds or ms (unverified format, R35). */
function expiryMs(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value < 1e12 ? value * 1000 : value;
  }
  return isoMs(value) ?? undefined;
}

/** Grok's config directory (`${GROK_HOME:-~/.grok}`). */
export const grokHome = (): string => process.env.GROK_HOME || join(homedir(), ".grok");

/** The grok CLI's login token, read in memory per check; never logged, persisted or put in an error. */
async function readGrokToken(): Promise<GrokToken | null> {
  const path = join(grokHome(), "auth.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  let auth: unknown;
  try {
    auth = JSON.parse(text);
  } catch {
    // JSON.parse's message quotes the file's text, which holds the token.
    throw new Error(`${path} is not valid JSON`);
  }
  if (!isRecord(auth)) {
    return null;
  }
  const scopes = [
    ...Object.keys(auth).filter((k) => k.startsWith("https://auth.x.ai::")),
    "https://accounts.x.ai/sign-in",
  ];
  for (const scope of scopes) {
    const entry = auth[scope];
    if (isRecord(entry) && typeof entry.key === "string" && entry.key !== "") {
      return { token: entry.key, expiresAt: expiryMs(entry.expires_at) };
    }
  }
  return null;
}

export const grokDeps: GrokDeps = { readToken: readGrokToken, fetch };

/** Spec 8.3: ACP `_x.ai/billing`, the CLI proxy on JSON-RPC `-32601`, and the grok.com retry for unknown usage. Never throws. */
export async function readGrokUsage(bin: string, deps: GrokDeps = grokDeps): Promise<UsageReading> {
  const fetchedAt = Date.now();
  const fail = (error: string): UsageReading => unreadable("grok", error, [], fetchedAt);
  let token: Promise<string | { error: string }> | undefined;
  const bearer = (): Promise<string | { error: string }> => {
    token ??= deps.readToken().then((t) => {
      if (t === null) {
        return { error: "no Grok login token (run `grok login`)" };
      }
      if (t.expiresAt !== undefined && t.expiresAt <= Date.now()) {
        return { error: "Grok login token expired (run `grok login`)" };
      }
      return t.token;
    });
    return token;
  };

  try {
    let source: GrokSource = "acp";
    let billing: unknown;
    try {
      billing = await withGrokAcp(bin, USAGE_TIMEOUT_MS, (ctx) => ctx.request("_x.ai/billing", {}));
    } catch (err) {
      if (!(err instanceof RequestError && err.code === -32601)) {
        return fail(`Grok ACP billing failed: ${errorMessage(err)}`);
      }
      source = "cli-proxy";
      const auth = await bearer();
      if (typeof auth !== "string") {
        return fail(`Grok ACP billing failed (${err.message}); CLI proxy skipped: ${auth.error}`);
      }
      const res = await deps.fetch(CLI_PROXY_URL, {
        headers: {
          Authorization: `Bearer ${auth}`,
          "x-xai-token-auth": "xai-grok-cli",
          Accept: "application/json",
        },
        credentials: "omit",
        signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
      });
      if (!res.ok) {
        return fail(`Grok ACP billing failed (${err.message}); CLI proxy HTTP ${res.status}`);
      }
      billing = await res.json();
    }

    const credits = parseGrokCredits(billing, fetchedAt);
    if ("error" in credits) {
      return fail(credits.error);
    }
    const spendOn = grokSpendOn(billing);
    let usedPercent = credits.usedPercent;
    if (usedPercent === null) {
      const auth = await bearer();
      if (typeof auth !== "string") {
        return fail(`${NO_PERCENT}; grok.com retry skipped: ${auth.error}`);
      }
      const res = await deps.fetch(GROK_COM_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth}`,
          "Content-Type": "application/grpc-web+proto",
          "X-Grpc-Web": "1",
        },
        body: GROK_COM_REQUEST,
        credentials: "omit",
        signal: AbortSignal.timeout(GROK_COM_BUDGET_MS),
      });
      const status = res.headers.get("grpc-status");
      if (!res.ok || (status !== null && status !== "0")) {
        return fail(`${NO_PERCENT}; grok.com ${res.ok ? `grpc-status ${status}` : `HTTP ${res.status}`}`);
      }
      const proto = parseGrokProto(new Uint8Array(await res.arrayBuffer()), fetchedAt);
      if ("error" in proto) {
        return fail(proto.error);
      }
      usedPercent = proto.usedPercent;
      source = "grok.com";
    }
    return {
      agent: "grok",
      fetchedAt,
      source,
      pools: [
        {
          id: "grok",
          agent: "grok",
          keys: ["grok"],
          windows: [window(usedPercent, credits.resetsAt, "period", credits.periodHours)],
        },
      ],
      ...(spendOn === undefined ? {} : { error: spendOn }),
      warnings: [],
    };
  } catch (err) {
    return fail(`Grok usage read failed: ${errorMessage(err)}`);
  }
}

export const grokAdapter: AgentAdapter = {
  id: "grok",

  isClient(clientName: string): boolean {
    return clientName.startsWith("grok-shell-");
  },

  async find(bin: string): Promise<{ version: string } | { error: string }> {
    try {
      const [version] = await Promise.all([
        versionLine(bin, workerEnv()),
        withGrokAcp(bin, DETECT_TIMEOUT_MS, async () => {}),
      ]);
      return { version };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  },

  readUsage(bin: string): Promise<UsageReading> {
    return readGrokUsage(bin);
  },

  async launch(lane: Lane, _cwd: string, bin: string): Promise<LaunchSpec> {
    const grokConfig = { models: { default: lane.model, default_reasoning_effort: lane.effort } };
    return {
      command: bin,
      args: GROK_ARGS,
      env: workerEnv({ GROK_CONFIG: JSON.stringify(grokConfig) }),
      config: { model: lane.model },
    };
  },

  classifyFailure(f: WorkerFailure): "quota" | "failed" {
    return GROK_QUOTA_RE.test(f.message) ? "quota" : "failed";
  },
};
