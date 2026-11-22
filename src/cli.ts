#!/usr/bin/env node
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { adapters } from "./agents/index.ts";
import { init } from "./init.ts";
import { serveStdio, usageText } from "./server.ts";
import { errorMessage, PACKAGE_VERSION } from "./util.ts";

const USAGE = `schmear: delegate coding subtasks across your AI subscriptions

Usage:
  schmear init [--yes]   detect CLIs, ask consent, register the MCP server in each host
  schmear usage          show each subscription's quota and where the next task would go
  schmear serve          run the stdio MCP server (your host starts this)

Options:
  -y, --yes      answer yes to the Codex, Grok and Antigravity consent questions (never Claude's)
  -h, --help     show this help
  -v, --version  print the version

Docs: https://github.com/kevin1chun/schmear
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
      yes: { type: "boolean", short: "y" },
    },
  });

  if (values.version) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const [command] = positionals;
  if (command === "serve") {
    await serveStdio(adapters);
    return;
  }

  if (command === "usage") {
    process.stdout.write(`${await usageText(adapters, null)}\n`);
    return;
  }

  if (command === "init") {
    const rl = createInterface({ input: process.stdin });
    const lines = rl[Symbol.asyncIterator]();
    const io = {
      async ask(question: string): Promise<string> {
        process.stdout.write(question);
        const next = await lines.next();
        return next.done ? "" : next.value;
      },
      out: (text: string) => process.stdout.write(`${text}\n`),
    };
    try {
      await init({ yes: values.yes === true, cliPath: fileURLToPath(import.meta.url) }, io, adapters);
    } finally {
      rl.close();
    }
    return;
  }

  process.stderr.write(USAGE);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`schmear: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
