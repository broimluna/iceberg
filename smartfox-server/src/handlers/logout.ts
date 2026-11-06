import { SFSObjectWriter, encodePacket } from "../sfs-wire.ts";
import type { HandlerContext } from "./context.ts";

// "zone.logout" (SmartfoxCommand.LEAVE_ROOM in the client). The client doesn't
// want an extension reply here: it waits for a system-level Logout response
// (controller 0, action 2). Only that makes it disconnect and fire
// ROOM_LEAVE; without it, "quit to menu" hangs.
export function handleZoneLogout(ctx: HandlerContext): void {
  ctx.send(encodePacket(0, 2, new SFSObjectWriter().putUtfString("zn", ctx.session.zoneName)));
  console.log(`[${new Date().toISOString()}] ${ctx.peer} <- logout response (zn=${ctx.session.zoneName})`);
}
