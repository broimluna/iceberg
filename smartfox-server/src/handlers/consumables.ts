import { getUtfString } from "../wire-helpers.ts";
import type { SFSObjectData } from "../sfs-wire.ts";
import type { HandlerContext } from "./context.ts";

// "con.set" - client -> server only, no response.
// `data` is a JSON SignedResponse<ConsumableInventory>.
// TODO: track inventory once con.use / con.reuse are implemented.
export function handleConsumableSet(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const dataJson = getUtfString(innerParams, "data");
  console.log(`[${new Date().toISOString()}] ${ctx.peer} - con.set received (data=${dataJson ?? "(none)"}), no response documented`);
}
