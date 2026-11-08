import { SFSObjectWriter, encodePacket, type OutgoingPacket } from "../sfs-wire.ts";
import { getAll, type RegisteredSession } from "../session-registry.ts";
import type { Session } from "../session.ts";
import type { HandlerContext } from "../handlers/context.ts";

// Replies to staff commands are chat.msg addressed to one player, shown
// over their own penguin. The OpenCPI client renders text starting with
// U+200B as a system message and U+200B U+200C as a system error; other
// clients show it as normal chat (the prefix characters are invisible).
const SYSTEM = "​";
const SYSTEM_ERROR = "​‌";

export function systemChatPacket(session: Session, text: string, error = false): OutgoingPacket {
  const msg = `{"senderSessionId":${session.playerSessionId ?? "0"},"message":${JSON.stringify((error ? SYSTEM_ERROR : SYSTEM) + text)},"emotion":0}`;
  const p = new SFSObjectWriter().putUtfString("msg", msg).putInt("senderId", session.userId);
  return encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "chat.msg").putSFSObject("p", p));
}

export function reply(ctx: HandlerContext, text: string): void {
  ctx.send(systemChatPacket(ctx.session, text));
}

export function replyError(ctx: HandlerContext, text: string): void {
  ctx.send(systemChatPacket(ctx.session, text, true));
}

/** A system bubble for every connected player (or those passing filter), each over their own penguin. */
export function broadcastSystem(text: string, filter: (entry: RegisteredSession) => boolean = () => true): void {
  for (const entry of getAll()) if (filter(entry)) entry.send(systemChatPacket(entry.session, text));
}
