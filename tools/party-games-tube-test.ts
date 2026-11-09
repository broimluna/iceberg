// Tube race session (smartfox-server/src/party-games/tube-race.ts), in
// process: layout message, server-timed results, modifier and finish checks,
// time cap, placements, rewards, leavers, locomotion.
process.env.PARTY_GAME_SCHEDULE = "off";
process.env.PARTY_GAME_TIME_SCALE = "0.05"; // red: 45 s max -> 2.25 s, cap 50 s -> 2.5 s
import { makeChecker } from "./lib/harness.ts";
import { makePlayer, type FakePlayer } from "./lib/party-fakes.ts";
import { SFSObjectWriter, decodeSFSObject } from "../smartfox-server/src/sfs-wire.ts";
import { unregister } from "../smartfox-server/src/session-registry.ts";

const { check, finish } = makeChecker();
const quiet = console.log;
console.log = (...a: unknown[]) => { if (!(typeof a[0] === "string" && a[0].startsWith("["))) quiet(...a); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(5); return cond(); };

const { startPartyGame, handlePartyGameMessage, onPartyGamePlayerLeft, onPartyGamePlayerMoved, setRewardGranter, sessionOf } = await import("../smartfox-server/src/party-games/manager.ts");
const { TubeRace } = await import("../smartfox-server/src/party-games/tube-race.ts");
const { tubeRaceLayouts, getPartyGame } = await import("../smartfox-server/src/party-games/definitions.ts");
const { pathReaches } = await import("../smartfox-server/src/party-games/tube-race-rules.ts");
type Vec3 = [number, number, number];

const grants: { username: string; reward: any }[] = [];
setRewardGranter((username, reward) => { grants.push({ username, reward }); });

const ROOM = "Alpine:en_US:MtBlizzard::1.15.1;offline;2026-11-08;NONE";
const INT = 2; // SFS2X VariableType INT
const LAYOUT = 10, COLLECT = 11, FINISHED = 12, RESULT = 13;
const red = getPartyGame(4)!.gameData as any;
const END: Vec3 = [red.RaceEndPosition.x, red.RaceEndPosition.y, red.RaceEndPosition.z];
const ctxOf = (p: FakePlayer) => ({ session: p.session, peer: p.session.userName, send: p.entry.send });
// The client's serialize() has no int overload: id and type arrive as LONG.
const msg = (id: number, type: number, message: string) =>
  decodeSFSObject(new SFSObjectWriter().putLong("id", BigInt(id)).putLong("type", BigInt(type)).putUtfString("message", message).encodeBody("sfs2x"), 0, "sfs2x").value;
const say = (game: { id: number }, p: FakePlayer, type: number, body: string) => handlePartyGameMessage(msg(game.id, type, body), ctxOf(p));
const collect = (game: { id: number }, p: FakePlayer, id: number) => say(game, p, COLLECT, `{"ModifierId":${id}}`);
const finished = (game: { id: number }, p: FakePlayer) => say(game, p, FINISHED, "{}");
const move = (p: FakePlayer, pos: Vec3) => { p.session.lastPosition = pos; onPartyGamePlayerMoved(p.session, pos); };

// pgame.message bodies as raw text (PlayerId must keep its 64-bit value).
const raw = (p: FakePlayer, type: number) => p.extOf("pgame.message").filter((m) => m.type!.value === type).map((m) => m.message!.value as string);
const parseIds = (text: string) => JSON.parse(text.replace(/"(PlayerId|PlayerSessionId)":(\d+)/g, '"$1":"$2"'));
const results = (p: FakePlayer) => raw(p, RESULT).map(parseIds);
const resultFor = (watcher: FakePlayer, racer: FakePlayer) => results(watcher).find((r) => r.PlayerId === racer.sid);
const endOf = (p: FakePlayer) => { const e = p.extOf("pgame.end")[0]; return e ? parseIds(e.results!.value as string) as { PlayerSessionId: string; Placement: number }[] : undefined; };
const placeOf = (p: FakePlayer, racer: FakePlayer) => endOf(p)?.find((r) => r.PlayerSessionId === racer.sid)?.Placement;
const locOf = (p: FakePlayer) => p.vars.filter((x) => x.u === p.session.userId && "loc" in x.vars).at(-1);
const paid = (p: FakePlayer) => grants.filter((g) => g.username === p.session.accountName);
const start = (players: FakePlayer[]) => startPartyGame(4, players.map((p) => p.entry))! as InstanceType<typeof TubeRace>;
const layoutOf = (p: FakePlayer) => JSON.parse(raw(p, LAYOUT)[0]!).ModifierLayoutId as number;

try {
  // ================= Race 1: A valid with one +25, B too fast, C never finishes =================
  const [A, B, C] = ["A", "B", "C"].map((n) => makePlayer(n, ROOM)) as FakePlayer[];
  const game = start([A!, B!, C!]);
  check(!!game && game instanceof TubeRace, "a red race starts");
  check([A, B, C].every((p) => locOf(p!)?.vars.loc === 7 && locOf(p!)?.types.loc === INT), "every racer gets loc Racing (7) as an int");
  check([A, B, C].every((p) => raw(p!, LAYOUT).length === 1), "every racer gets one layout message");
  const lid = layoutOf(A!);
  check(Number.isInteger(lid) && [0, 1, 2].includes(lid) && raw(A!, LAYOUT)[0] === `{"ModifierLayoutId":${lid}}`, `the layout message is {"ModifierLayoutId":<int>} (${raw(A!, LAYOUT)[0]})`);
  const layout = tubeRaceLayouts(4).get(lid)!;
  const plus = layout.find((m) => m.delta > 0)!;
  const path: Vec3[] = [[plus.pos[0], plus.pos[1] + 20, plus.pos[2]], plus.pos, END];
  const minus = layout.find((m) => m.delta < 0 && !pathReaches(path, m.pos, 3));

  // B finishes at once: under the minimum time.
  move(B!, END);
  finished(game, B!);
  check(resultFor(A!, B!)?.OverallScore === 0 && resultFor(A!, B!)?.ScoreModifier === 0, `a finish under the minimum time scores DefaultPoints (${JSON.stringify(resultFor(A!, B!))})`);

  // Junk never reaches past the game's checks (a throw would end the race).
  for (const body of ["null", '{"ModifierId":"3"}', '{"ModifierId":3.5}', "[]", '{"ModifierId":99999999999999999999}']) say(game, A!, COLLECT, body);
  check(!A!.extOf("pgame.end").length && sessionOf(A!.session) === game, "junk modifier claims don't end the race");

  move(A!, path[0]!);
  await sleep(300);
  move(A!, plus.pos);
  collect(game, A!, plus.id); collect(game, A!, plus.id); collect(game, A!, 9999);
  if (minus) collect(game, A!, minus.id);
  await sleep(200);
  move(A!, END);
  finished(game, A!);
  finished(game, A!);
  const ra = resultFor(B!, A!);
  check(!!ra && results(B!).filter((r) => r.PlayerId === A!.sid).length === 1, "each racer gets exactly one result for A (finishing twice counts once)");
  check(ra?.ScoreModifier === 25, `only the reached +25 counts (duplicate, unknown${minus ? ", unreached -25" : ""} ignored) (${ra?.ScoreModifier})`);
  check(Number.isInteger(ra?.CompletionTimeInMilliseconds) && ra.CompletionTimeInMilliseconds >= 1000 && ra.CompletionTimeInMilliseconds <= 45_000,
    `A's time is server-measured, scaled back, an integer (${ra?.CompletionTimeInMilliseconds})`);
  check(ra?.OverallScore === 400 - Math.floor(ra.CompletionTimeInMilliseconds * 10 / 1000) + 25, `A's score is 400 - 10/s + 25 (${ra?.OverallScore})`);
  check(raw(C!, RESULT).some((t) => t.includes(`"PlayerId":${A!.sid},`)), "PlayerId is sent as the full 64-bit session id");

  // C never finishes: the cap gives C a DefaultPoints result, then pgame.end.
  check(await until(() => !!endOf(A!), 6000), "the race ends at the time cap");
  check(resultFor(A!, C!)?.OverallScore === 0 && resultFor(A!, C!)?.CompletionTimeInMilliseconds === 45_000 && resultFor(C!, C!) !== undefined,
    `an unfinished racer gets a DefaultPoints result at the cap (${JSON.stringify(resultFor(A!, C!))})`);
  check(placeOf(A!, A!) === 0 && placeOf(A!, B!) === 1 && placeOf(A!, C!) === 2, `placements: A 0, B 1, C 2 (${JSON.stringify(endOf(A!))})`);
  check(paid(A!).length === 1 && paid(A!)[0]!.reward.coins === 15 && paid(B!).length === 0 && paid(C!).length === 0, "only the valid finisher is paid (15 coins)");
  check(await until(() => locOf(A!)?.vars.loc === 0 && locOf(C!)?.vars.loc === 0, 2000), "loc goes back to 0 after the end");

  // ================= Race 2: everyone finishes: ends before the cap =================
  const [D, E] = ["D", "E"].map((n) => makePlayer(n, ROOM)) as FakePlayer[];
  const g2 = start([D!, E!]);
  await sleep(200);
  move(D!, END); move(E!, END);
  finished(g2, D!); finished(g2, E!);
  const t0 = Date.now();
  check(await until(() => !!endOf(D!), 1500) && Date.now() - t0 < 1000, `with everyone finished, pgame.end follows the rewards delay (${Date.now() - t0} ms)`);
  check(paid(D!).length === 1 && paid(E!).length === 1, "both valid finishers are paid");

  // ================= Race 3: solo =================
  const F = makePlayer("F", ROOM);
  const g3 = start([F]);
  await sleep(200);
  move(F, END); finished(g3, F);
  check(await until(() => !!endOf(F), 1500) && placeOf(F, F) === 2 && paid(F)[0]?.reward.coins === 5, `a solo racer gets placement 2 and 5 coins (${placeOf(F, F)})`);

  // ================= Race 4: a racer who never moved =================
  const [G, H] = ["G", "H"].map((n) => makePlayer(n, ROOM)) as FakePlayer[];
  G!.session.lastPosition = undefined;
  const g4 = start([G!, H!]);
  await sleep(200);
  finished(g4, G!);
  move(H!, END); finished(g4, H!);
  check(await until(() => !!endOf(H!), 1500), "race 4 ends");
  check(resultFor(H!, G!)?.OverallScore === 0 && paid(G!).length === 0 && placeOf(H!, G!) === 1, "a finish with no known position scores DefaultPoints, unpaid");

  // ================= Race 5: a finisher leaves before the end =================
  const [I, J] = ["I", "J"].map((n) => makePlayer(n, ROOM)) as FakePlayer[];
  const g5 = start([I!, J!]);
  const t5 = Date.now();
  await sleep(200);
  move(I!, END); finished(g5, I!);
  unregister(I!.session); onPartyGamePlayerLeft(I!.session);
  check(await until(() => !!endOf(J!), 6000) && Date.now() - t5 < 2500 + 1000, `the race still ends by the cap (${Date.now() - t5} ms)`);
  check(endOf(J!)!.length === 1 && placeOf(J!, J!) !== undefined && placeOf(J!, I!) === undefined, `the leaver is out of the placements (${JSON.stringify(endOf(J!))})`);
  check(I!.extOf("pgame.end").length === 0 && paid(I!).length === 0, "the leaver gets nothing");

  // ================= Race 6: everyone leaves =================
  const [K, L] = ["K", "L"].map((n) => makePlayer(n, ROOM)) as FakePlayer[];
  start([K!, L!]);
  for (const p of [K!, L!]) { unregister(p.session); onPartyGamePlayerLeft(p.session); }
  await sleep(100);
  check(!sessionOf(K!.session) && !sessionOf(L!.session) && K!.extOf("pgame.end").length === 0, "a race everyone left is over, with no results sent");
} catch (err) {
  check(false, `threw: ${(err as Error).stack}`);
}
finish();
