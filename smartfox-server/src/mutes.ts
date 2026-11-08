import type { Session } from "./session.ts";
import { ROLE_LEVEL, type Role } from "./commands/roles.ts";

// Chat mutes set by :mute. Keyed by the signed swid, which is known as soon
// as a player logs in (the account name arrives a moment later), so a muted
// player who reconnects is muted from their first message. Each mute
// remembers the role that set it: only that rank or higher can lift it. In
// memory: mutes last until they expire or the server restarts.
interface Mute {
  accountName: string;
  until: number;
  setBy: Role;
}
const mutes = new Map<string, Mute>();

export function mute(target: { swid: string; accountName: string }, minutes: number, setBy: Role): void {
  mutes.set(target.swid, { accountName: target.accountName, until: Date.now() + minutes * 60_000, setBy });
}

function live(swid: string): Mute | undefined {
  const entry = mutes.get(swid);
  if (entry && entry.until <= Date.now()) {
    mutes.delete(swid);
    return undefined;
  }
  return entry;
}

/** When the session's mute ends (ms), or undefined if it isn't muted. */
export function mutedUntil(session: Session): number | undefined {
  return session.swid ? live(session.swid)?.until : undefined;
}

/**
 * The mute for an account name, matched exactly, else the only mute whose
 * name matches ignoring case. Works for players who are offline.
 */
export function findMute(accountName: string): { swid: string; mute: Mute } | undefined {
  const all = [...mutes.keys()].map((swid) => ({ swid, mute: live(swid) })).filter((m): m is { swid: string; mute: Mute } => !!m.mute);
  const exact = all.find((m) => m.mute.accountName === accountName);
  if (exact) return exact;
  const loose = all.filter((m) => m.mute.accountName.toLowerCase() === accountName.toLowerCase());
  return loose.length === 1 ? loose[0] : undefined;
}

export function canLift(m: Mute, by: Role): boolean {
  return ROLE_LEVEL[by] >= ROLE_LEVEL[m.setBy];
}

export function unmute(swid: string): void {
  mutes.delete(swid);
}
