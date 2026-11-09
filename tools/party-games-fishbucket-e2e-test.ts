// Fish Bucket end to end: a real web API and game server, three fake clients.
// The owner holds out FishBucketGroup, guests join, the owner presses Start
// (LaunchThrow), the owner's client sends the start positions, then every client
// draws (l.a 4) and passes (l.a 7) by the rules until the deck runs out. The
// scores are recomputed from the broadcast cards and must match the placements
// and the coins in the web API.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";
import { SFSObjectWriter } from "../smartfox-server/src/sfs-wire.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const sfs = await startGameServer(api, KEY, { PARTY_GAME_TIME_SCALE: "0.02" });
const REWARD_COINS = [25, 15, 10, 5];

// Retail buttons (locomotion actions): lobby Start and Fish = Action1 (l.a 7), Pass = Action2 (l.a 8).
const START = 7, FISH = 7, PASS = 8;

class Client extends GameClient {
  constructor(swid: string, name: string) { super(api, sfs.port, swid, name); }
  act(action: number) { this.action(action); }
  pgame(id: number, type: number, body: string) {
    this.ext13("pgame.message", new SFSObjectWriter().putLong("id", BigInt(id)).putLong("type", BigInt(type)).putUtfString("message", body));
  }
  // Raw bodies (session ids exceed 2^53).
  raws(type: number) { return this.extOf("pgame.message").filter((p) => p.type!.value === type).map((p) => p.message!.value as string); }
}
function coins(username: string): number {
  const db = new Database(api.dbPath);
  const row = db.query("SELECT coins FROM player_assets WHERE username = ?").get(username) as any;
  db.close();
  return row?.coins ?? -1;
}
const until = async (cond: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(20); return cond(); };
const v = (x: number) => ({ x, y: 0, z: 2 });

// One game: owner first, then guests; `drop` disconnects that guest once the game is running.
async function run(label: string, clients: Client[], drop?: Client) {
  const [O, ...guests] = clients;
  for (const c of clients) c.clear();
  O!.setCon("FishBucketGroup"); await sleep(100); await O!.use("FishBucketGroup"); await sleep(200);
  for (const g of guests) { g.interactWith(O!.sid); await sleep(150); }
  O!.act(START);
  check(await until(() => clients.every((c) => c.extOf("pgame.start.v2").length === 1), 5000), `${label}: everyone gets pgame.start.v2`);
  const id = O!.extOf("pgame.start.v2")[0]!.id!.value as number;
  const before = new Map(clients.map((c) => [c, coins(c.username)]));
  O!.pgame(id, 4, JSON.stringify({ OwnerPosition: v(1), PlayerPositions: guests.map((_, i) => v(2 + i)), GamePositions: [v(0)] }));
  check(await until(() => clients.every((c) => c.raws(4).length === 1)), `${label}: positions relayed to everyone`);
  const total = JSON.parse(O!.raws(4)[0]!).IntData[0] as number;
  check(await until(() => clients.every((c) => c.raws(6).length > 0)), `${label}: first turn started`);
  const alive = new Set(clients);
  const seenTurns = new Map<Client, number>(), seenOutputs = new Map<Client, number>();
  let dropped = false;
  const deadline = Date.now() + 40000;
  while (O!.extOf("pgame.end").length === 0 && Date.now() < deadline) {
    for (const c of alive) {
      const turns = c.raws(6), outs = c.raws(5);
      if (turns.length > (seenTurns.get(c) ?? 0)) {
        seenTurns.set(c, turns.length);
        if (turns.at(-1) === `{"PlayerId":${c.sid}}`) c.act(FISH);
      }
      if (outs.length > (seenOutputs.get(c) ?? 0)) {
        seenOutputs.set(c, outs.length);
        const last = JSON.parse(outs.at(-1)!.replace(/"PlayerId":(\d+)/, '"PlayerId":"$1"'));
        if (last.PlayerId === c.sid && last.ScoreDelta > 0) setTimeout(() => { if (alive.has(c)) c.act(PASS); }, 120);
      }
    }
    if (drop && !dropped && O!.raws(5).length >= 2) { dropped = true; drop.sock.destroy(); alive.delete(drop); }
    await sleep(10);
  }
  const live = clients.filter((c) => c !== drop || !dropped);
  check(await until(() => live.every((c) => c.extOf("pgame.end").length === 1), 3000), `${label}: everyone still connected gets pgame.end`);
  const results = JSON.parse((O!.extOf("pgame.end")[0]!.results!.value as string).replace(/"PlayerSessionId":(\d+)/g, '"PlayerSessionId":"$1"')) as { PlayerSessionId: string; Placement: number }[];
  const players = drop ? clients.length - 1 : clients.length;
  check(results.length === players, `${label}: ${players} results (${results.length})`);
  // Scores from the broadcast cards (the clamp at 0 is the client's own rule).
  const scores = new Map<string, number>(clients.map((c) => [c.sid, 0]));
  let cards = 0;
  for (const raw of O!.raws(5)) {
    const m = JSON.parse(raw.replace(/"PlayerId":(\d+)/, '"PlayerId":"$1"')) as { PlayerId: string; ScoreDelta: number };
    scores.set(m.PlayerId, Math.max((scores.get(m.PlayerId) ?? 0) + m.ScoreDelta, 0));
    cards++;
  }
  if (!drop) check(cards === total, `${label}: every card dealt once (${cards}/${total})`);
  const rank = (sid: string) => [...new Set(results.map((r) => scores.get(r.PlayerSessionId)!))].sort((a, b) => b - a).indexOf(scores.get(sid)!);
  check(results.every((r) => r.Placement === rank(r.PlayerSessionId)), `${label}: placements follow the scores ${JSON.stringify([...scores])} -> ${JSON.stringify(results)}`);
  await sleep(500);
  for (const r of results) {
    const c = clients.find((x) => x.sid === r.PlayerSessionId)!;
    check(coins(c.username) === before.get(c)! + REWARD_COINS[r.Placement]!, `${label}: ${c.name} paid ${REWARD_COINS[r.Placement]} (${before.get(c)} -> ${coins(c.username)})`);
  }
  check(await until(() => live.every((c) => c.varsOf(c.myId).at(-1)?.con === null)), `${label}: bucket props cleared`);
}

try {
  const O = new Client("{FBE-OWNER}", "fbowner"), A = new Client("{FBE-A}", "fbguesta"), B = new Client("{FBE-B}", "fbguestb");
  for (const c of [O, A, B]) await c.connect();
  check([O, A, B].every((c) => c.myId > 0), "all logged in");
  await sleep(150);
  await run("3 players", [O, A, B]);
  await run("2 players", [O, A]);
  await run("3 players, a guest disconnects", [O, A, B], B);
  O.clear();
  O.ext13("time.get", new SFSObjectWriter());
  check(await until(() => O.ext.length > 0), "server still answers");
} catch (err) {
  check(false, `threw: ${(err as Error).stack}`);
} finally {
  sfs.stop();
  await api.stop();
}
finish(sfs.logs() + api.logs());
