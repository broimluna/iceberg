// Mix session against a throwaway WebAPI copy, using a client that behaves
// like the real SDK: Guest Controller login, RSA -> AES key exchange,
// encrypted bodies, and notifications applied strictly at latest + 1.
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { MixClient, createPlayer } from "./lib/mix-client.ts";

const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1" } });
const { check, finish } = makeChecker();

try {
  await createPlayer(api.base, api.dbPath, "{AAAA-1}", "alice");
  await createPlayer(api.base, api.dbPath, "{BBBB-2}", "bob");
  const A = new MixClient(api.base), B = new MixClient(api.base);
  await A.login("alice", "pw-alice"); await B.login("bob", "pw-bob");
  await A.startSession(); await B.startSession();
  check(A.swid === "{AAAA-1}" && B.swid === "{BBBB-2}", `login resolves swids (${A.swid}, ${B.swid})`);

  const s = await A.state();
  await B.state();
  check(s?.Status === "OK", `/state decrypts with Status OK (${s?.Status})`);
  check(JSON.stringify(s.PollIntervals) === "[2,5,10]", `PollIntervals ${JSON.stringify(s.PollIntervals)}`);
  check(s.NotificationSequenceCounter === 0, `fresh user counter ${s.NotificationSequenceCounter}`);
  check(s.NotificationSequenceThreshold === 10000, `threshold is 10 s in ms (${s.NotificationSequenceThreshold})`);

  const inv = await A.call("PUT", "/friendship/invitation", { InviteeDisplayName: "bob", IsTrusted: false });
  check(inv.http === 200 && inv.body?.Status === "OK", `invite -> ${inv.http} ${inv.body?.Status}`);
  check(A.apply(inv.body?.Notification, "AddFriendshipInvitation"), "alice applies her own invite notification");

  let got: { type: string; n: any }[] = [];
  try { got = await B.drain(); } catch (e) { check(false, `bob drain: ${(e as Error).message}`); }
  check(got.length === 1 && got[0].type === "AddFriendshipInvitation", `bob drains one AddFriendshipInvitation (${got.map((g) => g.type).join(",") || "none"})`);
} finally {
  api.stop();
}
finish(api.logs());
