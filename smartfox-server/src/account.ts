import type { Session } from "./session.ts";
import { fetchIdentity } from "./webapi-client.ts";

// Resolves the web API account (and staff role) behind a login's swid.
// Called once, right after login. An unsigned login (development only)
// gets the account but never a staff role.
export function resolveIdentity(session: Session, peer: string): void {
  const swid = session.swid;
  if (!swid) return;
  session.identityReady = fetchIdentity(swid).then((identity) => {
    if (!identity) {
      console.log(`[${new Date().toISOString()}] ${peer} - identity ${swid}: no account (rewards and staff commands disabled)`);
      return;
    }
    session.accountName = identity.username;
    if (session.signedLogin) session.role = identity.role;
    console.log(
      `[${new Date().toISOString()}] ${peer} - identity ${swid} -> ${identity.username} (${session.signedLogin ? identity.role : "role ignored: unsigned"})`
    );
  });
}

// Runs fn with the verified account name once it's known; logs and skips
// when there is none.
export function withAccount(session: Session, what: string, fn: (accountName: string) => unknown): void {
  void session.identityReady.then(() => {
    if (session.accountName) return fn(session.accountName);
    console.log(`[${new Date().toISOString()}] skipping ${what} for user ${session.userId}: no verified account`);
  });
}
