import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

export interface FakeAppServerScript {
  config?: Record<string, unknown>;
  error?: string;
  exitOnConfigRead?: boolean;
  hang?: boolean;
  rateLimits?: Record<string, unknown>;
  pidFile: string;
  readFile: string;
}

const script = JSON.parse(process.argv[2] ?? "{}") as FakeAppServerScript;
const reply = (m: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
};

writeFileSync(script.pidFile, String(process.pid));
let initialized = false;
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    reply({ id: msg.id, result: { userAgent: "fake-app-server" } });
  } else if (msg.method === "initialized") {
    initialized = true;
  } else if (msg.method === "account/rateLimits/read") {
    writeFileSync(script.readFile, JSON.stringify({ initialized, args: process.argv.slice(3) }));
    reply({ id: msg.id, result: script.rateLimits ?? {} });
  } else if (msg.method === "config/read") {
    writeFileSync(script.readFile, JSON.stringify({ initialized, params: msg.params }));
    if (script.exitOnConfigRead) {
      process.exit(1);
    } else if (script.error) {
      reply({ id: msg.id, error: { code: -32000, message: script.error } });
    } else if (!script.hang) {
      reply({ id: msg.id, result: { config: script.config ?? {} } });
    }
  }
});
