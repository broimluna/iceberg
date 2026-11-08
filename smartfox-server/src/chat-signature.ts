// Checks the web API's signature on chat.msg (web-api/src/utils/
// chatSignature.ts signs it in /chat/v1/message/verify, after the text
// filter). Without it a modified client could skip the filter, send any
// amount of text, or put another player's swid on a message.
import crypto from "node:crypto";
import { signingKey } from "./join-signature.ts";

export const MAX_CHAT_LENGTH = 200;
// Room chat is sent seconds after it's verified; a little clock skew
// between the two servers is tolerated.
const SKEW_MS = 30_000;

export interface SignedChat {
  message: string;
  emotion: number;
}

/** The signed message, or the reason it's refused. */
export function checkChatSignature(parsed: any, swid: string | undefined, now = Date.now()): SignedChat | string {
  if (!swid) return "no swid";
  const data = parsed?.data;
  if (typeof parsed?.signature !== "string" || parsed.signature.length === 0) return "no signature";
  if (!Number.isSafeInteger(parsed?.goodUntil)) return "no goodUntil";
  if (parsed.swid !== swid) return "not the sender's swid";
  if (typeof data?.message !== "string" || !Number.isInteger(data?.emotion) || typeof data?.moderated !== "boolean") return "malformed";
  if ([...data.message].length > MAX_CHAT_LENGTH) return "too long";
  const payload = `chat|${swid}|${parsed.goodUntil}|${data.emotion}|${data.moderated ? 1 : 0}|${data.message}`;
  const expected = crypto.createHmac("sha256", signingKey()).update(payload).digest();
  const given = Buffer.from(parsed.signature, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return "bad signature";
  if (parsed.goodUntil + SKEW_MS < now) return "expired";
  return { message: data.message, emotion: data.emotion };
}
