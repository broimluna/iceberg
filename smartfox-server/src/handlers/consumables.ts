import { getUtfString } from "../wire-helpers.ts";
import type { SFSObjectData } from "../sfs-wire.ts";
import type { HandlerContext } from "./context.ts";

// SmartfoxCommand.SET_CONSUMABLE_INVENTORY ("con.set",
// SMARTFOX_PACKETS_DOCUMENTATION.md's Consumables section) - OUT only,
// no documented response: `data` = JSON `SignedResponse<ConsumableInventory>`.
// The old recovered Java extension's own SET_CONSUMABLE_INVENTORY.java is
// a bare trace-log with no logic at all - real con.use/con.reuse (the
// actual "use a Party Blaster" flow) both need a per-room MMO item
// broadcast this server can't do yet (no cross-connection room registry -
// see server.ts's module comment), so there's nothing meaningful to do
// with the inventory data itself until that's built. Logging only.
export function handleConsumableSet(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const dataJson = getUtfString(innerParams, "data");
  console.log(`[${new Date().toISOString()}] ${ctx.peer} - con.set received (data=${dataJson ?? "(none)"}), no response documented`);
}
