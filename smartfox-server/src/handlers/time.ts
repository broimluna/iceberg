import { SFSDataType, SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import type { HandlerContext } from "./context.ts";

// "time.get" - the client sends this right after joining a room and waits
// for the reply before sending anything else; without it the room join
// hangs. Echo the client's "ct" back and add "st" (server time, ms).
export function handleTimeGet(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const ct = innerParams["ct"];
  const clientTime = ct?.type === SFSDataType.LONG ? ct.value : 0n;
  const responseP = new SFSObjectWriter().putLong("ct", clientTime).putLong("st", BigInt(Date.now()));
  ctx.send(encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "time.get").putSFSObject("p", responseP)));
  console.log(`[${new Date().toISOString()}] ${ctx.peer} <- time.get response (ct=${clientTime}, st=${Date.now()})`);
}
