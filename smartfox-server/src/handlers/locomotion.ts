import { SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import { getFloatArray, getByte, getUtfString } from "../wire-helpers.ts";
import { getByRoomExcluding } from "../session-registry.ts";
import { handleConsumableInteraction } from "./consumables.ts";
import type { HandlerContext } from "./context.ts";

// "l.a" - player movement, the most frequent packet. Echo "p" (position) and
// "a" (action byte) to everyone in the room, including the sender, adding
// "senderId" (room-local user id) and "t" (server time, ms). "d"/"v"/"o"
// are passed through only if present. Receivers resolve senderId through
// their local user list, which proximity.ts populates on room join.
export function handleLocomotionAction(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const position = getFloatArray(innerParams, "p");
  const action = getByte(innerParams, "a");
  if (position === undefined || action === undefined) {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - l.a missing required "p"/"a" field, not responding`);
    return;
  }
  // Used by validate.state and zone.player_location.
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
  // Pinata hits, trays.
  handleConsumableInteraction(ctx, action, object);
}
