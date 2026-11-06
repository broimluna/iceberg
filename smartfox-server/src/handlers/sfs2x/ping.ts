import { SFSObjectWriter, encodePacket } from "../../sfs-wire.ts";
import type { HandlerContext } from "../context.ts";

// RequestType.PingPong = 29 (SmartFox2X.decompiled.cs:12618). FnPingPong
// doesn't read msg.Content at all - just calls sfs.LagMonitor.OnPingPong()
// - so an empty ack is correct, not a guess (confirmed at
// SmartFox2X.decompiled.cs:3388).
export function handlePingPong(ctx: HandlerContext): void {
  ctx.send(encodePacket(0, 29, new SFSObjectWriter()));
}
