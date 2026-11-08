import { SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import { getPossiblyEncryptedUtfString } from "../wire-helpers.ts";
import { getByRoomExcluding } from "../session-registry.ts";
import { onChatMessage } from "../daily-tasks.ts";
import type { HandlerContext } from "./context.ts";
import { handleCommand } from "../commands/index.ts";

// "chat.msg"
// Client -> server: "msg" = JSON SignedResponse<ChatMessage>, encrypted once
// an encryption.get key exists.
// Server -> room: "msg" = JSON ReceivedChatMessage {senderSessionId,
// message, emotion} (no SignedResponse wrapper), plus "senderId" (room-local
// user id) inside "p".
// senderSessionId is a 64-bit id beyond Number.MAX_SAFE_INTEGER, so it's
// spliced into the JSON as a string instead of going through
// JSON.stringify.
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
  if (handleCommand(messageText, ctx)) return;
  const receivedChatMessage = `{"senderSessionId":${ctx.session.playerSessionId ?? "0"},"message":${JSON.stringify(
    messageText
  )},"emotion":${emotion}}`;
  const chatResponseP = new SFSObjectWriter().putUtfString("msg", receivedChatMessage).putInt("senderId", ctx.session.userId);
  const packet = encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "chat.msg").putSFSObject("p", chatResponseP));
  ctx.send(packet);
  for (const entry of getByRoomExcluding(ctx.session.roomName, ctx.session.userId)) entry.send(packet);
  console.log(`[${new Date().toISOString()}] ${ctx.peer} <- chat.msg echo (message=${JSON.stringify(messageText)}, emotion=${emotion})`);
  // "emotion" is the sizzle clip id.
  onChatMessage(ctx, messageText, emotion);
}

// "chat.activity" / "chat.activity_cancel" - typing indicator start/stop.
// Receivers only need "senderId".
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
