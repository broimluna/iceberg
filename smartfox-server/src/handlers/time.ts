import { SFSDataType, SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import type { HandlerContext } from "./context.ts";

// SmartfoxCommand.GET_SERVER_TIME ("time.get") - confirmed root cause of
// the room-join hang via a byte-level capture of the real client hitting
// our own server: the client
// sends this immediately after JoinRoom, completely unconditionally, and
// its own bootstrap sequence blocks waiting for a response before ever
// sending anything else (`encryption.get`, movement, etc.) - since this
// project never had a handler for it, the client just hung forever with
// no visible error. Response: echoes the client's own "ct" value
// back verbatim (both LONG) and adds "st" (server time in ms, also LONG).
export function handleTimeGet(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const ct = innerParams["ct"];
  const clientTime = ct?.type === SFSDataType.LONG ? ct.value : 0n;
  const responseP = new SFSObjectWriter().putLong("ct", clientTime).putLong("st", BigInt(Date.now()));
  ctx.send(encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "time.get").putSFSObject("p", responseP)));
  console.log(`[${new Date().toISOString()}] ${ctx.peer} <- time.get response (ct=${clientTime}, st=${Date.now()})`);
}
