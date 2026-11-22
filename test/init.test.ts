import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

// Every path init resolves points into this temp dir before src/ is imported.
const root = mkdtempSync(join(tmpdir(), "schmear-init-"));
const home = join(root, "home");
const bin = join(root, "bin");
const callLog = join(root, "calls.jsonl");
mkdirSync(home);
mkdirSync(bin);
Object.assign(process.env, {
  HOME: home,
  CODEX_HOME: join(home, ".codex"),
  GROK_HOME: join(home, ".grok"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  PATH: bin,
});

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const claudeState = join(home, "fake-claude-mcp.json");
// Present: `mcp get` shows an entry of this scope shadowing the user entry.
const claudeShadow = join(home, "fake-claude-shadow");
// Present: `mcp add-json` fails.
const claudeAddFails = join(home, "fake-claude-add-fails");

// Each fake logs its argv; `mcp list` prints the server names its host's config file holds.
const prelude = (name: string) => `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ bin: ${JSON.stringify(name)}, args }) + "\\n");
const rpc = (answer) => {
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.id === undefined) return;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: answer(msg) }) + "\\n");
  });
};
`;
const FAKES: Record<string, string> = {
  claude: `
const state = ${JSON.stringify(claudeState)};
const a = args.join(" ");
if (a === "--version") console.log("2.1.330 (Claude Code)");
else if (a === "auth status --json") console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
else if (a === "mcp get schmear") {
  const shadow = ${JSON.stringify(claudeShadow)};
  if (fs.existsSync(shadow)) {
    console.log(["schmear:", "  Scope: " + fs.readFileSync(shadow, "utf8"), "  Type: stdio", "  Command: /shadow", "  Args: "].join("\\n"));
    process.exit(0);
  }
  if (!fs.existsSync(state)) { console.error("No MCP server found with name: schmear"); process.exit(1); }
  const s = JSON.parse(fs.readFileSync(state, "utf8"));
  console.log(["schmear:", "  Scope: User config (available in all your projects)", "  Status: ✓ Connected", "  Type: stdio",
    "  Command: " + s.command, "  Args: " + s.args.join(" "),
    ...(s.timeout === undefined ? [] : ["  Timeout: " + s.timeout + "ms"])].join("\\n"));
} else if (a === "mcp remove -s user schmear") {
  if (!fs.existsSync(state)) { console.error("No user-scoped MCP server found with name: schmear"); process.exit(1); }
  fs.rmSync(state);
} else if (a.startsWith("mcp add-json -s user schmear ")) {
  if (fs.existsSync(${JSON.stringify(claudeAddFails)})) { console.error("add-json refused"); process.exit(1); }
  if (fs.existsSync(state)) { console.error("MCP server schmear already exists"); process.exit(1); }
  fs.writeFileSync(state, args[5]);
} else process.exit(2);
`,
  codex: `
if (args[0] === "--version") console.log("codex-cli 0.147.0");
else if (args.join(" ") === "-s read-only -a never app-server")
  rpc((m) => (m.method === "initialize" ? {} : JSON.parse(fs.readFileSync(${JSON.stringify(fixture("codex-monthly.json"))}, "utf8"))));
else if (args.join(" ") === "mcp list") console.log(fs.readFileSync(process.env.CODEX_HOME + "/config.toml", "utf8").match(/^\\[mcp_servers\\.[^\\]]+\\]/gm).join("\\n"));
else process.exit(2);
`,
  grok: `
if (args[0] === "--version") console.log("grok 1.0.77");
else if (args.join(" ") === "--no-auto-update agent stdio")
  rpc((m) => (m.method === "initialize" ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
    : JSON.parse(fs.readFileSync(${JSON.stringify(fixture("grok-billing-percent.json"))}, "utf8"))));
else if (args.join(" ") === "mcp list") console.log(fs.readFileSync(process.env.GROK_HOME + "/config.toml", "utf8").match(/^\\[mcp_servers\\.[^\\]]+\\]/gm).join("\\n"));
else process.exit(2);
`,
  agy: `
if (args[0] === "--version") console.log("1.5.14");
else if (args.join(" ") === "-p /usage --output-format json") process.stdout.write(fs.readFileSync(${JSON.stringify(fixture("agy-usage.json"))}));
else if (args.join(" ") === "mcp list") console.log(Object.keys(JSON.parse(fs.readFileSync(process.env.HOME + "/.gemini/config/mcp_config.json", "utf8")).mcpServers).join("\\n"));
else process.exit(2);
`,
};
for (const [name, body] of Object.entries(FAKES)) {
  writeFileSync(join(bin, name), prelude(name) + body);
  chmodSync(join(bin, name), 0o755);
}

const { init } = await import("../src/init.ts");
const { adapters } = await import("../src/agents/index.ts");

after(() => rmSync(root, { recursive: true, force: true }));

const cliPath = join(root, "lib", "node_modules", "schmear", "dist", "cli.js");
const codexToml = join(home, ".codex", "config.toml");
const grokToml = join(home, ".grok", "config.toml");
const agyJson = join(home, ".gemini", "config", "mcp_config.json");
const configJson = join(home, ".config", "schmear", "config.json");
const files = [codexToml, grokToml, agyJson, configJson, claudeState];

/**
 * Runs init with `answers` as the typed replies in order, then ""; returns the questions asked and the printed
 * text. A rejection carries the printed text as `out`.
 */
async function runInit(yes: boolean, answers: string[] = [], path = cliPath, agents = adapters) {
  const questions: string[] = [];
  const out: string[] = [];
  try {
    await init(
      { yes, cliPath: path },
      {
        ask: async (q) => {
          questions.push(q);
          return answers.shift() ?? "";
        },
        out: (text) => out.push(text),
      },
      agents,
    );
  } catch (err) {
    throw Object.assign(err as Error, { out: out.join("\n") });
  }
  return { questions, out: out.join("\n") };
}

const calls = (): { bin: string; args: string[] }[] =>
  readFileSync(callLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const snapshot = () => files.map((f) => [f, readFileSync(f, "utf8"), statSync(f).mtimeMs]);
const args = [cliPath, "serve"];
// Spread: smol-toml tables have a null prototype.
const toml = (path: string) => ({
  ...((parse(readFileSync(path, "utf8")).mcp_servers as Record<string, object>).schmear as object),
});
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("init", () => {
  it("refuses to register a path in npx's cache and writes nothing", async () => {
    await assert.rejects(runInit(true, [], "/u/.npm/_npx/1a2b/node_modules/schmear/dist/cli.js"), /npx/);
    for (const f of files) assert.equal(existsSync(f), false, f);
  });

  it("--yes writes the four entries with timeouts and absolute paths and answers no consent or overage question", async () => {
    mkdirSync(join(home, ".codex"));
    writeFileSync(
      codexToml,
      '# my codex settings\nmodel = "gpt-5.6-terra"\n\n[mcp_servers.other]\ncommand = "x"\n',
    );
    chmodSync(codexToml, 0o640); // not the 0600 default, so preservation shows
    const { questions, out } = await runInit(true);

    assert.equal(
      questions.length,
      4,
      "Claude's consent and the three overage questions wait for a typed answer",
    );
    assert.match(questions[0] as string, /Anthropic restricts third-party use of subscription logins/);
    assert.match(questions[1] as string, /Are Codex credits off\?/);
    assert.match(questions[2] as string, /Grok prepaid balance and on-demand spend/);
    assert.match(questions[3] as string, /Are AI credits off\?/);
    assert.ok(isAbsolute(process.execPath) && isAbsolute(cliPath));
    assert.deepEqual(json(claudeState), {
      type: "stdio",
      command: process.execPath,
      args,
      timeout: 86_400_000,
    });
    assert.deepEqual(toml(codexToml), {
      command: process.execPath,
      args,
      tool_timeout_sec: 86_400,
      env_vars: ["SCHMEAR_WORKER"],
    });
    assert.deepEqual(toml(grokToml), { command: process.execPath, args, tool_timeout_sec: 86_400 });
    assert.deepEqual(json(agyJson).mcpServers.schmear, {
      command: process.execPath,
      args,
      timeoutSeconds: 86_400,
    });
    const codexText = readFileSync(codexToml, "utf8");
    assert.ok(codexText.startsWith('# my codex settings\nmodel = "gpt-5.6-terra"\n\n[mcp_servers.other]\n'));
    assert.equal(statSync(codexToml).mode & 0o777, 0o640);

    assert.deepEqual(json(configJson), {
      version: 1,
      agents: {
        claude: { consent: false, path: join(bin, "claude") },
        codex: { consent: true, path: join(bin, "codex") },
        grok: { consent: true, path: join(bin, "grok") },
        agy: { consent: true, path: join(bin, "agy") },
      },
    });
    for (const host of ["Claude Code", "Codex", "Grok", "Antigravity"]) {
      assert.match(out, new RegExp(`registered in ${host}`));
    }
    assert.match(out, /## claude\nskipped: no consent/);
    assert.match(out, /pool codex: period 30d 63% left/);
    assert.match(out, /pool grok: /);
    assert.match(out, /pool agy-gemini: /);
    assert.match(out, /\$ codex mcp list\n\[mcp_servers\.other\]\n\[mcp_servers\.schmear\]/);
    assert.match(out, /\$ agy mcp list\nschmear/);
    assert.match(out, /\$ claude mcp get schmear\nschmear:/);
  });

  it("a second run changes nothing", async () => {
    const before = snapshot();
    const callCount = calls().length;
    const { out } = await runInit(true);
    assert.deepEqual(snapshot(), before);
    const writes = calls()
      .slice(callCount)
      .filter((c) => c.bin === "claude" && (c.args[1] === "add-json" || c.args[1] === "remove"));
    assert.deepEqual(writes, []);
    for (const host of ["Claude Code", "Codex", "Grok", "Antigravity"]) {
      assert.match(out, new RegExp(`already registered in ${host}`));
    }
    assert.doesNotMatch(out, /updated in/);
  });

  it("an edited entry is rewritten and reported updated", async () => {
    writeFileSync(claudeState, JSON.stringify({ type: "stdio", command: process.execPath, args }));
    writeFileSync(
      codexToml,
      readFileSync(codexToml, "utf8").replace("tool_timeout_sec = 86400", "tool_timeout_sec = 60") +
        '\n[profiles.fast]\nmodel = "gpt-5.6-luna"\n',
    );
    writeFileSync(grokToml, `[mcp_servers.schmear]\ncommand = "node"\nargs = ["/old/cli.js", "serve"]\n`);
    const agy = json(agyJson);
    agy.mcpServers.schmear.timeoutSeconds = 180;
    agy.mcpServers.mine = { command: "mine" };
    writeFileSync(agyJson, JSON.stringify(agy));

    const { out } = await runInit(true);
    for (const host of ["Claude Code", "Codex", "Grok", "Antigravity"]) {
      assert.match(out, new RegExp(`updated in ${host}`));
    }
    assert.equal(json(claudeState).timeout, 86_400_000);
    assert.equal((toml(codexToml) as { tool_timeout_sec: number }).tool_timeout_sec, 86_400);
    assert.deepEqual(toml(grokToml), { command: process.execPath, args, tool_timeout_sec: 86_400 });
    assert.equal(json(agyJson).mcpServers.schmear.timeoutSeconds, 86_400);
    assert.deepEqual(json(agyJson).mcpServers.mine, { command: "mine" });
    const codex = JSON.parse(JSON.stringify(parse(readFileSync(codexToml, "utf8"))));
    assert.deepEqual(codex.profiles, { fast: { model: "gpt-5.6-luna" } });
    assert.deepEqual(codex.mcp_servers.other, { command: "x" });
    assert.match(readFileSync(codexToml, "utf8"), /^# my codex settings\n/);
  });

  it("a typed yes grants Claude consent and a typed y or yes confirms overage off", async () => {
    const { questions } = await runInit(true, ["yes", "y", "yes", "y"]);
    assert.equal(
      questions.length,
      5,
      "Claude's question, three overage questions, then the credit lane offer",
    );
    const agents = json(configJson).agents;
    assert.equal(agents.claude.consent, true);
    for (const id of ["codex", "grok", "agy"]) assert.equal(agents[id].overageOff, true, id);
  });

  it("a typed y does not grant Claude consent", async () => {
    // An earlier test's typed yes would be kept, so start from no config and restore it after.
    const earlier = existsSync(configJson) ? readFileSync(configJson, "utf8") : undefined;
    rmSync(configJson, { force: true });
    try {
      await runInit(true, ["y", "y", "y", "y"]);
      assert.notEqual(json(configJson).agents.claude.consent, true);
    } finally {
      if (earlier !== undefined) writeFileSync(configJson, earlier);
    }
  });

  it("a later --yes with no typed answer keeps a typed Claude consent and overage answers", async () => {
    const { questions, out } = await runInit(true);
    assert.equal(questions.length, 1);
    assert.match(questions[0] as string, /credit lane/);
    assert.match(out, /claude: consent kept/);
    assert.match(out, /grok: overage-off answer kept/);
    const agents = json(configJson).agents;
    assert.equal(agents.claude.consent, true);
    for (const id of ["codex", "grok", "agy"]) assert.equal(agents[id].overageOff, true, id);
    assert.equal(json(configJson).credits, undefined, "--yes never sets up the credit lane");
  });

  const keyCommand = ["security", "find-generic-password", "-s", "schmear-anthropic", "-w"];
  const creditAnswers = ["yes", "100", "31", "10", JSON.stringify(keyCommand)];

  it("a credit lane setup without the no-overage confirmation writes no pool", async () => {
    const { out } = await runInit(true, [...creditAnswers, "no"]);
    assert.match(out, /no credit pool written/);
    assert.equal(json(configJson).credits, undefined);
  });

  it("an invalid credit answer aborts before writing", async () => {
    const before = readFileSync(configJson, "utf8");
    await assert.rejects(runInit(true, ["yes", "100", "32"]), /invalid answer '32'/);
    await assert.rejects(runInit(true, ["yes", "Infinity"]), /invalid answer 'Infinity'/);
    await assert.rejects(
      runInit(true, [...creditAnswers.slice(0, 4), '"security"', "yes"]),
      /invalid key command/,
    );
    assert.equal(readFileSync(configJson, "utf8"), before);
  });

  it("a typed credit lane setup writes the pool, and a later run keeps it without asking", async () => {
    await runInit(true, [...creditAnswers, "yes"]);
    const pool = { grantUsd: 100, cycleDay: 31, keyCommand, taskCapUsd: 10, overageOff: true };
    assert.deepEqual(json(configJson).credits, pool);

    const { questions, out } = await runInit(true);
    assert.deepEqual(questions, []);
    assert.match(out, /credit pool kept; to remove it, delete "credits"/);
    assert.deepEqual(json(configJson).credits, pool);
  });

  it("registers PATH node when it resolves to process.execPath, and falls back when it points elsewhere", async () => {
    const pathNode = join(bin, "node");
    const otherNode = join(root, "other-node");
    writeFileSync(otherNode, "#!/bin/sh\n");
    chmodSync(otherNode, 0o755);
    try {
      symlinkSync(process.execPath, pathNode);
      const linked = await runInit(true);
      for (const host of ["Claude Code", "Codex", "Grok", "Antigravity"]) {
        assert.match(linked.out, new RegExp(`updated in ${host}`));
      }
      assert.equal(json(claudeState).command, pathNode);
      assert.equal((toml(codexToml) as { command: string }).command, pathNode);
      assert.equal((toml(grokToml) as { command: string }).command, pathNode);
      assert.equal(json(agyJson).mcpServers.schmear.command, pathNode);

      rmSync(pathNode);
      symlinkSync(otherNode, pathNode);
      const other = await runInit(true);
      for (const host of ["Claude Code", "Codex", "Grok", "Antigravity"]) {
        assert.match(other.out, new RegExp(`updated in ${host}`));
      }
      assert.equal(json(claudeState).command, process.execPath);
      assert.equal((toml(codexToml) as { command: string }).command, process.execPath);
      assert.equal((toml(grokToml) as { command: string }).command, process.execPath);
      assert.equal(json(agyJson).mcpServers.schmear.command, process.execPath);
    } finally {
      rmSync(pathNode, { force: true });
      rmSync(otherNode, { force: true });
    }
  });

  it("keeps a user-added [mcp_servers.schmear.env] subtable and reports already registered", async () => {
    const subtable = '\n[mcp_servers.schmear.env]\nFOO = "bar"\n';
    writeFileSync(codexToml, readFileSync(codexToml, "utf8") + subtable);
    writeFileSync(grokToml, readFileSync(grokToml, "utf8") + subtable);
    const codexBefore = readFileSync(codexToml, "utf8");
    const grokBefore = readFileSync(grokToml, "utf8");

    const { out } = await runInit(true);
    assert.match(out, /already registered in Codex/);
    assert.match(out, /already registered in Grok/);
    assert.doesNotMatch(out, /updated in (Codex|Grok)/);
    assert.equal(readFileSync(codexToml, "utf8"), codexBefore);
    assert.equal(readFileSync(grokToml, "utf8"), grokBefore);
    assert.deepEqual({ ...(toml(codexToml) as { env: object }).env }, { FOO: "bar" });
    assert.deepEqual({ ...(toml(grokToml) as { env: object }).env }, { FOO: "bar" });

    // Updating an init-owned key still preserves the env subtable and converges on the next run.
    writeFileSync(codexToml, codexBefore.replace("tool_timeout_sec = 86400", "tool_timeout_sec = 60"));
    const updated = await runInit(true);
    assert.match(updated.out, /updated in Codex/);
    assert.equal((toml(codexToml) as { tool_timeout_sec: number }).tool_timeout_sec, 86_400);
    assert.deepEqual({ ...(toml(codexToml) as { env: object }).env }, { FOO: "bar" });

    const steady = await runInit(true);
    assert.match(steady.out, /already registered in Codex/);
  });
  it("reports each agent's own detection error and still registers the others", async () => {
    const failing = {
      ...adapters,
      codex: { ...adapters.codex, find: async () => ({ error: "codex is not logged in" }) },
    };
    const { out } = await runInit(true, [], cliPath, failing);
    assert.match(
      out,
      new RegExp(`codex: ${join(bin, "codex")} failed detection \\(codex is not logged in\\); not offered`),
    );
    assert.doesNotMatch(out, /claude\.ai login/);
    assert.equal(json(configJson).agents.codex, undefined);
    assert.ok(json(configJson).agents.agy);
  });

  it("skips an agent that is not on PATH", async () => {
    renameSync(join(bin, "agy"), join(bin, "agy.off"));
    try {
      const { out } = await runInit(true);
      assert.match(out, /agy: not found on PATH/);
      assert.equal(json(configJson).agents.agy, undefined);
    } finally {
      renameSync(join(bin, "agy.off"), join(bin, "agy"));
    }
  });

  const serverToml = (command: string, argsLines: string, rest: string) =>
    `[mcp_servers.schmear]\n# managed by schmear\ncommand = ${JSON.stringify(command)}\n${argsLines}\nenabled = false   # paused\nstartup_timeout_sec = 30\n${rest}`;
  const cliArgs = `args = [ ${JSON.stringify(cliPath)}, "serve" ]`;

  it("leaves a TOML entry with user keys and lines alone when init's keys match, and rewrites only init's keys otherwise", async () => {
    // default_tools_approval_mode is a user key: init never writes it and keeps it.
    const codexRest =
      'tool_timeout_sec = 86400\nenv_vars = [ "SCHMEAR_WORKER" ]\ndefault_tools_approval_mode = "approve"\n\n[mcp_servers.schmear.env]\nFOO = "bar"\n\n[mcp_servers.other]\ncommand = "x"\n';
    const codexText = `# my codex settings\n\n${serverToml(process.execPath, cliArgs, codexRest)}`;
    const grokText = serverToml(process.execPath, cliArgs, "tool_timeout_sec = 86400\n");
    writeFileSync(codexToml, codexText);
    writeFileSync(grokToml, grokText);

    const steady = await runInit(true);
    assert.match(steady.out, /already registered in Codex/);
    assert.match(steady.out, /already registered in Grok/);
    assert.equal(readFileSync(codexToml, "utf8"), codexText);
    assert.equal(readFileSync(grokToml, "utf8"), grokText);

    // An old multi-line args value, a changed timeout, and a missing init key.
    writeFileSync(
      codexToml,
      codexText
        .replace(cliArgs, 'args = [\n  "/old/cli.js",\n  "serve",\n]')
        .replace("tool_timeout_sec = 86400", "tool_timeout_sec = 60")
        .replace('env_vars = [ "SCHMEAR_WORKER" ]\n', ""),
    );
    writeFileSync(
      grokToml,
      serverToml("node", 'args = ["/old/cli.js", "serve"]', "tool_timeout_sec = 86400\n"),
    );
    const updated = await runInit(true);
    assert.match(updated.out, /updated in Codex/);
    assert.match(updated.out, /updated in Grok/);
    assert.equal(
      readFileSync(codexToml, "utf8"),
      codexText
        .replace('env_vars = [ "SCHMEAR_WORKER" ]\n', "")
        .replace("[mcp_servers.schmear]\n", '[mcp_servers.schmear]\nenv_vars = [ "SCHMEAR_WORKER" ]\n'),
    );
    assert.equal(readFileSync(grokToml, "utf8"), grokText);
    assert.equal(
      (toml(codexToml) as { enabled: boolean }).enabled,
      false,
      "a disabled server stays disabled",
    );
    assert.match((await runInit(true)).out, /already registered in Codex/);
  });

  it("leaves an Antigravity entry with user keys alone when init's keys match, and rewrites only init's keys otherwise", async () => {
    const entry = {
      command: process.execPath,
      args,
      timeoutSeconds: 86_400,
      env: { A: "1" },
      disabled: true,
    };
    const text = `${JSON.stringify({ mcpServers: { schmear: entry, mine: { command: "mine" } } }, null, 2)}\n`;
    writeFileSync(agyJson, text);
    assert.match((await runInit(true)).out, /already registered in Antigravity/);
    assert.equal(readFileSync(agyJson, "utf8"), text);

    writeFileSync(agyJson, text.replace('"timeoutSeconds": 86400', '"timeoutSeconds": 180'));
    assert.match((await runInit(true)).out, /updated in Antigravity/);
    assert.equal(readFileSync(agyJson, "utf8"), text);
  });

  it("writes through a symlinked host config and keeps the link", async () => {
    const real = join(root, "dotfiles", "codex.toml");
    mkdirSync(join(root, "dotfiles"));
    writeFileSync(
      real,
      readFileSync(codexToml, "utf8").replace("tool_timeout_sec = 86400", "tool_timeout_sec = 60"),
    );
    rmSync(codexToml);
    symlinkSync(real, codexToml);
    assert.match((await runInit(true)).out, /updated in Codex/);
    assert.ok(lstatSync(codexToml).isSymbolicLink());
    assert.equal((toml(real) as { tool_timeout_sec: number }).tool_timeout_sec, 86_400);
  });

  it("registers at user scope and warns when another Claude scope shadows the entry", async () => {
    const scope = "Local config (private to you in this project)";
    writeFileSync(claudeShadow, scope);
    rmSync(claudeState);
    try {
      const { out } = await runInit(true);
      assert.match(
        out,
        new RegExp(`claude: the ${scope.replace(/[()]/g, "\\$&")} schmear entry shadows the user entry`),
      );
      assert.match(out, /registered in Claude Code/);
      assert.deepEqual(json(claudeState), {
        type: "stdio",
        command: process.execPath,
        args,
        timeout: 86_400_000,
      });
    } finally {
      rmSync(claudeShadow);
    }
    assert.match((await runInit(true)).out, /already registered in Claude Code/);
  });

  it("a host that fails to register is reported, the others still register and list, and init fails", async () => {
    const grokText = readFileSync(grokToml, "utf8");
    writeFileSync(grokToml, "[mcp_servers.schmear\n");
    writeFileSync(claudeAddFails, "");
    rmSync(claudeState);
    try {
      const err = await runInit(true).then(
        () => assert.fail("init resolved"),
        (e: Error & { out: string }) => e,
      );
      assert.equal(err.message, "not registered in Claude Code, Grok");
      assert.match(err.out, /Claude Code: not registered \(.*add-json refused/s);
      assert.match(err.out, /Grok: not registered \(cannot parse /);
      assert.match(err.out, /already registered in Codex/);
      assert.match(err.out, /already registered in Antigravity/);
      for (const id of ["claude", "codex", "grok", "agy"]) assert.match(err.out, new RegExp(`\\$ ${id} mcp`));
    } finally {
      rmSync(claudeAddFails);
      writeFileSync(grokToml, grokText);
    }
    assert.match((await runInit(true)).out, /registered in Claude Code/);
  });
});
