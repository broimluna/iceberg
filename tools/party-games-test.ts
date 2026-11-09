// Find Four end to end: a real web API and game server, three fake clients
// (owner, guest, spectator) in Town. The owner holds out the FindFourGroup
// invitation, the guest accepts by interacting with them, they play, and
// the web API's coins change by the placement rewards.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";
import { SFSObjectWriter } from "../smartfox-server/src/sfs-wire.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const sfs = await startGameServer(api, KEY, { PARTY_GAME_TIME_SCALE: "0.01" });

class Client extends GameClient {
  constructor(swid: string, name: string) { super(api, sfs.port, swid, name); }
  move(id: number, column: number) {
    // As the client sends them: LONG, not INT.
    this.ext13("pgame.message", new SFSObjectWriter().putLong("id", BigInt(id)).putLong("type", 5n)
      .putUtfString("message", `{"PlayerId":${this.sid},"ScoreDelta":${column}}`));
  }
}

function coins(username: string): number {
  const db = new Database(api.dbPath);
  const row = db.query("SELECT coins FROM player_assets WHERE username = ?").get(username) as any;
  db.close();
  return row?.coins ?? -1;
}
const until = async (cond: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(20); return cond(); };

try {
  const O = new Client("{PG-OWNER}", "owner"), G = new Client("{PG-GUEST}", "guest"), S = new Client("{PG-SPEC}", "spectator");
  const all = [O, G, S];
  for (const c of all) await c.connect();
  check(all.every((c) => c.myId > 0), `all three logged in (${all.map((c) => c.myId)})`);
  await sleep(150);

  // ---- invitation held ----
  O.setCon("FindFourGroup");
  await sleep(100);
  for (const c of all) c.clear();
  await O.use("FindFourGroup");
  await sleep(200);
  for (const c of all) {
    const up = c.varsOf(O.myId);
    check(up.length === 1 && up[0]!.con === "consum:FindFourGroup" && up[0]!.con_prop === '{"actionCount":1}',
      `${c.name} sees the held invitation ${JSON.stringify(up)}`);
  }

  // ---- self-interact does nothing ----
  for (const c of all) c.clear();
  O.interactWith(O.sid);
  await sleep(200);
  // l.a itself is relayed to the room as usual.
  check(all.every((c) => c.updates.length === 0 && c.ext.every((e) => e.cmd === "l.a")), "owner interacting with themselves changes nothing");

  // ---- busy guest refused ----
  G.setCon("PizzaGroup");
  await sleep(100);
  await G.use("PizzaGroup");
  await sleep(150);
  for (const c of all) c.clear();
  G.interactWith(O.sid);
  await sleep(200);
  check(all.every((c) => c.extOf("pgame.start.v2").length === 0) && O.varsOf(O.myId).length === 0, "a guest with full hands can't join");
  G.setCon(null);
  await sleep(200);

  // ---- join starts the match ----
  for (const c of all) c.clear();
  G.interactWith(O.sid);
  await until(() => O.extOf("pgame.start.v2").length > 0, 4000);
  await sleep(100);
  const start = O.extOf("pgame.start.v2")[0];
  const id = start?.id?.value as number;
  check(!!start && G.extOf("pgame.start.v2").length === 1 && S.extOf("pgame.start.v2").length === 0, "both players get pgame.start.v2, spectator none");
  check(start?.players?.value === `{"Players":[{"TeamId":0,"UserSessionId":${O.sid},"RoleId":0},{"TeamId":0,"UserSessionId":${G.sid},"RoleId":0}]}`,
    `owner listed first: ${start?.players?.value}`);
  for (const c of all) {
    const ov = c.varsOf(O.myId);
    const cleared = ov.findIndex((v) => v.con === null && v.con_prop === null);
    const equipped = ov.findIndex((v) => v.con === "pgame:FindFourGameServerAdded");
    check(cleared >= 0 && equipped > cleared, `${c.name}: owner's invitation removed, then game prop (${JSON.stringify(ov)})`);
    // The SFS client applies variable values on arrival but dispatches the
    // change events once per frame: if the game prop lands in the same frame
    // as the removal, the removal event sees the new "con" and the client
    // throws, leaving the invitation open. They must arrive well apart.
    const all2 = c.updates.filter((x) => x.u === O.myId);
    const gap = cleared >= 0 && equipped > cleared ? all2[equipped]!.at - all2[cleared]!.at : -1;
    check(gap >= 500, `${c.name}: game prop arrives ${gap} ms after the invitation is removed (>= 500)`);
    check(c.varsOf(G.myId).some((v) => v.con === "pgame:FindFourGameServerAdded"), `${c.name}: guest holds the game prop`);
  }

  // ---- full match ----
  const oBefore = coins(O.username), gBefore = coins(G.username);
  await sleep(100); // intro
  for (const [i, col] of [0, 6, 1, 6, 2, 6, 3].entries()) {
    (i % 2 === 0 ? O : G).move(id, col);
    await sleep(60);
  }
  check(await until(() => O.extOf("pgame.end").length === 1 && G.extOf("pgame.end").length === 1), "both players get pgame.end");
  check(O.extOf("pgame.end")[0]?.results?.value === `[{"PlayerSessionId":${O.sid},"Placement":0},{"PlayerSessionId":${G.sid},"Placement":1}]`,
    `owner won: ${O.extOf("pgame.end")[0]?.results?.value}`);
  check(O.extOf("reward.add_delayed").length === 1 && G.extOf("reward.add_delayed").length === 1 && S.ext.every((e) => !e.cmd.startsWith("pgame.") && e.cmd !== "reward.add_delayed"),
    "each player gets reward.add_delayed; spectator nothing");
  await until(() => coins(O.username) === oBefore + 20, 2000);
  check(coins(O.username) === oBefore + 20 && coins(G.username) === gBefore + 10, `coins +20 / +10 (${oBefore}->${coins(O.username)}, ${gBefore}->${coins(G.username)})`);
  check(all.every((c) => c.varsOf(O.myId).at(-1)?.con === null && c.varsOf(G.myId).at(-1)?.con === null), "game props cleared for the room");

  // ---- quitting: the client puts the game prop away and waits for pgame.end ----
  O.setCon("FindFourGroup"); await sleep(100); await O.use("FindFourGroup"); await sleep(150);
  for (const c of all) c.clear();
  G.interactWith(O.sid);
  await until(() => O.extOf("pgame.start.v2").length > 0, 4000);
  const qid = O.extOf("pgame.start.v2")[0]?.id?.value as number;
  const oQuit = coins(O.username), gQuit = coins(G.username);
  G.setCon(null);
  check(await until(() => O.extOf("pgame.end").length === 1 && G.extOf("pgame.end").length === 1), `quit ends match ${qid} for both players`);
  check(G.extOf("pgame.end")[0]?.results?.value === `[{"PlayerSessionId":${O.sid},"Placement":0},{"PlayerSessionId":${G.sid},"Placement":1}]`,
    `quit results: ${G.extOf("pgame.end")[0]?.results?.value}`);
  await until(() => coins(O.username) === oQuit + 20, 2000);
  check(coins(O.username) === oQuit + 20 && coins(G.username) === gQuit, `stayer paid, quitter not (${oQuit}->${coins(O.username)}, ${gQuit}->${coins(G.username)})`);

  // ---- cancelling the invitation just as the guest joins: no game ----
  O.setCon("FindFourGroup"); await sleep(100); await O.use("FindFourGroup"); await sleep(150);
  for (const c of all) c.clear();
  G.interactWith(O.sid);
  await sleep(300);
  O.setCon(null);
  await sleep(2000 * 0.5 + 1500);
  check(all.every((c) => c.extOf("pgame.start.v2").length === 0), "owner cancelling during the handoff means no game starts");

  // ---- forfeit by disconnect ----
  O.setCon("FindFourGroup"); await sleep(100); await O.use("FindFourGroup"); await sleep(150);
  for (const c of all) c.clear();
  G.interactWith(O.sid);
  await until(() => O.extOf("pgame.start.v2").length > 0, 4000);
  const id2 = O.extOf("pgame.start.v2")[0]?.id?.value as number;
  check(id2 === id + 2, `third match started (${id2})`);
  const before2 = coins(O.username);
  G.sock.destroy();
  check(await until(() => O.extOf("pgame.end").length === 1), "owner's match ends when the guest disconnects");
  check(O.extOf("pgame.end")[0]?.results?.value === `[{"PlayerSessionId":${O.sid},"Placement":0}]`, `forfeit results: ${O.extOf("pgame.end")[0]?.results?.value}`);
  await until(() => coins(O.username) === before2 + 20, 2000);
  check(coins(O.username) === before2 + 20, `forfeit winner paid (${before2}->${coins(O.username)})`);

  // ---- server alive ----
  S.clear();
  S.ext13("time.get", new SFSObjectWriter());
  check(await until(() => S.ext.length > 0), "server still answers");
} catch (err) {
  check(false, `threw: ${(err as Error).stack}`);
} finally {
  sfs.stop();
  await api.stop();
}
finish(sfs.logs() + api.logs());
