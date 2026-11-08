import { SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import { getPossiblyEncryptedUtfString } from "../wire-helpers.ts";
import { getByRoomExcluding } from "../session-registry.ts";
import { onChatMessage } from "../daily-tasks.ts";
import type { HandlerContext } from "./context.ts";
import { handleCommand } from "../commands/index.ts";
import { checkChatSignature, MAX_CHAT_LENGTH } from "../chat-signature.ts";
import { ALLOW_UNSIGNED_LOGIN } from "../config.ts";
import { replyError } from "../commands/reply.ts";
import { mutedUntil } from "../mutes.ts";

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
  let parsed: any = null;
  try {
    parsed = outMsgJson ? JSON.parse(outMsgJson) : null;
  } catch (err) {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - chat.msg: failed to parse "msg" JSON: ${(err as Error).message}`);
    return;
  }
  // Only chat the web API filtered and signed for this player is relayed.
  // Development logins (SFS_ALLOW_UNSIGNED_LOGIN) may chat unsigned.
  const signed = checkChatSignature(parsed, ctx.session.swid);
  let messageText: string;
  let emotion: number;
  if (typeof signed !== "string") {
    ({ message: messageText, emotion } = signed);
  } else if (ALLOW_UNSIGNED_LOGIN && typeof parsed?.data?.message === "string" && [...parsed.data.message].length <= MAX_CHAT_LENGTH) {
    messageText = parsed.data.message;
    emotion = Number.isInteger(parsed.data.emotion) ? parsed.data.emotion : 0;
  } else {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - chat.msg refused (${signed})`);
    return;
  }
  // Leading zero-width characters are how the OpenCPI client marks system
  // messages (commands/reply.ts); players can't use them.
  messageText = messageText.replace(/^[\u200B-\u200D\u2060\uFEFF]+/, "");
  if (handleCommand(messageText, ctx)) return;
  const muted = mutedUntil(ctx.session);
  if (muted !== undefined) {
    const minutes = Math.ceil((muted - Date.now()) / 60_000);
    replyError(ctx, `You are muted for ${minutes} more minute${minutes === 1 ? "" : "s"}`);
    return;
  }
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
