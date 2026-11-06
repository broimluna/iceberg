import { SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import { getUtfString } from "../wire-helpers.ts";
import { getBySwid } from "../session-registry.ts";
import type { HandlerContext } from "./context.ts";

// SmartfoxCommand.GET_PLAYER_LOCATION ("zone.player_location",
// SMARTFOX_PACKETS_DOCUMENTATION.md's Room/igloo/zone section) - BOTH:
// OUT `swid` = target player's SWID (a lookup, not a broadcast); IN
// `pos` = a Vec3 float array on success, or the separate, payload-less
// SmartfoxCommand.PLAYER_NOT_FOUND ("zone.player_notfound") on miss -
// confirmed as two distinct commands, not an error flag inside the same
// response (ClubPenguinClient.decompiled.cs:2177-2183).
//
// Now backed by the real cross-connection registry (session-registry.ts,
// room registry + reward integrity pass, 2026-09-17 plan) instead of
// always replying not-found - see that plan for why this was previously
// unreachable (no shared state existed to look anyone up in).
// session.lastPosition is only ever set by the target's own l.a traffic
// (handlers/locomotion.ts); if they haven't moved yet this session,
// there's nothing real to report, so this still falls back to
// player_notfound rather than fabricating a (0,0,0) that isn't actually
// where they are.
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
