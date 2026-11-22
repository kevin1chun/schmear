import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { FakeAgentLog, FakeAgentScript } from "./fake-agent.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FAKE_AGY = fileURLToPath(new URL("./fake-agy.ts", import.meta.url));
const AGY_USAGE = fileURLToPath(new URL("./fixtures/agy-usage.json", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "schmear-serve-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const configOptions: NonNullable<FakeAgentScript["configOptions"]> = [
  {
    id: "m",
    name: "m",
    category: "model",
    type: "select",
    currentValue: "gemini-4-hydrogen",
    options: [{ value: "gemini-4-hydrogen", name: "gemini-4-hydrogen" }],
  },
  {
    id: "e",
    name: "e",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [{ value: "medium", name: "medium" }],
  },
];

/** A sandbox with a schmear config, then `serve` spawned in it with stdio pipes. */
function start(name: string, config: string, script: FakeAgentScript = {}) {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "config", "schmear"), { recursive: true });
  writeFileSync(join(dir, "config", "schmear", "config.json"), config);
  const child = spawn(process.execPath, [CLI, "serve"], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_STATE_HOME: join(dir, "state"),
      FAKE_AGY_OUT: AGY_USAGE,
      FAKE_AGY_ACP_SCRIPT: JSON.stringify(script),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
  return { dir, child, exited, stderr: () => stderr };
}

/** Newline-delimited JSON-RPC over the server's stdio. */
function rpc(child: ChildProcess) {
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = "";
  child.stdout?.on("data", (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, nl)) as { id?: number };
      buffer = buffer.slice(nl + 1);
      if (message.id !== undefined) waiting.get(message.id)?.(message);
    }
  });
  let next = 0;
  const send = (message: object) => child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  return {
    send,
    call(method: string, params: object): Promise<Record<string, unknown>> {
      const id = ++next;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        send({ id, method, params });
      });
    },
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(ok: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) {
    if (ok()) return true;
  }
  return ok();
}

describe("serve", () => {
  it("lists the tools and, on stdin close, ends the running worker and exits 0", async () => {
    const dir = join(scratch, "stdio");
    const logFile = join(dir, "worker.json");
    const config = JSON.stringify({
      version: 1,
      agents: { agy: { consent: true, path: FAKE_AGY, overageOff: true } },
    });
    const { child, exited, stderr } = start("stdio", config, {
      configOptions,
      reply: "ok",
      sleepMs: 60_000,
      logFile,
    });
    const client = rpc(child);

    await client.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "serve-test", version: "0" },
    });
    client.send({ method: "notifications/initialized" });
    const listed = await client.call("tools/list", {});
    const names = ((listed.result as { tools: { name: string }[] }).tools ?? []).map((t) => t.name).sort();
    assert.deepEqual(names, ["delegate", "usage"]);

    void client.call("tools/call", {
      name: "delegate",
      arguments: { tasks: [{ prompt: "p", cwd: scratch, tier: 1, agents: ["agy"] }] },
    });
    const prompted = () =>
      existsSync(logFile) && (JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog).promptCalled;
    assert.ok(await until(prompted, 20_000), `worker never reached the prompt; stderr: ${stderr()}`);
    const { pid } = JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog;
    assert.ok(alive(pid), "worker should be running before stdin closes");

    child.stdin?.end();
    const code = await Promise.race([exited, sleep(10_000).then(() => "still running")]);
    if (code === "still running") child.kill("SIGKILL");
    assert.equal(code, 0, `serve did not exit 0 after stdin closed; stderr: ${stderr()}`);
    assert.ok(await until(() => !alive(pid), 5000), `worker ${pid} outlived the server`);
  });

  it("exits 1 with the malformed-config message", async () => {
    const { exited, stderr } = start("malformed", "{ not json");
    assert.equal(await exited, 1);
    assert.match(stderr(), /schmear: malformed config/);
  });
});
