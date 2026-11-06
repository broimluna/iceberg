import { SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import { getUtfString } from "../wire-helpers.ts";
import { getBySwid } from "../session-registry.ts";
import type { HandlerContext } from "./context.ts";

// "zone.player_location" - looks up another player by `swid`.
// Found: reply with `pos` (Vec3 float array).
// Not found: reply with the separate "zone.player_notfound" command.
// Position comes from the target's own movement (l.a), so a player who
// hasn't moved yet counts as not found.
export function handlePlayerLocation(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const targetSwid = getUtfString(innerParams, "swid");
  const target = targetSwid ? getBySwid(targetSwid) : undefined;
  const position = target?.session.lastPosition;
  if (!position) {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - zone.player_location lookup for swid=${targetSwid ?? "(none)"}: ${target ? "connected but no known position yet" : "not connected"}, replying not-found`);
    ctx.send(encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "zone.player_notfound").putSFSObject("p", new SFSObjectWriter())));
    return;
  }
  console.log(`[${new Date().toISOString()}] ${ctx.peer} - zone.player_location lookup for swid=${targetSwid}: found at ${JSON.stringify(position)}`);
  ctx.send(encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "zone.player_location").putSFSObject("p", new SFSObjectWriter().putFloatArray("pos", position))));
}
