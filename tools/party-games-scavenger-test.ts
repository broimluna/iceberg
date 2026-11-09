// Scavenger Hunt (smartfox-server/src/party-games/scavenger-hunt.ts), driven
// in-process through the manager with fake players and a fast clock.
process.env.PARTY_GAME_TIME_SCALE ??= "0.01";
import { makeChecker } from "./lib/harness.ts";
import { makePlayer, type FakePlayer } from "./lib/party-fakes.ts";
import { SFSObjectWriter, decodeSFSObject } from "../smartfox-server/src/sfs-wire.ts";
const { startPartyGame, handlePartyGameMessage, onPartyGamePlayerLeft, onPartyGamePlayerQuit, onPartyGameAction, onPartyGamePlayerMoved, setRewardGranter, sessionOf } =
  await import("../smartfox-server/src/party-games/manager.ts");
const { ScavengerHunt } = await import("../smartfox-server/src/party-games/scavenger-hunt.ts");

const { check, finish } = makeChecker();
const quiet = console.log;
console.log = (...a: unknown[]) => { if (!(typeof a[0] === "string" && a[0].startsWith("["))) quiet(...a); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const grants: { username: string; reward: any }[] = [];
setRewardGranter((username, reward) => { grants.push({ username, reward }); });

// Scaled (0.01): intro 50 ms, hide + buffer 280 ms, prop settle 10 ms, find + buffer 580 ms.
const ROOM = "Alpine:Town:en";
const HIDER_PROP = "pgame:ScavengerHuntHiderServerAdded", FINDER_PROP = "pgame:ScavengerHuntFinderServerAdded";
let n = 0;
ScavengerHunt.pickHider = () => 0;

async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(2); }
  return cond();
}
const states = (p: FakePlayer) => p.messages().filter((m) => m.type === 1).map((m) => m.json.GameStateId);
const items = (p: FakePlayer, type: number) => p.messages().filter((m) => m.type === type).map((m) => m.json);
const holds = (p: FakePlayer, prop: string) => p.vars.some((v) => v.vars.con === prop);
const results = (p: FakePlayer) => p.extOf("pgame.end").map((e) => e.results!.value as string);
const resultsOf = (pairs: [FakePlayer, number][]) => `[${pairs.map(([p, pl]) => `{"PlayerSessionId":${p.sid},"Placement":${pl}}`).join(",")}]`;
const drop = (p: FakePlayer, pos: [number, number, number], action = 7) => { onPartyGameAction(p.session, action, pos); onPartyGamePlayerMoved(p.session, pos); };
const remove = (p: FakePlayer, itemId: unknown) => {
  const id = sessionOf(p.session)!.id;
  const w = new SFSObjectWriter().putLong("id", BigInt(id)).putLong("type", 3n).putUtfString("message", JSON.stringify({ ItemId: itemId }));
  handlePartyGameMessage(decodeSFSObject(w.encodeBody("sfs2x"), 0, "sfs2x").value, { session: p.session, peer: p.session.userName, send: p.entry.send });
};
// A running game with players[0] the Hider, in the Hiding state.
async function hiding() {
  const hider = makePlayer(`h${++n}`, ROOM), finder = makePlayer(`f${n}`, ROOM);
  startPartyGame(0, [hider.entry, finder.entry]);
  await waitFor(() => states(hider).includes(1));
  return { hider, finder };
}

try {
  // ---- roles and intro ----
  {
    const hider = makePlayer(`h${++n}`, ROOM), finder = makePlayer(`f${n}`, ROOM);
    startPartyGame(0, [hider.entry, finder.entry]);
    check(JSON.stringify(hider.messages()) === '[{"type":0,"json":{"RoleId":0}}]', `hider gets only its own SetRole: ${JSON.stringify(hider.messages())}`);
    check(JSON.stringify(finder.messages()) === '[{"type":0,"json":{"RoleId":1}}]', `finder gets only its own SetRole: ${JSON.stringify(finder.messages())}`);
    const raw = hider.extOf("pgame.message")[0]!.message!.value as string;
    check(raw === '{"RoleId":0}', `RoleId is a JSON number: ${raw}`);
    check(holds(hider, HIDER_PROP) && !holds(finder, FINDER_PROP), "the Hider holds the hider prop from the start, the Finder nothing yet");
    check(hider.extOf("pgame.start.v2").length === 1 && !!sessionOf(hider.session), "the game started for both");
    await sleep(20);
    drop(hider, [1, 0, 1]);
    check(items(hider, 2).length === 0, "a drop during the intro is ignored");
    await waitFor(() => states(hider).includes(1));
    check(states(hider).join() === "1" && states(finder).join() === "1", "Hiding state to both after the intro");

    // ---- drops ----
    onPartyGameAction(finder.session, 7, [0, 0, 0]);
    check(items(hider, 2).length === 0, "the Finder's Action1 drops nothing");
    drop(hider, [0, 0, 0], 0);
    drop(hider, [0, 0, 0], 6);
    check(items(hider, 2).length === 0, "a non-Action1 action (Move, SlideTrick) drops nothing");
    drop(hider, [1, 0, 2]);
    check(JSON.stringify(items(hider, 2)) === '[{"ItemId":1,"Pos":{"x":1,"y":0,"z":2}}]' && JSON.stringify(items(finder, 2)) === JSON.stringify(items(hider, 2)), `first drop announced to both: ${JSON.stringify(items(finder, 2))}`);
    drop(hider, [1.5, 0, 2]);
    check(items(hider, 2).length === 1, "a drop 0.5 m from a marble is ignored");
    drop(hider, [9, 0, 2]);
    check(items(hider, 2).length === 1, "a drop 8 m from where the Hider was is ignored");
    onPartyGamePlayerMoved(hider.session, [1, 0, 2]);
    drop(hider, [3, 0, 2]); drop(hider, [5, 0, 2]);
    check(items(hider, 2).map((i) => i.ItemId).join() === "1,2,3", "ids count up from 1");
    drop(hider, [7, 0, 2]);
    check(items(hider, 2).length === 3, "a 4th marble is ignored");

    // ---- finding ----
    check(await waitFor(() => holds(finder, FINDER_PROP)), "the Finder gets the finder prop before Finding");
    onPartyGamePlayerMoved(hider.session, [3, 0, 2]);
    drop(hider, [4, 0, 2]);
    check(items(hider, 2).length === 3 && !states(finder).includes(2), "a drop in the gap before Finding is ignored");
    check(!states(finder).includes(2), "the prop arrives before the Finding state");
    check(await waitFor(() => states(finder).includes(2)), "Finding state after the hide time");
    drop(hider, [7, 0, 2]);
    check(items(hider, 2).length === 3, "no drops once Finding");
    remove(finder, 1);
    check(items(finder, 3).length === 0, "pickup with no known Finder position is ignored");
    onPartyGamePlayerMoved(finder.session, [8.5, 0, 2]);
    remove(finder, 1);
    check(items(finder, 3).length === 0, "pickup from 7.5 m is ignored");
    onPartyGamePlayerMoved(finder.session, [2, 0, 2]);
    remove(hider, 1);
    check(items(finder, 3).length === 0, "the Hider can't pick up");
    for (const bad of [99, -1, 1.5, "1", null]) remove(finder, bad);
    check(items(finder, 3).length === 0, "unknown / malformed ids are ignored");
    remove(finder, 1);
    check(JSON.stringify(items(hider, 3)) === '[{"ItemId":1}]' && items(finder, 3).length === 1, `pickup announced to both: ${JSON.stringify(items(hider, 3))}`);
    remove(finder, 1);
    check(items(finder, 3).length === 1, "a repeated pickup is ignored");
    remove(finder, 2); remove(finder, 3);
    check(items(finder, 3).length === 3 && results(finder).length === 0, "all found, the result waits ~1 s");
    check(await waitFor(() => results(finder).length === 1), "pgame.end after the last find");
    check(results(finder)[0] === resultsOf([[finder, 0], [hider, 1]]) && results(hider)[0] === results(finder)[0], `Finder wins: ${results(finder)[0]}`);
    check(grants.find((g) => g.username === finder.session.accountName)?.reward.coins === 20 && grants.find((g) => g.username === hider.session.accountName)?.reward.coins === 10, "win 20 coins, lose 10");
    check(results(finder).length === 1 && sessionOf(hider.session) === undefined, "ended once, players free");
    check(!hider.session.heldObject && !finder.session.heldObject, "props cleared");
  }

  // ---- positions: seeded from the last known one; a jump disqualifies ----
  {
    const hider = makePlayer(`h${++n}`, ROOM), finder = makePlayer(`f${n}`, ROOM);
    hider.session.lastPosition = [100, 0, 0];
    finder.session.lastPosition = [5, 0, 5];
    startPartyGame(0, [hider.entry, finder.entry]);
    await waitFor(() => states(hider).includes(1));
    onPartyGameAction(hider.session, 7, [0, 0, 0]);
    check(items(hider, 2).length === 0, "a first drop far from the last known position is ignored");
    onPartyGamePlayerMoved(hider.session, [0, 0, 0]);
    onPartyGamePlayerMoved(hider.session, [0, 0, 30]);
    onPartyGameAction(hider.session, 7, [0, 0, 30]);
    check(items(hider, 2).length === 0, "a Hider whose position jumped 30 m can't drop");
    await waitFor(() => states(finder).includes(2));
    remove(finder, 1);
    check(items(finder, 3).length === 0, "nothing to pick up (no marbles)");
  }
  {
    const hider = makePlayer(`h${++n}`, ROOM), finder = makePlayer(`f${n}`, ROOM);
    finder.session.lastPosition = [5, 0, 5];
    startPartyGame(0, [hider.entry, finder.entry]);
    await waitFor(() => states(hider).includes(1));
    drop(hider, [5, 0, 6]);
    await waitFor(() => states(finder).includes(2));
    remove(finder, 1);
    check(items(finder, 3).length === 1, "a Finder who hasn't moved is placed by their last known position");
    await waitFor(() => results(hider).length === 1);
  }
  {
    const hider = makePlayer(`h${++n}`, ROOM), finder = makePlayer(`f${n}`, ROOM);
    startPartyGame(0, [hider.entry, finder.entry]);
    await waitFor(() => states(hider).includes(1));
    drop(hider, [0, 0, 0]);
    await waitFor(() => states(finder).includes(2));
    onPartyGamePlayerMoved(finder.session, [0, 0, 0]);
    onPartyGamePlayerMoved(finder.session, [0, 0, 40]);
    onPartyGamePlayerMoved(finder.session, [0, 0, 0]);
    remove(finder, 1);
    check(items(finder, 3).length === 0, "a Finder whose position jumped 40 m can't pick up");
    onPartyGamePlayerLeft(hider.session);
  }

  // ---- sub-20 m hops at packet rate add up to speed: disqualified; a walking pace is not ----
  {
    const hider = makePlayer(`h${++n}`, ROOM), finder = makePlayer(`f${n}`, ROOM);
    startPartyGame(0, [hider.entry, finder.entry]);
    await waitFor(() => states(hider).includes(1));
    drop(hider, [0, 0, 0]);
    await waitFor(() => states(finder).includes(2));
    for (const z of [0, 15, 0, 15, 0]) onPartyGamePlayerMoved(finder.session, [0, 0, z]);
    remove(finder, 1);
    check(items(finder, 3).length === 0, "a Finder hopping 15 m per packet (60 m in under a second, back at the marble) can't pick up");
    onPartyGamePlayerLeft(hider.session);
  }
  {
    const hider = makePlayer(`h${++n}`, ROOM), finder = makePlayer(`f${n}`, ROOM);
    startPartyGame(0, [hider.entry, finder.entry]);
    await waitFor(() => states(hider).includes(1));
    drop(hider, [0, 0, 0]);
    await waitFor(() => states(finder).includes(2));
    for (let i = 0; i < 20; i++) onPartyGamePlayerMoved(finder.session, [0, 0, i * 0.4]);
    onPartyGamePlayerMoved(finder.session, [0, 0, 0]);
    remove(finder, 1);
    check(items(finder, 3).length === 1, "a Finder walking at a normal pace can still pick up");
    await waitFor(() => results(hider).length === 1);
  }

  // ---- the live client's hide button sends Action2 (8) ----
  {
    const { hider, finder } = await hiding();
    drop(hider, [0, 0, 0], 8);
    check(items(finder, 2).length === 1, "Action2 (8), what the live client sends for the hide button, drops a marble");
    onPartyGamePlayerLeft(finder.session);
  }
  {
    const { hider, finder } = await hiding();
    drop(hider, [0, 0, 0], 9);
    check(items(finder, 2).length === 0, "Action3 (9) does not drop");
    onPartyGamePlayerLeft(finder.session);
  }

  // ---- a packet flood is itself disqualifying ----
  {
    const hider = makePlayer(`h${++n}`, ROOM), finder = makePlayer(`f${n}`, ROOM);
    startPartyGame(0, [hider.entry, finder.entry]);
    await waitFor(() => states(hider).includes(1));
    drop(hider, [0, 0, 0]);
    await waitFor(() => states(finder).includes(2));
    for (let i = 0; i < 80; i++) onPartyGamePlayerMoved(finder.session, [0, 0, 0]);
    remove(finder, 1);
    check(items(finder, 3).length === 0, "a Finder flooding position packets can't pick up");
    onPartyGamePlayerLeft(hider.session);
  }

  // ---- time runs out with a marble left: the Hider wins ----
  {
    const { hider, finder } = await hiding();
    drop(hider, [0, 0, 0]); drop(hider, [2, 0, 0]);
    await waitFor(() => states(finder).includes(2));
    onPartyGamePlayerMoved(finder.session, [0, 0, 0]);
    remove(finder, 1);
    check(await waitFor(() => results(hider).length === 1, 3000), "ends when the find time is up");
    check(results(hider)[0] === resultsOf([[hider, 0], [finder, 1]]), `Hider wins: ${results(hider)[0]}`);
  }

  // ---- nothing hidden: the Hider loses ----
  {
    const { hider, finder } = await hiding();
    check(await waitFor(() => results(hider).length === 1, 3000), "ends with nothing hidden");
    check(results(hider)[0] === resultsOf([[finder, 0], [hider, 1]]), `Finder wins when nothing was hidden: ${results(hider)[0]}`);
  }

  // ---- quit and leave ----
  {
    const { hider, finder } = await hiding();
    hider.session.heldObject = undefined;
    onPartyGamePlayerQuit(hider.session);
    check(results(finder)[0] === resultsOf([[finder, 0], [hider, 1]]), `the stayer wins when the Hider quits: ${results(finder)[0]}`);
    await sleep(700);
    check(results(finder).length === 1 && states(finder).length === 1, "nothing fires after the end");
  }
  {
    const { hider, finder } = await hiding();
    await waitFor(() => holds(finder, FINDER_PROP));
    onPartyGamePlayerLeft(finder.session); // during the prop-settle gap
    check(results(hider)[0] === resultsOf([[hider, 0]]), `the stayer wins when the Finder leaves mid-gap: ${results(hider)[0]}`);
    await sleep(100);
    check(results(hider).length === 1 && !states(hider).includes(2), "no Finding state after the end");
  }
  {
    const { hider, finder } = await hiding();
    drop(hider, [0, 0, 0]);
    await waitFor(() => states(finder).includes(2));
    onPartyGamePlayerMoved(finder.session, [0, 0, 0]);
    remove(finder, 1);
    onPartyGamePlayerLeft(hider.session); // after the last find, before the result
    check(results(finder)[0] === resultsOf([[finder, 0]]), `the decided result stands when the Hider leaves: ${results(finder)[0]}`);
    await sleep(100);
    check(results(finder).length === 1, "ended once");
  }
} catch (err) {
  check(false, `threw: ${(err as Error).stack}`);
}
finish();
