import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { type RunWorkerOptions, runWorker, workerEnv } from "../src/acp.ts";
import { permit } from "../src/agents/permit.ts";
import type { LaunchSpec, WorkerRun } from "../src/types.ts";
import type { FakeAgentLog, FakeAgentScript } from "./fake-agent.ts";

const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.ts", import.meta.url));

function makeSpec(script: FakeAgentScript, overrides?: Partial<LaunchSpec>): LaunchSpec {
  return {
    command: process.execPath,
    args: [FAKE_AGENT, JSON.stringify(script)],
    env: workerEnv(),
    ...overrides,
  };
}

const rejectAll: RunWorkerOptions["permit"] = (req, turn) =>
  permit(req, turn, { who: "test worker", note() {} });

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A reparented process may linger as a zombie for a moment after SIGKILL. */
async function diesSoon(pid: number): Promise<boolean> {
  for (let i = 0; i < 40 && isAlive(pid); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "schmear-acp-test-"));
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("runWorker", () => {
  it("reply capture", async () => {
    const spec = makeSpec({
      reply: ["Hello, ", "world!"],
      usageUpdates: [
        { used: 100, size: 1000, cost: { amount: 0.0125, currency: "USD" } },
        { used: 200, size: 1000, cost: { amount: 0.025, currency: "USD" } },
      ],
    });

    const run = await runWorker(spec, process.cwd(), "say hello", {
      agent: "claude",
      signal: new AbortController().signal,
      permit: rejectAll,
    });

    assert.equal(run.stopReason, "end_turn");
    assert.equal(run.reply, "Hello, world!");
    assert.equal(run.sessionId, "fake-session-1");
    assert.equal(run.costUsd, 0.025);
    assert.equal(run.failure, undefined);
  });

  it("config option by category", async () => {
    await withTempDir(async (dir) => {
      const logFile = join(dir, "log.json");
      const configOptions: FakeAgentScript["configOptions"] = [
        {
          id: "session_mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "auto",
          options: [
            { value: "default", name: "Default" },
            { value: "auto", name: "Auto" },
          ],
        },
      ];

      const spec = makeSpec({ configOptions, reply: "ok", logFile }, { config: { mode: "default" } });

      const run = await runWorker(spec, dir, "hi", {
        agent: "claude",
        signal: new AbortController().signal,
        permit: rejectAll,
      });

      assert.equal(run.stopReason, "end_turn");
      const log = JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog;
      assert.deepEqual(log.configSets, [{ configId: "session_mode", value: "default" }]);

      // Missing value fails before prompt is sent.
      const invalidLogFile = join(dir, "invalid-log.json");
      const invalidSpec = makeSpec(
        { configOptions, reply: "should not run", logFile: invalidLogFile },
        { config: { mode: "nonexistent-mode" } },
      );
      const invalidRun = await runWorker(invalidSpec, dir, "hi", {
        agent: "claude",
        signal: new AbortController().signal,
        permit: rejectAll,
      });

      assert.ok(invalidRun.failure);
      assert.match(invalidRun.failure?.message ?? "", /nonexistent-mode/);
      assert.equal(invalidRun.reply, "");
    });
  });

  it("permission requests are rejected with reject_once, or cancelled when none is listed", async () => {
    await withTempDir(async (dir) => {
      const logFile = join(dir, "perm-log.json");
      const spec = makeSpec({
        reply: "done",
        logFile,
        permissionRequests: [
          {
            toolCall: { toolCallId: "tc-1", kind: "read", title: "Read file" },
            options: [
              { optionId: "opt-allow", name: "Allow once", kind: "allow_once" },
              { optionId: "opt-reject", name: "Reject once", kind: "reject_once" },
            ],
          },
          {
            toolCall: { toolCallId: "tc-2", kind: "edit", title: "Write file" },
            options: [{ optionId: "opt-allow", name: "Allow once", kind: "allow_once" }],
          },
        ],
      });

      const run = await runWorker(spec, dir, "check perms", {
        agent: "claude",
        signal: new AbortController().signal,
        permit: rejectAll,
      });

      assert.equal(run.stopReason, "end_turn");
      const log = JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog;
      assert.deepEqual(log.permissionOutcomes, [
        { outcome: { outcome: "selected", optionId: "opt-reject" } },
        CANCELLED,
      ]);
    });
  });

  it("abort sends session/cancel before a pending permission request is answered cancelled", async () => {
    await withTempDir(async (dir) => {
      const logFile = join(dir, "turn-log.json");
      const controller = new AbortController();
      const spec = makeSpec({
        logFile,
        permissionRequests: [
          {
            toolCall: { toolCallId: "tc-1", kind: "edit", title: "Write file" },
            options: [{ optionId: "opt-reject", name: "Reject once", kind: "reject_once" }],
          },
        ],
      });

      let turnAbortedAtRequest: boolean | undefined;
      const run = await runWorker(spec, dir, "ask then wait", {
        agent: "claude",
        signal: controller.signal,
        // Like a driver prompt left open: answers only when the turn aborts.
        permit: (_req, turn) =>
          new Promise<RequestPermissionResponse>((resolve) => {
            turnAbortedAtRequest = turn.aborted;
            turn.addEventListener("abort", () => resolve(CANCELLED), { once: true });
            controller.abort();
          }),
      });

      assert.equal(turnAbortedAtRequest, false);
      assert.equal(run.stopReason, "cancelled");
      const log = JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog;
      assert.deepEqual(log.events, ["cancel", "permission:cancelled"]);
    });
  });

  it("a worker that exits with a request pending aborts turn", async () => {
    await withTempDir(async (dir) => {
      const spec = makeSpec({
        exitWithPermissionPending: true,
        permissionRequests: [
          {
            toolCall: { toolCallId: "tc-1", kind: "edit", title: "Write file" },
            options: [{ optionId: "opt-reject", name: "Reject once", kind: "reject_once" }],
          },
        ],
      });

      let turn: AbortSignal | undefined;
      const run = await runWorker(spec, dir, "ask then die", {
        agent: "claude",
        signal: new AbortController().signal,
        permit: (_req, signal) => {
          turn = signal;
          return new Promise<RequestPermissionResponse>(() => {});
        },
      });

      assert.ok(run.failure);
      assert.ok(turn, "permit was never called");
      assert.equal(turn.aborted, true);
    });
  });

  it("a worker that traps SIGTERM is dead when runWorker returns", { timeout: 15_000 }, async () => {
    await withTempDir(async (dir) => {
      const logFile = join(dir, "log.json");
      const run = await runWorker(makeSpec({ trapSigterm: true, reply: "ok", logFile }), dir, "hi", {
        agent: "claude",
        signal: new AbortController().signal,
        permit: rejectAll,
      });
      assert.equal(run.stopReason, "end_turn");
      const log = JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog;
      assert.equal(isAlive(log.pid), false);
    });
  });

  it("a worker that exits while a grandchild holds stdout ends the run with a failure", {
    timeout: 15_000,
  }, async () => {
    await withTempDir(async (dir) => {
      const logFile = join(dir, "log.json");
      const spec = makeSpec({ exitLeavingGrandchild: true, logFile });
      const run = await runWorker(spec, dir, "hi", {
        agent: "claude",
        signal: new AbortController().signal,
        permit: rejectAll,
      });
      assert.ok(run.failure);
      assert.match(run.failure?.message ?? "", /claude agent exited/);
      const { grandchildPid } = JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog;
      assert.ok(grandchildPid !== undefined);
      assert.equal(await diesSoon(grandchildPid), true);
    });
  });

  it("cancel kills the worker's grandchild even when it ignores SIGTERM", { timeout: 15_000 }, async () => {
    await withTempDir(async (dir) => {
      const logFile = join(dir, "log.json");
      const controller = new AbortController();
      const spec = makeSpec({
        grandchild: true,
        sleepMs: 10_000,
        usageUpdates: [{ used: 1, size: 100, _meta: { "_claude/rateLimit": {} } }],
        logFile,
      });
      const run = await runWorker(spec, dir, "hi", {
        agent: "claude",
        signal: controller.signal,
        onRateLimit: () => controller.abort(),
        permit: rejectAll,
      });
      assert.equal(run.stopReason, "cancelled");
      const { grandchildPid } = JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog;
      assert.ok(grandchildPid !== undefined);
      assert.equal(await diesSoon(grandchildPid), true);
    });
  });

  it("a worker that never opens a session fails at the open timeout", async () => {
    await withTempDir(async (dir) => {
      const logFile = join(dir, "log.json");
      const run = await runWorker(makeSpec({ stallNew: true, logFile }), dir, "hi", {
        agent: "codex",
        signal: new AbortController().signal,
        openTimeoutMs: 300,
        permit: rejectAll,
      });
      assert.equal(run.failure?.message, "codex did not open a session within 0.3 s");
      assert.equal(run.prompted, false);
      const log = JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog;
      assert.equal(isAlive(log.pid), false);
    });
  });

  it("the open timeout does not bound the prompt", async () => {
    // Opening takes well under 2 s even on a loaded machine; the prompt alone outlasts the limit.
    const run = await runWorker(makeSpec({ sleepMs: 3000, reply: "done" }), process.cwd(), "hi", {
      agent: "claude",
      signal: new AbortController().signal,
      openTimeoutMs: 2000,
      permit: rejectAll,
    });
    assert.equal(run.stopReason, "end_turn");
    assert.equal(run.reply, "done");
  });

  it("requireAuth mismatch", async () => {
    await withTempDir(async (dir) => {
      const logFile = join(dir, "auth-log.json");
      const spec = makeSpec(
        {
          authStatus: { kind: "api_key", label: "Anthropic API key", detail: "apiKeyHelper" },
          reply: "must not be reached",
          logFile,
        },
        { requireAuth: { kind: "account" } },
      );

      const run = await runWorker(spec, dir, "do work", {
        agent: "claude",
        signal: new AbortController().signal,
        permit: rejectAll,
      });

      assert.ok(run.failure);
      assert.equal(run.reply, "");
      assert.equal(run.failure?.auth, "Anthropic API key");
      const log = JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog;
      assert.equal(log.promptCalled, false);
    });
  });

  it("error into failure", async () => {
    const spec = makeSpec({
      stderr: "adapter diagnostic line\n",
      usageUpdates: [
        {
          used: 50,
          size: 1000,
          _meta: { "_claude/rateLimit": { status: "rejected", isUsingOverage: false } },
        },
      ],
      error: {
        stage: "prompt",
        code: -32603,
        message: "Internal error",
        data: { errorKind: "billing_error" },
      },
    });

    const run = await runWorker(spec, process.cwd(), "trigger error", {
      agent: "claude",
      signal: new AbortController().signal,
      permit: rejectAll,
    });

    assert.ok(run.failure);
    assert.equal(run.failure?.code, -32603);
    assert.deepEqual(run.failure?.data, { errorKind: "billing_error" });
    assert.deepEqual(run.failure?.rateLimit, { status: "rejected", isUsingOverage: false });
    assert.equal(run.failure?.message, "Internal error");
    assert.equal(run.failure?.stderr, "adapter diagnostic line");

    const authErrSpec = makeSpec({
      error: {
        stage: "session_new",
        code: -32000,
        message: "Authentication required",
      },
    });
    const authErrRun = await runWorker(authErrSpec, process.cwd(), "auth fail", {
      agent: "claude",
      signal: new AbortController().signal,
      permit: rejectAll,
    });
    assert.ok(authErrRun.failure);
    assert.equal(authErrRun.failure?.code, -32000);
    assert.equal(authErrRun.failure?.message, "log in with the claude CLI");
  });

  it("cancel -> cancelled", async () => {
    await withTempDir(async (dir) => {
      const logFile = join(dir, "cancel-log.json");
      const controller = new AbortController();
      // Abort once the prompt is running (first rate-limit update), not on a timer that races session setup.
      const spec = makeSpec({
        sleepMs: 10_000,
        usageUpdates: [{ used: 1, size: 100, _meta: { "_claude/rateLimit": {} } }],
        logFile,
      });

      {
        const started = Date.now();
        const run = await runWorker(spec, dir, "long task", {
          agent: "claude",
          signal: controller.signal,
          onRateLimit: () => controller.abort(),
          permit: rejectAll,
        });
        const elapsed = Date.now() - started;

        assert.equal(run.stopReason, "cancelled");
        assert.ok(elapsed < 5_000, `expected prompt cancellation, took ${elapsed}ms`);
        const log = JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog;
        assert.equal(log.cancelled, true);
      }
    });
  });

  describe("model and effort reporting", () => {
    const select = (
      id: string,
      category: string,
      currentValue: string,
      values: string[],
    ): NonNullable<FakeAgentScript["configOptions"]>[number] => ({
      id,
      name: id,
      category,
      type: "select",
      currentValue,
      options: values.map((value) => ({ value, name: value })),
    });
    const run = (script: FakeAgentScript, overrides?: Partial<LaunchSpec>) =>
      runWorker(makeSpec({ reply: "ok", ...script }, overrides), process.cwd(), "hi", {
        agent: "claude",
        signal: new AbortController().signal,
        permit: rejectAll,
      });

    it("from the session/new options", async () => {
      const result = await run({
        configOptions: [
          select("m", "model", "opus", ["opus", "sonnet"]),
          select("e", "thought_level", "high", ["low", "high"]),
        ],
      });
      assert.equal(result.model, "opus");
      assert.equal(result.effort, "high");
    });

    it("follows the options a set_config_option response returns", async () => {
      const result = await run(
        {
          configOptions: [
            select("mode", "mode", "default", ["default", "auto"]),
            select("m", "model", "opus", ["opus", "sonnet"]),
            select("e", "thought_level", "high", ["low", "high"]),
          ],
          configOptionsAfterSet: [
            select("mode", "mode", "auto", ["default", "auto"]),
            select("m", "model", "sonnet", ["opus", "sonnet"]),
            select("e", "thought_level", "low", ["low"]),
          ],
        },
        { config: { mode: "auto" } },
      );
      assert.equal(result.model, "sonnet");
      assert.equal(result.effort, "low");
    });

    it("falls back to the models block's reasoningEffort when there is no thought_level option", async () => {
      const result = await run({
        configOptions: [select("m", "model", "grok-4.7", ["grok-4.7"])],
        models: {
          currentModelId: "grok-4.7",
          availableModels: [
            { modelId: "grok-4.6", name: "Grok 4.6", _meta: { reasoningEffort: "low" } },
            { modelId: "grok-4.7", name: "Grok 4.7", _meta: { reasoningEffort: "high" } },
          ],
        },
      });
      assert.equal(result.model, "grok-4.7");
      assert.equal(result.effort, "high");
    });

    it("a thought_level option wins over the models block", async () => {
      const result = await run({
        configOptions: [select("e", "thought_level", "low", ["low", "high"])],
        models: {
          currentModelId: "x",
          availableModels: [{ modelId: "x", name: "X", _meta: { reasoningEffort: "high" } }],
        },
      });
      assert.equal(result.effort, "low");
    });

    describe("setting model then effort", () => {
      const initial = [
        select("m", "model", "opus", ["opus", "sonnet"]),
        select("e", "thought_level", "high", ["low", "high"]),
      ];
      // Selecting a model changes which efforts it offers (R33).
      const afterModel = [
        select("m", "model", "sonnet", ["opus", "sonnet"]),
        select("e", "thought_level", "max", ["low", "max"]),
      ];
      const runLogged = async (
        script: FakeAgentScript,
        config: NonNullable<LaunchSpec["config"]>,
      ): Promise<{ result: WorkerRun; log: FakeAgentLog }> => {
        return withTempDir(async (dir) => {
          const logFile = join(dir, "log.json");
          const result = await run({ ...script, logFile }, { config });
          return { result, log: JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog };
        });
      };

      it("sets the model before the effort and looks the effort up in the post-model options", async () => {
        const { result, log } = await runLogged(
          { configOptions: initial, configOptionsAfterSet: afterModel },
          { model: "sonnet", effort: "max" },
        );
        assert.equal(result.stopReason, "end_turn");
        assert.deepEqual(log.events, ["set:m", "set:e"]);
        assert.deepEqual(log.configSets, [
          { configId: "m", value: "sonnet" },
          { configId: "e", value: "max" },
        ]);
        assert.equal(result.model, "sonnet");
        assert.equal(result.effort, "max");
      });

      it("an effort only the initial options offer is not offered after the model change", async () => {
        const { result, log } = await runLogged(
          { configOptions: initial, configOptionsAfterSet: afterModel },
          { model: "sonnet", effort: "high" },
        );
        assert.ok(result.failure);
        assert.deepEqual(result.failure?.notOffered, {
          model: "sonnet",
          effort: "high",
        });
        assert.deepEqual(result.offered, ["opus", "sonnet"]);
        assert.equal(log.promptCalled, false);
        assert.deepEqual(log.events, ["set:m"]);
      });

      it("a missing model is notOffered and no prompt is sent", async () => {
        const { result, log } = await runLogged(
          { configOptions: initial },
          { model: "haiku", effort: "low" },
        );
        assert.ok(result.failure);
        assert.deepEqual(result.failure?.notOffered, { model: "haiku" });
        assert.deepEqual(result.offered, ["opus", "sonnet"]);
        assert.equal(log.promptCalled, false);
        assert.deepEqual(log.events, []);
      });

      it("no model option is a plain failure, not notOffered", async () => {
        const { result, log } = await runLogged(
          { configOptions: [select("e", "thought_level", "high", ["high"])] },
          { model: "opus" },
        );
        assert.ok(result.failure);
        assert.equal(result.failure?.message, 'config option category "model" is not available');
        assert.equal(result.failure?.notOffered, undefined);
        assert.equal(log.promptCalled, false);
      });

      it("a missing effort is notOffered and no prompt is sent", async () => {
        const { result, log } = await runLogged(
          { configOptions: initial },
          { model: "sonnet", effort: "max" },
        );
        assert.ok(result.failure);
        assert.deepEqual(result.failure?.notOffered, {
          model: "sonnet",
          effort: "max",
        });
        assert.deepEqual(result.offered, ["opus", "sonnet"]);
        assert.equal(log.promptCalled, false);
      });

      it("an effort with no thought_level option is notOffered with an empty list", async () => {
        const { result, log } = await runLogged(
          { configOptions: [select("m", "model", "opus", ["opus"])] },
          { model: "opus", effort: "low" },
        );
        assert.deepEqual(result.failure?.notOffered, { model: "opus", effort: "low" });
        assert.deepEqual(result.offered, ["opus"]);
        assert.equal(log.promptCalled, false);
      });

      it("without config.effort nothing is set for effort (Grok)", async () => {
        const { result, log } = await runLogged(
          {
            configOptions: [select("m", "model", "grok-4.6", ["grok-4.6", "grok-4.7"])],
            models: {
              currentModelId: "grok-4.7",
              availableModels: [
                { modelId: "grok-4.7", name: "Grok 4.7", _meta: { reasoningEffort: "high" } },
              ],
            },
          },
          { model: "grok-4.7" },
        );
        assert.equal(result.stopReason, "end_turn");
        assert.deepEqual(log.events, ["set:m"]);
        assert.equal(result.model, "grok-4.7");
        assert.equal(result.effort, "high");
      });
    });

    it("offered lists the model option's values on success", async () => {
      const result = await run({ configOptions: [select("m", "model", "opus", ["opus", "sonnet"])] });
      assert.equal(result.stopReason, "end_turn");
      assert.deepEqual(result.offered, ["opus", "sonnet"]);
    });

    it("offered is absent without a model option", async () => {
      const result = await run({ configOptions: [select("e", "thought_level", "high", ["low", "high"])] });
      assert.ok(!("offered" in result));
    });

    it("both are undefined when nothing reports them", async () => {
      const result = await run({});
      assert.equal(result.model, undefined);
      assert.equal(result.effort, undefined);
      assert.ok(!("model" in result) && !("effort" in result));
    });
  });

  describe("resume", () => {
    const select = (
      id: string,
      category: string,
      currentValue: string,
      values: string[],
    ): NonNullable<FakeAgentScript["configOptions"]>[number] => ({
      id,
      name: id,
      category,
      type: "select",
      currentValue,
      options: values.map((value) => ({ value, name: value })),
    });
    const configOptions = [
      select("m", "model", "opus", ["opus", "sonnet"]),
      select("e", "thought_level", "high", ["low", "high"]),
    ];
    const resumeRun = (script: FakeAgentScript, overrides?: Partial<LaunchSpec>) =>
      withTempDir(async (dir) => {
        const logFile = join(dir, "log.json");
        const result = await runWorker(makeSpec({ reply: "ok", ...script, logFile }, overrides), dir, "hi", {
          agent: "claude",
          signal: new AbortController().signal,
          permit: rejectAll,
          resume: "old-session",
        });
        return { result, log: JSON.parse(readFileSync(logFile, "utf8")) as FakeAgentLog };
      });

    it("prefers session/resume over session/load and returns the resumed id", async () => {
      const { result, log } = await resumeRun({ advertiseResume: true, advertiseLoad: true });
      assert.deepEqual(log.sessionCalls, ["resume:old-session"]);
      assert.equal(result.stopReason, "end_turn");
      assert.equal(result.sessionId, "old-session");
      assert.equal(result.reply, "ok");
    });

    it("uses session/load when only load is advertised, and ignores its history replay", async () => {
      const { result, log } = await resumeRun({ advertiseLoad: true, replayOnLoad: "earlier turn" });
      assert.deepEqual(log.sessionCalls, ["load:old-session"]);
      assert.equal(result.stopReason, "end_turn");
      assert.equal(result.sessionId, "old-session");
      assert.equal(result.reply, "ok");
    });

    it("fails naming the agent, without a prompt, when neither is advertised", async () => {
      const { result, log } = await resumeRun({});
      assert.ok(result.failure);
      assert.match(result.failure?.message ?? "", /claude agent cannot resume/);
      assert.deepEqual(log.sessionCalls, []);
      assert.equal(log.promptCalled, false);
    });

    it("re-applies model then effort from the options the resume returns", async () => {
      const afterModel = [
        select("m", "model", "sonnet", ["opus", "sonnet"]),
        select("e", "thought_level", "max", ["low", "max"]),
      ];
      const { result, log } = await resumeRun(
        { advertiseResume: true, configOptions, configOptionsAfterSet: afterModel },
        { config: { model: "sonnet", effort: "max" } },
      );
      assert.equal(result.stopReason, "end_turn");
      assert.deepEqual(log.events, ["set:m", "set:e"]);
      assert.deepEqual(log.configSets, [
        { configId: "m", value: "sonnet" },
        { configId: "e", value: "max" },
      ]);
      assert.equal(result.model, "sonnet");
      assert.equal(result.effort, "max");
    });

    it("re-applies config after session/load too", async () => {
      const { result, log } = await resumeRun(
        { advertiseLoad: true, configOptions },
        { config: { model: "sonnet" } },
      );
      assert.equal(result.stopReason, "end_turn");
      assert.deepEqual(log.configSets, [{ configId: "m", value: "sonnet" }]);
      assert.equal(result.model, "sonnet");
    });
  });
});
