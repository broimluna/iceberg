// Signs the SignedResponse<ChatMessage> that /chat/v1/message/verify
// returns. The client passes it unchanged to the SmartFox server as
// chat.msg, and smartfox-server/src/chat-signature.ts checks it, so room
// chat can't skip the text filter or claim another player's swid.
//
// HMAC-SHA256 over "chat|swid|goodUntil|emotion|moderated|message", keyed
// like joinRoomData (utils/joinSignature.ts).
import crypto from "node:crypto";
import { signingKey } from "./joinSignature.ts";

export const MAX_CHAT_LENGTH = 200;
const VALID_MS = 60 * 60 * 1000;

export function chatPayload(swid: string, goodUntil: number, emotion: number, moderated: boolean, message: string): string {
    return `chat|${swid}|${goodUntil}|${emotion}|${moderated ? 1 : 0}|${message}`;
}

export function signChat(swid: string, data: { message: string; emotion: number; moderated: boolean }) {
    const goodUntil = Date.now() + VALID_MS;
    const signature = crypto.createHmac("sha256", signingKey())
        .update(chatPayload(swid, goodUntil, data.emotion, data.moderated, data.message))
        .digest("base64url");
    return { goodUntil, signature };
}
