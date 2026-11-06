// SFS2X's MMORoom proximity/AOI mechanism, player side - `c=0,a=30`
// (RequestType.SetUserPosition), the "p"/"m" fields. Confirmed against the
// real decompiled SFS2X SDK (Sfs2X.Requests.MMO/SetUserPositionRequest.cs,
// Sfs2X.Controllers/SystemController.cs's FnSetUserPosition dispatch entry
// for action 30), not the historical Java reference (that's only used
// elsewhere to confirm the mechanism/cadence exists, never as a wire-shape
// source). This is the *only* thing that spawns another player's avatar
// client-side - ClubPenguinClient never subscribes to the plain SFS2X
// USER_ENTER_ROOM/USER_EXIT_ROOM/USER_COUNT_CHANGE events at all (confirmed
// via its one event-registration site, SmartFoxGameServerClientSFSThread.
// AddListeners), only SFSEvent.PROXIMITY_LIST_UPDATE, itself only ever
// dispatched from this same action-30 packet.
//
// Sibling to ../world-objects.ts, which already implements action 30's "q"
// (item) side for Scheduled World Objects - same wire message, same room-id
// constant convention (a local `ROOM_ID = 1`, matching login.ts's
// buildRoomArray and world-objects.ts's own copy: this server has always
// used a single literal room id for whichever room a session is in, not one
// id per distinct room name). Deliberately kept as a separate module rather
// than merged into world-objects.ts - that file's whole structure (per-room
// def tables, scheduling/timers) is about server-driven scheduled items,
// which has nothing in common with player presence being driven by
// login/movement/disconnect events instead.
//
// AOI model: unconditional "whole room is in range," not real 3D distance
// gating. Every room this server sends (buildRoomArray) hardcodes
// DefaultAOI=[900,900,900], and nothing found so far indicates any CPI room
// exceeds that footprint - so distance math would only add O(n^2) per-room
// comparisons and boundary-popping edge cases for a case that doesn't
// appear to exist. If that changes, only getByRoomExcluding (session-
// registry.ts) needs to learn distance filtering - nothing in this file or
// its callers would need to change.

import { SFSObjectWriter, SFSArrayWriter, encodePacket } from "../sfs-wire.ts";
import { getByRoomExcluding, type RegisteredSession } from "../session-registry.ts";
import { buildUserVariablesArray } from "../user-variables.ts";
import type { Session } from "../session.ts";

// Matches login.ts's buildRoomArray(...) and world-objects.ts's own ROOM_ID
// - all three independently hold the same literal because this server has
// never modeled more than one numeric room id. Not unified into a shared
// export: each file already carries this as a one-line, well-commented
// constant, and introducing a shared import here would touch two other
// already-working, already-tested files for no behavioral change.
const ROOM_ID = 1;

// [id:int, name:utf, privilegeId:short, playerId:short, variables:SFSArray,
// AOIEntryPoint?:FloatArray] - SFSUser.FromSFSArray's real 5/6-element
// shape (Sfs2X.Entities/SFSUser.cs). `position` omitted -> 5-element form
// (used for JoinRoom's "ul", which never carries an AOIEntryPoint);
// provided -> 6-element form (used for every actual proximity-add packet,
// so the client's SnapToPosition has something real to snap to).
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

// Sends `target` a snapshot of everyone already in the room, so their
// client actually spawns those avatars (onProximityListUpdate's
// addedUsers branch). Deliberately sends nothing at all - not even an
// empty "p" - when the room has no other occupants: this project already
// shipped a spurious action-30 payload once (09-sfs2x-server-open-
// questions.md's 21st/22nd pass) that hung the client, so a solo login
// must produce exactly zero new wire traffic, matching everything tested
// so far.
export function sendExistingOccupantsToJoiner(target: RegisteredSession, roomName: string): void {
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

// Tells everyone remaining in the room that `left` is gone, so their
// client fires ROOM_USER_REMOVED instead of leaving a permanent ghost
// avatar. Uses "m" (minus-user-list, a real INT_ARRAY - see sfs-wire.ts's
// putIntArray) rather than the SFSArray-of-tuples shape "p" uses; the two
// fields are independently typed on the same SetUserPositionRequest.
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
