// Player presence via SFS2X's MMORoom proximity updates (controller 0,
// action 30, SetUserPosition). This is the only way the CPI client spawns
// or removes other players' avatars: it never listens for the plain
// USER_ENTER_ROOM / USER_EXIT_ROOM events, only PROXIMITY_LIST_UPDATE.
//   "p" = users added, "m" = user ids removed.
// world-objects.ts uses the same packet's "q" field for MMO items.
//
// Area of interest: the whole room counts as in range. Every room declares
// a 900x900x900 AOI, which covers every CPI room. If that ever changes,
// distance filtering belongs in session-registry.ts's getByRoomExcluding.

import { SFSObjectWriter, SFSArrayWriter, encodePacket } from "../sfs-wire.ts";
import { getByRoomExcluding, type RegisteredSession } from "../session-registry.ts";
import { buildUserVariablesArray } from "../user-variables.ts";
import type { Session } from "../session.ts";

// Same single room id as login.ts and world-objects.ts.
const ROOM_ID = 1;

// SFSUser wire shape: [id, name, privilegeId, playerId, variables,
// AOIEntryPoint?]. Without `position` this is the 5-element form used in
// JoinRoom's user list; with it, the 6-element form proximity updates need
// so the client knows where to place the avatar.
export function buildProximityUserEntry(session: Session, position: number[] | undefined): SFSArrayWriter {
  const entry = new SFSArrayWriter()
    .putInt(session.userId)
    .putUtfString(session.userName)
    .putShort(0) // privilegeId
    .putShort(0) // playerId
    .putSFSArray(buildUserVariablesArray(session));
  if (position !== undefined) entry.putFloatArray(position);
  return entry;
}

// Sends a new arrival everyone already in the room. Sends nothing when the
// room is empty: an empty action-30 packet hangs the client.
export function sendExistingOccupantsToJoiner(target: Pick<RegisteredSession, "session" | "send" | "peer">, roomName: string): void {
  const others = getByRoomExcluding(roomName, target.session.userId);
  if (others.length === 0) return;
  const p = new SFSArrayWriter();
  for (const entry of others) {
    p.putSFSArray(buildProximityUserEntry(entry.session, entry.session.lastPosition ?? [0, 0, 0]));
  }
  const params = new SFSObjectWriter().putInt("r", ROOM_ID).putSFSArray("p", p);
  target.send(encodePacket(0, 30, params));
  console.log(`[${new Date().toISOString()}] ${target.peer} <- proximity snapshot (room=${roomName}, occupants=${others.length})`);
}

// Tells everyone already in the room that `joined` just arrived.
export function broadcastNewJoinerToRoom(roomName: string, joined: Session): void {
  const others = getByRoomExcluding(roomName, joined.userId);
  if (others.length === 0) return;
  const p = new SFSArrayWriter().putSFSArray(buildProximityUserEntry(joined, joined.lastPosition ?? [0, 0, 0]));
  const params = new SFSObjectWriter().putInt("r", ROOM_ID).putSFSArray("p", p);
  const packet = encodePacket(0, 30, params);
  for (const entry of others) entry.send(packet);
  console.log(
    `[${new Date().toISOString()}] proximity: notified ${others.length} occupant(s) of room "${roomName}" that user ${joined.userId} joined`
  );
}

// Tells the rest of the room that a player left, so their avatar is removed
// instead of lingering. Uses "m" (an INT_ARRAY of user ids).
export function broadcastUserLeftRoom(roomName: string, left: Session): void {
  const remaining = getByRoomExcluding(roomName, left.userId);
  if (remaining.length === 0) return;
  const params = new SFSObjectWriter().putInt("r", ROOM_ID).putIntArray("m", [left.userId]);
  const packet = encodePacket(0, 30, params);
  for (const entry of remaining) entry.send(packet);
  console.log(
    `[${new Date().toISOString()}] proximity: notified ${remaining.length} occupant(s) of room "${roomName}" that user ${left.userId} left`
  );
}
