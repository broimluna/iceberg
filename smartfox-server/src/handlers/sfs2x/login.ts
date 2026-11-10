import net from "node:net";
import { SFSObjectWriter, SFSArrayWriter, encodePacket, type SFSObjectData } from "../../sfs-wire.ts";
import { getUtfString, getSFSObject, extractRawJsonValue, fitsBytes, isOutfitJson, MAX_NAME_BYTES } from "../../wire-helpers.ts";
import { JOIN_DELAY_MS, ALLOW_UNSIGNED_LOGIN } from "../../config.ts";
import { checkJoinSignature } from "../../join-signature.ts";
import { sendWorldObjectsSnapshot } from "../../world-objects.ts";
import { sendConsumableItemsSnapshot } from "../consumables.ts";
import { sendRoomItemsSnapshot } from "../../party-games/room-items.ts";
import { ensureRoomLobbies } from "../../party-games/lobby.ts";
import { ensureRoomPlaygrounds } from "../../island-targets/playground.ts";
import { getByRoomExcluding } from "../../session-registry.ts";
import { buildUserVariablesArray } from "../../user-variables.ts";
import { restoreTransientData } from "../../transient-data.ts";
import { buildProximityUserEntry, sendExistingOccupantsToJoiner, broadcastNewJoinerToRoom } from "../proximity.ts";
import type { HandlerContext } from "../context.ts";
import { logSafe } from "../../log-safe.ts";

// RequestType.Login = 1. Params: {zn, un, pw, p: {joinRoomData: <JSON text>}}.
// joinRoomData decides the room and the player's appearance. It's the web
// API's SignedResponse, passed through by the client; its signature is
// checked (join-signature.ts) before the swid, sessionId and room in it are
// trusted. Returns false, after closing the connection, when it's refused.
export function handleLogin(params: SFSObjectData, ctx: HandlerContext, socket: net.Socket): boolean {
  const { session } = ctx;
  const zoneName = getUtfString(params, "zn") ?? "ClubPenguin";
  const userName = getUtfString(params, "un");
  const innerParams = getSFSObject(params, "p");
  const joinRoomDataStr = getUtfString(innerParams, "joinRoomData");

  let parsed: any = null;
  if (joinRoomDataStr) {
    try {
      parsed = JSON.parse(joinRoomDataStr);
    } catch (err) {
      console.log(`[${new Date().toISOString()}] ${ctx.peer} - failed to parse joinRoomData JSON: ${(err as Error).message}`);
    }
  }
  const claims = {
    swid: typeof parsed?.swid === "string" ? parsed.swid : "",
    sessionId: Number.isSafeInteger(parsed?.data?.sessionId) ? String(parsed.data.sessionId) : "",
    room: typeof parsed?.data?.room === "string" ? parsed.data.room : "",
    goodUntil: parsed?.goodUntil,
    userName: typeof parsed?.data?.userName === "string" ? parsed.data.userName : "",
    signature: parsed?.signature,
  };
  const refused = checkJoinSignature(claims);
  if (refused && !ALLOW_UNSIGNED_LOGIN) {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - login refused (${refused}, swid=${JSON.stringify(claims.swid).slice(0, 60)}), closing`);
    socket.destroy();
    return false;
  }

  session.signedLogin = refused === null;
  session.zoneName = zoneName;
  // The name the room sees is the signed one. The login's own "un" is the
  // same text from an honest client, and anything at all from another.
  const shownName = session.signedLogin ? claims.userName : userName;
  session.userName = shownName && fitsBytes(shownName, MAX_NAME_BYTES) ? shownName : "guest";
  let roomName = "ClubPenguin_default_room";
  if (fitsBytes(claims.room, MAX_NAME_BYTES) && claims.room) roomName = claims.room;
  if (claims.swid && fitsBytes(claims.swid, MAX_NAME_BYTES)) session.swid = claims.swid;
  if (claims.sessionId) {
    session.playerSessionId = claims.sessionId;
  } else if (joinRoomDataStr && ALLOW_UNSIGNED_LOGIN) {
    // Unsigned development logins may carry a 64-bit sessionId (beyond
    // Number.MAX_SAFE_INTEGER), so take it from the raw text.
    const sessionIdMatch = joinRoomDataStr.match(/"sessionId"\s*:\s*(\d{1,20})\b/);
    if (sessionIdMatch) session.playerSessionId = sessionIdMatch[1];
  }
  // Both go out as INT user variables; putInt throws on anything else.
  const isInt32 = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= -0x80000000 && (n as number) <= 0x7fffffff;
  if (isInt32(parsed?.data?.playerRoomData?.profile?.colour)) session.colour = parsed.data.playerRoomData.profile.colour;
  if (isInt32(parsed?.data?.selectedTubeId)) session.selectedTubeId = parsed.data.selectedTubeId;
  if (joinRoomDataStr) {
    // The outfit also contains a sessionId, so it's kept as raw JSON text.
    const outfit = extractRawJsonValue(joinRoomDataStr, "outfit");
    if (isOutfitJson(outfit)) session.outfitJson = outfit;
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
  console.log(`[${new Date().toISOString()}] ${ctx.peer} <- login response (id=${session.userId}, zn=${logSafe(zoneName)}, un=${logSafe(session.userName)})`);

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
    // Party-game lobbies and games (party-games/room-items.ts).
    // Crate Co targets (island-targets/playground.ts): created before the
    // snapshot, which then carries the stats item (the joiner isn't
    // registered yet, so it misses the item's add).
    ensureRoomPlaygrounds(roomName);
    sendRoomItemsSnapshot(ctx, roomName);
    // Starts the room's scheduled party-game lobbies (Dance Battle in Town).
    ensureRoomLobbies(roomName);
    // ctx has the same shape as a RegisteredSession.
    sendExistingOccupantsToJoiner(ctx, roomName);
    broadcastNewJoinerToRoom(roomName, session);
  };
  // The delayed path runs outside server.ts's dispatch try/catch.
  if (JOIN_DELAY_MS > 0) {
    setTimeout(() => {
      try {
        sendJoin();
      } catch (err) {
        console.log(`[${new Date().toISOString()}] ${ctx.peer} - delayed join push threw: ${(err as Error).stack ?? err}`);
      }
    }, JOIN_DELAY_MS);
  } else {
    sendJoin();
  }
  return true;
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
