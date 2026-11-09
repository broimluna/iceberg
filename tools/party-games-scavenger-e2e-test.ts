// Scavenger Hunt end to end: a real web API and game server, two fake
// clients. The owner holds out the ScavengerHuntGroup invitation, the guest
// accepts, roles are random so each client works out its own, the Hider drops
// marbles with an l.a Action1 (7), the Finder picks them up with RemoveItem, and
// the web API's coins change by the placement rewards.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";
import { SFSObjectWriter, SFSDataType } from "../smartfox-server/src/sfs-wire.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const sfs = await startGameServer(api, KEY, { PARTY_GAME_TIME_SCALE: "0.02" });

class Client extends GameClient {
  constructor(swid: string, name: string) { super(api, sfs.port, swid, name); }
  // l.a as the client sends it: position "p", action byte "a".
  act(action: number, p: [number, number, number]) {
    this.ext13("l.a", new SFSObjectWriter().putFloatArray("p", p).putByte("a", action).putFloatArray("d", [0, 0, 0]));
  }
  pgame(id: number, type: number, body: string) {
    this.ext13("pgame.message", new SFSObjectWriter().putLong("id", BigInt(id)).putLong("type", BigInt(type)).putUtfString("message", body));
  }
  msgs(type: number) { return this.extOf("pgame.message").filter((p) => p.type!.value === type).map((p) => JSON.parse(p.message!.value as string)); }
}

function coins(username: string): number {
  const db = new Database(api.dbPath);
  const row = db.query("SELECT coins FROM player_assets WHERE username = ?").get(username) as any;
  db.close();
  return row?.coins ?? -1;
}
const until = async (cond: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(20); return cond(); };

try {
  const O = new Client("{SH-OWNER}", "showner"), G = new Client("{SH-GUEST}", "shguest");
  for (const c of [O, G]) await c.connect();
  check(O.myId > 0 && G.myId > 0, "both logged in");
  await sleep(150);

  O.setCon("ScavengerHuntGroup");
  await sleep(100);
  await O.use("ScavengerHuntGroup");
  await sleep(200);
  check(O.updates.some((u) => u.vars.con === "consum:ScavengerHuntGroup"), "the invitation is held out");
  const oBefore = coins(O.username), gBefore = coins(G.username);
  for (const c of [O, G]) c.clear();
  G.interactWith(O.sid);
  check(await until(() => O.extOf("pgame.start.v2").length > 0 && G.extOf("pgame.start.v2").length > 0), "both get pgame.start.v2");
  const start = O.extOf("pgame.start.v2")[0]!;
  const id = start.id!.value as number;
  check(start.template!.value === 0 && start.id!.type === SFSDataType.INT && start.template!.type === SFSDataType.INT, "template 0, id/template are ints");

  // ---- roles ----
  check(await until(() => O.msgs(0).length === 1 && G.msgs(0).length === 1), "each client gets one SetRole");
  const raw = O.extOf("pgame.message").find((p) => p.type!.value === 0)!;
  check(raw.type!.type === SFSDataType.INT && raw.id!.type === SFSDataType.INT && /^\{"RoleId":[01]\}$/.test(raw.message!.value as string), `SetRole wire: ${raw.message!.value}`);
  const roles = [O.msgs(0)[0].RoleId, G.msgs(0)[0].RoleId];
  check(roles.includes(0) && roles.includes(1), `one Hider, one Finder (${roles})`);
  const [H, F] = roles[0] === 0 ? [O, G] : [G, O];
  check(H.varsOf(H.myId).concat(F.varsOf(H.myId)).some((v) => v.con === "pgame:ScavengerHuntHiderServerAdded"), "the Hider holds the hider prop");

  // ---- hiding ----
  check(await until(() => O.msgs(1).some((m) => m.GameStateId === 1) && G.msgs(1).some((m) => m.GameStateId === 1)), "Hiding state to both");
  F.act(7, [10, 0, 12]);
  H.act(0, [10, 0, 10]);
  H.act(7, [10, 0, 10]);
  check(await until(() => O.msgs(2).length === 1 && G.msgs(2).length === 1), "the Hider's Action1 announces a marble to both");
  const add = O.extOf("pgame.message").find((p) => p.type!.value === 2)!;
  check(add.message!.value === '{"ItemId":1,"Pos":{"x":10,"y":0,"z":10}}', `AddItem wire: ${add.message!.value}`);
  H.act(0, [12, 0, 10]); H.act(7, [12, 0, 10]);
  await until(() => O.msgs(2).length === 2);
  check(O.msgs(2).length === 2 && F.msgs(2).length === 2, "a second marble");
  // The Finder can't hide, and can't pick up before Finding.
  F.pgame(id, 3, '{"ItemId":1}');
  await sleep(100);
  check(O.msgs(3).length === 0, "no pickup while hiding");

  // ---- finding ----
  check(await until(() => F.updates.some((u) => u.u === F.myId && u.vars.con === "pgame:ScavengerHuntFinderServerAdded")), "the Finder gets the finder prop");
  check(await until(() => O.msgs(1).some((m) => m.GameStateId === 2)), "Finding state");
  F.act(0, [18, 0, 10]);
  F.pgame(id, 3, '{"ItemId":1}');
  await sleep(100);
  check(O.msgs(3).length === 0, "a far Finder's pickup is refused");
  F.act(0, [11, 0, 10]);
  F.pgame(id, 3, '{"ItemId":1}');
  F.pgame(id, 3, '{"ItemId":2}');
  check(await until(() => O.msgs(3).length === 2 && G.msgs(3).length === 2), "both pickups announced");
  check(JSON.stringify(O.msgs(3)) === '[{"ItemId":1},{"ItemId":2}]', `RemoveItem wire: ${JSON.stringify(O.msgs(3))}`);

  // ---- result ----
  check(await until(() => O.extOf("pgame.end").length === 1 && G.extOf("pgame.end").length === 1), "both get pgame.end");
  check(O.extOf("pgame.end")[0]?.results?.value === `[{"PlayerSessionId":${F.sid},"Placement":0},{"PlayerSessionId":${H.sid},"Placement":1}]`,
    `Finder won: ${O.extOf("pgame.end")[0]?.results?.value}`);
  check(O.extOf("reward.add_delayed").length === 1 && G.extOf("reward.add_delayed").length === 1, "each gets reward.add_delayed");
  const win = F === O ? O : G, lose = F === O ? G : O;
  await until(() => coins(win.username) === (win === O ? oBefore : gBefore) + 20, 2000);
  check(coins(win.username) === (win === O ? oBefore : gBefore) + 20 && coins(lose.username) === (lose === O ? oBefore : gBefore) + 10, "coins +20 / +10");
  await sleep(100);
  check([O, G].every((c) => c.varsOf(O.myId).at(-1)?.con === null && c.varsOf(G.myId).at(-1)?.con === null), "game props cleared");
} finally {
  sfs.stop(); api.stop();
}
finish();
