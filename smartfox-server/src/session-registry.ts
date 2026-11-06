import type { Session } from "./session.ts";

// Cross-connection registry - see docs/plans (room registry + reward
// integrity pass, 2026-09-17) for why this exists: server.ts previously
// gave every socket its own isolated Session with nothing tracking who
// else is connected, which blocked room broadcasts (igloo updates, party
// games, consumables visible to other players) and blocked the WebAPI's
// own push mechanism (web-api/src/smartfoxNotifier.ts's
// POST localhost:9339/notify, called from routes/catalog.ts
// and routes/player.ts, with nothing listening on the other end until
// notify-listener.ts). Deliberately a module-level registry, not a class
// owned by one connection - both extension-command handlers and the
// notify listener need to reach it independently of any single socket.
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

// Room-name lookups power broadcasts. Session.roomName is set at Login
// (handlers/sfs2x/login.ts) - same field already used everywhere else on
// this server, no new identity concept introduced.
export function getByRoom(roomName: string): RegisteredSession[] {
  return [...byUserId.values()].filter((entry) => entry.session.roomName === roomName);
}

// Same as getByRoom, minus one userId - the shape every room-presence call
// site actually wants (broadcast to/snapshot of "everyone else in this
// room"), so proximity.ts, locomotion.ts's movement broadcast, and login.ts's
// join/leave notifications all route through one function instead of each
// re-deriving the same filter.
export function getByRoomExcluding(roomName: string, excludeUserId: number): RegisteredSession[] {
  return getByRoom(roomName).filter((entry) => entry.session.userId !== excludeUserId);
}

// Username/swid lookups power targeted pushes - zone.player_location
// (handlers/player-location.ts) and the WebAPI notify bridge
// (notify-listener.ts), both of which only have a username or swid to
// key off, never our internal userId.
export function getByUsername(userName: string): RegisteredSession | undefined {
  return [...byUserId.values()].find((entry) => entry.session.userName === userName);
}

export function getBySwid(swid: string): RegisteredSession | undefined {
  return [...byUserId.values()].find((entry) => entry.session.swid === swid);
}
