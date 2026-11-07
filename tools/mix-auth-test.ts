// Mix requests must act only as the user their X-Mix-OneIdToken belongs
// to: a bogus token, a forged body UserId, or someone else's session id
// is rejected with the 401 status the SDK expects (MixWebCallFactory).
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { MixClient, createPlayer } from "./lib/mix-client.ts";

const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1" } });
const { check, finish } = makeChecker();

// A client that borrows parts of real ones, to forge requests.
function forge(from: MixClient, over: Partial<Pick<MixClient, "swid" | "accessToken" | "sessionId" | "key">>) {
  const f = new MixClient(api.base);
  Object.assign(f, { swid: from.swid, accessToken: from.accessToken, sessionId: from.sessionId, key: from.key }, over);
  return f;
}

try {
  await createPlayer(api.base, api.dbPath, "{AAAA-1}", "alice");
  await createPlayer(api.base, api.dbPath, "{BBBB-2}", "bob");
  await createPlayer(api.base, api.dbPath, "{CCCC-3}", "carol");
  const A = new MixClient(api.base), B = new MixClient(api.base);
  await A.login("alice", "pw-alice"); await B.login("bob", "pw-bob");
  await A.startSession(); await B.startSession();
  await A.state(); const bobBefore = (await B.state()).NotificationSequenceCounter;

  const own = await A.call("POST", "/state");
  check(own.http === 200 && own.body?.Status === "OK", `alice's own call -> ${own.http} ${own.body?.Status}`);

  const bogus = await forge(A, { accessToken: "not-a-real-token" }).call("POST", "/state");
  check(bogus.http === 401 && bogus.body?.Status === "UNAUTHORIZED_ONEID_TOKEN", `bogus token -> ${bogus.http} ${bogus.body?.Status}`);

  const noToken = await forge(A, { accessToken: "" }).call("POST", "/state");
  check(noToken.http === 401 && noToken.body?.Status === "UNAUTHORIZED_ONEID_TOKEN", `missing token -> ${noToken.http} ${noToken.body?.Status}`);

  // alice's token, alice's session, but claiming to be bob: invite carol as bob.
  const asBob = await forge(A, { swid: B.swid }).call("PUT", "/friendship/invitation", { InviteeDisplayName: "carol", IsTrusted: false });
  check(asBob.http === 401 && asBob.body?.Status === "UNAUTHORIZED_ONEID_TOKEN", `alice's token with UserId bob -> ${asBob.http} ${asBob.body?.Status}`);
  const bobAfter = (await B.state()).NotificationSequenceCounter;
  check(bobAfter === bobBefore, `bob's notification counter unchanged (${bobBefore} -> ${bobAfter})`);

  // alice's token on bob's session.
  const onBobSession = await forge(A, { sessionId: B.sessionId, key: B.key }).call("POST", "/state");
  check(onBobSession.http === 401 && onBobSession.body?.Status === "UNAUTHORIZED_MIX_SESSION", `alice's token on bob's session -> ${onBobSession.http} ${onBobSession.body?.Status}`);

  // Session start with a forged UserId must not create a session for bob.
  const startAsBob = await forge(A, { swid: B.swid, sessionId: null, key: null }).call("PUT", "/session/user", { PublicKeyModulus: "AQAB", PublicKeyExponent: "AQAB" });
  check(startAsBob.http === 401 && startAsBob.body?.Status === "UNAUTHORIZED_ONEID_TOKEN", `session start as bob with alice's token -> ${startAsBob.http} ${startAsBob.body?.Status}`);
  const bobStill = await B.call("POST", "/state");
  check(bobStill.http === 200, `bob's own session still works (${bobStill.http})`);
} finally {
  api.stop();
}
finish(api.logs());
