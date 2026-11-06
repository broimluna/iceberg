import crypto from "node:crypto";
import { SFSObjectWriter, encodePacket } from "../../sfs-wire.ts";
import { COMPRESSION_THRESHOLD, MAX_MESSAGE_SIZE } from "../../config.ts";
import type { HandlerContext } from "../context.ts";

// Controller 0 / action 0: the SFS2X handshake. Replies with a session token,
// the compression threshold and the max message size.
export function handleHandshake(ctx: HandlerContext): void {
  const token = crypto.randomUUID();
  const responseParams = new SFSObjectWriter()
    .putUtfString("tk", token)
    .putInt("ct", COMPRESSION_THRESHOLD)
    .putInt("ms", MAX_MESSAGE_SIZE);
  ctx.send(encodePacket(0, 0, responseParams));
  console.log(`[${new Date().toISOString()}] ${ctx.peer} <- handshake response (tk=${token})`);
}
