#!/usr/bin/env node
// Fake `agy`: --version, `-p /usage --output-format json` (readAgyUsage), and `acp`, which runs fake-agent.ts
// with the script in FAKE_AGY_ACP_SCRIPT.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname } from "node:path";

const args = process.argv.slice(2).join(" ");
if (process.env.AGY_CLI_DISABLE_AUTO_UPDATE !== "true") {
  console.error("AGY_CLI_DISABLE_AUTO_UPDATE not true");
  process.exit(2);
}
if (process.env.FAKE_AGY_LOG) {
  appendFileSync(process.env.FAKE_AGY_LOG, `${args}\n`, "utf8");
}

if (args === "--version") {
  if (process.env.FAKE_AGY_VERSION_FAIL) {
    console.error("version check failed");
    process.exit(1);
  }
  process.stdout.write(`${process.env.FAKE_AGY_VERSION ?? "1.5.14"}\n`);
  process.exit(0);
}

if (args === "acp") {
  process.argv[2] = process.env.FAKE_AGY_ACP_SCRIPT ?? "{}";
  await import("./fake-agent.ts");
  await new Promise(() => {});
}

if (args !== "-p /usage --output-format json") {
  console.error(`unexpected invocation: ${args}`);
  process.exit(2);
}

if (process.env.FAKE_AGY_INSPECT) {
  const probe = (cmd: string, cmdArgs: string[]) => {
    const res = spawnSync(cmd, cmdArgs, { stdio: "ignore" });
    return { status: res.status, error: res.error ? res.error.message : null };
  };
  const pathHead = (process.env.PATH ?? "").split(delimiter)[0] ?? "";
  writeFileSync(
    process.env.FAKE_AGY_INSPECT,
    JSON.stringify({
      cwd: process.cwd(),
      pathHead: pathHead ? realpathSync(pathHead) : "",
      browser: process.env.BROWSER ?? "",
      browserDir: process.env.BROWSER ? realpathSync(dirname(process.env.BROWSER)) : "",
      open: probe("open", ["https://example.com"]),
      xdgOpen: probe("xdg-open", ["https://example.com"]),
      browserExec: process.env.BROWSER ? probe(process.env.BROWSER, ["https://example.com"]) : null,
    }),
    "utf8",
  );
}

if (process.env.FAKE_AGY_FAIL) {
  console.error("FAKE_AGY_SECRET_STDERR");
  process.exit(1);
}
if (process.env.FAKE_AGY_PID) {
  writeFileSync(process.env.FAKE_AGY_PID, String(process.pid), "utf8");
}
if (process.env.FAKE_AGY_HANG) {
  if (process.env.FAKE_AGY_IGNORE_TERM) {
    process.on("SIGTERM", () => {});
  }
  setInterval(() => {}, 1000);
} else if (process.env.FAKE_AGY_BG_PID) {
  const bg = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "inherit", "ignore"],
  });
  bg.unref();
  writeFileSync(process.env.FAKE_AGY_BG_PID, String(bg.pid), "utf8");
  process.stdout.write(readFileSync(process.env.FAKE_AGY_OUT ?? "", "utf8"));
} else {
  process.stdout.write(readFileSync(process.env.FAKE_AGY_OUT ?? "", "utf8"));
}
