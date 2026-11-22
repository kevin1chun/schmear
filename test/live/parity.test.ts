import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { runWorker, STRIPPED_ENV_VARS } from "../../src/acp.ts";
import { adapters } from "../../src/agents/index.ts";
import { permit } from "../../src/agents/permit.ts";
import type { AgentId, LaunchSpec } from "../../src/types.ts";
import { isRecord } from "../../src/util.ts";
import { detect, guard } from "./guard.ts";

// Spec §14 "Worker parity". Spends one or two tiny turns per admitted agent. Never run in CI.
const execFileAsync = promisify(execFile);
const PROBES = fileURLToPath(new URL("../../docs/probes/", import.meta.url));
const TEE = join(PROBES, "tee_exec.sh");
const PROMPT = "Reply with exactly: OK";
const SETTLE_INTERVAL_MS = 1_000;
const SETTLE_MAX_MS = 30_000;

const root = realpathSync(mkdtempSync(join(tmpdir(), "schmear-parity-")));
after(() => rmSync(root, { recursive: true, force: true }));

// The native reference runs without the stripped variables too: they are a listed difference, and an
// exported API key would bill the native run to API credits.
const nativeEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !(STRIPPED_ENV_VARS as readonly string[]).includes(key)) {
    nativeEnv[key] = value;
  }
}

const canon = (value: unknown): string =>
  JSON.stringify(value, (_key, x: unknown) =>
    isRecord(x) && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  ) ?? "absent";

const item = (x: unknown): string => (typeof x === "string" ? x : canon(x));

interface Listed {
  nativeOnly?: string[];
  workerOnly?: string[];
}

type Compare = (field: string, native: unknown, worker: unknown, listed?: Listed) => void;

/** Prints each comparison; records every difference not in `listed`. Arrays compare as sets. */
function comparer(t: TestContext, cwd: string): { value: Compare; failures: string[] } {
  const failures: string[] = [];
  // Items from the user's own config are counted, not listed, when both sides agree.
  const shown = (xs: string[]): string => {
    const fixture = xs.filter((x) => x.includes("pk") || x.includes(cwd));
    const other = xs.length - fixture.length;
    return [...fixture, ...(other > 0 ? [`+${other} other`] : [])].join(", ");
  };
  const value: Compare = (field, native, worker, listed = {}) => {
    if (native === undefined && worker === undefined) {
      t.diagnostic(`${field}: absent from both records`);
      failures.push(`${field}: absent from both records`);
      return;
    }
    if (!Array.isArray(native) || !Array.isArray(worker)) {
      const [n, w] = [item(native), item(worker)];
      t.diagnostic(`${field}: ${n === w ? `equal ${n}` : `native ${n} | worker ${w}`}`);
      if (n !== w) {
        failures.push(`${field}: native ${n} | worker ${w}`);
      }
      return;
    }
    const n = new Set(native.map(item));
    const w = new Set(worker.map(item));
    const nativeOnly = [...n].filter((x) => !w.has(x)).sort();
    const workerOnly = [...w].filter((x) => !n.has(x)).sort();
    const unlisted = [
      ...nativeOnly.filter((x) => !listed.nativeOnly?.includes(x)).map((x) => `native-only ${x}`),
      ...workerOnly.filter((x) => !listed.workerOnly?.includes(x)).map((x) => `worker-only ${x}`),
    ];
    t.diagnostic(
      `${field}: ${
        nativeOnly.length + workerOnly.length === 0
          ? `equal (${shown([...n].sort())})`
          : `native-only [${nativeOnly.join(", ")}] worker-only [${workerOnly.join(", ")}]${
              unlisted.length === 0 ? " (all listed)" : ""
            }`
      }`,
    );
    if (unlisted.length > 0) {
      failures.push(`${field}: ${unlisted.join("; ")}`);
    }
  };
  return { value, failures };
}

async function runCli(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  const pending = execFileAsync(cmd, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 });
  // `claude -p` appends piped stdin to the prompt and waits for it to close.
  pending.child.stdin?.end();
  return (await pending).stdout;
}

function jsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) {
        out.push(value);
      }
    } catch {
      // not a JSON line
    }
  }
  return out;
}

/** Reads until two reads 1 s apart agree, at most 30 s (R27). */
async function settle<T>(read: () => Promise<T>): Promise<T> {
  let last = await read();
  const end = Date.now() + SETTLE_MAX_MS;
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_INTERVAL_MS));
    const next = await read();
    if (isDeepStrictEqual(next, last)) {
      return next;
    }
    last = next;
  }
  return last;
}

async function work(t: TestContext, agent: AgentId, spec: LaunchSpec, cwd: string): Promise<void> {
  const run = await runWorker(spec, cwd, PROMPT, {
    agent,
    signal: t.signal,
    permit: (req, turn) =>
      permit(req, turn, { who: `${agent} parity worker`, note: (text) => t.diagnostic(text) }),
  });
  t.diagnostic(`worker run: ${run.stopReason} ${JSON.stringify(run.reply)}`);
  assert.equal(run.stopReason, "end_turn", run.failure?.message);
}

interface ClaudeInit {
  model: string;
  permissionMode: string;
  output_style: string;
  apiKeySource: string;
  agents?: string[];
  skills: string[];
  slash_commands: string[];
  plugins: { name: string }[];
  tools: string[];
  mcp_servers: { name: string; status: string; source?: string }[];
}

function claudeInit(text: string, what: string): ClaudeInit {
  const init = jsonLines(text).find((m) => m.type === "system" && m.subtype === "init");
  assert.ok(init, `no system/init record in the ${what} output`);
  return init as unknown as ClaudeInit;
}

const nonMcpTools = (init: ClaudeInit): string[] =>
  init.tools.filter((tool) => !tool.startsWith("mcp__") && !tool.includes("Mcp"));

/** The InstructionsLoaded hook log the fixture's `.claude/settings.json` writes to `$PK_PAR_LOG`. */
const instructionFiles = (path: string): string[] =>
  jsonLines(readFileSync(path, "utf8")).map((r) => `${String(r.memory_type)}:${String(r.file_path)}`);

interface CodexThread {
  model?: string;
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  sandbox?: { type?: string };
  instructionSources?: string[];
}

interface CodexTurn {
  model?: string;
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  sandboxPolicy?: { type?: string };
}

// `thread/start` config codex-acp sends (§14 listed difference; index.js:43999–44011).
const codexOverrides = (cwd: string): unknown => ({
  features: { cwd_relative_turn_diffs: false },
  skills: { config: [{ name: "visualize:visualize", enabled: false }] },
  projects: { [cwd]: { trust_level: "trusted" } },
});

/** A direct `<bin> app-server`: `thread/start` with `startParams`, then skills and MCP startup names, settled. */
async function codexInventory(
  bin: string,
  cwd: string,
  env: Record<string, string>,
  startParams: unknown,
): Promise<{ thread: CodexThread; skills: string[]; mcp: string[] }> {
  const child = spawn(bin, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  const mcp = new Set<string>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    for (const m of jsonLines(line)) {
      if (m.method === "mcpServer/startupStatus/updated" && isRecord(m.params)) {
        mcp.add(String(m.params.name));
      } else if (typeof m.id === "number" && m.method === undefined) {
        pending.get(m.id)?.(m);
      }
    }
  });
  let nextId = 0;
  const call = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (m) =>
        isRecord(m.error)
          ? reject(new Error(`codex ${method}: ${String(m.error.message)}`))
          : resolve(m.result),
      );
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  try {
    await call("initialize", { clientInfo: { name: "schmear-parity", version: "0" } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const thread = (await call("thread/start", startParams)) as CodexThread;
    const read = await settle(async () => {
      const listed = (await call("skills/list", { cwds: [cwd] })) as {
        data?: { skills?: { name: string; enabled?: boolean }[] }[];
      };
      const skills = (listed.data ?? [])
        .flatMap((entry) => entry.skills ?? [])
        // visualize's enabled flag is codex-acp's listed override.
        .map((s) => (s.name === "visualize:visualize" ? s.name : `${s.name}:${String(s.enabled)}`))
        .sort();
      return { skills, mcp: [...mcp].sort() };
    });
    return { thread, ...read };
  } finally {
    child.kill();
  }
}

/** `command.data` of `agy -p /skills --output-format json` (R29, `num_turns 0`). */
function agySkills(stdout: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(stdout);
  const data = isRecord(raw) && isRecord(raw.command) ? raw.command.data : undefined;
  assert.ok(
    isRecord(data),
    `agy /skills has no command.data: status ${isRecord(raw) ? String(raw.status) : raw}`,
  );
  return data;
}

/** Names of the fixture loggers that logged `initialize` since the last call; their logs are then removed. */
function takeStartedLoggers(logs: string): string[] {
  const started: string[] = [];
  for (const file of readdirSync(logs).filter((f) => f.endsWith(".jsonl"))) {
    const path = join(logs, file);
    if (jsonLines(readFileSync(path, "utf8")).some((r) => r.event === "initialize")) {
      started.push(file.slice(0, -".jsonl".length));
    }
    rmSync(path);
  }
  return started;
}

interface Run {
  t: TestContext;
  bin: string;
  cwd: string;
  logs: string;
  value: Compare;
}

const GROK_FIELDS = ["projectTrusted", "projectInstructions", "skills", "mcpServers", "hooks", "plugins"];

const parity: Record<AgentId, (r: Run) => Promise<void>> = {
  async claude({ t, bin, cwd, logs, value }) {
    const nativeHooks = join(logs, "native.hook");
    const native = claudeInit(
      await runCli(bin, ["-p", "--output-format", "stream-json", "--verbose", PROMPT], cwd, {
        ...nativeEnv,
        PK_PAR_LOG: nativeHooks,
      }),
      "native claude -p",
    );
    const spec = await adapters.claude.launch(
      { id: "claude:haiku", agent: "claude", key: "claude", tier: 1, model: "haiku", effort: "medium" },
      cwd,
      TEE,
    );
    const tee = join(logs, "claude-tee");
    const workerHooks = join(logs, "worker.hook");
    Object.assign(spec.env, { PK_TEE_REAL: bin, PK_TEE_LOG: tee, PK_PAR_LOG: workerHooks });
    await work(t, "claude", spec, cwd);
    const worker = claudeInit(readFileSync(`${tee}.out`, "utf8"), "worker CLI");

    // schmear sets the model (§14 listed difference); M4's live tiers test checks which.
    t.diagnostic(`model: set by schmear (listed): native ${native.model} | worker ${worker.model}`);
    for (const field of ["permissionMode", "output_style", "apiKeySource", "agents"] as const) {
      value(field, native[field], worker[field]);
    }
    value("skills", native.skills, worker.skills, { workerOnly: ["send-to-project"] });
    const statuses = (init: ClaudeInit) => init.mcp_servers.map((s) => `${s.name}:${s.status}`).join(", ");
    t.diagnostic(`MCP server status: native [${statuses(native)}] worker [${statuses(worker)}]`);
    // A server still pending in the worker (listed, R26) has not yet added its prompts as slash commands;
    // Claude Code names them mcp__<server name with other characters as _>__<prompt>.
    const pending = worker.mcp_servers
      .filter((s) => s.status !== "connected")
      .map((s) => `mcp__${s.name.replace(/[^a-zA-Z0-9_-]/g, "_")}__`);
    const ofPending = (cmd: string) => pending.some((prefix) => cmd.startsWith(prefix));
    const dropped = [...new Set([...native.slash_commands, ...worker.slash_commands].filter(ofPending))];
    if (dropped.length > 0) {
      t.diagnostic(`slash_commands of servers pending in the worker, not compared: ${dropped.join(", ")}`);
    }
    const commands = (init: ClaudeInit) => init.slash_commands.filter((cmd) => !ofPending(cmd));
    value("slash_commands", commands(native), commands(worker), { workerOnly: ["send-to-project"] });
    const pluginNames = (init: ClaudeInit) => init.plugins.map((p) => p.name);
    value("plugins", pluginNames(native), pluginNames(worker), { nativeOnly: ["cc-plugin-easel"] });
    value("non-MCP tools", nonMcpTools(native), nonMcpTools(worker), {
      workerOnly: ["EnterPlanMode", "ExitPlanMode", "SendToProject", "SendToProjectContext"],
    });
    // Status is not compared: the worker's servers can still be pending (R26).
    const servers = (init: ClaudeInit) => init.mcp_servers.map((s) => `${s.name}:${String(s.source)}`);
    value("MCP servers", servers(native), servers(worker));
    value("instruction files", instructionFiles(nativeHooks), instructionFiles(workerHooks));
  },

  async codex({ t, bin, cwd, logs, value }) {
    // The native thread gets codex-acp's trust override (a listed difference) so the project layer
    // loads on both sides, as in R27.
    const native = await codexInventory(bin, cwd, nativeEnv, {
      cwd,
      config: { projects: { [cwd]: { trust_level: "trusted" } } },
    });
    const spec = await adapters.codex.launch(
      {
        id: "codex:gpt-5.6-terra",
        agent: "codex",
        key: "codex",
        tier: 1,
        model: "gpt-5.6-terra",
        effort: "max",
      },
      cwd,
      bin,
    );
    const tee = join(logs, "codex-tee");
    // Set after launch(), so launch()'s own config/read stays out of the log.
    Object.assign(spec.env, { CODEX_PATH: TEE, PK_TEE_REAL: bin, PK_TEE_LOG: tee });
    await work(t, "codex", spec, cwd);

    const sent = jsonLines(readFileSync(`${tee}.in`, "utf8"));
    const received = jsonLines(readFileSync(`${tee}.out`, "utf8"));
    const start = sent.find((m) => m.method === "thread/start");
    assert.ok(start, "codex-acp sent no thread/start");
    const thread = received.find((m) => m.id === start.id && m.method === undefined)?.result as
      | CodexThread
      | undefined;
    assert.ok(thread, "no thread/start result in codex-acp's app-server traffic");
    // codex-acp's turn/start carries the mode's policy and the model, overriding the thread's.
    const turn = (sent.find((m) => m.method === "turn/start")?.params ?? {}) as CodexTurn;
    const replay = await codexInventory(bin, cwd, spec.env, start.params);

    value(
      "thread/start overrides",
      codexOverrides(cwd),
      isRecord(start.params) ? start.params.config : undefined,
    );
    t.diagnostic(
      `model: set by schmear (listed): native ${native.thread.model} | worker ${turn.model ?? thread.model}`,
    );
    value("approvalPolicy", native.thread.approvalPolicy, turn.approvalPolicy ?? thread.approvalPolicy);
    value(
      "approvalsReviewer",
      native.thread.approvalsReviewer,
      turn.approvalsReviewer ?? thread.approvalsReviewer,
    );
    value("sandbox", native.thread.sandbox?.type, turn.sandboxPolicy?.type ?? thread.sandbox?.type);
    value("instructionSources", native.thread.instructionSources, thread.instructionSources);
    value("skills", native.skills, replay.skills);
    value("MCP names", native.mcp, replay.mcp);
  },

  async grok({ cwd, bin, value }) {
    // `agent stdio` reports no inventory (R28), so the worker side is `inspect` under the worker env.
    const spec = await adapters.grok.launch(
      { id: "grok:grok-4.7", agent: "grok", key: "grok", tier: 1, model: "grok-4.7", effort: "medium" },
      cwd,
      bin,
    );
    const native = JSON.parse(await runCli(bin, ["inspect", "--json"], cwd, nativeEnv)) as Record<
      string,
      unknown
    >;
    const worker = JSON.parse(await runCli(spec.command, ["inspect", "--json"], cwd, spec.env)) as Record<
      string,
      unknown
    >;
    for (const field of GROK_FIELDS) {
      value(field, native[field], worker[field]);
    }
  },

  async agy({ t, bin, cwd, logs, value }) {
    const skillsArgs = ["-p", "/skills", "--output-format", "json"];
    const agyEnv = { ...nativeEnv, AGY_CLI_DISABLE_AUTO_UPDATE: "true" };
    const native = agySkills(await runCli(bin, skillsArgs, cwd, agyEnv));
    // `/skills` does not reliably start workspace MCP servers; a one-turn prompt run is the native reference.
    takeStartedLoggers(logs);
    await runCli(bin, ["-p", PROMPT, "--output-format", "json"], cwd, agyEnv);
    const nativeStarted = takeStartedLoggers(logs);
    const spec = await adapters.agy.launch(
      {
        id: "agy-gemini:gemini-4-hydrogen",
        agent: "agy",
        key: "agy-gemini",
        tier: 1,
        model: "gemini-4-hydrogen",
        effort: "medium",
      },
      cwd,
      bin,
    );
    await work(t, "agy", spec, cwd);
    const workerStarted = takeStartedLoggers(logs);
    // `agy acp` has no skills record of its own; `/skills` under the worker env stands in for it.
    const worker = agySkills(await runCli(bin, skillsArgs, cwd, spec.env));

    for (const key of new Set([...Object.keys(native), ...Object.keys(worker)])) {
      value(`skills ${key}`, native[key], worker[key]);
    }
    value("MCP servers started", nativeStarted, workerStarted);
  },
};

describe("live parity", () => {
  for (const agent of Object.keys(adapters) as AgentId[]) {
    it(`parity: ${agent} worker loads what the native CLI loads`, { timeout: 600_000 }, async (t) => {
      const reason = await guard(agent, (line) => t.diagnostic(`usage ${line}`));
      if (reason) {
        t.diagnostic(`skipped: ${reason}`);
        t.skip(reason);
        return;
      }
      const found = await detect(agent);
      assert.ok(!("error" in found), `${agent} failed detection after the guard passed`);
      const cwd = join(root, agent, "repo");
      const logs = join(root, agent, "logs");
      execFileSync("sh", [join(PROBES, "parity_fixture.sh"), cwd, logs]);
      const { value, failures } = comparer(t, cwd);
      await parity[agent]({ t, bin: found.path, cwd, logs, value });
      assert.deepEqual(failures, [], "unlisted parity differences");
    });
  }
});
