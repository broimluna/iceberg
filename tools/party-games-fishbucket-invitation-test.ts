// Fish Bucket's owner-start invitation end to end: a real web API and game
// server, four fake clients in Town. The FishBucketGroup invitation has 3 guest
// slots and starts on the owner's Start press (LobbyType STRICT_USER_START),
// or by itself when every slot is filled.
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const sfs = await startGameServer(api, KEY, { PARTY_GAME_TIME_SCALE: "0.01", INVITATION_AUTOSTART_SECONDS: "6" });
const until = async (cond: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(20); return cond(); };
// Retail Start button = Action1 (l.a 7); a snowball throw is ChargeThrow 3 + LaunchThrow 4.
const START = 7, LAUNCH_THROW = 4, CHARGE_THROW = 3;

class Client extends GameClient {
  constructor(swid: string, name: string) { super(api, sfs.port, swid, name); }
  started() { return this.extOf("pgame.start.v2"); }
}

try {
  const O = new Client("{FB-OWNER}", "owner"), A = new Client("{FB-A}", "guesta"), B = new Client("{FB-B}", "guestb"), C = new Client("{FB-C}", "guestc");
  const all = [O, A, B, C];
  for (const c of all) await c.connect();
  check(all.every((c) => c.myId > 0), "all four logged in");
  await sleep(150);
  const hold = async () => { O.setCon("FishBucketGroup"); await sleep(100); for (const c of all) c.clear(); await O.use("FishBucketGroup"); await sleep(200); };
  const noGame = () => all.every((c) => c.started().length === 0);

  // ---- held out with 3 open slots ----
  await hold();
  check(all.every((c) => c.varsOf(O.myId).some((v) => v.con === "consum:FishBucketGroup" && v.con_prop === '{"actionCount":3}')), "invitation held out with 3 slots");

  // ---- a guest joining doesn't start it; Start with 1 guest does ----
  A.interactWith(O.sid);
  await sleep(1000);
  check(noGame() && O.varsOf(O.myId).some((v) => v.con_prop === '{"actionCount":2}'), "one guest joined, 2 slots left, no game");
  O.action(CHARGE_THROW); O.action(LAUNCH_THROW);
  await sleep(1000);
  check(noGame(), "a snowball throw (ChargeThrow, LaunchThrow) isn't Start");
  A.action(START);
  await sleep(1000);
  check(noGame(), "a guest can't Start");
  O.action(START);
  check(await until(() => O.started().length > 0, 4000), "the owner's Start begins the game");
  const start = O.started()[0];
  check(start?.template?.value === 1 && start?.players?.value === `{"Players":[{"TeamId":0,"UserSessionId":${O.sid},"RoleId":0},{"TeamId":0,"UserSessionId":${A.sid},"RoleId":0}]}`, `template 1, owner first, one guest: ${start?.players?.value}`);
  check(A.started().length === 1 && B.started().length === 0 && C.started().length === 0, "only the two players start");
  await sleep(100);
  check(O.varsOf(O.myId).some((v) => v.con === "pgame:FishBucketGameServerAdded") && O.varsOf(A.myId).some((v) => v.con === "pgame:FishBucketGameServerAdded"), "both hold the bucket prop");
  A.setCon(null);
  check(await until(() => O.extOf("pgame.end").length === 1), "the guest quitting ends the 2-player game");

  // ---- Start with no guests does nothing, the invitation stays ----
  await hold();
  O.action(START);
  await sleep(1500);
  check(noGame() && !all.some((c) => c.varsOf(O.myId).some((v) => v.con === null)), "Start with 0 guests: no game, invitation kept");

  // ---- cancel during the handoff ----
  A.interactWith(O.sid);
  await sleep(300);
  O.action(START);
  await sleep(300);
  O.setCon(null);
  await sleep(2000);
  check(noGame(), "cancelling during the handoff means no game");

  // ---- a guest who leaves during the 1 s handoff ----
  {
    for (const c of all) c.clear();
    await hold();
    const Y = new Client("{FB-Y}", "guesty"), Z = new Client("{FB-Z}", "guestz");
    await Y.connect(); await Z.connect(); await sleep(150);
    Y.interactWith(O.sid); await sleep(300);
    Z.interactWith(O.sid); await sleep(300);
    O.action(START);
    await sleep(300);
    Y.sock.destroy();
    check(await until(() => O.started().length > 0, 4000), "a guest leaving in the handoff: the game starts with who is left");
    check(O.started()[0]?.players?.value === `{"Players":[{"TeamId":0,"UserSessionId":${O.sid},"RoleId":0},{"TeamId":0,"UserSessionId":${Z.sid},"RoleId":0}]}`, `without the departed guest: ${O.started()[0]?.players?.value}`);
    Z.setCon(null);
    await until(() => O.extOf("pgame.end").length === 1);
    await sleep(300);

    // The only guest leaves: nothing to start, so the owner gets the invitation back.
    for (const c of all) c.clear();
    await hold();
    const W = new Client("{FB-W}", "guestw");
    await W.connect(); await sleep(150);
    W.interactWith(O.sid); await sleep(300);
    O.action(START);
    await sleep(300);
    W.sock.destroy();
    await sleep(1800);
    check(noGame(), "the only guest left in the handoff: no game");
    const last = O.varsOf(O.myId).filter((v) => v.con !== undefined).at(-1);
    check(last?.con === "consum:FishBucketGroup" && O.varsOf(O.myId).at(-1)?.con_prop === '{"actionCount":3}', `the invitation is back with 3 slots: ${JSON.stringify(O.varsOf(O.myId).slice(-3))}`);
    O.setCon(null); await sleep(200);
  }

  // ---- a guest who left before Start is dropped ----
  await hold();
  A.interactWith(O.sid); await sleep(300);
  B.interactWith(O.sid); await sleep(300);
  A.sock.destroy();
  await sleep(300);
  O.action(START);
  check(await until(() => O.started().length > 0, 4000), "Start still works with the remaining guest");
  check(O.started()[0]?.players?.value === `{"Players":[{"TeamId":0,"UserSessionId":${O.sid},"RoleId":0},{"TeamId":0,"UserSessionId":${B.sid},"RoleId":0}]}`, `the departed guest is dropped: ${O.started()[0]?.players?.value}`);
  B.setCon(null);
  await until(() => O.extOf("pgame.end").length === 1);

  // ---- a guest who left is given their slot back, and Start counts only who is still there ----
  await hold();
  const X = new Client("{FB-X}", "guestx");
  await X.connect(); await sleep(150);
  X.interactWith(O.sid); await sleep(300);
  X.sock.destroy();
  await sleep(300);
  O.action(START);
  await sleep(1500);
  check(noGame(), "Start after the only guest left: no game");
  check(O.varsOf(O.myId).at(-1)?.con_prop === '{"actionCount":3}', `the departed guest's slot is open again: ${JSON.stringify(O.varsOf(O.myId).at(-1))}`);

  // ---- a guest now holding something else isn't pulled in; with them free again the invitation starts by itself ----
  B.interactWith(O.sid); await sleep(300);
  B.setCon("Popscorn"); await sleep(300);
  O.action(START);
  await sleep(1500);
  check(noGame(), "Start with the only guest holding another item: no game");
  B.setCon(null);
  check(await until(() => O.started().length > 0, 9000), "with the minimum met, the invitation starts by itself after the wait");
  check(O.started()[0]?.players?.value === `{"Players":[{"TeamId":0,"UserSessionId":${O.sid},"RoleId":0},{"TeamId":0,"UserSessionId":${B.sid},"RoleId":0}]}`, `auto-start players: ${O.started()[0]?.players?.value}`);
  B.setCon(null);
  await until(() => O.extOf("pgame.end").length === 1);

  // ---- a full invitation starts by itself ----
  for (const c of all) c.clear();
  O.setCon("FishBucketGroup"); await sleep(100); await O.use("FishBucketGroup"); await sleep(200);
  const D = new Client("{FB-D}", "guestd"), E = new Client("{FB-E}", "gueste");
  await D.connect(); await E.connect(); await sleep(150);
  B.interactWith(O.sid); D.interactWith(O.sid); E.interactWith(O.sid);
  await sleep(300);
  check(await until(() => O.started().length > 0, 4000), "three guests fill the invitation and the game starts without Start");
  check(O.started()[0]?.players?.value?.split("UserSessionId").length === 5, "four players");
} catch (err) {
  check(false, `threw: ${(err as Error).stack}`);
} finally {
  sfs.stop();
  await api.stop();
}
finish(sfs.logs() + api.logs());
