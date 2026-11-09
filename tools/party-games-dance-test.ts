// Dance Battle session (smartfox-server/src/party-games/dance-battle.ts), in
// process: a 2 v 2 match with a spectator in the room. Team 0 plays every
// round perfectly, team 1 plays everything wrong.
process.env.PARTY_GAME_SCHEDULE = "off";
process.env.PARTY_GAME_TIME_SCALE = "0.05";
import { makeChecker } from "./lib/harness.ts";
import { makePlayer, decodeItemTuple, decodeItemVars, type FakePlayer } from "./lib/party-fakes.ts";
import { SFSObjectWriter, decodeSFSObject, type SFSValue } from "../smartfox-server/src/sfs-wire.ts";
import { unregister } from "../smartfox-server/src/session-registry.ts";

const { check, finish } = makeChecker();
const quiet = console.log;
console.log = (...a: unknown[]) => { if (!(typeof a[0] === "string" && a[0].startsWith("["))) quiet(...a); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(5); return cond(); };

const { startPartyGame, handlePartyGameMessage, onPartyGamePlayerLeft, setRewardGranter, sessionOf } = await import("../smartfox-server/src/party-games/manager.ts");
const { DanceBattle } = await import("../smartfox-server/src/party-games/dance-battle.ts");

const grants: { username: string; reward: any }[] = [];
setRewardGranter((username, reward) => { grants.push({ username, reward }); });

const ROOM = "Alpine:en_US:Town::1.15.1;offline;2026-11-08;NONE";
const ctxOf = (p: FakePlayer) => ({ session: p.session, peer: p.session.userName, send: p.entry.send });
// The client's serialize() has no int overload: id and type arrive as LONG.
const msg = (id: number, type: number, message: string) =>
  decodeSFSObject(new SFSObjectWriter().putLong("id", BigInt(id)).putLong("type", BigInt(type)).putUtfString("message", message).encodeBody("sfs2x"), 0, "sfs2x").value;
const SHOW_TURN_OUTPUT = 5;
const send = (game: { id: number }, p: FakePlayer, move: number | string) =>
  handlePartyGameMessage(msg(game.id, SHOW_TURN_OUTPUT, `{"PlayerId":${p.sid},"ScoreDelta":${move}}`), ctxOf(p));

// Session ids exceed 2^53: read them as strings.
const parseIds = (text: string) => JSON.parse(text.replace(/"(PlayerSessionId|UserSessionId)":(\d+)/g, '"$1":"$2"'));

// The latest value of a game-item variable as the spectator saw it.
const itemVar = (watcher: FakePlayer, name: string): any => {
  let value: unknown;
  for (const m of watcher.mmo) {
    if (m.a === 30 && m.p.q) value = decodeItemTuple((m.p.q.value as SFSValue[])[0]!).vars[name] ?? value;
    if (m.a === 1007 && m.p.v) { const v = decodeItemVars(m.p.v.value as SFSValue[]); if (name in v) value = v[name]; }
  }
  return typeof value === "string" ? parseIds(value) : value;
};
const itemAdded = (w: FakePlayer) => w.mmo.find((m) => m.a === 30 && m.p.q);
const heldOf = (p: FakePlayer, observer: FakePlayer = p) => observer.vars.filter((x) => x.u === p.session.userId && "con" in x.vars).at(-1)?.vars.con;
const locOf = (p: FakePlayer) => p.vars.filter((x) => x.u === p.session.userId && "loc" in x.vars).at(-1)?.vars.loc;

const mk = (prefix: string) => ({
  a1: makePlayer(prefix + "a1", ROOM), a2: makePlayer(prefix + "a2", ROOM), b1: makePlayer(prefix + "b1", ROOM), b2: makePlayer(prefix + "b2", ROOM), s: makePlayer(prefix + "s", ROOM),
});
const slots = [{ teamId: 0, roleId: 0 }, { teamId: 0, roleId: 1 }, { teamId: 1, roleId: 0 }, { teamId: 1, roleId: 1 }];
const startMatch = (g: ReturnType<typeof mk>) => startPartyGame(3, [g.a1, g.a2, g.b1, g.b2].map((p) => p.entry), slots)! as InstanceType<typeof DanceBattle>;

try {
  // ================= Match 1: A perfect, B all wrong =================
  const g = mk("m1");
  const game = startMatch(g);
  check(!!game && game instanceof DanceBattle, "a 2 v 2 Dance Battle starts");
  check(g.a1.extOf("pgame.start.v2").length === 1 && g.s.extOf("pgame.start.v2").length === 0, "players get pgame.start.v2, the spectator doesn't");
  check([g.a1, g.b2].every((p) => heldOf(p, g.s) === "pgame:DanceBattleGameServerAdded" && locOf(p) === 2), "players hold the game prop and are locked in the dance pose");
  await until(() => !!itemAdded(g.s));
  const tuple = decodeItemTuple((itemAdded(g.s)!.p.q!.value as SFSValue[])[0]!);
  check(tuple.vars.category === 7 && tuple.vars.int_a === 3 && tuple.position.join() === "16,0.5,-10", `the spectator sees the game item (${JSON.stringify(tuple)})`);

  const sets = [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12, 13, 14, 15], [11, 12, 13, 14, 15]];
  const lengths = [3, 5, 6, 7];
  let lastRoundChecked = -1;
  for (let round = 0; round < 4; round++) {
    await until(() => itemVar(g.s, "turn")?.RoundNum === round && game.phase === "display");
    const turn = itemVar(g.s, "turn");
    check(turn.RoundNum === round && turn.Moves.length === lengths[round] && turn.Moves.every((m: number) => m >= 1 && m <= 3), `round ${round}: ${lengths[round]} moves from 1-3 (${turn.Moves})`);
    if (round === 0) {
      send(game, g.a1, turn.Moves[0]); // too early: still showing the sequence
    }
    await until(() => game.phase === "input");
    if (round === 0) {
      send(game, g.a1, 0); send(game, g.a1, 99); send(game, g.a1, "abc"); send(game, g.a1, 2.5);
      handlePartyGameMessage(msg(game.id, SHOW_TURN_OUTPUT, "not json"), ctxOf(g.a1));
      handlePartyGameMessage(msg(game.id, SHOW_TURN_OUTPUT, `{"ScoreDelta":1}`), ctxOf(g.s)); // a spectator
      handlePartyGameMessage(msg(game.id, 9, "{}"), ctxOf(g.a1)); // DanceMoveSequenceComplete: nothing to do
    }
    for (let i = 0; i < turn.Moves.length; i++) {
      send(game, g.a1, turn.Moves[i]); send(game, g.a2, turn.Moves[i]);
      send(game, g.b1, (turn.Moves[i] % 3) + 1); // wrong; b2 sends nothing at all
    }
    send(game, g.a1, 1); // one more than the sequence: ignored
    await until(() => itemVar(g.s, "dancemoves")?.StartTimeInSeconds !== undefined && game.phase === "perform" && (itemVar(g.s, "dancemoves").PlayerMoveDatas?.length ?? 0) > 0 && lastRoundChecked < round);
    const dm = itemVar(g.s, "dancemoves");
    const byPlayer = (p: FakePlayer) => dm.PlayerMoveDatas.find((d: any) => String(d.PlayerSessionId) === p.sid)?.DanceMoveIds;
    const emote = (m: number) => sets[round]![m - 1];
    check(byPlayer(g.a1)?.join() === turn.Moves.map(emote).join(), `round ${round}: a perfect player dances the round's moves (${byPlayer(g.a1)})`);
    check(byPlayer(g.b1)?.join() === turn.Moves.map(() => 19).join() && byPlayer(g.b2)?.join() === turn.Moves.map(() => 19).join(), `round ${round}: wrong and missing moves play the failure move`);
    check(Math.abs(dm.StartTimeInSeconds - Date.now() / 1000) < 2, "dance moves are stamped with the current time");
    lastRoundChecked = round;
    await until(() => itemVar(g.s, "score")?.Team1Score === round + 1);
    const score = itemVar(g.s, "score");
    check(score.Team1Score === round + 1 && score.Team2Score === 0, `round ${round}: scores are team means summed (${score.Team1Score}, ${score.Team2Score})`);
  }

  await until(() => g.a1.extOf("pgame.end").length > 0);
  const end = parseIds(g.a1.extOf("pgame.end")[0]!.results!.value as string);
  const placeOf = (p: FakePlayer) => end.find((e: any) => String(e.PlayerSessionId) === p.sid)?.Placement;
  check([g.a1, g.a2].every((p) => placeOf(p) === 0) && [g.b1, g.b2].every((p) => placeOf(p) === 1), `team A first, team B second (${JSON.stringify(end)})`);
  check(g.s.extOf("pgame.end").length === 0, "the spectator doesn't get pgame.end");
  const paid = (name: string) => grants.find((x) => x.username === name)?.reward;
  check(paid("m1a1")?.coins === 20 && paid("m1a2")?.coins === 20 && paid("m1b1")?.coins === 10 && paid("m1b2")?.coins === 10 && grants.length === 4,
    `winners get the first-place reward, losers the second (${JSON.stringify(grants)})`);
  await until(() => !!g.s.mmo.find((m) => m.a === 30 && m.p.n));
  check(!!g.s.mmo.find((m) => m.a === 30 && m.p.n), "the game item is removed after the end");
  await until(() => locOf(g.a1) === 0);
  check([g.a1, g.b2].every((p) => locOf(p) === 0 && heldOf(p, g.s) === null), "players are released: prop gone, locomotion back to normal");
  check(!sessionOf(g.a1.session), "players are free for the next game");
  for (const p of Object.values(g)) unregister(p.session);

  // ================= Match 2: nobody plays =================
  const before = grants.length;
  const h = mk("m2");
  const afk = startMatch(h);
  await until(() => h.a1.extOf("pgame.end").length > 0, 15000);
  const endAfk = parseIds(h.a1.extOf("pgame.end")[0]!.results!.value as string);
  check(endAfk.length === 4 && endAfk.every((e: any) => e.Placement === 0), "an AFK match ends in a tie");
  check(grants.length === before, "and pays nobody");
  const sc = itemVar(h.s, "score");
  check(sc.Team1Score === 0 && sc.Team2Score === 0, "with zero scores");
  await sleep(300);
  for (const p of Object.values(h)) unregister(p.session);

  // ================= Match 3: a team empties =================
  const before3 = grants.length;
  const k = mk("m3");
  const gm = startMatch(k);
  await until(() => gm.phase === "display");
  unregister(k.b1.session); onPartyGamePlayerLeft(k.b1.session);
  check(gm.ended === false, "one player leaving doesn't end the game");
  unregister(k.b2.session); onPartyGamePlayerLeft(k.b2.session);
  await until(() => k.a1.extOf("pgame.end").length > 0);
  const end3 = parseIds(k.a1.extOf("pgame.end")[0]!.results!.value as string);
  check(end3.length === 2 && end3.every((e: any) => e.Placement === 0), `when a team empties the other team wins and only they are listed (${JSON.stringify(end3)})`);
  check(grants.length === before3 + 2, "the remaining team is paid");
  await sleep(300);
} catch (err) {
  check(false, `threw: ${(err as Error).stack}`);
}
finish();
