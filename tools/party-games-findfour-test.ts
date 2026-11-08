// Find Four rules (smartfox-server/src/party-games/find-four.ts), driven
// in-process through the manager with fake players and a fast clock.
process.env.PARTY_GAME_TIME_SCALE ??= "0.01";
import { makeChecker } from "./lib/harness.ts";
import { makePlayer, type FakePlayer } from "./lib/party-fakes.ts";
import { SFSObjectWriter, decodeSFSObject } from "../smartfox-server/src/sfs-wire.ts";
import { unregister } from "../smartfox-server/src/session-registry.ts";
const { startPartyGame, handlePartyGameMessage, onPartyGamePlayerLeft, setRewardGranter, sessionOf } =
  await import("../smartfox-server/src/party-games/manager.ts");
const { normaliseColumn } = await import("../smartfox-server/src/party-games/find-four.ts");

const { check, finish } = makeChecker();
const quiet = console.log;
console.log = (...a: unknown[]) => { if (!(typeof a[0] === "string" && a[0].startsWith("["))) quiet(...a); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
setRewardGranter(() => {});

// Scaled timings (0.01): intro 50 ms, chip 20 ms, backstop 220 ms, outro 40 ms.
const INTRO = 80, CHIP = 40, BACKSTOP = 300, OUTRO = 80;
const ROOM = "Alpine:Town:en";
let n = 0;

function move(p: FakePlayer, column: unknown, playerId?: string) {
  const id = sessionOf(p.session)!.id;
  const body = `{"PlayerId":${playerId ?? p.sid},"ScoreDelta":${JSON.stringify(column)}}`;
  const w = new SFSObjectWriter().putInt("id", id).putInt("type", 5).putUtfString("message", body);
  handlePartyGameMessage(decodeSFSObject(w.encodeBody("sfs2x"), 0, "sfs2x").value, { session: p.session, peer: p.session.userName, send: p.entry.send });
}
async function newGame() {
  const owner = makePlayer(`o${++n}`, ROOM), guest = makePlayer(`g${n}`, ROOM);
  startPartyGame(2, [owner.entry, guest.entry]);
  await sleep(INTRO);
  return { owner, guest };
}
async function play(owner: FakePlayer, guest: FakePlayer, cols: number[]) {
  for (let i = 0; i < cols.length; i++) {
    move(i % 2 === 0 ? owner : guest, cols[i]);
    await sleep(CHIP);
  }
}
const outputs = (p: FakePlayer) => p.messages().filter((m) => m.type === 5).map((m) => m.json);
const results = (p: FakePlayer) => p.extOf("pgame.end").map((e) => e.results!.value as string);
const resultsOf = (pairs: [FakePlayer, number][]) => `[${pairs.map(([p, pl]) => `{"PlayerSessionId":${p.sid},"Placement":${pl}}`).join(",")}]`;

try {
  // ---- column normalisation (pure) ----
  const empty = () => Array.from({ length: 7 }, () => [] as number[]);
  const b = empty();
  check(normaliseColumn(b, 3, 3) === 3, "valid column kept");
  check(normaliseColumn(b, "x", 3) === 3, "non-number -> default");
  check(normaliseColumn(b, 9, 3) === 6 && normaliseColumn(b, -2, 3) === 0, "out of range -> nearest edge");
  check(normaliseColumn(b, 2.7, 3) === 2, "float floored");
  const full3 = empty(); full3[3] = [0, 1, 0, 1, 0, 1];
  check(normaliseColumn(full3, 3, 3) === 2, "full column -> nearest open, lower first");
  const fullAll = Array.from({ length: 7 }, () => [0, 1, 0, 1, 0, 1]);
  check(normaliseColumn(fullAll, 3, 3) === -1, "full board -> -1");

  // ---- intro, turn order, echo ----
  {
    const owner = makePlayer(`o${++n}`, ROOM), guest = makePlayer(`g${n}`, ROOM);
    startPartyGame(2, [owner.entry, guest.entry]);
    check(JSON.stringify(owner.messages()) === JSON.stringify([{ type: 1, json: { GameStateId: 0 } }]), `intro state first: ${JSON.stringify(owner.messages())}`);
    await sleep(INTRO);
    const m = owner.messages().map((x) => `${x.type}:${JSON.stringify(x.json)}`);
    check(m[1] === '1:{"GameStateId":1}' && m[2] === `6:{"PlayerId":${owner.sid}}`, `game state then owner's turn: ${m.join(" ")}`);
    // The client parses PlayerId as a long: it's spliced in raw.
    check((owner.extOf("pgame.message")[2]!.message!.value as string) === `{"PlayerId":${owner.sid}}`, "PlayerId spliced as a raw number");

    move(guest, 0);
    await sleep(CHIP);
    check(outputs(owner).length === 0, "guest can't move on the owner's turn");
    move(owner, 3); move(owner, 3);
    await sleep(CHIP);
    check(outputs(owner).length === 1 && outputs(guest).length === 1, `double move ignored (${outputs(owner).length})`);
    const echoed = owner.extOf("pgame.message").map((e) => e.message!.value as string).find((t) => t.includes("ScoreDelta"));
    check(echoed === `{"PlayerId":${owner.sid},"ScoreDelta":3}`, `move echoed: ${echoed}`);
    await sleep(CHIP);
    const last = owner.messages().at(-1)!;
    check(last.type === 6 && String(owner.extOf("pgame.message").at(-1)!.message!.value).includes(guest.sid), "guest's turn next");
    move(guest, 4, owner.sid);
    await sleep(CHIP);
    const spoof = owner.extOf("pgame.message").map((e) => e.message!.value as string).filter((t) => t.includes("ScoreDelta")).at(-1);
    check(spoof === `{"PlayerId":${guest.sid},"ScoreDelta":4}`, `spoofed PlayerId replaced by sender: ${spoof}`);
  }

  // ---- full column redirected ----
  {
    const { owner, guest } = await newGame();
    await play(owner, guest, [0, 0, 0, 0, 0, 0]);
    owner.clear();
    move(owner, 0);
    await sleep(CHIP);
    check(outputs(owner)[0]?.ScoreDelta === 1, `full column 0 -> 1 (${JSON.stringify(outputs(owner))})`);
  }

  // ---- wins ----
  const wins: Record<string, number[]> = {
    horizontal: [0, 6, 1, 6, 2, 6, 3],
    vertical: [0, 1, 0, 1, 0, 1, 0],
    rising: [0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3],
    falling: [6, 5, 5, 4, 4, 3, 4, 3, 3, 0, 3],
  };
  for (const [name, cols] of Object.entries(wins)) {
    const { owner, guest } = await newGame();
    await play(owner, guest, cols);
    const finished = owner.messages().some((m) => m.type === 1 && m.json.GameStateId === 2);
    await sleep(OUTRO);
    check(finished && results(owner)[0] === resultsOf([[owner, 0], [guest, 1]]) && results(guest).length === 1,
      `${name} win: ${results(owner)[0]}`);
  }
  {
    const { owner, guest } = await newGame();
    await play(owner, guest, [5, 0, 5, 1, 6, 2, 6, 3]);
    await sleep(OUTRO);
    check(results(owner)[0] === resultsOf([[guest, 0], [owner, 1]]), `guest win: ${results(owner)[0]}`);
  }

  // ---- draw ----
  {
    const { owner, guest } = await newGame();
    await play(owner, guest, [5, 3, 2, 3, 1, 5, 3, 1, 0, 1, 4, 1, 2, 5, 0, 5, 6, 6, 2, 0, 6, 0, 4, 2, 3, 0, 3, 4, 2, 3, 2, 6, 0, 4, 1, 1, 5, 4, 4, 5, 6, 6]);
    await sleep(OUTRO);
    check(results(owner)[0] === resultsOf([[owner, 1], [guest, 1]]), `draw gives both placement 1: ${results(owner)[0]}`);
  }

  // ---- timeout backstop ----
  {
    const { owner } = await newGame();
    await sleep(BACKSTOP);
    check(outputs(owner)[0]?.ScoreDelta === 3, `server plays the default column on timeout (${JSON.stringify(outputs(owner))})`);
  }

  // ---- a decided result stands if someone leaves during the outro ----
  {
    const { owner, guest } = await newGame();
    await play(owner, guest, [0, 6, 1, 6, 2, 6, 3]);
    unregister(owner.session);
    onPartyGamePlayerLeft(owner.session);
    check(results(guest)[0] === resultsOf([[guest, 1]]), `winner leaving in the outro doesn't hand the loser the win: ${results(guest)[0]}`);
  }

  // ---- forfeit mid-game and during the intro ----
  {
    const { owner, guest } = await newGame();
    await play(owner, guest, [3, 3]);
    owner.clear();
    unregister(guest.session);
    onPartyGamePlayerLeft(guest.session);
    check(results(owner)[0] === resultsOf([[owner, 0]]), `forfeit: ${results(owner)[0]}`);
    check(!owner.messages().some((m) => m.type === 1 && m.json.GameStateId === 2), "forfeit ends at once, no outro");
  }
  {
    const owner = makePlayer(`o${++n}`, ROOM), guest = makePlayer(`g${n}`, ROOM);
    startPartyGame(2, [owner.entry, guest.entry]);
    unregister(guest.session);
    onPartyGamePlayerLeft(guest.session);
    check(results(owner)[0] === resultsOf([[owner, 0]]), "forfeit during intro");
    owner.clear();
    await sleep(INTRO + BACKSTOP);
    check(owner.ext.length === 0, `no timer fires after a forfeit (${owner.ext.map((e) => e.cmd)})`);
  }
} catch (err) {
  check(false, `threw: ${(err as Error).stack}`);
}
finish();
