import { SFSDataType, SFSObjectWriter, encodePacket, type SFSObjectData } from "../../sfs-wire.ts";
import { getByRoomExcluding } from "../../session-registry.ts";
import type { HandlerContext } from "../context.ts";

// RequestType.SetUserVariables = 12 (SmartFox2X.decompiled.cs:12610). Real
// SFS2X broadcasts a client's own SetUserVariables request back out
// (KEY_USER="u" + KEY_VAR_LIST="vl", SetUserVariablesRequest.KEY_USER/
// KEY_VAR_LIST, SmartFox2X.decompiled.cs:13048-13050) to every relevant
// user in the room, INCLUDING the sender - that echo is what actually
// applies the variable to the client's own local User object
// (FnSetUserVariables looks the user up by the "u" id and calls
// SetVariable per entry, SmartFox2X.decompiled.cs:2757-2781 - the client's
// own outgoing request never touches its local state directly). The
// request itself only carries "vl", not "u" - confirmed live, first seen
// as "no handler for c=0 a=12" the very first time this project connected
// a real client. Broadcasting to every OTHER occupant of the room (not
// just echoing to the sender) is what makes this actually a broadcast -
// same room-registry pattern as handlers/locomotion.ts's "l.a" and
// handlers/chat.ts's chat.msg; this was the one remaining spot still doing
// the old single-connection echo, which is why a live outfit/colour/tube
// change (My Penguin) never reached anyone else already standing in the
// room with the sender.
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
