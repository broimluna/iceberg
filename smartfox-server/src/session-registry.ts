import type { Session } from "./session.ts";
import type { OutgoingPacket } from "./sfs-wire.ts";

// Every connected player, keyed by user id. Used for room broadcasts and for
// pushes from the WebAPI (notify-listener.ts).
export interface RegisteredSession {
  session: Session;
  peer: string;
  send: (packet: OutgoingPacket) => void;
  /** Closes the connection. */
  close: () => void;
}

const byUserId = new Map<number, RegisteredSession>();

export function register(entry: RegisteredSession): void {
  byUserId.set(entry.session.userId, entry);
}

export function unregister(session: Session): void {
  byUserId.delete(session.userId);
}

// Everyone connected, in any room.
export function getAll(): RegisteredSession[] {
  return [...byUserId.values()];
}

// Everyone in a room - the basis for all room broadcasts.
export function getByRoom(roomName: string): RegisteredSession[] {
  return [...byUserId.values()].filter((entry) => entry.session.roomName === roomName);
}

// Everyone in a room except one user (usually the sender).
export function getByRoomExcluding(roomName: string, excludeUserId: number): RegisteredSession[] {
  return getByRoom(roomName).filter((entry) => entry.session.userId !== excludeUserId);
}

// Lookups for targeted pushes, where only a web API username or SWID is
// known. Matches the verified account, not the login's unsigned "un".
export function getByUsername(userName: string): RegisteredSession | undefined {
  return [...byUserId.values()].find((entry) => entry.session.accountName === userName);
}

// For staff commands: an exact account-name match, else the one connected
// account whose name matches ignoring case (none when that is ambiguous).
export function getByAccountName(name: string): RegisteredSession | undefined {
  const all = [...byUserId.values()].filter((entry) => entry.session.accountName);
  const exact = all.find((entry) => entry.session.accountName === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  const loose = all.filter((entry) => entry.session.accountName!.toLowerCase() === lower);
  return loose.length === 1 ? loose[0] : undefined;
}

export function getBySwid(swid: string): RegisteredSession | undefined {
  return [...byUserId.values()].find((entry) => entry.session.swid === swid);
}
