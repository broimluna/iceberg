import { SFSObjectWriter, encodePacket } from "../../sfs-wire.ts";
import type { HandlerContext } from "../context.ts";

// RequestType.PingPong = 29. The client's FnPingPong ignores the payload and
// just feeds its lag monitor, so an empty ack is all it needs.
export function handlePingPong(ctx: HandlerContext): void {
  ctx.send(encodePacket(0, 29, new SFSObjectWriter()));
}
