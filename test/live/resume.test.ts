import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { adapters } from "../../src/agents/index.ts";
import { createServer } from "../../src/server.ts";
import type { AgentId } from "../../src/types.ts";
import { guard, liveConfig } from "./guard.ts";

// Spends a tiny amount of each installed agent's subscription quota. Never run in CI.
const root = mkdtempSync(join(tmpdir(), "schmear-live-"));
const priorConfigHome = process.env.XDG_CONFIG_HOME;

before(async () => {
  process.env.XDG_CONFIG_HOME = (await liveConfig(root)).configHome;
});
after(() => {
  if (priorConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = priorConfigHome;
  rmSync(root, { recursive: true, force: true });
});

describe("live resume", () => {
  for (const agent of Object.keys(adapters) as AgentId[]) {
    it(`resume: ${agent} remembers a word across a resumed session`, async (t) => {
      const reason = await guard(agent, (line) => t.diagnostic(`usage ${line}`));
      if (reason) {
        t.diagnostic(`skipped: ${reason}`);
        t.skip(reason);
        return;
      }
      const cwd = mkdtempSync(join(root, "cwd-"));
      const server = await createServer(adapters);
      const client = new Client({ name: "schmear-live-test", version: "0" });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const turn = async (prompt: string, session?: string): Promise<string> => {
        const result = await client.callTool(
          {
            name: "delegate",
            arguments: { tasks: [{ prompt, cwd, tier: 1, agents: [agent], session }] },
          },
          undefined,
          { timeout: 300_000 },
        );
        return (result.content as { type: string; text: string }[])[0]?.text ?? "";
      };
      try {
        const first = await turn("Remember the word MANGO. Reply with only OK.");
        t.diagnostic(`turn 1: ${first}`);
        assert.match(first, /status: done/, first);
        const handle = /^session: (\S+)$/m.exec(first)?.[1];
        assert.ok(handle, `turn 1 returned no session line:\n${first}`);

        const second = await turn("What word did I ask you to remember? Reply with only that word.", handle);
        t.diagnostic(`turn 2: ${second}`);
        assert.match(second, /status: done/, second);
        assert.match(second, /^session: \S+$/m, second);
        // The header lines never carry the word (the description is turn 2's prompt); only the reply can.
        assert.match(second, /MANGO/, second);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }
});
