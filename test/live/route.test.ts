import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { adapters } from "../../src/agents/index.ts";
import { createServer } from "../../src/server.ts";
import type { AgentId } from "../../src/types.ts";
import { guard, liveConfig } from "./guard.ts";

// Spends a tiny amount of each installed agent's subscription quota. Never run in CI.
const root = mkdtempSync(join(tmpdir(), "schmear-live-"));
const fixture = join(root, "fixture");
const priorConfigHome = process.env.XDG_CONFIG_HOME;
execFileSync("sh", [fileURLToPath(new URL("../../docs/probes/make_fixture.sh", import.meta.url)), fixture]);

before(async () => {
  process.env.XDG_CONFIG_HOME = (await liveConfig(root)).configHome;
});
after(() => {
  if (priorConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = priorConfigHome;
  rmSync(root, { recursive: true, force: true });
});

describe("live route", () => {
  for (const agent of Object.keys(adapters) as AgentId[]) {
    it(`route: ${agent} returns the fixture README's first line`, async (t) => {
      const reason = await guard(agent, (line) => t.diagnostic(`usage ${line}`));
      if (reason) {
        t.diagnostic(`skipped: ${reason}`);
        t.skip(reason);
        return;
      }
      const server = await createServer(adapters);
      const client = new Client({ name: "schmear-live-test", version: "0" });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      try {
        const result = await client.callTool(
          {
            name: "delegate",
            arguments: {
              tasks: [
                {
                  prompt: "Read README.md and reply with only its first line.",
                  cwd: fixture,
                  tier: 1,
                  agents: [agent],
                },
              ],
            },
          },
          undefined,
          { timeout: 300_000 },
        );
        const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
        t.diagnostic(`result: ${text}`);
        assert.match(text, /status: done/, text);
        assert.match(text, /PINEAPPLE/, text);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }
});
