// Friend flow against a throwaway WebAPI copy, checked with the client's own
// Mix rules: every notification needs a non-zero SequenceNumber that is
// exactly one past the user's last (starting from /state's
// NotificationSequenceCounter), plus the fields its validator requires.
import { Database } from "bun:sqlite";

import { startWebApi, makeChecker } from "./lib/harness.ts";

// A throwaway copy of iceberg's web-api with its own empty database.
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1" } });
const DB = api.dbPath;
const BASE = api.base;
const { check, finish } = makeChecker();
const server = { kill: api.stop };

// Mirrors the client's NotificationQueue: apply only latest+1.
class MixClient {
  latest = 0;
  constructor(public swid: string, public name: string) {}
  async call(path: string, body: object) {
    const r = await fetch(`${BASE}${path}`, {
      method: path === "/friendship/invitation" || path === "/friendship" ? "PUT" : "POST",
      headers: { "Content-Type": "application/json", "X-Mix-OneIdToken": "t" },
      body: JSON.stringify({ UserId: this.swid, Timestamp: Date.now(), ...body }),
    });
    return r.json() as Promise<any>;
  }
  async state() { this.latest = (await this.call("/state", {})).NotificationSequenceCounter; return this.latest; }
  // Returns whether the client would accept it.
  apply(n: any, label: string): boolean {
    const ok = typeof n?.SequenceNumber === "number" && n.SequenceNumber !== 0 && n.SequenceNumber === this.latest + 1;
    check(ok, `${this.name}: ${label} seq=${n?.SequenceNumber} (latest ${this.latest})`);
    if (ok) this.latest = n.SequenceNumber;
    return ok;
  }
  // Like NotificationPoller.Poll: asks for latest + 1 onward (inclusive).
  async poll() {
    const r = await this.call("/notifications/sinceSequence", { SequenceNumber: this.latest + 1, ExcludeNotificationSequenceNumbers: [] });
    return r;
  }
}

try {
  // Two players with display names.
  for (const s of ["{AAAA-1}", "{BBBB-2}"]) await fetch(`${BASE}/player/v1`, { headers: { Authorization: "Basic " + btoa(`${s}:x`) } });
  const db = new Database(DB);
  const cols = db.query("SELECT name FROM pragma_table_info('player_identity')").all().map((x: any) => x.name);
  const nameCol = cols.includes("display_name") ? "display_name" : "displayName";
  db.run(`UPDATE player_identity SET ${nameCol} = 'alice' WHERE swid = '{AAAA-1}'`);
  db.run(`UPDATE player_identity SET ${nameCol} = 'bob' WHERE swid = '{BBBB-2}'`);
  db.close();

  const A = new MixClient("{AAAA-1}", "alice"), B = new MixClient("{BBBB-2}", "bob");
  await A.state(); await B.state();
  check(A.latest === 0 && B.latest === 0, "fresh users start at sequence 0");

  // Invite.
  const inv = await A.call("/friendship/invitation", { InviteeDisplayName: "bob", IsTrusted: false });
  check(inv.Status === "OK", `invite status ${inv.Status}`);
  const n = inv.Notification;
  check(n?.Invitation?.FriendDisplayName === "bob" && n.Invitation.IsInviter === true && typeof n.Invitation.FriendshipInvitationId === "number" && n.Invitation.IsTrusted === false,
    "inviter notification has the fields its validator needs");
  A.apply(n, "own AddFriendshipInvitation");
  const bp = await B.poll();
  check(bp.AddFriendshipInvitation?.length === 1 && bp.AddFriendshipInvitation[0].Invitation.IsInviter === false, "bob's poll returns the invitation");
  B.apply(bp.AddFriendshipInvitation?.[0], "incoming AddFriendshipInvitation");
  check(bp.NotificationSequenceCounter === B.latest, `bob's counter in poll = ${bp.NotificationSequenceCounter}`);
  const again = await A.call("/friendship/invitation", { InviteeDisplayName: "bob", IsTrusted: false });
  check(again.Status === "INVITATION_ALREADY_EXISTS", "second invite -> INVITATION_ALREADY_EXISTS");
  check((await A.poll()).AddFriendshipInvitation?.length === 0, "alice's poll doesn't redeliver her own applied notification");

  // Accept.
  const acc = await B.call("/friendship", { InvitationId: n.Invitation.FriendshipInvitationId, IsTrusted: false });
  check(acc.Status === "OK" && acc.Notification?.Friend?.UserId === "{AAAA-1}", "accept OK, Friend is alice");
  B.apply(acc.Notification, "own AddFriendship");
  const ap = await A.poll();
  check(ap.AddFriendship?.length === 1 && ap.AddFriendship[0].Friend.UserId === "{BBBB-2}", "alice's poll returns AddFriendship with bob");
  A.apply(ap.AddFriendship?.[0], "incoming AddFriendship");

  // Relogin keeps the counter.
  const before = A.latest;
  await A.state();
  check(A.latest === before, `/state counter after relogin = ${A.latest}`);

  // Unfriend.
  const del = await A.call("/friendship/delete", { FriendUserId: "{BBBB-2}" });
  check(del.Notification?.FriendUserId === "{BBBB-2}", "unfriend notification has FriendUserId");
  A.apply(del.Notification, "own RemoveFriendship");
  const bp2 = await B.poll();
  check(bp2.RemoveFriendship?.[0]?.FriendUserId === "{AAAA-1}", "bob is told alice removed him");
  B.apply(bp2.RemoveFriendship?.[0], "incoming RemoveFriendship");

  // Invite then cancel.
  const inv2 = await A.call("/friendship/invitation", { InviteeDisplayName: "bob", IsTrusted: false });
  A.apply(inv2.Notification, "second invite");
  const id2 = inv2.Notification.Invitation.FriendshipInvitationId;
  B.apply((await B.poll()).AddFriendshipInvitation?.[0], "second incoming invite");
  const cancel = await A.call("/friendship/invitation/delete", { InvitationId: id2 });
  check(cancel.Notification?.InvitationId === id2, "cancel notification has InvitationId");
  A.apply(cancel.Notification, "own RemoveFriendshipInvitation");
  B.apply((await B.poll()).RemoveFriendshipInvitation?.[0], "incoming RemoveFriendshipInvitation");
} finally {
  server.kill();
}
finish(api.logs());
