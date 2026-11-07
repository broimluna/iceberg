import type { SFSObjectData } from "../sfs-wire.ts";
import { getUtfString } from "../wire-helpers.ts";
import type { HandlerContext } from "./context.ts";

// WebServiceEvent.type values.
const WS_EVENT_FISHING_CATCH = 1;

// "wsevent.{type}" - client -> server only. Whenever a WebAPI response
// carries wsEvents, the client forwards each one here with d = JSON
// SignedResponse<WebServiceEvent> {type: int, details: JSON}. The client
// handles no reply. The only type the WebAPI sends is 1, a fishing catch,
// with details = the winning reward name.
// TODO: feed fishing catches into the daily task system.
export function handleWebServiceEvent(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const json = getUtfString(innerParams, "d");
  let type: unknown;
  let details: unknown;
  try {
    const data = json ? JSON.parse(json)?.data : undefined;
    type = data?.type;
    details = data?.details;
  } catch (err) {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - wsevent: failed to parse "d" JSON: ${(err as Error).message}`);
    return;
  }
  const label = type === WS_EVENT_FISHING_CATCH ? "fishing catch" : "unknown type";
  console.log(`[${new Date().toISOString()}] ${ctx.peer} - wsevent ${String(type)} (${label}), details=${JSON.stringify(details)}`);
}
