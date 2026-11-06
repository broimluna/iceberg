import { SFSDataType, SFSObjectWriter, encodePacket, type SFSObjectData } from "../../sfs-wire.ts";
import { getByRoomExcluding } from "../../session-registry.ts";
import type { HandlerContext } from "../context.ts";

// RequestType.SetUserVariables = 12. The request carries only "vl"; the
// server broadcasts {u, vl} to everyone in the room, including the sender.
// The client only applies the variables to its own user when that echo
// arrives, so the sender needs it too.
export function handleSetUserVariables(params: SFSObjectData, ctx: HandlerContext): void {
  const vl = params["vl"];
  if (vl?.type === SFSDataType.SFS_ARRAY) {
    const packet = encodePacket(0, 12, new SFSObjectWriter().putInt("u", ctx.session.userId).putRaw("vl", vl));
    ctx.send(packet);
    for (const entry of getByRoomExcluding(ctx.session.roomName, ctx.session.userId)) entry.send(packet);
    console.log(`[${new Date().toISOString()}] ${ctx.peer} <- set user variables broadcast (u=${ctx.session.userId})`);
  } else {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - SetUserVariables with no "vl" array, not responding`);
  }
}
