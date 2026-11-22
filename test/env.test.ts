import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STRIPPED_ENV_VARS, workerEnv } from "../src/acp.ts";

// Literal copy of the spec §14 list: a source edit must not shrink it unnoticed.
const SPEC_STRIPPED = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "MODEL_PROVIDER",
  "CODEX_CONFIG",
  "DEFAULT_AUTH_REQUEST",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "XAI_API_KEY",
  "GROK_CODE_XAI_API_KEY",
  "GROK_AUTH",
  "GROK_MODELS_BASE_URL",
  "GROK_XAI_API_BASE_URL",
  "GROK_CLI_CHAT_PROXY_BASE_URL",
];

describe("workerEnv", () => {
  it("strips exactly the spec §14 variables", () => {
    assert.deepEqual([...STRIPPED_ENV_VARS].sort(), [...SPEC_STRIPPED].sort());
  });

  it("strips every auth/billing variable and sets SCHMEAR_WORKER=1", () => {
    const base: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/home",
      KEEP_ME: "yes",
    };
    for (const key of STRIPPED_ENV_VARS) {
      base[key] = `fixture-${key}`;
    }

    const result = workerEnv({ EXTRA_FLAG: "1" }, base);

    for (const key of STRIPPED_ENV_VARS) {
      assert.equal(key in result, false, `expected ${key} to be stripped`);
    }
    assert.equal(result.SCHMEAR_WORKER, "1");
    assert.equal(result.PATH, "/usr/bin:/bin");
    assert.equal(result.HOME, "/tmp/home");
    assert.equal(result.KEEP_ME, "yes");
    assert.equal(result.EXTRA_FLAG, "1");
  });
});
