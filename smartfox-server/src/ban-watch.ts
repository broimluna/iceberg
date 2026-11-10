// Bans are made in the web API's database (tools/mod.ts, Mix reports).
// The web API refuses a banned account's calls at once, but joinRoomData
// it signed earlier stays valid for a day, and a connection that is
// already open needs nothing from the web API to keep walking around. So
// the game server asks: at login (account.ts) and, for everyone online,
// every BAN_RECHECK_MS.
import { BAN_RECHECK_MS } from "./config.ts";
import { getAll, type RegisteredSession } from "./session-registry.ts";
import { fetchBanned } from "./webapi-client.ts";
import { DISCONNECT_KICK, disconnectPacket } from "./commands/moderation.ts";

export function kickBanned(entry: RegisteredSession): void {
  console.log(`[${new Date().toISOString()}] ${entry.peer} - ${entry.session.swid} is banned, closing`);
  try {
    entry.send(disconnectPacket(DISCONNECT_KICK));
  } catch {
    // The socket may already be gone.
  }
  setTimeout(() => entry.close(), 100);
}

async function recheck(): Promise<void> {
  const online = getAll().filter((entry) => entry.session.swid && entry.session.signedLogin);
  if (online.length === 0) return;
  const banned = await fetchBanned([...new Set(online.map((entry) => entry.session.swid!))]);
  if (!banned || banned.length === 0) return;
  const set = new Set(banned);
  for (const entry of getAll()) {
    if (entry.session.swid && set.has(entry.session.swid)) kickBanned(entry);
  }
}

export function startBanWatch(): void {
  if (!(BAN_RECHECK_MS > 0)) return;
  setInterval(() => void recheck().catch((err) => console.log(`[${new Date().toISOString()}] ban check failed: ${(err as Error).message}`)), BAN_RECHECK_MS).unref();
}
