import type { AgentAdapter, AgentId } from "../types.ts";
import { agyAdapter } from "./agy.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { grokAdapter } from "./grok.ts";

export const adapters: Record<AgentId, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  grok: grokAdapter,
  agy: agyAdapter,
};
