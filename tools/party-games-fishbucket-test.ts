// Fish Bucket (smartfox-server/src/party-games/fish-bucket.ts), driven
// in-process through the manager with fake players and a fast clock.
process.env.PARTY_GAME_TIME_SCALE ??= "0.01";
import { makeChecker } from "./lib/harness.ts";
import { makePlayer, type FakePlayer } from "./lib/party-fakes.ts";
import { SFSObjectWriter, decodeSFSObject } from "../smartfox-server/src/sfs-wire.ts";
const { startPartyGame, handlePartyGameMessage, onPartyGamePlayerLeft, onPartyGamePlayerQuit, onPartyGameAction, setRewardGranter, sessionOf } =
  await import("../smartfox-server/src/party-games/manager.ts");
const { FishBucket } = await import("../smartfox-server/src/party-games/fish-bucket.ts");

const { check, finish } = makeChecker();
const quiet = console.log;
const logLines: string[] = [];
console.log = (...a: unknown[]) => {
  if (typeof a[0] === "string" && a[0].startsWith("[")) { logLines.push(a[0]); return; }
  quiet(...a);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const grants: { username: string; reward: any }[] = [];
setRewardGranter((username, reward) => { grants.push({ username, reward }); });

// Scaled (0.01): intro 50 ms, fish delay 30 ms, squid delay 50 ms, turn 100 ms + 20 ms grace, positions backstop 100 ms.
const ROOM = "Alpine:Town:en";
// Retail buttons: Fish = Action1 (l.a 7), Pass = Action2 (l.a 8).
const FISH = 7, PASS = 8;
let n = 0;

async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(2); }
  return cond();
}
// Raw message bodies of one type (session ids exceed 2^53, so JSON.parse can't tell players apart).
const raws = (p: FakePlayer, type: number) => p.extOf("pgame.message").filter((m) => m.type!.value === type).map((m) => m.message!.value as string);
const states = (p: FakePlayer) => raws(p, 1).map((r) => JSON.parse(r).GameStateId as number);
const turns = (p: FakePlayer) => raws(p, 6);
const outputs = (p: FakePlayer) => raws(p, 5);
const turnOf = (p: FakePlayer) => `{"PlayerId":${p.sid}}`;
const results = (p: FakePlayer) => p.extOf("pgame.end").map((e) => e.results!.value as string);
const resultsOf = (pairs: [FakePlayer, number][]) => `[${pairs.map(([p, pl]) => `{"PlayerSessionId":${p.sid},"Placement":${pl}}`).join(",")}]`;
const act = (p: FakePlayer, action: number) => onPartyGameAction(p.session, action, [0, 0, 0]);
const coins = (p: FakePlayer) => grants.filter((g) => g.username === p.session.accountName).map((g) => g.reward.coins);
const v = (x: number) => ({ x, y: 0, z: 2 });
function send(p: FakePlayer, type: number, body: unknown) {
  const id = sessionOf(p.session)!.id;
  const w = new SFSObjectWriter().putLong("id", BigInt(id)).putLong("type", BigInt(type)).putUtfString("message", JSON.stringify(body));
  handlePartyGameMessage(decodeSFSObject(w.encodeBody("sfs2x"), 0, "sfs2x").value, { session: p.session, peer: p.session.userName, send: p.entry.send });
}
const validPositions = (players: number) => ({ OwnerPosition: v(1), PlayerPositions: Array.from({ length: players - 1 }, (_, i) => v(2 + i)), GamePositions: [v(0)] });

// A game with `count` players and a fixed deck, past the positions, in the Game state with players[0] to move.
async function game(count: number, deck: number[], untilTurn = true) {
  FishBucket.makeDeck = () => deck.slice();
  const ps = Array.from({ length: count }, (_, i) => makePlayer(`fb${++n}_${i}`, ROOM));
  startPartyGame(1, ps.map((p) => p.entry));
  send(ps[0]!, 4, validPositions(count));
  if (untilTurn) await waitFor(() => turns(ps[0]!).length > 0);
  return ps;
}

try {
  // ---- start and positions ----
  {
    FishBucket.makeDeck = () => [1, 1, 1, 1];
    const [o, g, h] = [makePlayer(`o${++n}`, ROOM), makePlayer(`g${n}`, ROOM), makePlayer(`h${n}`, ROOM)];
    startPartyGame(1, [o.entry, g.entry, h.entry]);
    check(o.extOf("pgame.start.v2").length === 1 && !!sessionOf(o.session), "the game started");
    check(o.extOf("pgame.message").length === 0, "the server sends no state at start (the client enters AwaitingPositions itself)");
    send(g, 4, validPositions(3));
    send(o, 4, { ...validPositions(3), PlayerPositions: [v(2)] });
    send(o, 4, { ...validPositions(3), PlayerPositions: [v(2), { x: "a", y: 0, z: 0 }] });
    send(o, 4, { ...validPositions(3), GamePositions: [] });
    send(o, 4, "positions");
    check(g.extOf("pgame.message").length === 0, "positions from a non-owner, wrong lengths, non-numbers, or nothing are not relayed");
    send(o, 4, { ...validPositions(3), Extra: "x" });
    const want = '{"OwnerPosition":{"x":1,"y":0,"z":2},"PlayerPositions":[{"x":2,"y":0,"z":2},{"x":3,"y":0,"z":2}],"GamePositions":[{"x":0,"y":0,"z":2}],"IntData":[4]}';
    check(raws(g, 4).join() === want && raws(h, 4).join() === want && raws(o, 4).join() === want, `positions relayed to everyone with IntData = deck size: ${raws(g, 4)}`);
    send(o, 4, validPositions(3));
    check(raws(g, 4).length === 1, "a second positions message is ignored");
    check(states(o).join() === "1" , `Intro (1) right after the relay: ${states(o)}`);
    check(await waitFor(() => states(o).includes(2)), "Game (2) after the intro");
    check(turns(o).join() === turnOf(o) && turns(g).join() === turnOf(o), `PlayerTurnStart for the owner: ${turns(g)}`);
    check(o.extOf("pgame.message").every((m) => (m.type!.value as number) !== 1 || JSON.parse(m.message!.value as string).GameStateId !== 0), "state 0 is never sent");
    check(sessionOf(o.session) !== undefined, "still running");
  }
  {
    FishBucket.makeDeck = () => [1];
    const [o, g] = [makePlayer(`o${++n}`, ROOM), makePlayer(`g${n}`, ROOM)];
    startPartyGame(1, [o.entry, g.entry]);
    check(await waitFor(() => results(o).length === 1, 400), "no positions in 10 s ends the game with no results");
    check(results(o)[0] === "[]", `empty results: ${results(o)[0]}`);
  }

  // ---- turns ----
  {
    const [a, b] = await game(2, [1, 2, -2, 1, 1, 1, 1, 1]);
    check(turns(b).join() === turnOf(a), "a starts");
    act(b, FISH); act(a, 0); act(a, 3); act(a, 4); act(a, 10); act(a, 9);
    check(outputs(a).length === 0, "Fish by the wrong player, Move, ChargeThrow, LaunchThrow, CancelThrow, Action3: nothing");
    act(a, PASS);
    check(turns(a).length === 1, "Pass before any draw is ignored");
    act(a, FISH); act(a, FISH);
    check(outputs(a).join() === `{"PlayerId":${a.sid},"ScoreDelta":1}` && outputs(b).join() === outputs(a).join(), `one draw per press, announced to both: ${outputs(a)}`);
    act(a, PASS);
    check(turns(a).length === 1, "Pass during the post-draw delay is ignored");
    await sleep(60);
    act(a, FISH);
    check(outputs(a).length === 2 && outputs(a)[1] === `{"PlayerId":${a.sid},"ScoreDelta":2}`, `Fish again after a fish card draws again; deck order kept: ${outputs(a)}`);
    await sleep(60);
    act(a, PASS);
    check(turns(a).join() === [turnOf(a), turnOf(b)].join(), `Pass hands over immediately: ${turns(a)}`);
    act(b, FISH);
    check(outputs(a)[2] === `{"PlayerId":${b.sid},"ScoreDelta":-2}`, "squid drawn");
    act(b, FISH); act(b, PASS); act(a, FISH);
    check(outputs(a).length === 3 && turns(a).length === 2, "actions during the squid delay are ignored, the turn hasn't moved");
    check(await waitFor(() => turns(a).length === 3), "the turn moves on after the squid delay");
    check(turns(a)[2] === turnOf(a), "wraps around to a");
  }
  {
    const [a, b] = await game(2, [1, 1, 1, 1]);
    check(await waitFor(() => turns(a).length === 2, 800), "an idle turn ends after TurnTime + grace");
    check(outputs(a).join() === `{"PlayerId":${a.sid},"ScoreDelta":1}` && turns(a)[1] === turnOf(b), `...after one automatic draw (so a game can't hang): ${outputs(a)}`);
  }
  {
    const [a, b] = await game(2, [1, 1]);
    check(await waitFor(() => results(a).length === 1, 4000), "a game where nobody presses anything still ends");
    check(results(a)[0] === resultsOf([[a, 0], [b, 0]]), `...as a tie: ${results(a)[0]}`);
  }
  {
    logLines.length = 0;
    const [a, b] = await game(2, [1, 1, 1, 1]);
    send(b, 9, { Hello: 1 });
    check(logLines.some((l) => l.includes("[FISH]") && l.includes("message type=9")), "a pgame.message the game doesn't handle is logged (to learn what the client sends)");
    send(a, 5, { PlayerId: 1, ScoreDelta: 3 });
    check(outputs(a).length === 0, "a client-sent ShowTurnOutput draws nothing");
  }
  {
    FishBucket.makeDeck = () => [1];
    const [o, g] = [makePlayer(`o${++n}`, ROOM), makePlayer(`g${n}`, ROOM)];
    o.session.lastPosition = [0, 0, 0];
    startPartyGame(1, [o.entry, g.entry]);
    send(o, 4, { OwnerPosition: v(1), PlayerPositions: [v(2)], GamePositions: [{ x: 500, y: 0, z: 2 }] });
    send(o, 4, { OwnerPosition: v(1), PlayerPositions: [{ x: 1e30, y: 0, z: 0 }], GamePositions: [v(0)] });
    check(g.extOf("pgame.message").length === 0, "start positions far from the owner are not relayed");
    send(o, 4, validPositions(2));
    check(raws(g, 4).length === 1, "positions near the owner are");
  }

  // ---- ending ----
  {
    const [a, b] = await game(2, [3, -2]);
    act(a, FISH); await sleep(60); act(a, PASS); act(b, FISH);
    check(await waitFor(() => states(a).includes(3)), "Finished (3) after the last card's delay");
    check(results(a).length === 0, "the result follows the Finished state");
    check(await waitFor(() => results(a).length === 1), "pgame.end");
    check(results(a)[0] === resultsOf([[a, 0], [b, 1]]) && results(b)[0] === results(a)[0], `highest score first, clamped at 0: ${results(a)[0]}`);
    check(coins(a).join() === "25" && coins(b).join() === "15", "placement rewards 25 / 15");
    check(sessionOf(a.session) === undefined, "players freed");
  }
  {
    const [a, b] = await game(2, [1]);
    act(a, FISH);
    check(await waitFor(() => results(a).length === 1), "a fish as the last card also ends the game");
    check(results(a)[0] === resultsOf([[a, 0], [b, 1]]), `winner and loser: ${results(a)[0]}`);
  }
  {
    const [a, b] = await game(2, [1, 1]);
    act(a, FISH); await sleep(60); act(a, PASS); act(b, FISH);
    check(await waitFor(() => results(a).length === 1), "tied game ends");
    check(results(a)[0] === resultsOf([[a, 0], [b, 0]]) && coins(a).includes(25) && coins(b).includes(25), `a tie shares placement 0: ${results(a)[0]}`);
  }

  // ---- quitting and disconnecting ----
  {
    const [a, b] = await game(2, [1, 1, 1, 1]);
    onPartyGamePlayerQuit(b.session);
    check(raws(a, 7).join() === `{"PlayerId":${b.sid}}`, `PlayerLeftGame to the stayer: ${raws(a, 7)}`);
    check(results(a)[0] === resultsOf([[a, 0], [b, 1]]), `the stayer wins, the quitter is listed: ${results(a)[0]}`);
    await sleep(20);
    check(coins(b).length === 0 && coins(a).length > 0, `the quitter is unpaid: a=${coins(a)} b=${coins(b)}`);
  }
  {
    // Quit during the 1 s outro, after the deck ran out: the final standings are already decided, so it is still paid.
    const [a, b] = await game(2, [1]);
    act(a, FISH);
    check(await waitFor(() => states(a).includes(3)), "outro reached");
    onPartyGamePlayerQuit(b.session);
    check(await waitFor(() => results(a).length === 1), "the outro quit ends the game");
    check(results(a)[0] === resultsOf([[a, 0], [b, 1]]), `final placements kept: ${results(a)[0]}`);
    await sleep(20);
    check(coins(b).join() === "15" && coins(a).join() === "25", `an outro quitter is paid: a=${coins(a)} b=${coins(b)}`);
  }
  {
    // A player who quit during play stays unpaid even if the outro-quit path ends the game.
    const [a, b, c] = await game(3, [1]);
    onPartyGamePlayerQuit(c.session);
    act(a, FISH);
    check(await waitFor(() => states(a).includes(3)), "outro reached with c already quit");
    onPartyGamePlayerQuit(b.session);
    check(await waitFor(() => results(a).length === 1), "ended");
    await sleep(20);
    check(coins(c).length === 0 && coins(b).length === 1, `earlier quitter unpaid, outro quitter paid: b=${coins(b)} c=${coins(c)}`);
  }

  {
    const [a, b] = await game(2, [1, 1, 1, 1]);
    onPartyGamePlayerLeft(b.session);
    check(results(a)[0] === resultsOf([[a, 0]]), `a disconnect lists only players still here: ${results(a)[0]}`);
  }
  {
    const [a, b, c] = await game(3, [1, 1, 1, 1, 1, 1]);
    onPartyGamePlayerQuit(a.session);
    check(raws(b, 7).join() === `{"PlayerId":${a.sid}}` && raws(c, 7).length === 1, "PlayerLeftGame to the others");
    check(turns(b).join() === [turnOf(a), turnOf(b)].join(), `the quitter's turn passes to the next player: ${turns(b)}`);
    check(sessionOf(b.session) !== undefined && results(b).length === 0, "a 3-player game goes on with 2");
    act(a, FISH);
    check(outputs(b).length === 0, "the quitter can't act");
    act(b, FISH); await sleep(60); act(b, PASS);
    check(turns(b)[2] === turnOf(c), "turns skip the quitter");
    onPartyGamePlayerLeft(c.session);
    check(results(b).length === 1 && results(b)[0] === resultsOf([[b, 0], [a, 1]]), `a lone stayer wins, the quitter still listed: ${results(b)[0]}`);
  }

  {
    // The client only restores a quitter's controls in destroy(), which runs on pgame.end; an
    // empty-results end to just the quitter (the client's own scene-change teardown) frees them.
    const [a, b, c] = await game(3, [1, 1, 1, 1, 1, 1]);
    onPartyGamePlayerQuit(a.session);
    check(results(a).join() === "[]" && results(b).length === 0 && results(c).length === 0, `only the quitter gets an empty pgame.end: a=${results(a)} b=${results(b)}`);
    check(sessionOf(a.session) === undefined && sessionOf(b.session) !== undefined, "the quitter is freed, the others stay in");
    const before = a.extOf("pgame.message").length;
    act(b, FISH); await sleep(60);
    check(a.extOf("pgame.message").length === before, "the released quitter gets no more game messages");
    onPartyGamePlayerLeft(c.session);
    check(results(b).length === 1 && results(a).length === 1, "the final end does not go to the released quitter again");
    await sleep(20);
    check(coins(a).length === 0, "the released quitter is unpaid");
  }
  {
    // Before the cannon can exist (positions/intro) the client's destroy() would throw, so the quitter waits for the real end.
    FishBucket.makeDeck = () => [1, 1];
    const ps = Array.from({ length: 3 }, (_, i) => makePlayer(`fq${++n}_${i}`, ROOM));
    startPartyGame(1, ps.map((p) => p.entry));
    onPartyGamePlayerQuit(ps[1]!.session);
    check(results(ps[1]!).length === 0 && sessionOf(ps[1]!.session) !== undefined, "a positions-phase quitter is not released early");
  }

  // ---- logging ----
  {
    logLines.length = 0;
    const [a] = await game(2, [1, 1]);
    act(a, 4); act(a, 5); act(a, 0); act(a, 12);
    check(logLines.some((l) => l.includes("[FISH]") && l.includes("action byte=4")) && logLines.some((l) => l.includes("action byte=5")), "other non-Move bytes (LaunchThrow, Torpedo) are logged");
    check(!logLines.some((l) => l.includes("action byte=0 ") || l.includes("action byte=12 ")), "Move and the continuous byte 12 are not");
  }
} catch (e) {
  console.log = quiet;
  console.error(e);
  process.exit(1);
}
finish("");
