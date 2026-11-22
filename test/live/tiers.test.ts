import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { adapters } from "../../src/agents/index.ts";
import { createServer } from "../../src/server.ts";
import { readOffered } from "../../src/state.ts";
import { agentOf, candidates, DEFAULT_TIERS, parseTiers } from "../../src/tiers.ts";
import { type AgentId, LANE_KEYS, type Offered } from "../../src/types.ts";
import { guard, liveConfig } from "./guard.ts";

// Spends a tiny amount of each installed agent's subscription quota. Never run in CI.
const root = mkdtempSync(join(tmpdir(), "schmear-live-tiers-"));
const cwd = join(root, "cwd");
const priorConfigHome = process.env.XDG_CONFIG_HOME;
mkdirSync(cwd);

before(async () => {
  process.env.XDG_CONFIG_HOME = (await liveConfig(root)).configHome;
});
after(() => {
  if (priorConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = priorConfigHome;
  rmSync(root, { recursive: true, force: true });
});

const reported = (text: string, field: "model" | "effort") =>
  text.match(new RegExp(`^${field}: (.*)$`, "m"))?.[1];

describe("live tiers", () => {
  for (const agent of Object.keys(adapters) as AgentId[]) {
    it(`tiers: ${agent} runs its first tier-1 lane`, async (t) => {
      const reason = await guard(agent, (line) => t.diagnostic(`usage ${line}`));
      if (reason) {
        t.diagnostic(`skipped: ${reason}`);
        t.skip(reason);
        return;
      }
      const offered: Offered = {};
      for (const key of LANE_KEYS) {
        const models = agentOf(key) === agent ? await readOffered(key) : undefined;
        if (models) offered[key] = models;
      }
      const expected = candidates(1, parseTiers(DEFAULT_TIERS), offered).find((l) => l.agent === agent);
      assert.ok(expected, `no ${agent} lane for tier 1`);

      const server = await createServer(adapters);
      const client = new Client({ name: "schmear-live-test", version: "0" });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      try {
        const result = await client.callTool(
          {
            name: "delegate",
            arguments: {
              tasks: [{ prompt: "Reply with exactly: OK", cwd, tier: 1, agents: [agent] }],
            },
          },
          undefined,
          { timeout: 300_000 },
        );
        const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
        t.diagnostic(`result: ${text}`);
        const model = reported(text, "model");
        const effort = reported(text, "effort");
        t.diagnostic(
          `expected ${expected.model} at ${expected.effort}; reported ${model ?? "none"} at ${effort ?? "none"}`,
        );
        assert.match(text, /status: done/, text);
        assert.equal(model, expected.model);
        assert.equal(effort, expected.effort);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }
});
