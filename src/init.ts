import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { codexConfigPath } from "./agents/codex.ts";
import { grokHome } from "./agents/grok.ts";
import { needsOverageOff } from "./router.ts";
import { usageText } from "./server.ts";
import { configPath, readConfig, writeAtomic } from "./state.ts";
import type { AgentAdapter, AgentId, Config, CreditPoolConfig } from "./types.ts";
import { errorMessage, execFileAsync, findExecutableOnPath, isRecord } from "./util.ts";

const TIMEOUT_S = 86_400;
const KEY_COMMAND_EXAMPLE = ["security", "find-generic-password", "-s", "schmear-anthropic", "-w"];
const HOST_CMD_TIMEOUT_MS = 30_000;

const CLAUDE_RISK =
  "Claude workers run your own `claude` binary on your claude.ai login through Anthropic's Agent SDK, without the adapter's `--hide-claude-auth` flag. Anthropic restricts third-party use of subscription logins and may restrict your account or this route.";

const HOSTS: Record<AgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  agy: "Antigravity",
};

const CONSENT: Record<AgentId, string> = {
  claude: `Claude: schmear reads your plan usage through \`claude\` (get_usage, no inference) and runs Claude workers on your login. ${CLAUDE_RISK} Type yes to allow Claude workers: `,
  codex:
    "Codex: schmear reads your rate limits through `codex app-server` (no inference) and runs Codex workers on your login. Allow? [y/N] ",
  grok: "Grok: schmear reads your billing through `grok agent stdio`, falling back to grok.com and the Grok CLI proxy with the login token in ~/.grok/auth.json (read in memory, never stored or sent elsewhere), and runs Grok workers on your login. Allow? [y/N] ",
  agy: "Antigravity: schmear reads your quota through `agy -p /usage` (no inference) and runs Antigravity workers on your login. Allow? [y/N] ",
};

const OVERAGE: Record<Exclude<AgentId, "claude">, string> = {
  codex:
    "Codex credits can pay past your plan limit and schmear cannot see that setting. Are Codex credits off? [y/N] ",
  grok: "Grok prepaid balance and on-demand spend can pay past your plan limit; schmear skips Grok while its billing shows either above zero. Are both off? [y/N] ",
  agy: "Antigravity can continue on paid AI credits after a limit and schmear cannot see that setting. Are AI credits off? [y/N] ",
};

interface InitIO {
  /** Prints `question` and returns the user's line ("" at end of input). */
  ask(question: string): Promise<string>;
  out(text: string): void;
}

type Outcome = "added" | "updated" | "unchanged";

interface ServerCommand {
  command: string;
  args: string[];
}

/** `init [--yes]` (§3.1, §12): detect, consent, write config, read usage once, register in each host, list. */
export async function init(
  opts: { yes: boolean; cliPath: string },
  io: InitIO,
  adapters: Record<AgentId, AgentAdapter>,
): Promise<void> {
  if (opts.cliPath.includes("/_npx/")) {
    throw new Error(
      `refusing to register ${opts.cliPath}: it is in npx's cache, which npm may delete. Install with \`npm i -g schmear\` and run \`schmear init\`.`,
    );
  }
  const entry: ServerCommand = { command: await nodeCommand(), args: [opts.cliPath, "serve"] };
  const ids = Object.keys(adapters) as AgentId[];

  const prior = await readConfig();
  const hosts = new Map<AgentId, string>();
  const agents: Config["agents"] = {};
  for (const id of ids) {
    const bin = await findExecutableOnPath(id);
    if (!bin) {
      io.out(`${id}: not found on PATH`);
      continue;
    }
    hosts.set(id, bin);
    const found = await adapters[id].find(bin);
    if ("error" in found) {
      io.out(`${id}: ${bin} failed detection (${found.error}); not offered as a worker`);
      continue;
    }
    io.out(`${id}: ${bin} ${found.version}`);
    // A typed Claude consent is never asked again, so a later `init --yes` with no input cannot revoke it.
    const kept = id === "claude" && prior.agents.claude?.consent === true;
    if (kept) {
      io.out(`claude: consent kept; to revoke, set "consent": false for claude in ${configPath()}`);
    }
    const consent = kept || (await confirm(io, CONSENT[id], opts.yes && id !== "claude", id === "claude"));
    // `--yes` never answers an overage question; a typed answer is kept like Claude's consent.
    const overageQuestion = needsOverageOff(id) ? OVERAGE[id] : undefined;
    const overageKept = consent && overageQuestion !== undefined && prior.agents[id]?.overageOff === true;
    if (overageKept) {
      io.out(`${id}: overage-off answer kept; to revoke, delete "overageOff" for ${id} in ${configPath()}`);
    }
    const overageOff =
      overageKept ||
      (consent && overageQuestion !== undefined && (await confirm(io, overageQuestion, false)));
    agents[id] = { consent, path: bin, ...(overageOff ? { overageOff: true as const } : {}) };
  }

  const config: Config = { ...prior, agents };
  if (prior.credits) {
    io.out(`claude-credits: credit pool kept; to remove it, delete "credits" in ${configPath()}`);
  } else if (agents.claude?.consent) {
    const credits = await askCreditPool(io);
    if (credits) {
      config.credits = credits;
    }
  }
  await writeIfChanged(configPath(), `${JSON.stringify(config, null, 2)}\n`);
  io.out(`\n${await usageText(adapters, null)}\n`);

  const register: Record<AgentId, (bin: string) => Promise<Outcome>> = {
    claude: (bin) => registerClaude(bin, entry, io),
    codex: () =>
      registerToml(codexConfigPath(), {
        ...entry,
        tool_timeout_sec: TIMEOUT_S,
        env_vars: ["SCHMEAR_WORKER"],
      }),
    grok: () =>
      registerToml(join(grokHome(), "config.toml"), {
        ...entry,
        tool_timeout_sec: TIMEOUT_S,
      }),
    agy: () =>
      registerJson(join(homedir(), ".gemini", "config", "mcp_config.json"), {
        ...entry,
        timeoutSeconds: TIMEOUT_S,
      }),
  };
  const failed: string[] = [];
  for (const [id, bin] of hosts) {
    try {
      const outcome = await register[id](bin);
      io.out(
        outcome === "added"
          ? `registered in ${HOSTS[id]}`
          : outcome === "updated"
            ? `updated in ${HOSTS[id]}`
            : `already registered in ${HOSTS[id]}`,
      );
    } catch (err) {
      failed.push(HOSTS[id]);
      io.out(`${HOSTS[id]}: not registered (${errorMessage(err)})`);
    }
  }

  const list: Record<AgentId, string[]> = {
    claude: ["mcp", "get", "schmear"],
    codex: ["mcp", "list"],
    grok: ["mcp", "list"],
    agy: ["mcp", "list"],
  };
  for (const [id, bin] of hosts) {
    const { ok, output } = await run(bin, list[id]);
    io.out(`\n$ ${id} ${list[id].join(" ")}${ok ? "" : " (failed)"}\n${output}`);
  }
  if (failed.length > 0) {
    throw new Error(`not registered in ${failed.join(", ")}`);
  }
}

/** §13: typed answers only (`--yes` never sets up the credit lane); an invalid answer aborts init. */
async function askCreditPool(io: InitIO): Promise<CreditPoolConfig | undefined> {
  const typed = async (q: string) => (await io.ask(q)).trim().toLowerCase() === "yes";
  if (
    !(await typed(
      "Claude credit lane: spend your Anthropic Console credit grant (the Max/Ultra monthly API credits) on a separate claude-credits lane, through an API key? Type yes to set it up [no]: ",
    ))
  ) {
    return undefined;
  }
  const number = async (q: string, valid: (n: number) => boolean): Promise<number> => {
    const answer = (await io.ask(q)).trim();
    const n = Number(answer);
    if (answer === "" || !Number.isFinite(n) || !valid(n)) {
      throw new Error(`invalid answer '${answer}' to: ${q.trim()}`);
    }
    return n;
  };
  const grantUsd = await number("Grant per billing cycle, USD: ", (n) => n > 0);
  const cycleDay = await number(
    "Day of the month the cycle starts (1-31): ",
    (n) => Number.isInteger(n) && n >= 1 && n <= 31,
  );
  const taskCapUsd = await number("Most one task may spend, USD: ", (n) => n > 0 && n <= grantUsd);
  const keyAnswer = (
    await io.ask(
      `Command that prints the API key, as a JSON array (for example ${JSON.stringify(KEY_COMMAND_EXAMPLE)}): `,
    )
  ).trim();
  let keyCommand: unknown;
  try {
    keyCommand = JSON.parse(keyAnswer);
  } catch {
    // validated below
  }
  if (
    !Array.isArray(keyCommand) ||
    keyCommand.length === 0 ||
    !keyCommand.every((a) => typeof a === "string" && a)
  ) {
    throw new Error(`invalid key command '${keyAnswer}': expected a JSON array of non-empty strings`);
  }
  if (
    !(await typed(
      "schmear meters the grant locally and cannot see your Console balance. If purchased credits or auto-reload are on, Anthropic bills past the grant. Use a dedicated Console workspace whose spend limit equals the grant. Type yes to confirm nothing past the grant can be billed: ",
    ))
  ) {
    io.out("claude-credits: not confirmed; no credit pool written");
    return undefined;
  }
  return { grantUsd, cycleDay, keyCommand, taskCapUsd, overageOff: true };
}

async function confirm(io: InitIO, question: string, assumeYes: boolean, typedYes = false): Promise<boolean> {
  if (assumeYes) {
    io.out(`${question}yes`);
    return true;
  }
  const answer = (await io.ask(question)).trim().toLowerCase();
  return typedYes ? answer === "yes" : answer === "y" || answer === "yes";
}

async function run(bin: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: HOST_CMD_TIMEOUT_MS });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message };
  }
}

async function readText(path: string): Promise<{ text: string; mode?: number }> {
  try {
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { text, mode: info.mode & 0o777 };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { text: "" };
    }
    throw err;
  }
}

async function writeIfChanged(path: string, data: string): Promise<void> {
  if ((await readText(path)).text !== data) {
    await writeAtomic(path, data);
  }
}

/**
 * `claude mcp get` prints the entry Claude uses, with `Scope:`, `Command:`, `Args:` (space-joined) and
 * `Timeout: <n>ms` lines; it exits non-zero when absent.
 */
async function registerClaude(bin: string, entry: ServerCommand, io: InitIO): Promise<Outcome> {
  const timeout = TIMEOUT_S * 1000;
  const got = await run(bin, ["mcp", "get", "schmear"]);
  const field = (name: string) => new RegExp(`^\\s*${name}: (.*)$`, "m").exec(got.output)?.[1];
  const scope = got.ok ? (field("Scope") ?? "unscoped") : undefined;
  const user = scope !== undefined && /^user\b/i.test(scope);
  if (user) {
    if (
      field("Command") === entry.command &&
      field("Args") === entry.args.join(" ") &&
      field("Timeout") === `${timeout}ms`
    ) {
      return "unchanged";
    }
    await execFileAsync(bin, ["mcp", "remove", "-s", "user", "schmear"], { timeout: HOST_CMD_TIMEOUT_MS });
  } else if (scope !== undefined) {
    io.out(`claude: the ${scope} schmear entry shadows the user entry`);
    // `get` shows only the shadowing entry, so a user entry may or may not exist: remove it if it does.
    await run(bin, ["mcp", "remove", "-s", "user", "schmear"]);
  }
  const json = JSON.stringify({ type: "stdio", ...entry, timeout });
  await execFileAsync(bin, ["mcp", "add-json", "-s", "user", "schmear", json], {
    timeout: HOST_CMD_TIMEOUT_MS,
  });
  return user ? "updated" : "added";
}

/** Prefer `node` on PATH when it resolves to this binary, so symlinked installs (e.g. Homebrew) survive upgrades. */
async function nodeCommand(): Promise<string> {
  const onPath = await findExecutableOnPath("node");
  if (onPath && (await realpath(onPath)) === (await realpath(process.execPath))) {
    return onPath;
  }
  return process.execPath;
}

// Compare only the keys init owns, so user keys (`env`, `enabled`, `disabled`, …) never make an entry differ.
const sameTable = (parsed: unknown, table: Record<string, unknown>): boolean =>
  isRecord(parsed) &&
  !Array.isArray(parsed) &&
  Object.entries(table).every(([k, v]) => Object.hasOwn(parsed, k) && isDeepStrictEqual(parsed[k], v));

const TOML_HEADER = /^\s*\[\s*mcp_servers\.schmear\s*\]\s*(#.*)?$/;

const parsesAlone = (toml: string): boolean => {
  try {
    parseToml(toml);
    return true;
  } catch {
    return false;
  }
};

/** Appends `[mcp_servers.schmear]`, or rewrites only init's keys in it, as text, so every other line stays. */
async function registerToml(path: string, table: Record<string, unknown>): Promise<Outcome> {
  const { text, mode } = await readText(path);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text);
  } catch (err) {
    throw new Error(`cannot parse ${path}: ${errorMessage(err)}`);
  }
  const servers = parsed.mcp_servers;
  const current = isRecord(servers) ? servers.schmear : undefined;
  if (sameTable(current, table)) {
    return "unchanged";
  }
  let next: string;
  if (current === undefined) {
    const block = `[mcp_servers.schmear]\n${stringifyToml(table)}`;
    next = `${text}${text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n"}${block}`;
  } else {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => TOML_HEADER.test(line));
    if (start < 0) {
      throw new Error(
        `${path} defines mcp_servers.schmear without a [mcp_servers.schmear] header; edit it by hand`,
      );
    }
    const after = lines.findIndex((line, i) => i > start && /^\s*\[/.test(line));
    let end = after < 0 ? lines.length : after;
    const missing: string[] = [];
    for (const [key, value] of Object.entries(table)) {
      const line = stringifyToml({ [key]: value }).trimEnd();
      const keyLine = new RegExp(`^\\s*${key}\\s*=`);
      const at = lines.findIndex((l, i) => i > start && i < end && keyLine.test(l));
      if (at < 0) {
        missing.push(line);
        continue;
      }
      // A value can span lines (a multi-line array): it ends at the first line where the key parses alone.
      let last = at;
      while (last < end - 1 && !parsesAlone(lines.slice(at, last + 1).join("\n"))) {
        last++;
      }
      lines.splice(at, last - at + 1, line);
      end -= last - at;
    }
    lines.splice(start + 1, 0, ...missing);
    next = lines.join("\n");
  }
  const check = parseToml(next).mcp_servers;
  const expected = { ...(isRecord(current) ? current : {}), ...table };
  if (!isRecord(check) || !isRecord(check.schmear) || !isDeepStrictEqual({ ...check.schmear }, expected)) {
    throw new Error(`rewriting ${path} would not yield the expected [mcp_servers.schmear]; edit it by hand`);
  }
  await writeAtomic(path, next, mode);
  return current === undefined ? "added" : "updated";
}

async function registerJson(path: string, server: Record<string, unknown>): Promise<Outcome> {
  const { text, mode } = await readText(path);
  let parsed: unknown = {};
  if (text.trim() !== "") {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`cannot parse ${path}: ${errorMessage(err)}`);
    }
  }
  if (
    !isRecord(parsed) ||
    Array.isArray(parsed) ||
    (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))
  ) {
    throw new Error(`${path}: expected {"mcpServers": {...}}`);
  }
  const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>;
  const current = servers.schmear;
  if (sameTable(current, server)) {
    return "unchanged";
  }
  const kept = isRecord(current) && !Array.isArray(current) ? current : {};
  const next = { ...parsed, mcpServers: { ...servers, schmear: { ...kept, ...server } } };
  await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`, mode);
  return current === undefined ? "added" : "updated";
}
