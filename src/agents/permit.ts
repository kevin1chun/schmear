import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { Ask } from "../types.ts";
import { errorMessage } from "../util.ts";

function namedPaths(req: RequestPermissionRequest): string[] {
  const paths = (req.toolCall.locations ?? []).map((l) => l.path);
  for (const c of req.toolCall.content ?? []) {
    if (c.type === "diff") {
      paths.push(c.path);
    }
  }
  return [...new Set(paths)];
}

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

function rejection(req: RequestPermissionRequest): RequestPermissionResponse {
  const reject = req.options.filter((o) => o.kind === "reject_once");
  const option = reject.find((o) => o.optionId === "decline") ?? reject[0];
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : CANCELLED;
}

export async function permit(
  req: RequestPermissionRequest,
  turn: AbortSignal,
  ctx: { who: string; ask?: Ask; note(text: string): void },
): Promise<RequestPermissionResponse> {
  const { kind, title } = req.toolCall;
  const paths = namedPaths(req);
  let answer: RequestPermissionResponse;

  if (!ctx.ask) {
    answer = rejection(req);
  } else {
    const where = paths.length > 0 ? `: ${paths.join(", ")}` : "";
    const message = `${ctx.who} asks: ${title ?? "a tool call"} (${kind ?? "other"}${where})`;
    try {
      const optionId = await ctx.ask(message, req.options, turn);
      answer = optionId === undefined ? rejection(req) : { outcome: { outcome: "selected", optionId } };
    } catch (err) {
      if (!turn.aborted) {
        ctx.note(`permission prompt failed: ${errorMessage(err)}; rejected`);
      }
      answer = rejection(req);
    }
  }
  return turn.aborted ? CANCELLED : answer;
}
