import type { Session } from "./session.ts";

// Every connected player, keyed by user id. Used for room broadcasts and for
// pushes from the WebAPI (notify-listener.ts).
export interface RegisteredSession {
  session: Session;
  peer: string;
  send: (data: Buffer) => void;
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

// Lookups for targeted pushes, where only a username or SWID is known.
export function getByUsername(userName: string): RegisteredSession | undefined {
  return [...byUserId.values()].find((entry) => entry.session.userName === userName);
}

export function getBySwid(swid: string): RegisteredSession | undefined {
  return [...byUserId.values()].find((entry) => entry.session.swid === swid);
}
