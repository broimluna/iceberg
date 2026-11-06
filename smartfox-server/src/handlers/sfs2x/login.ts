import net from "node:net";
import { SFSObjectWriter, SFSArrayWriter, encodePacket, type SFSObjectData } from "../../sfs-wire.ts";
import { getUtfString, getSFSObject, extractRawJsonValue } from "../../wire-helpers.ts";
import { JOIN_DELAY_MS } from "../../config.ts";
import { sendWorldObjectsSnapshot } from "../../world-objects.ts";
import { getByRoomExcluding } from "../../session-registry.ts";
import { buildUserVariablesArray } from "../../user-variables.ts";
import { buildProximityUserEntry, sendExistingOccupantsToJoiner, broadcastNewJoinerToRoom } from "../proximity.ts";
import type { HandlerContext } from "../context.ts";

// RequestType.Login = 1 (SmartFox2X.decompiled.cs:12598). Params confirmed
// live: {zn, un, pw, p:{joinRoomData: <TEXT JSON>}}.
export function handleLogin(params: SFSObjectData, ctx: HandlerContext, socket: net.Socket): void {
  const { session } = ctx;
  const zoneName = getUtfString(params, "zn") ?? "ClubPenguin";
  session.zoneName = zoneName;
  session.userName = getUtfString(params, "un") ?? "guest";
  const innerParams = getSFSObject(params, "p");
  const joinRoomDataStr = getUtfString(innerParams, "joinRoomData");

  let roomName = "ClubPenguin_default_room";
  // sessionId is a 64-bit long (e.g. 1059482726353499894) that exceeds
  // Number.MAX_SAFE_INTEGER - JSON.parse would silently round it via
  // IEEE754 double, producing a value that no longer matches what the
  // client itself holds. Pulled as a string via regex straight from the
  // raw JSON text specifically to avoid that - see sendStarterRewards
  // (handlers/quest.ts) for the reward.add bugs this and other things
  // caused.
  if (joinRoomDataStr) {
    try {
      const parsed = JSON.parse(joinRoomDataStr);
      if (typeof parsed?.data?.room === "string") roomName = parsed.data.room;
      // colour/selectedTubeId are plain small ints - no precision hazard,
      // safe to read straight off the already-parsed object
      // (PlayerRoomData.profile.colour / PlayerRoomData's own
      // selectedTubeId, ClubPenguinClient.decompiled.cs:10882-10919).
      if (typeof parsed?.data?.playerRoomData?.profile?.colour === "number") {
        session.colour = parsed.data.playerRoomData.profile.colour;
      }
      if (typeof parsed?.data?.selectedTubeId === "number") {
        session.selectedTubeId = parsed.data.selectedTubeId;
      }
      // "swid" is a sibling of "data" on the SignedResponse<JoinRoomData>
      // wrapper itself, not nested inside JoinRoomData - same top-level
      // shape as every other SignedResponse<T> in this protocol.
      if (typeof parsed?.swid === "string") session.swid = parsed.swid;
    } catch (err) {
      console.log(`[${new Date().toISOString()}] ${ctx.peer} - failed to parse joinRoomData JSON: ${(err as Error).message}`);
    }
    const sessionIdMatch = joinRoomDataStr.match(/"sessionId"\s*:\s*(\d+)/);
    if (sessionIdMatch) session.playerSessionId = sessionIdMatch[1];
    // "outfit" (PlayerOutfitDetails) nests its OWN sessionId field -
    // extracted verbatim rather than via JSON.parse/stringify to avoid
    // reintroducing the same precision loss - see extractRawJsonValue's
    // own comment (wire-helpers.ts).
    session.outfitJson = extractRawJsonValue(joinRoomDataStr, "outfit");
  }
  session.roomName = roomName;

  // Room array MUST be the 14-element MMORoom shape (SFSRoom.FromSFSArray,
  // SmartFox2X.decompiled.cs:6089): `bool flag = sfsa.Size() == 14;` is
  // literally what decides SFSRoom vs MMORoom client-side. Fields 0-8:
  // id, name, groupId, isGame, isHidden, isPasswordProtected, userCount,
  // maxUsers, variables; 9-10: spectatorCount, maxSpectators (only
  // actually read client-side `if (room.IsGame)`, still need to be
  // present for size 14); 11-13: DefaultAOI/LowerMapLimit/HigherMapLimit,
  // 3-float Vec3D arrays. name MUST match joinRoomData.room -
  // ClubPenguinClient.onRoomJoin checks
  // RoomIdentifier.EqualsIgnoreInstanceId(room.Name, JoinRoomDataRoom)
  // before proceeding (ClubPenguinClient.decompiled.cs:2376-2391).
  //
  // userCount is the one field that legitimately differs between the two
  // places this array is sent below - confirmed against a byte-level
  // capture of a real SmartFoxServer 2X 2.19.0 + Java extension handling
  // a real account's joinRoomData: the login response's `rl`
  // snapshot reports userCount=0 (queried before this user has joined),
  // the JoinRoom push's own room array reports userCount=1 (after).
  function buildRoomArray(userCount: number): SFSArrayWriter {
    return new SFSArrayWriter()
      .putInt(1)
      .putUtfString(roomName)
      .putUtfString("default") // SFSConstants.DEFAULT_GROUP_ID
      .putBool(false) // isGame
      .putBool(false) // isHidden
      .putBool(false) // isPasswordProtected
      .putShort(userCount)
      .putShort(100) // maxUsers
      .putSFSArray(new SFSArrayWriter()) // variables
      .putShort(0) // spectatorCount
      .putShort(100) // maxSpectators
      .putFloatArray([900, 900, 900]) // DefaultAOI
      .putFloatArray([-900, -900, -900]) // LowerMapLimit
      .putFloatArray([900, 900, 900]); // HigherMapLimit
  }

  // LoginRequest response fields: id, un, pi, rs, zn, rl, p - all
  // confirmed against FnLogin/LoginRequest in SmartFox2X.decompiled.cs.
  // `rl` (room list): the twentieth pass populated this after a synthetic
  // capture showed it non-empty, but a twenty-second-pass capture of a
  // REAL retail client's actual successful login (via a transparent raw
  // TCP proxy in front of real SFS2X, not a synthetic script) showed `rl`
  // EMPTY in a session that worked fine end to end - the earlier capture
  // was very likely a one-off race (that exact room's very first-ever
  // creation after a fresh server boot), not a real requirement. Reverted
  // to empty to match the actually-proven-working trace.
  const loginResponseParams = new SFSObjectWriter()
    .putInt("id", session.userId)
    .putUtfString("un", session.userName)
    .putShort("pi", 0)
    .putShort("rs", 0)
    .putUtfString("zn", zoneName)
    .putSFSArray("rl", new SFSArrayWriter())
    .putSFSObject("p", new SFSObjectWriter());
  ctx.send(encodePacket(0, 1, loginResponseParams));
  console.log(`[${new Date().toISOString()}] ${ctx.peer} <- login response (id=${session.userId}, zn=${zoneName}, un=${session.userName})`);

  // Unsolicited JoinRoom push (RequestType.JoinRoom = 4). `ul` (user list)
  // is the set of *other* users already in the room, NOT including the
  // local player - confirmed empty in the same real-capture above (real
  // SFS2X's own JoinRoom push for a freshly-created, empty room sent
  // `"ul":[]`). Previously this project embedded the local user's own
  // entry here (with a "sess" variable) on the theory that's how the
  // client learns its own session id - wrong on two counts: it's not
  // where "sess" comes from (see the single combined SetUserVariables
  // broadcast below, which is what real SFS2X actually uses), and
  // including yourself in a "who else is here" list is exactly backwards.
  //
  // `ul` is now genuinely populated (previously always empty, which only
  // happened to match every capture so far because none of them had a
  // second real user in the room) - built inside sendJoin() itself, not
  // eagerly here, so it reflects session-registry's actual state at send
  // time. That matters with JOIN_DELAY_MS > 0: this session is only
  // registered by server.ts *after* handleLogin returns, so with zero
  // delay it's real never self-registered yet when sendJoin runs, but with
  // any delay it could be - excluding session.userId explicitly (not
  // relying on registration timing) keeps this correct either way.
  //
  // Populating `ul` alone isn't enough on its own, though: the client's
  // own onRoomJoin never loops over `ul` to spawn avatars - it only feeds
  // SFS2X's internal room-membership bookkeeping (GetUserById lookups).
  // Avatars only ever spawn via the proximity mechanism
  // (handlers/proximity.ts), so sendJoin also sends this joiner a
  // proximity snapshot of everyone already present, and tells everyone
  // already present that this joiner arrived.
  const sendJoin = () => {
    if (socket.destroyed) return;
    const others = getByRoomExcluding(roomName, session.userId);
    const ul = new SFSArrayWriter();
    for (const entry of others) ul.putSFSArray(buildProximityUserEntry(entry.session, undefined));
    const joinRoomParams = new SFSObjectWriter().putSFSArray("r", buildRoomArray(1)).putSFSArray("ul", ul);
    ctx.send(encodePacket(0, 4, joinRoomParams));
    console.log(
      `[${new Date().toISOString()}] ${ctx.peer} <- join room push (room=${roomName}, delay=${JOIN_DELAY_MS}ms, ul=${others.length})`
    );
    sendInitialUserVariables(ctx);
    // Scheduled World Objects (geysers, blinking lights, etc.) - see
    // world-objects.ts's header comment for the full wire trace. This
    // initializes the room's objects on whichever session joins first, then
    // sends this session its own action-30 items-in-AOI snapshot; ongoing
    // state changes (geysers erupting, lights blinking) broadcast to
    // everyone currently registered in the room via session-registry.
    sendWorldObjectsSnapshot(ctx, roomName);
    // Player-presence half of the same action-30 mechanism world objects
    // just used above for items - see handlers/proximity.ts. `ctx` is
    // structurally a RegisteredSession (same session/peer/send shape) even
    // though this joiner isn't registered in session-registry yet.
    sendExistingOccupantsToJoiner(ctx, roomName);
    broadcastNewJoinerToRoom(roomName, session);
  };
  if (JOIN_DELAY_MS > 0) setTimeout(sendJoin, JOIN_DELAY_MS);
  else sendJoin();
}

// Historical precedent (a Java SFS2X extension's zone-join handler
// "Initialize user variable defaults") and confirmed byte-for-byte against a real SFS2X +
// extension capture: right after the JoinRoom push, ONE SetUserVariables
// broadcast (c=0, a=12) carries ALL seven of the client's expected
// per-session variables together - sess, outfit, colour, tube, loc
// (locomotionState), awayfromkeyboard, tempheadstatus. Previously split
// across two mechanisms (sess embedded in JoinRoom's own now-removed user
// array, outfit/colour/tube in a separate partial broadcast, loc/afk/
// tempheadstatus never sent at all) - real SFS2X sends none of those
// separately, only this one combined call.
//
// Value shapes taken from the real Java source: Login.java stores
// "colour" as a plain extracted int (`profile.getInt("colour")`) and
// re-sends it as a raw Integer SFSUserVariable (VariableType.INT), not a
// JSON-wrapped string - same for "tube" (`selectedTubeId`). Only "outfit"
// is a JSON string (`.toString()` of the whole outfit JSONObject). "sess"
// is the client's own fabricated joinRoomData.data.sessionId as a STRING
// (not INT - it exceeds Number.MAX_SAFE_INTEGER/Java int range, kept as
// text end to end, matching getSessionId's own `long.Parse(...
// GetStringValue())`, ClubPenguinClient.decompiled.cs:2533-2536). Actual
// array-building now lives in ../../user-variables.ts, reused by
// handlers/proximity.ts's proximity-add packets for remote players.
function sendInitialUserVariables(ctx: HandlerContext): void {
  const { session } = ctx;
  const varList = buildUserVariablesArray(session);
  ctx.send(encodePacket(0, 12, new SFSObjectWriter().putInt("u", session.userId).putSFSArray("vl", varList)));
  console.log(
    `[${new Date().toISOString()}] ${ctx.peer} <- set user variables (sess, outfit${session.outfitJson !== undefined ? "" : "=absent"}, colour=${session.colour ?? 0}, tube=${session.selectedTubeId ?? 0}, loc=0, awayfromkeyboard=0, tempheadstatus=0)`
  );
}

// Controller 0 / action 30's real payload (confirmed via a byte-level
// capture against real SFS2X): `q` = SFSArray of per-item tuples
// [itemId:int, variables:SFSArray, position:FloatArray], `r` = room id -
// NOT "SetUserPosition" (an earlier, wrong theory). The twentieth pass
// tried sending a fabricated EMPTY one synchronously at join time on the
// theory the client's room-readiness gate needed *something* here - that
// didn't fix (or visibly break) anything, and a later real-client capture
// (twenty-second pass) confirmed why: real SFS2X only ever sends this
// asynchronously, tied to ScheduledWorldObjectManager's own periodic
// per-room timer (Alpine:Town's blinking lights, ~450ms after JoinRoom in
// that capture), never as part of login/join itself, and never at all for
// a room with no scheduled objects. The actual room-join hang turned out to
// be unrelated (a BigInt JSON.stringify crash in a diagnostic log line,
// twenty-third pass) - so action 30's timing was never load-bearing for
// readiness either way.
//
// Scheduled World Objects are now implemented (world-objects.ts) - geysers/
// blinking lights/air vents per room, ported from the recovered Java
// extension's ScheduledWorldObjectManager with the same wire shapes traced
// above. Sent synchronously here (not delayed to mimic the ~450ms gap seen
// in the one real capture) since nothing found so far suggests the client
// actually gates on that specific timing - it's simpler and still correct
// per-session ("an item just entered my AOI" is true the moment this
// session's own join completes, and every other session in the room
// already got its own copy at its own join time).
