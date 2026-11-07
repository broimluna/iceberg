import net from "node:net";
import { SFSObjectWriter, SFSArrayWriter, encodePacket, type SFSObjectData } from "../../sfs-wire.ts";
import { getUtfString, getSFSObject, extractRawJsonValue } from "../../wire-helpers.ts";
import { JOIN_DELAY_MS } from "../../config.ts";
import { sendWorldObjectsSnapshot } from "../../world-objects.ts";
import { sendConsumableItemsSnapshot } from "../consumables.ts";
import { getByRoomExcluding } from "../../session-registry.ts";
import { buildUserVariablesArray } from "../../user-variables.ts";
import { restoreTransientData } from "../../transient-data.ts";
import { buildProximityUserEntry, sendExistingOccupantsToJoiner, broadcastNewJoinerToRoom } from "../proximity.ts";
import type { HandlerContext } from "../context.ts";

// RequestType.Login = 1. Params: {zn, un, pw, p: {joinRoomData: <JSON text>}}.
// joinRoomData decides the room and the player's appearance.
export function handleLogin(params: SFSObjectData, ctx: HandlerContext, socket: net.Socket): void {
  const { session } = ctx;
  const zoneName = getUtfString(params, "zn") ?? "ClubPenguin";
  session.zoneName = zoneName;
  session.userName = getUtfString(params, "un") ?? "guest";
  const innerParams = getSFSObject(params, "p");
  const joinRoomDataStr = getUtfString(innerParams, "joinRoomData");

  let roomName = "ClubPenguin_default_room";
  // sessionId is a 64-bit value beyond Number.MAX_SAFE_INTEGER; JSON.parse
  // would round it, so it's pulled out of the raw text with a regex.
  if (joinRoomDataStr) {
    try {
      const parsed = JSON.parse(joinRoomDataStr);
      if (typeof parsed?.data?.room === "string") roomName = parsed.data.room;
      if (typeof parsed?.data?.playerRoomData?.profile?.colour === "number") {
        session.colour = parsed.data.playerRoomData.profile.colour;
      }
      if (typeof parsed?.data?.selectedTubeId === "number") {
        session.selectedTubeId = parsed.data.selectedTubeId;
      }
      // swid sits beside "data" on the SignedResponse wrapper.
      if (typeof parsed?.swid === "string") session.swid = parsed.swid;
    } catch (err) {
      console.log(`[${new Date().toISOString()}] ${ctx.peer} - failed to parse joinRoomData JSON: ${(err as Error).message}`);
    }
    const sessionIdMatch = joinRoomDataStr.match(/"sessionId"\s*:\s*(\d+)/);
    if (sessionIdMatch) session.playerSessionId = sessionIdMatch[1];
    // The outfit also contains a sessionId, so it's kept as raw JSON text.
    session.outfitJson = extractRawJsonValue(joinRoomDataStr, "outfit");
  }
  session.roomName = roomName;
  // The client also sends p.transientData, but that copy is unsigned; the
  // server restores its own.
  restoreTransientData(session);

  // The array's size is how the client tells an MMORoom from a plain room:
  // exactly 14 elements for SFS2X, more than 12 for SFS3. SFS3 adds
  // isAudioStreamingAllowed after the variables.
  //   0-8:   id, name, groupId, isGame, isHidden, isPasswordProtected,
  //          userCount, maxUsers, variables
  //   SFS3:  isAudioStreamingAllowed
  //   then:  spectatorCount, maxSpectators,
  //          DefaultAOI, LowerMapLimit, HigherMapLimit (Vec3 float arrays)
  // The name must match joinRoomData.room or the client rejects the join.
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
      .onlyFor("sfs3", (w) => w.putBool(false)) // isAudioStreamingAllowed
      .putShort(0) // spectatorCount
      .putShort(100) // maxSpectators
      .putFloatArray([900, 900, 900]) // DefaultAOI
      .putFloatArray([-900, -900, -900]) // LowerMapLimit
      .putFloatArray([900, 900, 900]); // HigherMapLimit
  }

  // Login response: id, un, pi, rs, zn, rl, p. Real SFS2X sends an empty
  // room list here.
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

  // JoinRoom push (RequestType.JoinRoom = 4), sent without the client
  // asking. "ul" lists the other users already in the room, not the
  // player. The client doesn't spawn avatars from "ul"; that only happens
  // through proximity updates, so the joiner also gets a proximity
  // snapshot and the room is told about the new arrival. Built at send
  // time so a JOIN_DELAY_MS delay still sees current state.
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
    // Geysers, blinking lights, etc. (world-objects.ts).
    sendWorldObjectsSnapshot(ctx, roomName);
    // Party blasters etc. already in the room (consumables.ts).
    sendConsumableItemsSnapshot(ctx, roomName);
    // ctx has the same shape as a RegisteredSession.
    sendExistingOccupantsToJoiner(ctx, roomName);
    broadcastNewJoinerToRoom(roomName, session);
  };
  if (JOIN_DELAY_MS > 0) setTimeout(sendJoin, JOIN_DELAY_MS);
  else sendJoin();
}

// Right after JoinRoom, a single SetUserVariables packet (c=0, a=12) carries
// all of the player's variables: sess, outfit, colour, tube, loc,
// awayfromkeyboard, tempheadstatus. This matches a real SFS2X capture.
// colour and tube are INT variables, outfit is a JSON string, and sess is
// the 64-bit session id as a string.
function sendInitialUserVariables(ctx: HandlerContext): void {
  const { session } = ctx;
  const varList = buildUserVariablesArray(session);
  ctx.send(encodePacket(0, 12, new SFSObjectWriter().putInt("u", session.userId).putSFSArray("vl", varList)));
  console.log(
    `[${new Date().toISOString()}] ${ctx.peer} <- set user variables (sess, outfit${session.outfitJson !== undefined ? "" : "=absent"}, colour=${session.colour ?? 0}, tube=${session.selectedTubeId ?? 0}, loc=0, awayfromkeyboard=0, tempheadstatus=0)`
  );
}
