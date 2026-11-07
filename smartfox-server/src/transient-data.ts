// Room transient data: state that follows a player from one room to the
// next. When the player leaves (zone.logout) the server pushes "zone.transfer"
// with d = JSON SignedResponse<TransientData>; the client keeps it as
// LastRoomTransientData and sends it back as "transientData" in its next
// login. The echoed copy is unsigned here, so the server keeps its own copy
// per SWID and restores from that instead.
//
// TransientData fields: equippedConsumable, equippedConsumableProperties,
// questCurrentObjectiveData, questObjectiveState. Only the equipped
// consumable is tracked so far.

import { SFSObjectWriter, encodePacket } from "./sfs-wire.ts";
import type { Session } from "./session.ts";
import type { HandlerContext } from "./handlers/context.ts";

interface TransientData {
  equippedConsumable?: string;
}

// A room change reconnects within seconds; anything older is stale.
const TTL_MS = 60_000;
const saved = new Map<string, { data: TransientData; savedAt: number }>();

function collect(session: Session): TransientData {
  const data: TransientData = {};
  if (session.equippedConsumable) data.equippedConsumable = session.equippedConsumable;
  return data;
}

// Sends "zone.transfer" and remembers the data for the player's next login.
export function sendTransientData(ctx: HandlerContext): void {
  const { session } = ctx;
  const data = collect(session);
  if (session.swid) saved.set(session.swid, { data, savedAt: Date.now() });
  const payload = { goodUntil: 0, signature: "", swid: session.swid ?? "", data };
  const p = new SFSObjectWriter().putUtfString("d", JSON.stringify(payload));
  ctx.send(encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "zone.transfer").putSFSObject("p", p)));
  console.log(`[${new Date().toISOString()}] ${ctx.peer} <- zone.transfer (data=${JSON.stringify(data)})`);
}

// Restores the saved state at login. One use per save.
export function restoreTransientData(session: Session): void {
  if (!session.swid) return;
  const entry = saved.get(session.swid);
  saved.delete(session.swid);
  if (!entry || Date.now() - entry.savedAt > TTL_MS) return;
  session.equippedConsumable = entry.data.equippedConsumable;
}
