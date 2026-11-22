import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentId } from "../../src/types.ts";
import { guard, liveConfig } from "./guard.ts";

// Spends a tiny amount of one agent's subscription quota. Never run in CI. Run `npm run build` first.
// Config env vars (SCHMEAR_LIVE_OVERAGE_OFF, SCHMEAR_LIVE_GROK): see guard.ts.
const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "schmear-live-"));
const fixture = join(scratch, "fixture");
execFileSync("sh", [fileURLToPath(new URL("../../docs/probes/make_fixture.sh", import.meta.url)), fixture]);
after(() => rmSync(scratch, { recursive: true, force: true }));

const text = (result: object) =>
  ((result as { content?: unknown }).content as { type: string; text: string }[])[0]?.text ?? "";

/** Pace per pool in a `usage` block's `pool <id>: … | pace <n> | <status>` lines; null when the text shows `-`. */
function claudePaces(usage: string): Map<string, number | null> {
  const block = usage.split("\n\n").find((b) => b.startsWith("## claude")) ?? "";
  const paces = new Map<string, number | null>();
  for (const m of block.matchAll(/^pool (\S+?)(?: \[[^\]]*\])?: .* \| pace (-|[\d.]+) \| /gm)) {
    paces.set(m[1] as string, m[2] === "-" ? null : Number(m[2]));
  }
  return paces;
}

describe("live routing", () => {
  it("routing: usage names the tier-1 lane, the Claude reserve shows, and delegate runs that lane", async (t) => {
    assert.ok(existsSync(cli), `${cli} is missing: run \`npm run build\` first`);

    const { configHome, config } = await liveConfig(scratch);
    const { agents } = config;
    assert.ok(agents.claude, "claude is not installed or not logged in; the reserve check needs it");
    t.diagnostic(`config: ${JSON.stringify(agents)}`);
    // The router may pick any consented agent's lane, so every one must pass the money guard.
    for (const agent of Object.keys(agents) as AgentId[]) {
      const reason = await guard(agent, (line) => t.diagnostic(`usage ${line}`));
      if (reason) {
        t.diagnostic(`skipped: ${reason}`);
        t.skip(reason);
        return;
      }
    }

    const env = Object.fromEntries(
      Object.entries({ ...process.env, XDG_CONFIG_HOME: configHome }).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    );
    const client = new Client({ name: "claude-code", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "serve"], env }));
    try {
      const usage = text(
        await client.callTool({ name: "usage", arguments: {} }, undefined, { timeout: 120_000 }),
      );
      t.diagnostic(`usage:\n${usage}`);
      assert.match(usage, /^driver: claude$/m, usage);

      // `schmear usage` has no driver, hence no reserve; the same cached reading gives a higher Claude pace.
      const bare = execFileSync(process.execPath, [cli, "usage"], {
        env,
        encoding: "utf8",
        timeout: 120_000,
      });
      const reserved = claudePaces(usage);
      const free = claudePaces(bare);
      let lower = 0;
      for (const [id, pace] of reserved) {
        const base = free.get(id);
        if (pace === null || base == null) continue;
        assert.ok(
          pace <= base,
          `claude pool ${id}: pace ${pace} with the driver reserve exceeds ${base} without`,
        );
        if (pace < base) lower++;
      }
      assert.ok(
        lower > 0,
        `no claude pool shows a lower pace with the 5% reserve than without:\n${usage}\n---\n${bare}`,
      );

      const next = /^next: tier 1 → (\S+) \(([^)]+)\)$/m.exec(usage);
      assert.ok(next, `usage names no tier-1 lane:\n${usage}`);
      const laneId = next[1] as string;
      const split = laneId.indexOf(":");
      const key = laneId.slice(0, split);
      const model = laneId.slice(split + 1);
      const agent: AgentId = key.startsWith("agy-") ? "agy" : (key as AgentId);

      const out = text(
        await client.callTool(
          {
            name: "delegate",
            arguments: {
              tasks: [
                {
                  prompt: "Read README.md and reply with only its first line.",
                  cwd: fixture,
                  tier: 1,
                },
              ],
            },
          },
          undefined,
          { timeout: 300_000 },
        ),
      );
      t.diagnostic(`result: ${out}`);
      assert.match(out, /^status: done$/m, out);
      assert.match(out, /PINEAPPLE/, out);
      assert.match(
        out,
        new RegExp(`^provider: ${agent}$`, "m"),
        `expected provider ${agent} (lane ${laneId}):\n${out}`,
      );
      assert.ok(
        out.split("\n").includes(`model: ${model}`),
        `expected model ${model} (lane ${laneId}):\n${out}`,
      );
    } finally {
      await client.close();
    }
  });
});
