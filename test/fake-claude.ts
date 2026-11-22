#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

// FAKE_CLAUDE_LOG: file receiving {args, cwd, pid} then each stdin line. FAKE_CLAUDE_OUT: JSON array of
// messages printed when the `u` request arrives; unset = never answer. A non-JSON line precedes them.
const log = process.env.FAKE_CLAUDE_LOG;
if (log) {
  writeFileSync(
    log,
    `${JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), pid: process.pid })}\n`,
  );
}
const out = process.env.FAKE_CLAUDE_OUT;
createInterface({ input: process.stdin }).on("line", (line) => {
  if (log) {
    appendFileSync(log, `${line}\n`);
  }
  if (out && JSON.parse(line).request_id === "u") {
    process.stdout.write("not json\n");
    for (const message of JSON.parse(readFileSync(out, "utf8"))) {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    }
  }
});
setInterval(() => {}, 60_000);
