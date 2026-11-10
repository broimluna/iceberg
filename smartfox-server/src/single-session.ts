// One game connection per account. The client has one game connection at a
// time (a room change is a Disconnect then a Reconnect), so a second
// connection for the same swid is either the old one still closing or the
// account in use somewhere else. The newest login wins and the older
// connection is closed. Without this an account could sit in several rooms
// at once, in two party games, and multiply anything counted per connection.
import { getAll } from "./session-registry.ts";
import type { Session } from "./session.ts";
import { DISCONNECT_KICK, disconnectPacket } from "./commands/moderation.ts";

/** Closes every other connection that logged in with this session's signed swid. Call before registering the session. */
export function closeOlderConnections(session: Session, peer: string): void {
  // An unsigned login (development) has no verified swid to match on.
  if (!session.signedLogin || !session.swid) return;
  for (const entry of getAll()) {
    if (entry.session === session || !entry.session.signedLogin || entry.session.swid !== session.swid) continue;
    console.log(`[${new Date().toISOString()}] ${peer} - ${session.swid} logged in again, closing the older connection ${entry.peer}`);
    try {
      entry.send(disconnectPacket(DISCONNECT_KICK));
    } catch {
      // The socket may already be gone.
    }
    setTimeout(() => entry.close(), 100);
  }
}
