// Colour, tube and outfit are what other players see of someone. The client
// relays them itself (joinRoomData at login, user variables afterwards), so
// a modified client could show items it doesn't own. The web API has what is
// really saved for the account, so for signed logins the game server asks it
// (fetchAppearance) and shows the saved values:
// - at login the client's values are used straight away, as before, and
//   corrected within a request if they differ from the saved ones;
// - the outfit, colour and tube variables a client sets later are not
//   relayed. The saved values are, once the web API has answered, and only
//   if they differ from what the room already shows.
// Outfits are compared by what is worn (equipment id, definition and
// customizations), not by text, because the client re-serializes the JSON
// it gets.
// Unsigned development logins have no verified swid and keep the old
// pass-through.
import { SFSDataType, SFSObjectWriter, encodePacket, type OutgoingPacket, type SFSValue, type VariableKind } from "./sfs-wire.ts";
import { getByRoomExcluding, isRegistered } from "./session-registry.ts";
import { fetchAppearance } from "./webapi-client.ts";
import { onPlayerStateChanged } from "./daily-tasks.ts";
import type { Session } from "./session.ts";

export function variableEntry(name: string, kind: VariableKind, value: SFSValue): SFSValue {
  return {
    type: SFSDataType.SFS_ARRAY,
    value: [
      { type: SFSDataType.UTF_STRING, value: name },
      { type: SFSDataType.VARIABLE_TYPE, value: kind },
      value,
      { type: SFSDataType.BOOL, value: false },
    ],
  };
}

// A value with its keys sorted and nulls and empty arrays left out: the
// client re-serializes what it was sent, so field order and null-or-missing
// can differ between two texts that put the same thing on the avatar.
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort()) {
      const n = normalize((v as Record<string, unknown>)[key]);
      if (n === null || n === undefined || (Array.isArray(n) && n.length === 0)) continue;
      out[key] = n;
    }
    return out;
  }
  return v;
}

/** What an outfit's JSON puts on the avatar (each item, its definition and customizations), as comparable text; null if it isn't an outfit. */
export function wornItems(json: string | undefined): string | null {
  if (json === undefined) return "";
  try {
    const parts = JSON.parse(json)?.parts;
    if (parts === undefined || parts === null) return "";
    if (!Array.isArray(parts)) return null;
    return parts.map((p: any) => JSON.stringify([p?.equipmentId, p?.definitionId, normalize(p?.parts ?? [])])).sort().join(";");
  } catch {
    return null;
  }
}

// The newest request per session; an older answer arriving late is ignored.
const newest = new WeakMap<Session, number>();

export async function refreshAppearance(session: Session, send: (packet: OutgoingPacket) => void, why: string): Promise<void> {
  if (!session.signedLogin || !session.swid) return;
  const ticket = (newest.get(session) ?? 0) + 1;
  newest.set(session, ticket);
  const saved = await fetchAppearance(session.swid);
  if (!saved || newest.get(session) !== ticket || !isRegistered(session)) return;

  const changed: SFSValue[] = [];
  const names: string[] = [];
  if (saved.colour !== session.colour) {
    session.colour = saved.colour;
    changed.push(variableEntry("colour", "int", { type: SFSDataType.INT, value: saved.colour }));
    names.push("colour");
  }
  if (saved.tubeId !== session.selectedTubeId) {
    session.selectedTubeId = saved.tubeId;
    changed.push(variableEntry("tube", "int", { type: SFSDataType.INT, value: saved.tubeId }));
    names.push("tube");
  }
  const sessionId = Number(session.playerSessionId);
  const outfit = JSON.stringify({ parts: saved.parts, sessionId: Number.isSafeInteger(sessionId) ? sessionId : 0 });
  if (wornItems(session.outfitJson) !== wornItems(outfit)) {
    session.outfitJson = outfit;
    changed.push(variableEntry("outfit", "string", { type: SFSDataType.UTF_STRING, value: outfit }));
    names.push("outfit");
  }
  if (changed.length === 0) return;

  console.log(`[${new Date().toISOString()}] ${session.swid} - ${names.join(", ")} set to the saved value (${why})`);
  const packet = encodePacket(0, 12, new SFSObjectWriter().putInt("u", session.userId).putRaw("vl", { type: SFSDataType.SFS_ARRAY, value: changed }));
  send(packet);
  for (const entry of getByRoomExcluding(session.roomName, session.userId)) entry.send(packet);
  onPlayerStateChanged(session);
}
