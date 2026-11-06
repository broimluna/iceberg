import { SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import { getPossiblyEncryptedUtfString } from "../wire-helpers.ts";
import { getByRoomExcluding } from "../session-registry.ts";
import type { HandlerContext } from "./context.ts";

// SmartfoxCommand.CHAT ("chat.msg", SMARTFOX_PACKETS_DOCUMENTATION.md's
// Chat section, sourced from SendChatMessage/ChatMessage/
// ReceivedChatMessage - real field-level shapes, not guessed). OUT (what
// the client just sent us): "msg" = JSON string of
// SignedResponse<ChatMessage> ({goodUntil, swid, data: {senderSessionId,
// message, emotion, moderated, questId, objective}, signature} -
// ChatMessage.cs). IN (what we send back): "msg" = JSON string of a
// *different*, unwrapped struct, ReceivedChatMessage.cs ({senderSessionId,
// message, emotion} - only 3 fields, no SignedResponse wrapper - confirmed
// asymmetric from the client's own onExtensionResponse dispatch,
// SmartFoxGameServerClientSFSThread.cs:381:
// `mt.JsonService.Deserialize<ReceivedChatMessage>(iSFSObject.GetUtfString
// ("msg"))`). `senderSessionId` is a real `long` field (the client's own
// huge fabricated joinRoomData.data.sessionId, same identity space as
// reward.add's dict key and the "sess" user variable - NOT the small
// SFS2X room-local int id) - built via string interpolation rather than
// JSON.stringify(playerSessionId) since it exceeds
// Number.MAX_SAFE_INTEGER, so it's kept as a string end to end. Also
// confirmed from the same onExtensionResponse method (line 359-362):
// "senderId" is read as an int from *inside* the nested "p" object itself
// (`iSFSObject.GetInt("senderId")`, then resolved to the real sessionId
// via `getSessionId(userId)`) - not a sibling of "c" at the envelope's
// top level.
// Real client-side encryption applies here specifically once a key's
// established (SmartFoxEncryptor.EncryptParameter is only ever called on
// "msg" here, ClubPenguinClient.decompiled.cs:1384) - see
// getPossiblyEncryptedUtfString's own comment (wire-helpers.ts) for why
// this matters: without it, every chat.msg sent after the client's
// automatic post-time.get encryption.get handshake would silently decode
// to an empty message (JSON.parse on raw ciphertext, swallowed by the
// catch below).
export function handleChatMsg(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const outMsgJson = getPossiblyEncryptedUtfString(innerParams, "msg", ctx.session);
  let messageText = "";
  let emotion = 0;
  if (outMsgJson) {
    try {
      const parsed = JSON.parse(outMsgJson);
      if (typeof parsed?.data?.message === "string") messageText = parsed.data.message;
      if (typeof parsed?.data?.emotion === "number") emotion = parsed.data.emotion;
    } catch (err) {
      console.log(`[${new Date().toISOString()}] ${ctx.peer} - chat.msg: failed to parse "msg" JSON: ${(err as Error).message}`);
    }
  }
  const receivedChatMessage = `{"senderSessionId":${ctx.session.playerSessionId ?? "0"},"message":${JSON.stringify(
    messageText
  )},"emotion":${emotion}}`;
  const chatResponseP = new SFSObjectWriter().putUtfString("msg", receivedChatMessage).putInt("senderId", ctx.session.userId);
  const packet = encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "chat.msg").putSFSObject("p", chatResponseP));
  ctx.send(packet);
  for (const entry of getByRoomExcluding(ctx.session.roomName, ctx.session.userId)) entry.send(packet);
  console.log(`[${new Date().toISOString()}] ${ctx.peer} <- chat.msg echo (message=${JSON.stringify(messageText)}, emotion=${emotion})`);
}

// SmartfoxCommand.CHAT_ACTIVITY / CHAT_ACTIVITY_CANCEL - bare
// typing-indicator start/stop pings, no payload either direction per
// SMARTFOX_PACKETS_DOCUMENTATION.md's Chat section - the client resolves
// who's typing purely from "senderId" inside "p" (same lookup-by-room-
// local-id-then-"sess"-variable pattern as chat.msg above), so the
// response just needs that one field.
export function handleChatActivity(cmd: "chat.activity" | "chat.activity_cancel", ctx: HandlerContext): void {
  const packet = encodePacket(
    1,
    13,
    new SFSObjectWriter().putUtfString("c", cmd).putSFSObject("p", new SFSObjectWriter().putInt("senderId", ctx.session.userId))
  );
  ctx.send(packet);
  for (const entry of getByRoomExcluding(ctx.session.roomName, ctx.session.userId)) entry.send(packet);
  console.log(`[${new Date().toISOString()}] ${ctx.peer} <- ${cmd} echo (senderId=${ctx.session.userId})`);
}
