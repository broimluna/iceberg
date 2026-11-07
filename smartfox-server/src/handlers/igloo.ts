import { SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import { getUtfString } from "../wire-helpers.ts";
import { getByRoomExcluding } from "../session-registry.ts";
import type { HandlerContext } from "./context.ts";

// "room.igloo_updated" - the owner sends `igloo_data` (TEXT, JSON
// SignedResponse<IglooData>) after saving their igloo through the WebAPI.
// Everyone else in the room gets only `igloo_id`, which the client passes to
// POST /igloo/v1/iglooId/layout/active before reloading the scene. An
// igloo's id is its owner's SWID (the instanceId of the igloo's ZoneId,
// which is also part of the room name). The owner gets nothing back: their
// client already has the new layout.
export function handleIglooUpdated(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const { session } = ctx;
  const hasData = getUtfString(innerParams, "igloo_data") !== undefined;
  if (!hasData || !session.swid) {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - room.igloo_updated without igloo_data or swid, ignoring`);
    return;
  }
  if (!session.roomName.includes(session.swid)) {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - room.igloo_updated outside the sender's igloo (room=${session.roomName}), not broadcasting`);
    return;
  }
  const packet = encodePacket(
    1,
    13,
    new SFSObjectWriter().putUtfString("c", "room.igloo_updated").putSFSObject("p", new SFSObjectWriter().putUtfString("igloo_id", session.swid))
  );
  const others = getByRoomExcluding(session.roomName, session.userId);
  for (const entry of others) entry.send(packet);
  console.log(`[${new Date().toISOString()}] ${ctx.peer} <- room.igloo_updated broadcast (igloo_id=${session.swid}, recipients=${others.length})`);
}
