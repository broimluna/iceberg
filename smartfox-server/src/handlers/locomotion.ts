import { SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import { getFloatArray, getByte, getUtfString } from "../wire-helpers.ts";
import { getByRoomExcluding } from "../session-registry.ts";
import type { HandlerContext } from "./context.ts";

// SmartfoxCommand.LOCOMOTION_ACTION ("l.a", highest-frequency packet -
// SMARTFOX_PACKETS_DOCUMENTATION.md's Movement section). Cross-checked
// field-for-field against independent working implementations - they
// echo "p" (position, required) and "a" (action-type byte, required)
// straight back, add "senderId" (int - the room-local SFS id) and "t"
// (long - a fresh server timestamp in ms, NOT the client's own), and pass
// "d"/"v"/"o" through only if the incoming packet actually had them.
// Neither reference implementation resends a wire-level SetUserPosition
// (c=0,a=30) on every movement update - the real Java server's own
// MMOApi.setUserPosition() call is a server-internal engine call, not
// something that produces its own extra client-visible packet beyond this
// "l.a" echo itself.
//
// That echo DOES need to reach every other occupant of the room, not just
// the mover - confirmed via the Java reference's own
// `getSFSApi().sendExtensionResponse("l.a", data, room.getUserList(), room,
// false)` (room-wide, not sender-only), and necessary regardless for the
// receiving client to have anything to show: onExtensionResponse resolves
// the packet's "senderId" through the receiver's own local UserManager,
// which only has an entry for a sender once handlers/proximity.ts's
// join/leave notifications have told it about them - this broadcast and
// that mechanism work together, not two independent fixes.
export function handleLocomotionAction(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const position = getFloatArray(innerParams, "p");
  const action = getByte(innerParams, "a");
  if (position === undefined || action === undefined) {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - l.a missing required "p"/"a" field, not responding`);
    return;
  }
  // Only position tracking this server does - see Session.lastPosition's
  // own comment for why (validate.state's InWorldState.position).
  ctx.session.lastPosition = position;
  const locomotionResponseP = new SFSObjectWriter()
    .putFloatArray("p", position)
    .putByte("a", action)
    .putInt("senderId", ctx.session.userId)
    .putLong("t", BigInt(Date.now()));
  const direction = getFloatArray(innerParams, "d");
  const velocity = getFloatArray(innerParams, "v");
  const object = getUtfString(innerParams, "o");
  if (direction !== undefined) locomotionResponseP.putFloatArray("d", direction);
  if (velocity !== undefined) locomotionResponseP.putFloatArray("v", velocity);
  if (object !== undefined) locomotionResponseP.putUtfString("o", object);
  const packet = encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "l.a").putSFSObject("p", locomotionResponseP));
  ctx.send(packet);
  for (const entry of getByRoomExcluding(ctx.session.roomName, ctx.session.userId)) entry.send(packet);
}
