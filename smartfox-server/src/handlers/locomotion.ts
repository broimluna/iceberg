import { SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import { getFloatArray, getByte, getUtfString, fitsBytes } from "../wire-helpers.ts";
import { getByRoomExcluding } from "../session-registry.ts";
import { handleConsumableInteraction } from "./consumables.ts";
import { handleLobbyInteraction, onThrowAction } from "../party-games/lobby.ts";
import { onPartyGameAction, onPartyGamePlayerMoved } from "../party-games/manager.ts";
import { onLocomotion } from "../daily-tasks.ts";
import type { HandlerContext } from "./context.ts";

// "l.a" - player movement, the most frequent packet. Echo "p" (position) and
// "a" (action byte) to everyone in the room, including the sender, adding
// "senderId" (room-local user id) and "t" (server time, ms). "d"/"v"/"o"
// are passed through only if present. Receivers resolve senderId through
// their local user list, which proximity.ts populates on room join.
// p, d and v are Vector3s; o is a JSON ActionedObject {type, id, tag}.
const MAX_OBJECT_BYTES = 1024;
const isVector3 = (v: number[] | undefined) => v !== undefined && v.length === 3 && v.every(Number.isFinite);

export function handleLocomotionAction(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const position = getFloatArray(innerParams, "p");
  const action = getByte(innerParams, "a");
  if (position === undefined || action === undefined) {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - l.a missing required "p"/"a" field, not responding`);
    return;
  }
  const direction = getFloatArray(innerParams, "d");
  const velocity = getFloatArray(innerParams, "v");
  if (!isVector3(position) || (direction !== undefined && !isVector3(direction)) || (velocity !== undefined && !isVector3(velocity))) {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - l.a with a "p"/"d"/"v" that isn't 3 finite numbers, dropped`);
    return;
  }
  let object = getUtfString(innerParams, "o");
  if (object !== undefined && !fitsBytes(object, MAX_OBJECT_BYTES)) {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - l.a "o" over ${MAX_OBJECT_BYTES} bytes, left out`);
    object = undefined;
  }
  // Used by validate.state and zone.player_location.
  const previous = ctx.session.lastPosition;
  ctx.session.lastPosition = position;
  // Party games react to action bytes (the Hider's drop), before the move.
  onPartyGameAction(ctx.session, action, position as [number, number, number]);
  // Tube races check finishes and score modifiers against the racer's path.
  onPartyGamePlayerMoved(ctx.session, position as [number, number, number]);
  const locomotionResponseP = new SFSObjectWriter()
    .putFloatArray("p", position)
    .putByte("a", action)
    .putInt("senderId", ctx.session.userId)
    .putLong("t", BigInt(Date.now()));
  if (direction !== undefined) locomotionResponseP.putFloatArray("d", direction);
  if (velocity !== undefined) locomotionResponseP.putFloatArray("v", velocity);
  if (object !== undefined) locomotionResponseP.putUtfString("o", object);
  const packet = encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "l.a").putSFSObject("p", locomotionResponseP));
  ctx.send(packet);
  for (const entry of getByRoomExcluding(ctx.session.roomName, ctx.session.userId)) entry.send(packet);
  // Pinata hits, trays.
  handleConsumableInteraction(ctx, action, object);
  // Party-game lobbies: interacting with the lobby item joins it (after
  // any snowball throw in progress).
  onThrowAction(ctx.session, action);
  handleLobbyInteraction(ctx, action, object);
  // Daily challenges: scene switches and action watchers.
  onLocomotion(ctx, previous, position, action, object);
}
