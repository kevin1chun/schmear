import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { candidates, DEFAULT_TIERS, parseTiers } from "../src/tiers.ts";

const guide = readFileSync(fileURLToPath(new URL("../docs/guide.md", import.meta.url)), "utf8");

describe("DEFAULT_TIERS", () => {
  it("deep-equals the guide's default tier list", () => {
    const json = guide
      .split("<summary>Default tier list</summary>")[1]
      ?.match(/```json\n([\s\S]*?)\n```/)?.[1];
    assert.deepEqual(DEFAULT_TIERS, JSON.parse(json ?? ""));
  });

  it("parses cleanly", () => {
    const parsed = parseTiers(DEFAULT_TIERS);
    assert.equal(parsed.length, 4);
    assert.deepEqual(parsed[0][0], { key: "claude", model: "haiku", effort: "medium" });
    assert.deepEqual(parsed[3], [
      { key: "claude", model: "fable", effort: "medium" },
      { key: "claude-credits", model: "fable", effort: "medium" },
    ]);
  });
});

describe("parseTiers", () => {
  const shape = {
    message: 'tiers must be a non-empty list of tiers, each a non-empty list of "key:model@effort" strings',
  };

  it("rejects non-array, empty, non-array tier, and non-string entry", () => {
    for (const bad of [
      null,
      undefined,
      {},
      { claude: { "1": { medium: { model: "haiku", effort: "medium" } } } },
      "claude:haiku@medium",
      [],
      ["claude:haiku@medium"],
      [{}],
      [[123]],
      [[null]],
      [["claude:haiku@medium"], [{ model: "sonnet", effort: "medium" }]],
    ]) {
      assert.throws(() => parseTiers(bad), shape);
    }
  });

  it("rejects an empty tier with its 1-based tier number", () => {
    assert.throws(() => parseTiers([[]]), { message: "tier 1 is empty" });
    assert.throws(() => parseTiers([["claude:haiku@medium"], []]), { message: "tier 2 is empty" });
  });

  it("rejects entries not matching key:model@effort", () => {
    for (const e of [
      "claude:haiku",
      "haiku@medium",
      ":haiku@medium",
      "claude:@medium",
      "claude:haiku@",
      "claude:haiku@med ium",
      "claude:haiku@a@b",
      "",
    ]) {
      assert.throws(() => parseTiers([[e]]), {
        message: `tier 1 entry "${e}": expected "key:model@effort"`,
      });
    }
  });

  it("rejects unknown lane keys", () => {
    assert.throws(() => parseTiers([["claude:haiku@medium"], ["openai:gpt-5@medium"]]), {
      message:
        'tier 2 entry "openai:gpt-5@medium": unknown lane key "openai" (one of claude, codex, grok, agy-gemini, agy-argon, agy-3p, claude-credits)',
    });
  });

  it("rejects duplicate key:model in the same tier", () => {
    assert.throws(() => parseTiers([["claude:sonnet@low", "claude:sonnet@high"]]), {
      message: 'tier 1 entry "claude:sonnet@high": claude:sonnet is listed twice in this tier',
    });
  });

  it("allows the same key:model in different tiers", () => {
    const parsed = parseTiers([["claude:sonnet@low"], ["claude:sonnet@high"]]);
    assert.deepEqual(parsed, [
      [{ key: "claude", model: "sonnet", effort: "low" }],
      [{ key: "claude", model: "sonnet", effort: "high" }],
    ]);
  });
});

describe("candidates", () => {
  const defaultList = parseTiers(DEFAULT_TIERS);

  it("never returns a tier below the task's, and exact tier comes first", () => {
    for (const tier of [1, 2, 3, 4]) {
      const lanes = candidates(tier, defaultList, {});
      assert.ok(lanes.length > 0);
      assert.ok(lanes.every((l) => l.tier >= tier));
      assert.deepEqual(
        lanes.map((l) => l.tier),
        lanes.map((l) => l.tier).sort((a, b) => a - b),
      );
      assert.equal(lanes[0]?.tier, tier);
    }
  });

  it("orders exact tier, then higher tiers, preserving list order within a tier", () => {
    const list = parseTiers([
      ["codex:c@low", "claude:a@medium"],
      ["claude:b@high", "codex:d@max"],
    ]);
    assert.deepEqual(
      candidates(1, list, {}).map((l) => l.id),
      ["codex:c", "claude:a", "claude:b", "codex:d"],
    );
  });

  it("builds the lane from the entry and carries its effort", () => {
    const [lane] = candidates(2, defaultList, {});
    assert.deepEqual(lane, {
      id: "claude:sonnet",
      agent: "claude",
      key: "claude",
      tier: 2,
      model: "sonnet",
      effort: "medium",
    });
    assert.equal(candidates(1, defaultList, {}).find((l) => l.key === "agy-argon")?.agent, "agy");
    assert.equal(
      candidates(3, defaultList, {}).find((l) => l.id === "agy-gemini:gemini-4-hydrogen")?.effort,
      "high",
    );
  });

  it("keeps the lowest tier per key:model", () => {
    const list = parseTiers([["claude:a@low"], ["claude:a@high"], ["claude:b@medium"]]);
    assert.deepEqual(
      candidates(1, list, {}).map((l) => [l.id, l.tier, l.effort]),
      [
        ["claude:a", 1, "low"],
        ["claude:b", 3, "medium"],
      ],
    );
    assert.deepEqual(
      candidates(2, list, {}).map((l) => [l.id, l.tier, l.effort]),
      [
        ["claude:a", 2, "high"],
        ["claude:b", 3, "medium"],
      ],
    );
  });

  it("keeps the same model on different keys", () => {
    const list = parseTiers([["agy-gemini:m@low", "agy-argon:m@medium"]]);
    assert.deepEqual(
      candidates(1, list, {}).map((l) => l.id),
      ["agy-gemini:m", "agy-argon:m"],
    );
  });

  it("drops a model missing from a known offered list only", () => {
    const list = parseTiers([["claude:a@low", "codex:c@max"], ["claude:b@medium"]]);
    const ids = (offered: Record<string, string[]>) => candidates(1, list, offered).map((l) => l.id);
    assert.deepEqual(ids({ claude: ["b"] }), ["codex:c", "claude:b"]);
    assert.deepEqual(ids({}), ["claude:a", "codex:c", "claude:b"]);
    assert.deepEqual(ids({ claude: [], codex: ["c"] }), ["codex:c"]);
  });

  it("keys the offered list by lane key, so claude-credits and claude differ", () => {
    const list = parseTiers([["claude:a@low", "claude-credits:a@low"]]);
    const ids = (offered: Record<string, string[]>) => candidates(1, list, offered).map((l) => l.id);
    assert.deepEqual(ids({ "claude-credits": ["b"] }), ["claude:a"]);
    assert.deepEqual(ids({ claude: ["b"] }), ["claude-credits:a"]);
  });

  it("works on a 2-tier list", () => {
    const two = parseTiers([
      ["claude:sonnet@low", "codex:gpt-5.6-terra@medium", "agy-gemini:gemini-4-hydrogen@medium"],
      ["claude:opus@high", "agy-3p:claude-opus-5-5@high", "agy-gemini:gemini-4-neon@high"],
    ]);
    assert.deepEqual(
      candidates(2, two, {}).map((l) => [l.id, l.tier, l.effort]),
      [
        ["claude:opus", 2, "high"],
        ["agy-3p:claude-opus-5-5", 2, "high"],
        ["agy-gemini:gemini-4-neon", 2, "high"],
      ],
    );
    assert.equal(candidates(1, two, {}).length, 6);
  });

  it("works on a 10-tier list", () => {
    const ten = parseTiers(Array.from({ length: 10 }, (_, i) => [`claude:m${i + 1}@medium`]));
    const all = candidates(1, ten, {});
    assert.equal(all.length, 10);
    assert.deepEqual(
      all.map((l) => l.tier),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    assert.deepEqual(candidates(10, ten, {}), [
      { id: "claude:m10", agent: "claude", key: "claude", tier: 10, model: "m10", effort: "medium" },
    ]);
  });
});
