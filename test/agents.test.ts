import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { agyAdapter } from "../src/agents/agy.ts";
import { claudeAdapter, isClaudeQuotaRateLimit } from "../src/agents/claude.ts";
import { codexAdapter, codexConfigPath, codexMode } from "../src/agents/codex.ts";
import { grokAdapter, parseGrokProto } from "../src/agents/grok.ts";
import { window } from "../src/agents/shared.ts";
import { route } from "../src/router.ts";
import type { Config, Lane, UsageReading } from "../src/types.ts";
import type { FakeAppServerScript } from "./fake-app-server.ts";

const FAKE_APP_SERVER = fileURLToPath(new URL("./fake-app-server.ts", import.meta.url));

const CWD = "/repo/work";

const SUB_LANE: Lane = {
  id: "claude:haiku",
  agent: "claude",
  key: "claude",
  tier: 1,
  model: "haiku",
  effort: "medium",
};

function withFakePath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prevPath = process.env.PATH;
  const prevApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.PATH = dir;
  process.env.ANTHROPIC_API_KEY = "should-be-stripped";
  return fn().finally(() => {
    if (prevPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = prevPath;
    }
    if (prevApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = prevApiKey;
    }
  });
}

function writeFakeClaude(dir: string, authPayload: Record<string, unknown>, version = "2.1.330"): string {
  const binPath = join(dir, "claude");
  const script = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write(${JSON.stringify(`${version} (Claude Code)\n`)});
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status" && args[2] === "--json") {
  if (process.env.ANTHROPIC_API_KEY !== undefined || process.env.SCHMEAR_WORKER !== "1") {
    process.stderr.write("env not stripped\\n");
    process.exit(2);
  }
  process.stdout.write(${JSON.stringify(JSON.stringify(authPayload))});
  process.exit(0);
}
process.exit(1);
`;
  writeFileSync(binPath, script, "utf8");
  chmodSync(binPath, 0o755);
  return binPath;
}

describe("claudeAdapter metadata", () => {
  it("exposes id and isClient", () => {
    assert.equal(claudeAdapter.id, "claude");
    assert.equal(claudeAdapter.isClient("claude-code"), true);
    assert.equal(claudeAdapter.isClient("codex-mcp-client"), false);
    assert.equal(claudeAdapter.isClient("claude-code-extra"), false);
    assert.equal(claudeAdapter.isClient(""), false);
  });
});

describe("claudeAdapter.launch", () => {
  it("builds LaunchSpec with resolved bin, requireAuth, model and effort, and no sandbox or mode", async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "leaked-key";
    try {
      const spec = await claudeAdapter.launch(SUB_LANE, CWD, "/usr/local/bin/claude");
      assert.equal(spec.command, process.execPath);
      assert.equal(spec.args.length, 1);
      assert.ok(spec.args[0].endsWith("dist/index.js"), `unexpected bin path: ${spec.args[0]}`);
      assert.equal(existsSync(spec.args[0]), true);
      assert.equal(spec.args.includes("--hide-claude-auth"), false);
      assert.equal(spec.env.CLAUDE_CODE_EXECUTABLE, "/usr/local/bin/claude");
      assert.equal(spec.env.SCHMEAR_WORKER, "1");
      assert.equal(spec.env.ANTHROPIC_API_KEY, undefined);
      assert.deepEqual(spec.requireAuth, { kind: "account" });
      assert.equal("sessionMeta" in spec, false);
      assert.equal("mode" in spec, false);
      assert.deepEqual(spec.config, { model: "haiku", effort: "medium" });
    } finally {
      if (prevKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = prevKey;
      }
    }
  });
});

describe("claudeAdapter.classifyFailure", () => {
  it("classifies -32603 billing_error as quota", () => {
    assert.equal(
      claudeAdapter.classifyFailure({
        code: -32603,
        message: "Billing error",
        data: { errorKind: "billing_error" },
      }),
      "quota",
    );
  });

  it("classifies -32603 rate_limit with rejected status as quota", () => {
    assert.equal(
      claudeAdapter.classifyFailure({
        code: -32603,
        message: "Rate limited",
        data: { errorKind: "rate_limit", rateLimit: { status: "rejected" } },
      }),
      "quota",
    );
  });

  it("classifies bare transient rate_limit as failed", () => {
    assert.equal(
      claudeAdapter.classifyFailure({
        code: -32603,
        message: "Rate limited",
        data: { errorKind: "rate_limit" },
      }),
      "failed",
    );
    assert.equal(
      claudeAdapter.classifyFailure({
        code: -32603,
        message: "Rate limited",
        data: { errorKind: "rate_limit", rateLimit: { status: "allowed_warning" } },
      }),
      "failed",
    );
  });

  it("requires -32603 for data.errorKind classification", () => {
    assert.equal(
      claudeAdapter.classifyFailure({
        code: -32000,
        message: "Auth required",
        data: { errorKind: "billing_error" },
      }),
      "failed",
    );
  });

  it("classifies live rateLimit rejected or overage flags as quota", () => {
    assert.equal(
      claudeAdapter.classifyFailure({ message: "cancelled", rateLimit: { status: "rejected" } }),
      "quota",
    );
    assert.equal(
      claudeAdapter.classifyFailure({
        message: "cancelled",
        rateLimit: { status: "allowed", isUsingOverage: true },
      }),
      "quota",
    );
    assert.equal(
      claudeAdapter.classifyFailure({
        message: "cancelled",
        rateLimit: { status: "allowed", overageInUse: true },
      }),
      "quota",
    );
    assert.equal(isClaudeQuotaRateLimit({ status: "allowed", isUsingOverage: false }), false);
    assert.equal(
      claudeAdapter.classifyFailure({
        message: "other error",
        rateLimit: { status: "allowed", isUsingOverage: false, overageInUse: false },
      }),
      "failed",
    );
  });

  it("classifies generic failures as failed", () => {
    assert.equal(claudeAdapter.classifyFailure({ message: "process crashed" }), "failed");
  });
});

describe("claudeAdapter.find", () => {
  it("returns the version when claude.ai login is active without apiKeySource", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schmear-claude-find-"));
    try {
      const binPath = writeFakeClaude(dir, { loggedIn: true, authMethod: "claude.ai" });
      await withFakePath(dir, async () => {
        assert.deepEqual(await claudeAdapter.find(binPath), { version: "2.1.330 (Claude Code)" });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the reason when apiKeySource is set, logged out, or authMethod is not claude.ai", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schmear-claude-find-"));
    try {
      const binPath = writeFakeClaude(dir, {
        loggedIn: true,
        authMethod: "claude.ai",
        apiKeySource: "apiKeyHelper",
      });
      await withFakePath(dir, async () => {
        assert.deepEqual(await claudeAdapter.find(binPath), {
          error: 'claude uses an API key from "apiKeyHelper", which workers would bill',
        });
      });

      writeFakeClaude(dir, { loggedIn: false, authMethod: "claude.ai" });
      await withFakePath(dir, async () => {
        assert.deepEqual(await claudeAdapter.find(binPath), { error: "claude is not logged in" });
      });

      writeFakeClaude(dir, { loggedIn: true, authMethod: "apiKey" });
      await withFakePath(dir, async () => {
        assert.deepEqual(await claudeAdapter.find(binPath), {
          error: 'claude needs a claude.ai login, not "apiKey"',
        });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const CODEX_LANE: Lane = {
  id: "codex:gpt-5.6-terra",
  agent: "codex",
  key: "codex",
  tier: 1,
  model: "gpt-5.6-terra",
  effort: "max",
};
const GROK_LANE: Lane = {
  id: "grok:grok-4.7",
  agent: "grok",
  key: "grok",
  tier: 1,
  model: "grok-4.7",
  effort: "medium",
};
const AGY_LANE: Lane = {
  id: "agy-gemini:gemini-4-hydrogen",
  agent: "agy",
  key: "agy-gemini",
  tier: 1,
  model: "gemini-4-hydrogen",
  effort: "medium",
};

function withEnv(overrides: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(overrides)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of saved.entries()) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });
}

function writeFakeCodex(
  dir: string,
  opts: {
    version?: string;
    fail?: boolean;
    planType?: unknown;
    omitPlanType?: boolean;
    rateLimitsResult?: Record<string, unknown>;
    rpcError?: string;
    rpcFail?: boolean;
  } = {},
): string {
  const binPath = join(dir, "codex");
  const rateLimitsResult =
    opts.rateLimitsResult ??
    ({
      rateLimits: opts.omitPlanType ? {} : { planType: "planType" in opts ? opts.planType : "plus" },
    } as Record<string, unknown>);
  const script = `#!${process.execPath}
const readline = require("node:readline");
const args = process.argv.slice(2);
if (
  process.env.OPENAI_API_KEY !== undefined ||
  process.env.CODEX_API_KEY !== undefined ||
  process.env.SCHMEAR_WORKER !== "1"
) {
  process.stderr.write("env not stripped\\n");
  process.exit(2);
}
if (args[0] === "--version") {
  if (${JSON.stringify(Boolean(opts.fail))}) {
    process.exit(1);
  }
  process.stdout.write(${JSON.stringify(`${opts.version ?? "codex-cli 0.147.0"}\n`)});
  process.exit(0);
}
if (args.join(" ") === "-s read-only -a never app-server") {
  if (${JSON.stringify(Boolean(opts.rpcFail))}) {
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fake" } }) + "\\n");
    } else if (msg.method === "account/rateLimits/read") {
      if (${JSON.stringify(opts.rpcError ?? null)}) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: ${JSON.stringify(opts.rpcError ?? "")} } }) + "\\n");
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: ${JSON.stringify(rateLimitsResult)} }) + "\\n");
      }
    }
  });
  return;
}
process.exit(1);
`;
  writeFileSync(binPath, script, "utf8");
  chmodSync(binPath, 0o755);
  return binPath;
}

interface FakeCodexRun {
  bin: string;
  pidFile: string;
  readFile: string;
  cleanup: () => void;
}

function writeFakeAppServer(opts: Omit<FakeAppServerScript, "pidFile" | "readFile">): FakeCodexRun {
  const dir = mkdtempSync(join(tmpdir(), "schmear-codex-config-"));
  const pidFile = join(dir, "pid");
  const readFile = join(dir, "read.json");
  const scriptFile = join(dir, "script.json");
  writeFileSync(scriptFile, JSON.stringify({ ...opts, pidFile, readFile }), "utf8");
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    `#!/bin/sh\nexec "${process.execPath}" "${FAKE_APP_SERVER}" "$(cat "${scriptFile}")" "$@"\n`,
    "utf8",
  );
  chmodSync(bin, 0o755);
  return { bin, pidFile, readFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function waitFor(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !ok(); i++) {
    await sleep(20);
  }
  assert.equal(ok(), true, "condition not met in time");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeFakeGrok(
  dir: string,
  opts: { version?: string; initFail?: boolean; initError?: boolean } = {},
): string {
  const binPath = join(dir, "grok");
  const script = `#!${process.execPath}
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  if (process.env.XAI_API_KEY !== undefined || process.env.SCHMEAR_WORKER !== "1") {
    process.stderr.write("env not stripped\\n");
    process.exit(2);
  }
  process.stdout.write(${JSON.stringify(`${opts.version ?? "grok 1.0.77 (50ca579fa996) [stable]"}\n`)});
  process.exit(0);
}
if (args[0] === "--no-auto-update" && args[1] === "agent" && args[2] === "stdio") {
  if (process.env.XAI_API_KEY !== undefined || process.env.SCHMEAR_WORKER !== "1") {
    process.exit(2);
  }
  if (${JSON.stringify(Boolean(opts.initFail))}) {
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      if (${JSON.stringify(Boolean(opts.initError))}) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "auth required" } }) + "\\n");
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + "\\n");
      }
    }
  });
  return;
}
process.exit(1);
`;
  writeFileSync(binPath, script, "utf8");
  chmodSync(binPath, 0o755);
  return binPath;
}

function writeFakeAgy(dir: string, opts: { version?: string; fail?: boolean } = {}): string {
  const binPath = join(dir, "agy");
  const script = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "--version") {
  if (
    process.env.GEMINI_API_KEY !== undefined ||
    process.env.SCHMEAR_WORKER !== "1" ||
    process.env.AGY_CLI_DISABLE_AUTO_UPDATE !== "true"
  ) {
    process.stderr.write("env invalid\\n");
    process.exit(2);
  }
  if (${JSON.stringify(Boolean(opts.fail))}) {
    process.exit(1);
  }
  process.stdout.write(${JSON.stringify(`${opts.version ?? "1.5.14"}\n`)});
  process.exit(0);
}
process.exit(1);
`;
  writeFileSync(binPath, script, "utf8");
  chmodSync(binPath, 0o755);
  return binPath;
}

describe("codexAdapter", () => {
  it("exposes id and isClient", () => {
    assert.equal(codexAdapter.id, "codex");
    assert.equal(codexAdapter.isClient("codex-mcp-client"), true);
    assert.equal(codexAdapter.isClient("codex-mcp-client-extra"), false);
    assert.equal(codexAdapter.isClient("claude-code"), false);
    assert.equal(codexAdapter.isClient(""), false);
  });

  it("builds LaunchSpec from config/read with defaults, then kills app-server", async () => {
    const fake = writeFakeAppServer({});
    try {
      await withEnv({ OPENAI_API_KEY: "leaked", CODEX_API_KEY: "leaked" }, async () => {
        const spec = await codexAdapter.launch(CODEX_LANE, CWD, fake.bin);
        assert.equal(spec.command, process.execPath);
        assert.equal(spec.args.length, 1);
        assert.ok(spec.args[0].endsWith("dist/index.js"), `unexpected bin path: ${spec.args[0]}`);
        assert.equal(existsSync(spec.args[0]), true);
        assert.equal(spec.env.CODEX_PATH, fake.bin);
        assert.equal(spec.env.SCHMEAR_WORKER, "1");
        assert.equal(spec.env.OPENAI_API_KEY, undefined);
        assert.equal(spec.env.CODEX_API_KEY, undefined);
        assert.deepEqual(spec.config, { mode: "workspace-write", model: "gpt-5.6-terra", effort: "max" });
      });
      assert.deepEqual(JSON.parse(readFileSync(fake.readFile, "utf8")), {
        initialized: true,
        params: { cwd: CWD },
      });
      const pid = Number(readFileSync(fake.pidFile, "utf8"));
      await waitFor(() => !isAlive(pid));
    } finally {
      fake.cleanup();
    }
  });

  it("takes the mode from the config", async () => {
    const fake = writeFakeAppServer({
      config: { sandbox_mode: "read-only", approval_policy: "on-request", approvals_reviewer: "user" },
    });
    try {
      assert.equal((await codexAdapter.launch(CODEX_LANE, CWD, fake.bin)).config?.mode, "read-only");
    } finally {
      fake.cleanup();
    }
  });

  it("leaves mode unset when default_permissions is set, keeping model and effort", async () => {
    const fake = writeFakeAppServer({
      config: {
        sandbox_mode: "danger-full-access",
        approval_policy: "never",
        default_permissions: ":workspace",
      },
    });
    try {
      const spec = await codexAdapter.launch(CODEX_LANE, CWD, fake.bin);
      assert.deepEqual(spec.config, { model: "gpt-5.6-terra", effort: "max" });
    } finally {
      fake.cleanup();
    }
  });

  it("fails naming the triple, Codex config file and keys when no mode matches", async () => {
    const fake = writeFakeAppServer({ config: { approval_policy: "never" } });
    try {
      await withEnv({ CODEX_HOME: "/custom/codex-home" }, async () => {
        await assert.rejects(codexAdapter.launch(CODEX_LANE, CWD, fake.bin), (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(
            err.message,
            /sandbox_mode=workspace-write, approval_policy=never, approvals_reviewer=user/,
          );
          assert.ok(err.message.includes(join("/custom/codex-home", "config.toml")), err.message);
          assert.match(err.message, /default_permissions/);
          return true;
        });
      });
    } finally {
      fake.cleanup();
    }
  });

  it("fails on a config/read error reply and on app-server exit", async () => {
    const errored = writeFakeAppServer({ error: "boom" });
    const exited = writeFakeAppServer({ exitOnConfigRead: true });
    try {
      await assert.rejects(codexAdapter.launch(CODEX_LANE, CWD, errored.bin), /boom/);
      await assert.rejects(codexAdapter.launch(CODEX_LANE, CWD, exited.bin), /exited before answering/);
    } finally {
      errored.cleanup();
      exited.cleanup();
    }
  });

  it("times out after 15 s without a config/read reply and kills app-server", async () => {
    const fake = writeFakeAppServer({ hang: true });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const launched = assert.rejects(codexAdapter.launch(CODEX_LANE, CWD, fake.bin), /within 15000 ms/);
      await waitFor(() => existsSync(fake.readFile));
      mock.timers.tick(15_000);
      await launched;
      const pid = Number(readFileSync(fake.pidFile, "utf8"));
      await waitFor(() => !isAlive(pid));
    } finally {
      mock.timers.reset();
      fake.cleanup();
    }
  });

  it("classifies -32603 usageLimitExceeded as quota and transient errors as failed", () => {
    assert.equal(
      codexAdapter.classifyFailure({
        code: -32603,
        message: "Usage limit exceeded",
        data: { codexErrorInfo: "usageLimitExceeded" },
      }),
      "quota",
    );
    assert.equal(
      codexAdapter.classifyFailure({
        code: -32603,
        message: "Rate limited",
        data: { codexErrorInfo: "rateLimitExceeded" },
      }),
      "failed",
    );
    assert.equal(
      codexAdapter.classifyFailure({
        code: -32000,
        message: "Auth required",
        data: { codexErrorInfo: "usageLimitExceeded" },
      }),
      "failed",
    );
    assert.equal(codexAdapter.classifyFailure({ message: "other error" }), "failed");
  });

  it("finds codex only with a subscription planType and names the reason when failing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schmear-codex-find-"));
    try {
      await withEnv({ PATH: dir, OPENAI_API_KEY: "strip-me", CODEX_API_KEY: "strip-me" }, async () => {
        const binPath = writeFakeCodex(dir, { planType: "plus" });
        assert.deepEqual(await codexAdapter.find(binPath), { version: "codex-cli 0.147.0" });

        writeFakeCodex(dir, { planType: "free" });
        assert.deepEqual(await codexAdapter.find(binPath), { version: "codex-cli 0.147.0" });

        writeFakeCodex(dir, { planType: "Pro" });
        assert.deepEqual(await codexAdapter.find(binPath), { version: "codex-cli 0.147.0" });

        const error = async () => {
          const found = await codexAdapter.find(binPath);
          assert.ok("error" in found);
          return found.error;
        };
        writeFakeCodex(dir, { fail: true });
        assert.match(await error(), /--version/);

        writeFakeCodex(dir, { rpcFail: true });
        assert.match(await error(), /codex app-server exited before answering/);

        writeFakeCodex(dir, { rpcError: "not logged in" });
        assert.match(await error(), /not logged in/);

        writeFakeCodex(dir, { rateLimitsResult: {} });
        assert.equal(await error(), "Codex rate-limit reply has no rateLimits");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails find() naming the plan when planType does not bill a subscription", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schmear-codex-plan-"));
    try {
      await withEnv({ PATH: dir }, async () => {
        const binPath = join(dir, "codex");
        for (const [opts, pattern] of [
          [{ planType: "api" }, /"api"/],
          [{ planType: "unknown" }, /"unknown"/],
          [{ planType: "enterprise_cbp_usage_based" }, /"enterprise_cbp_usage_based"/],
          [{ planType: null }, /plan null/],
          [{ omitPlanType: true }, /plan missing/],
          [{ planType: "" }, /plan ""/],
        ] as const) {
          writeFakeCodex(dir, opts);
          const found = await codexAdapter.find(binPath);
          assert.ok("error" in found);
          assert.match(found.error, pattern);
          assert.match(found.error, /does not bill a ChatGPT subscription/);
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("codexMode", () => {
  it("maps each spec 8.2 row", () => {
    assert.equal(codexMode("read-only", "on-request", "user"), "read-only");
    assert.equal(codexMode("workspace-write", "on-request", "user"), "workspace-write");
    assert.equal(codexMode("workspace-write", "on-request", "auto_review"), "agent");
    assert.equal(codexMode("danger-full-access", "never", "user"), "agent-full-access");
  });

  it("throws naming the triple, Codex config file and keys for any other", () => {
    assert.throws(
      () => codexMode("workspace-write", "never", "user", "/tmp/codex/config.toml"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(
          err.message,
          /sandbox_mode=workspace-write, approval_policy=never, approvals_reviewer=user/,
        );
        assert.ok(err.message.includes("/tmp/codex/config.toml"), err.message);
        assert.match(err.message, /sandbox_mode.*approval_policy.*approvals_reviewer.*default_permissions/);
        return true;
      },
    );
    assert.throws(() => codexMode("read-only", "on-request", "auto_review"), /read-only/);
  });

  it("codexConfigPath uses CODEX_HOME when set and ~/.codex/config.toml otherwise", () => {
    assert.equal(codexConfigPath({ CODEX_HOME: "/alt/codex" }), join("/alt/codex", "config.toml"));
    assert.equal(codexConfigPath({}), join(homedir(), ".codex", "config.toml"));
  });
});

describe("grokAdapter", () => {
  it("exposes id and isClient", () => {
    assert.equal(grokAdapter.id, "grok");
    assert.equal(grokAdapter.isClient("grok-shell-probe"), true);
    assert.equal(grokAdapter.isClient("grok-shell-brokerx"), true);
    assert.equal(grokAdapter.isClient("grok-shell"), false);
    assert.equal(grokAdapter.isClient("claude-code"), false);
    assert.equal(grokAdapter.isClient(""), false);
  });

  it("builds LaunchSpec with --no-auto-update agent stdio, GROK_CONFIG, model only, and no sandbox variable", async () => {
    await withEnv({ XAI_API_KEY: "leaked" }, async () => {
      const spec = await grokAdapter.launch(GROK_LANE, CWD, "/usr/local/bin/grok");
      assert.equal(spec.command, "/usr/local/bin/grok");
      assert.deepEqual(spec.args, ["--no-auto-update", "agent", "stdio"]);
      assert.equal("GROK_SANDBOX" in spec.env, false);
      assert.equal(spec.env.SCHMEAR_WORKER, "1");
      assert.equal(spec.env.XAI_API_KEY, undefined);
      assert.deepEqual(JSON.parse(spec.env.GROK_CONFIG), {
        models: { default: "grok-4.7", default_reasoning_effort: "medium" },
      });
      assert.deepEqual(spec.config, { model: "grok-4.7" });
      assert.equal("effort" in (spec.config ?? {}), false);
    });
  });

  it("classifies quota messages and leaves others failed", () => {
    for (const message of [
      "Usage limit reached",
      "Rate limit exceeded",
      "rate_limit error",
      "Monthly quota exhausted",
      "Out of credits",
      "Insufficient credit",
    ]) {
      assert.equal(grokAdapter.classifyFailure({ message }), "quota", message);
    }
    assert.equal(grokAdapter.classifyFailure({ message: "network timeout" }), "failed");
  });

  it("finds grok only when initialize succeeds and names the reason otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schmear-grok-find-"));
    try {
      await withEnv({ PATH: dir, XAI_API_KEY: "strip-me" }, async () => {
        const binPath = writeFakeGrok(dir);
        assert.deepEqual(await grokAdapter.find(binPath), { version: "grok 1.0.77 (50ca579fa996) [stable]" });
        writeFakeGrok(dir, { initError: true });
        const authError = await grokAdapter.find(binPath);
        assert.ok("error" in authError);
        assert.match(authError.error, /auth required/);
        writeFakeGrok(dir, { initFail: true });
        assert.ok("error" in (await grokAdapter.find(binPath)));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agyAdapter", () => {
  it("exposes id and isClient", () => {
    assert.equal(agyAdapter.id, "agy");
    assert.equal(agyAdapter.isClient("antigravity-client"), true);
    assert.equal(agyAdapter.isClient("antigravity-client-extra"), false);
    assert.equal(agyAdapter.isClient("claude-code"), false);
    assert.equal(agyAdapter.isClient(""), false);
  });

  it("builds LaunchSpec with acp, AGY_CLI_DISABLE_AUTO_UPDATE, model and effort, and no mode", async () => {
    await withEnv({ GEMINI_API_KEY: "leaked", GOOGLE_API_KEY: "leaked" }, async () => {
      const spec = await agyAdapter.launch(AGY_LANE, CWD, "/usr/local/bin/agy");
      assert.equal(spec.command, "/usr/local/bin/agy");
      assert.deepEqual(spec.args, ["acp"]);
      assert.equal(spec.env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
      assert.equal(spec.env.SCHMEAR_WORKER, "1");
      assert.equal(spec.env.GEMINI_API_KEY, undefined);
      assert.equal(spec.env.GOOGLE_API_KEY, undefined);
      assert.deepEqual(spec.config, { model: "gemini-4-hydrogen", effort: "medium" });
    });
  });

  it("classifies quota messages and leaves others failed", () => {
    for (const message of [
      "Quota exceeded",
      "Limit reached for model",
      "Pool exhausted",
      "RESOURCE_EXHAUSTED: try again later",
      "HTTP 429 Too Many Requests",
    ]) {
      assert.equal(agyAdapter.classifyFailure({ message }), "quota", message);
    }
    assert.equal(agyAdapter.classifyFailure({ message: "internal server error" }), "failed");
    assert.equal(
      agyAdapter.classifyFailure({
        message: "internal server error",
        stderr: "2026-11-21T10:00:07.429Z quota",
      }),
      "failed",
    );
    assert.equal(agyAdapter.classifyFailure({ message: "at 2026-11-21T10:00:07.429Z" }), "failed");
  });

  it("finds agy and names the reason when failing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schmear-agy-find-"));
    try {
      await withEnv({ PATH: dir, GEMINI_API_KEY: "strip-me" }, async () => {
        const binPath = writeFakeAgy(dir);
        assert.deepEqual(await agyAdapter.find(binPath), { version: "1.5.14" });
        writeFakeAgy(dir, { fail: true });
        const failed = await agyAdapter.find(binPath);
        assert.ok("error" in failed);
        assert.match(failed.error, /--version/);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("non-finite usage", () => {
  const now = Date.UTC(2026, 10, 21);
  const H = 3.6e6;

  it("a grok.com NaN percent is unreadable", () => {
    // GetGrokCreditsConfigResponse{1: GrokCreditsConfig{1: float NaN}}
    const body = new Uint8Array([0x0a, 0x05, 0x0d, 0x00, 0x00, 0xc0, 0x7f]);
    assert.deepEqual(parseGrokProto(body, now), { error: "Grok reports no usage percent" });
  });

  it("a NaN window is out, so the task routes to the healthy lane", () => {
    assert.equal(window(Number.NaN, now + 100 * H, "period", 720).remaining, 0);
    const reading = (agent: "claude" | "grok", used: number): UsageReading => ({
      agent,
      fetchedAt: now,
      warnings: [],
      pools: [{ id: agent, agent, keys: [agent], windows: [window(used, now + 100 * H, "period", 720)] }],
    });
    const config: Config = {
      version: 1,
      agents: {
        claude: { consent: true, path: "/bin/claude" },
        grok: { consent: true, path: "/bin/grok", overageOff: true },
      },
    };
    const lanes: Lane[] = [
      { id: "grok:m", agent: "grok", key: "grok", tier: 1, model: "m", effort: "medium" },
      { id: "claude:m", agent: "claude", key: "claude", tier: 1, model: "m", effort: "medium" },
    ];
    const { assignments } = route({
      now,
      driver: null,
      readings: [reading("claude", 10), reading("grok", Number.NaN)],
      config,
      exclude: new Set(),
      tasks: [lanes],
    });
    assert.equal(assignments[0]?.id, "claude:m");
  });
});
