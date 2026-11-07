import { SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import { getUtfString } from "../wire-helpers.ts";
import { getByRoomExcluding } from "../session-registry.ts";
import type { HandlerContext } from "./context.ts";

// "proto" - a developer hook for prototype features; no shipped game code
// sends or listens for it. OUT: data = JSON. IN: senderId + data, which the
// client parses with LitJson, so only valid JSON is relayed. Prototype
// *state* is a separate user variable ("proto") the client sets itself.
export function handlePrototypeAction(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const data = getUtfString(innerParams, "data");
  try {
    if (data === undefined) throw new Error("missing");
    JSON.parse(data);
  } catch {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - proto with missing or invalid JSON data, not relaying`);
    return;
  }
  const p = new SFSObjectWriter().putInt("senderId", ctx.session.userId).putUtfString("data", data);
  const packet = encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "proto").putSFSObject("p", p));
  for (const entry of getByRoomExcluding(ctx.session.roomName, ctx.session.userId)) entry.send(packet);
}
