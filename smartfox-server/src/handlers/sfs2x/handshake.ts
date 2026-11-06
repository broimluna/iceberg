import crypto from "node:crypto";
import { SFSObjectWriter, encodePacket } from "../../sfs-wire.ts";
import { COMPRESSION_THRESHOLD, MAX_MESSAGE_SIZE } from "../../config.ts";
import type { HandlerContext } from "../context.ts";

// Controller 0 / action 0 - the real SFS2X wire handshake, verified against
// the decompiled client (see handshake-server.ts's original module comment
// for the project's origin as a narrow handshake-only diagnostic server).
export function handleHandshake(ctx: HandlerContext): void {
  const token = crypto.randomUUID();
  const responseParams = new SFSObjectWriter()
    .putUtfString("tk", token)
    .putInt("ct", COMPRESSION_THRESHOLD)
    .putInt("ms", MAX_MESSAGE_SIZE);
  ctx.send(encodePacket(0, 0, responseParams));
  console.log(`[${new Date().toISOString()}] ${ctx.peer} <- handshake response (tk=${token})`);
}
