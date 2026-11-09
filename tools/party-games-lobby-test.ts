// Scheduled party-game lobbies (smartfox-server/src/party-games/lobby.ts):
// window maths, team slots, joining by interacting with the lobby item,
// leaving, the player cap, and what happens when the lobby runs out.
process.env.PARTY_GAME_SCHEDULE = "off";
process.env.PARTY_GAME_TIME_SCALE = "0.02"; // the 60 s lobby lasts 1.2 s
import { makeChecker } from "./lib/harness.ts";
import { makePlayer, decodeItemTuple, decodeItemVars, type FakePlayer } from "./lib/party-fakes.ts";
import { unregister } from "../smartfox-server/src/session-registry.ts";
import type { SFSValue } from "../smartfox-server/src/sfs-wire.ts";

const { check, finish } = makeChecker();
const quiet = console.log;
console.log = (...a: unknown[]) => { if (!(typeof a[0] === "string" && a[0].startsWith("["))) quiet(...a); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { nextLobbyWindow, assignSlot, openLobby, handleLobbyInteraction, onLobbyPlayerLeft, releaseRoomLobbiesIfEmpty } = await import("../smartfox-server/src/party-games/lobby.ts");
const { registerGameType, sessionOf, endSession } = await import("../smartfox-server/src/party-games/manager.ts");
const { PartyGameSession } = await import("../smartfox-server/src/party-games/session.ts");
const { roomItemsIn } = await import("../smartfox-server/src/party-games/room-items.ts");

// A stand-in for Dance Battle that only records how it was started.
class Stub extends PartyGameSession {
  onStart() {}
  onMessage() {}
  onPlayerLeft() {}
  onPlayerQuit() {}
}
registerGameType(3, (id, def, players, slots) => new Stub(id, def, players, slots));

// ---- window maths ----
const SIX = 6 * 60_000;
const T = Math.ceil(Date.now() / SIX) * SIX;
const inside = nextLobbyWindow(T - 30_000, 6, 60);
check(inside.endsAtMs === T && inside.opensAtMs === T - 60_000, "inside a window: that window");
const after = nextLobbyWindow(T + 1_000, 6, 60);
check(after.endsAtMs === T + SIX && after.opensAtMs === T + SIX - 60_000, "just after a window: the next one");
check(nextLobbyWindow(T - 120_000, 6, 60).opensAtMs === T - 60_000, "before a window: it opens 60 s before the boundary");
check(after.endsAtMs % SIX === 0, "windows end on a multiple of 6 minutes");

// ---- slot assignment ----
const taken: { teamId: number; roleId: number }[] = [];
const order: string[] = [];
for (let i = 0; i < 20; i++) { const s = assignSlot(taken, 10, 2)!; taken.push(s); order.push(`${s.teamId}/${s.roleId}`); }
check(order.slice(0, 4).join() === "0/0,1/0,0/1,1/1", `slots alternate teams, lowest role first (${order.slice(0, 4)})`);
check(new Set(order).size === 20 && taken.filter((s) => s.teamId === 0).length === 10, "20 distinct slots, 10 per team");
check(assignSlot(taken, 10, 2) === undefined, "a full lobby has no slot");
taken.splice(taken.findIndex((s) => s.teamId === 1 && s.roleId === 3), 1);
check(JSON.stringify(assignSlot(taken, 10, 2)) === '{"teamId":1,"roleId":3}', "a freed slot is reused");
check(JSON.stringify(assignSlot([{ teamId: 0, roleId: 0 }, { teamId: 0, roleId: 1 }], 10, 2)) === '{"teamId":1,"roleId":0}', "the smaller team gets the next player");

// ---- lobby end to end (in-process) ----
const ROOM = "Alpine:en_US:Town::1.15.1;offline;2026-11-08;NONE";
const ctxOf = (p: FakePlayer) => ({ session: p.session, peer: p.session.userName, send: p.entry.send });
const interact = (p: FakePlayer, itemId: number) =>
  handleLobbyInteraction(ctxOf(p), 2, JSON.stringify({ type: 1, id: String(itemId), tag: "" }));
const rosterOf = (p: FakePlayer): { TeamId: number; RoleId: number; UserSessionId: number }[] => {
  const ups = p.mmo.filter((m) => m.a === 1007 && m.p.v);
  for (let i = ups.length - 1; i >= 0; i--) {
    const v = decodeItemVars(ups[i]!.p.v!.value as SFSValue[]);
    if (typeof v.score === "string") return JSON.parse((v.score as string).replace(/"UserSessionId":(\d+)/g, '"UserSessionId":"$1"')).Players;
  }
  return [];
};
// The player's own latest "con" (everyone in the room sees everyone's).
const heldOf = (p: FakePlayer) => { const v = p.vars.filter((x) => x.u === p.session.userId).at(-1)?.vars.con; return v === undefined ? "(unchanged)" : v; };

try {
  const [p1, p2, p3, p4, p5] = ["p1", "p2", "p3", "p4", "p5"].map((n) => makePlayer(n, ROOM)) as FakePlayer[];
  const far = makePlayer("far", "Alpine:en_US:Other::1.15.1;offline;2026-11-08;NONE");

  check(!openLobby(ROOM, 99), "unknown template: no lobby");
  check(!openLobby(ROOM, 2), "a template without a zone schedule: no lobby");
  check(openLobby(ROOM, 3), "a lobby opens in the room");
  check(!openLobby(ROOM, 3), "a second lobby in the same room is refused");
  const item = roomItemsIn(ROOM)[0]!;
  const add = p1!.mmo.find((m) => m.a === 30 && m.p.q);
  const t = add ? decodeItemTuple((add.p.q!.value as SFSValue[])[0]!) : undefined;
  check(!!t && t.vars.category === 6 && t.vars.int_a === 3 && t.vars.creator === 0 && t.position.join() === "16,0.5,-10"
    && Math.abs((t.vars.ttl as number) - 1.2) < 0.01 && Math.abs(Number(t.vars.statetimestamp) - Date.now() / 1000) < 3 && t.vars.score === '{"Players":[]}',
    `the lobby item reaches the room with template, ttl, start time and an empty roster (${JSON.stringify(t)})`);
  check(far.mmo.length === 0, "a player in another room doesn't see the lobby");

  interact(p1!, item.itemId); interact(p2!, item.itemId); interact(p3!, item.itemId); interact(p4!, item.itemId);
  const r4 = rosterOf(p1!);
  check(r4.map((p) => `${p.TeamId}/${p.RoleId}`).join() === "0/0,1/0,0/1,1/1" && r4[0]!.UserSessionId === p1!.sid as any, `four joiners are split 2/2 in order (${JSON.stringify(r4)})`);
  check([p1, p2, p3, p4].every((p) => heldOf(p!) === "pgame:DanceBattleLobbyServerAdded"), "each joiner holds the lobby prop");
  const n = p1!.mmo.length; interact(p1!, item.itemId);
  check(p1!.mmo.length === n, "joining twice changes nothing");
  handleLobbyInteraction(ctxOf(p5!), 3, JSON.stringify({ type: 1, id: String(item.itemId) }));
  handleLobbyInteraction(ctxOf(p5!), 2, JSON.stringify({ type: 1, id: "999999" }));
  handleLobbyInteraction(ctxOf(p5!), 2, "not json");
  handleLobbyInteraction(ctxOf(p5!), 2, undefined);
  check(rosterOf(p5!).length === 4 && heldOf(p5!) === "(unchanged)", "wrong action, unknown item, junk and no object are ignored");

  // p3 leaves; the slot frees up and the next joiner takes it.
  unregister(p3!.session); onLobbyPlayerLeft(p3!.session);
  check(rosterOf(p1!).map((p) => `${p.TeamId}/${p.RoleId}`).join() === "0/0,1/0,1/1", "a leaver is dropped from the roster");
  interact(p5!, item.itemId);
  check(rosterOf(p1!).map((p) => `${p.TeamId}/${p.RoleId}`).sort().join() === "0/0,0/1,1/0,1/1", "the freed slot is taken by the next joiner");

  for (const p of [p1, p2, p4, p5]) p!.clear();
  await sleep(1500);
  check(roomItemsIn(ROOM).length === 0 && p1!.mmo.some((m) => m.a === 30 && m.p.n), "the lobby item is removed when time is up");
  check([p1, p2, p4, p5].every((p) => heldOf(p!) === null), "the lobby prop is taken off everyone");
  const game = sessionOf(p1!.session);
  check(!!game && game.templateId === 3 && game.players.length === 4 && game.players.map((p) => `${p.teamId}/${p.roleId}`).sort().join() === "0/0,0/1,1/0,1/1",
    "a game starts with the roster's teams and roles");
  check([p1, p2, p4, p5].every((p) => p!.extOf("pgame.start.v2").length === 1), "every player gets pgame.start.v2");
  check(far.ext.length === 0, "the player in another room hears nothing");
  endSession(game!, new Map());

  // Too few players: cancelled, nobody started, prop removed.
  p1!.clear(); p2!.clear();
  openLobby(ROOM, 3);
  const item2 = roomItemsIn(ROOM)[0]!;
  interact(p1!, item2.itemId);
  await sleep(1500);
  check(roomItemsIn(ROOM).length === 0 && !sessionOf(p1!.session) && p1!.extOf("pgame.start.v2").length === 0 && heldOf(p1!) === null,
    "one player: the lobby is cancelled and the prop removed");

  // Everyone left on one team: cancelled too.
  p1!.clear(); p2!.clear(); p4!.clear();
  openLobby(ROOM, 3);
  const item3 = roomItemsIn(ROOM)[0]!;
  interact(p1!, item3.itemId); interact(p2!, item3.itemId); interact(p4!, item3.itemId);
  unregister(p2!.session); onLobbyPlayerLeft(p2!.session);
  await sleep(1500);
  check(!sessionOf(p1!.session) && p1!.extOf("pgame.start.v2").length === 0, "two players left on the same team: no game");

  // Player cap.
  const crowd = Array.from({ length: 21 }, (_, i) => makePlayer(`c${i}`, ROOM));
  openLobby(ROOM, 3);
  const item4 = roomItemsIn(ROOM)[0]!;
  for (const c of crowd) interact(c, item4.itemId);
  check(rosterOf(crowd[0]!).length === 20 && heldOf(crowd[20]!) === "(unchanged)", "the 21st joiner is refused and not equipped");

  // An empty room drops its lobby.
  for (const c of [...crowd, p1!, p2!, p4!, p5!]) unregister(c.session);
  releaseRoomLobbiesIfEmpty(ROOM);
  check(roomItemsIn(ROOM).length === 0, "an emptied room's lobby is removed");
  await sleep(1500);
  check(roomItemsIn(ROOM).length === 0, "and its timer doesn't bring anything back");
} catch (err) {
  check(false, `threw: ${(err as Error).stack}`);
}
finish();
