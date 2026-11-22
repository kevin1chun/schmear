import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PermissionOption, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { permit } from "../src/agents/permit.ts";
import type { Ask } from "../src/types.ts";

const CANCELLED = { outcome: { outcome: "cancelled" } };
const selected = (optionId: string) => ({ outcome: { outcome: "selected", optionId } });

const ALLOW: PermissionOption = { optionId: "allow", name: "Allow", kind: "allow_once" };
const REJECT: PermissionOption = { optionId: "reject", name: "Reject", kind: "reject_once" };
const DECLINE: PermissionOption = { optionId: "decline", name: "Continue without it", kind: "reject_once" };
const CANCEL: PermissionOption = { optionId: "cancel", name: "Cancel", kind: "reject_always" };

function request(
  toolCall: Partial<RequestPermissionRequest["toolCall"]>,
  options: PermissionOption[] = [ALLOW, REJECT],
): RequestPermissionRequest {
  return { sessionId: "s1", toolCall: { toolCallId: "tc1", ...toolCall }, options };
}

describe("permit", () => {
  function setup(ask?: Ask) {
    const notes: string[] = [];
    const calls: { message: string; options: PermissionOption[]; signal: AbortSignal }[] = [];
    const wrapped: Ask | undefined = ask
      ? (message, options, signal) => {
          calls.push({ message, options, signal });
          return ask(message, options, signal);
        }
      : undefined;
    const ctx = {
      who: "codex worker on 'Add tests'",
      ask: wrapped,
      note: (t: string) => notes.push(t),
    };
    return { ctx, notes, calls };
  }
  const live = () => new AbortController().signal;
  const pick =
    (id: string): Ask =>
    async () =>
      id;

  it("asks an edit with the §8 message, the request's options and the turn signal", async () => {
    const { ctx, calls } = setup(pick("allow"));
    const turn = live();
    const a = "/anywhere/a.ts";
    const b = "/elsewhere/b.ts";
    const options = [ALLOW, REJECT, CANCEL];
    await permit(
      request(
        {
          kind: "edit",
          title: "Edit a.ts",
          locations: [{ path: a }],
          content: [{ type: "diff", path: b, newText: "" }],
        },
        options,
      ),
      turn,
      ctx,
    );
    assert.equal(calls[0]?.message, `codex worker on 'Add tests' asks: Edit a.ts (edit: ${a}, ${b})`);
    assert.equal(calls[0]?.options, options);
    assert.equal(calls[0]?.signal, turn);
  });

  it("asks a non-edit request, with defaults and without a paths part when none are named", async () => {
    const { ctx, calls } = setup(pick("allow"));
    await permit(request({ kind: "execute", title: "Run ls" }), live(), ctx);
    await permit(request({}), live(), ctx);
    await permit(request({ kind: "read", title: null, locations: [{ path: "/etc/hosts" }] }), live(), ctx);
    assert.deepEqual(
      calls.map((c) => c.message),
      [
        "codex worker on 'Add tests' asks: Run ls (execute)",
        "codex worker on 'Add tests' asks: a tool call (other)",
        "codex worker on 'Add tests' asks: a tool call (read: /etc/hosts)",
      ],
    );
  });

  it("asks every edit kind on any path, pathless included, and notes nothing", async () => {
    const { ctx, calls, notes } = setup(pick("allow"));
    for (const kind of ["edit", "delete", "move"] as const) {
      const res = await permit(request({ kind, locations: [{ path: "/etc/passwd" }] }), live(), ctx);
      assert.deepEqual(res, selected("allow"));
    }
    assert.deepEqual(await permit(request({ kind: "edit" }), live(), ctx), selected("allow"));
    assert.equal(calls.length, 4);
    assert.deepEqual(notes, []);
  });

  it("selects the optionId ask returns", async () => {
    const { ctx } = setup(pick("allow"));
    assert.deepEqual(await permit(request({ kind: "execute" }), live(), ctx), selected("allow"));
  });

  it("rejects when ask returns undefined, preferring decline over other reject_once", async () => {
    const { ctx, notes } = setup(async () => undefined);
    const req = (options: PermissionOption[]) => request({ kind: "execute" }, options);
    assert.deepEqual(await permit(req([ALLOW, REJECT]), live(), ctx), selected("reject"));
    assert.deepEqual(await permit(req([ALLOW, REJECT, DECLINE, CANCEL]), live(), ctx), selected("decline"));
    assert.deepEqual(await permit(req([ALLOW, CANCEL]), live(), ctx), CANCELLED);
    assert.deepEqual(notes, []);
  });

  it("rejects and notes when ask throws", async () => {
    const { ctx, notes } = setup(async () => {
      throw new Error("elicitation broke");
    });
    const res = await permit(request({ kind: "execute" }, [ALLOW, REJECT, DECLINE]), live(), ctx);
    assert.deepEqual(res, selected("decline"));
    assert.deepEqual(notes, ["permission prompt failed: elicitation broke; rejected"]);
  });

  it("rejects without an ask, or cancels when no reject_once is listed", async () => {
    const { ctx } = setup();
    assert.deepEqual(
      await permit(request({ kind: "execute" }, [ALLOW, REJECT]), live(), ctx),
      selected("reject"),
    );
    assert.deepEqual(await permit(request({ kind: "execute" }, [ALLOW, CANCEL]), live(), ctx), CANCELLED);
  });

  it("returns cancelled once turn is aborted, whatever ask returned or threw", async () => {
    const turn = new AbortController();
    const answered = setup(async () => {
      turn.abort();
      return "allow";
    });
    assert.deepEqual(await permit(request({ kind: "execute" }), turn.signal, answered.ctx), CANCELLED);

    const threw = new AbortController();
    const thrown = setup(async () => {
      threw.abort();
      throw new Error("aborted");
    });
    assert.deepEqual(await permit(request({ kind: "execute" }), threw.signal, thrown.ctx), CANCELLED);
    assert.deepEqual(thrown.notes, []);

    const early = new AbortController();
    early.abort();
    const pre = setup(pick("allow"));
    assert.deepEqual(await permit(request({ kind: "edit" }), early.signal, pre.ctx), CANCELLED);
  });
});
