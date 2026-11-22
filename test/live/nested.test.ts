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

// Runs after the user's real `schmear init`: each worker loads the user's MCP config, so its nested
// schmear must see SCHMEAR_WORKER=1 (Codex only through env_vars) and offer only `usage`.
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

const PROMPT =
  "List the tools offered by your MCP server named schmear, without calling any of them. Reply with only the tool names, comma-separated, or NONE if you have no MCP server named schmear.";

describe("live nested", () => {
  for (const agent of Object.keys(adapters) as AgentId[]) {
    it(`nested: ${agent} worker sees only schmear's usage tool`, async (t) => {
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
      try {
        const result = await client.callTool(
          {
            name: "delegate",
            arguments: { tasks: [{ prompt: PROMPT, cwd, tier: 1, agents: [agent] }] },
          },
          undefined,
          { timeout: 300_000 },
        );
        const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
        t.diagnostic(text);
        assert.match(text, /status: done/, text);
        // The reply follows the first blank line; the header carries the prompt as its description.
        const reply = text.slice(text.indexOf("\n\n") + 2);
        // Hosts prefix tool names (`mcp__schmear__usage`), and `_` is a word character, so no leading `\b`.
        assert.match(reply, /(?<![A-Za-z])usage\b/, reply);
        assert.doesNotMatch(reply, /(?<![A-Za-z])delegate\b/, reply);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }
});
