// Party game session manager (smartfox-server/src/party-games/manager.ts):
// pgame.start.v2 / pgame.message / pgame.end go to the players only, the
// game prop is equipped for the room, placement rewards are granted and
// announced with reward.add_delayed, and bad input never reaches a game.
import { makeChecker } from "./lib/harness.ts";
import { makePlayer, type FakePlayer } from "./lib/party-fakes.ts";
import { SFSObjectWriter, decodeSFSObject } from "../smartfox-server/src/sfs-wire.ts";
import { unregister, type RegisteredSession } from "../smartfox-server/src/session-registry.ts";
import { PartyGameSession, type PartyGamePlayer } from "../smartfox-server/src/party-games/session.ts";
import {
  registerGameType, startPartyGame, endSession, sessionOf, handlePartyGameMessage,
  onPartyGamePlayerLeft, setRewardGranter, canStart, canStartWith, isInPartyGame,
} from "../smartfox-server/src/party-games/manager.ts";

const { check, finish } = makeChecker();
const quiet = console.log;
console.log = (...a: unknown[]) => { if (!(typeof a[0] === "string" && a[0].startsWith("["))) quiet(...a); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A stand-in game registered over Find Four's game type.
let probe: TestGame | undefined;
class TestGame extends PartyGameSession {
  started = 0; messages: { player: PartyGamePlayer; type: number; message: unknown }[] = []; left: PartyGamePlayer[] = [];
  throwOnMessage = false;
  onStart() { this.started++; probe = this; }
  onMessage(player: PartyGamePlayer, type: number, message: unknown) {
    if (this.throwOnMessage) throw new Error("boom");
    this.messages.push({ player, type, message });
  }
  onPlayerLeft(player: PartyGamePlayer) { this.left.push(player); }
  onPlayerQuit(_player: PartyGamePlayer) {}
  arm(seconds: number, fn: () => void) { this.timer(seconds, fn); }
  finishWith(p: Map<RegisteredSession, number>) { this.endWith(p); }
}
registerGameType(2, (id, def, players) => new TestGame(id, def, players));
registerGameType(3, (id, def, players, slots) => new TestGame(id, def, players, slots));

const grants: { username: string; reward: unknown }[] = [];
setRewardGranter((username, reward) => { grants.push({ username, reward }); });

const ROOM = "Alpine:Town:en";
const ctxOf = (p: FakePlayer) => ({ session: p.session, peer: p.session.userName, send: p.entry.send });
// The client's serialize() has no int overload: id and type arrive as LONG.
const msg = (id: number, type: number, message: string) => {
  const w = new SFSObjectWriter().putLong("id", BigInt(id)).putLong("type", BigInt(type)).putUtfString("message", message);
  return decodeSFSObject(w.encodeBody("sfs2x"), 0, "sfs2x").value;
};

try {
  const owner = makePlayer("owner", ROOM), guest = makePlayer("guest", ROOM), watcher = makePlayer("watcher", ROOM);
  const all = [owner, guest, watcher];

  check(canStart(2), "template 2 can start");
  check(!canStart(99), "unknown template can't start");
  check(canStartWith(2, [owner.entry, guest.entry]), "canStartWith: two free players");
  check(!canStartWith(2, [owner.entry]), "canStartWith: too few players");
  check(!canStartWith(2, [owner.entry, owner.entry]), "canStartWith: the same player twice");
  const gone = makePlayer("gone", ROOM);
  unregister(gone.session);
  check(!canStartWith(2, [owner.entry, gone.entry]), "canStartWith: a disconnected player");

  // ---- start ----
  const s1 = startPartyGame(2, [owner.entry, guest.entry])!;
  check(!!s1 && probe === s1 && (s1 as TestGame).started === 1, "session started");
  for (const p of [owner, guest]) {
    const st = p.extOf("pgame.start.v2");
    check(st.length === 1 && st[0]!.id!.value === s1.id && st[0]!.template!.value === 2, `${p.session.userName} gets pgame.start.v2`);
    const players = st[0]?.players?.value as string;
    check(players === `{"Players":[{"TeamId":0,"UserSessionId":${owner.sid},"RoleId":0},{"TeamId":0,"UserSessionId":${guest.sid},"RoleId":0}]}`,
      `players JSON, owner first, ids unquoted: ${players}`);
  }
  check(watcher.ext.every((e) => !e.cmd.startsWith("pgame.")), "spectator gets no pgame.*");
  for (const viewer of all) {
    for (const p of [owner, guest]) {
      const up = viewer.vars.filter((v) => v.u === p.session.userId);
      check(up.length === 1 && up[0]!.vars.con === "pgame:FindFourGameServerAdded" && !("con_prop" in up[0]!.vars),
        `${viewer.session.userName} sees ${p.session.userName}'s game prop (${JSON.stringify(up.map((u) => u.vars))})`);
    }
  }
  check(sessionOf(owner.session) === s1 && sessionOf(guest.session) === s1 && sessionOf(watcher.session) === undefined, "sessionOf tracks players");

  // ---- busy players ----
  for (const p of all) p.clear();
  const extra = makePlayer("extra", ROOM);
  check(startPartyGame(2, [extra.entry, guest.entry]) === undefined, "a player already in a game can't start another");
  check(all.every((p) => p.ext.length === 0) && extra.ext.length === 0, "refused start sends nothing");
  check(startPartyGame(2, [extra.entry]) === undefined, "below minPlayers refused");
  check(startPartyGame(99, [extra.entry, watcher.entry]) === undefined, "unknown template refused");

  // ---- messages ----
  const game = s1 as TestGame;
  handlePartyGameMessage(msg(s1.id, 5, '{"ScoreDelta":3}'), ctxOf(watcher));
  handlePartyGameMessage(msg(s1.id + 50, 5, '{"ScoreDelta":3}'), ctxOf(owner));
  handlePartyGameMessage(msg(s1.id, 5, "x".repeat(5000)), ctxOf(owner));
  handlePartyGameMessage(msg(s1.id, 5, "{not json"), ctxOf(owner));
  handlePartyGameMessage(decodeSFSObject(new SFSObjectWriter().putInt("id", s1.id).encodeBody("sfs2x"), 0, "sfs2x").value, ctxOf(owner));
  check(game.messages.length === 0, `bad pgame.message ignored (${game.messages.length} delivered)`);
  handlePartyGameMessage(msg(s1.id, 5, '{"ScoreDelta":3}'), ctxOf(guest));
  check(game.messages.length === 1 && game.messages[0]!.player.entry === guest.entry && game.messages[0]!.type === 5
    && (game.messages[0]!.message as any)?.ScoreDelta === 3, "pgame.message routed to the game with the sender");

  // ---- timers cleared on end, end, rewards, idempotent ----
  let fired = false;
  game.arm(0.05, () => { fired = true; });
  for (const p of all) p.clear();
  game.finishWith(new Map([[owner.entry, 0], [guest.entry, 1]]));
  for (const p of [owner, guest]) {
    const end = p.extOf("pgame.end");
    check(end.length === 1 && end[0]!.id!.value === s1.id, `${p.session.userName} gets pgame.end`);
    check(end[0]?.results?.value === `[{"PlayerSessionId":${owner.sid},"Placement":0},{"PlayerSessionId":${guest.sid},"Placement":1}]`,
      `results JSON: ${end[0]?.results?.value}`);
    const delayed = p.extOf("reward.add_delayed");
    const r = delayed.length === 1 ? JSON.parse(delayed[0]!.reward!.value as string) : undefined;
    const keys = r ? Object.keys(r.data.rewards) : [];
    check(r?.data.source === 5 && r.data.sourceId === String(s1.id) && keys.length === 1 && keys[0] === p.sid,
      `${p.session.userName} gets reward.add_delayed for their own id (${delayed[0]?.reward?.value})`);
  }
  check(watcher.ext.length === 0, "spectator gets no end or reward");
  for (const viewer of all) for (const p of [owner, guest]) {
    check(viewer.vars.some((v) => v.u === p.session.userId && v.vars.con === null), `${viewer.session.userName} sees ${p.session.userName}'s con cleared`);
  }
  await sleep(0); // grants wait for the account lookup (already resolved here)
  check(JSON.stringify(grants) === JSON.stringify([
    { username: "owner", reward: { coins: 20, mascotXP: { AuntArctic: 15 } } },
    { username: "guest", reward: { coins: 10, mascotXP: { AuntArctic: 10 } } },
  ]), `rewards granted: ${JSON.stringify(grants)}`);
  check(sessionOf(owner.session) === undefined && sessionOf(guest.session) === undefined, "players free after end");
  for (const p of all) p.clear();
  endSession(s1, new Map([[owner.entry, 0]]));
  check(all.every((p) => p.ext.length === 0 && p.vars.length === 0) && grants.length === 2, "end is idempotent");
  await sleep(120);
  check(!fired, "timers cleared on end");

  // ---- ids increase; leaving; a throwing game balks ----
  const s2 = startPartyGame(2, [owner.entry, guest.entry])! as TestGame;
  check(s2.id === s1.id + 1, `ids increase (${s1.id} -> ${s2.id})`);
  unregister(guest.session);
  onPartyGamePlayerLeft(guest.session);
  check(s2.left.length === 1 && s2.left[0]!.entry === guest.entry && s2.left[0]!.left, "onPlayerLeft called once with the leaver marked");
  onPartyGamePlayerLeft(guest.session);
  check(s2.left.length === 1, "a second leave is ignored");
  for (const p of all) p.clear();
  s2.throwOnMessage = true;
  handlePartyGameMessage(msg(s2.id, 5, "{}"), ctxOf(owner));
  const balk = owner.extOf("pgame.end");
  check(balk.length === 1 && balk[0]!.results!.value === "[]", `a throwing game ends with empty results (${balk[0]?.results?.value})`);
  check(guest.ext.length === 0, "nothing sent to the player who left");
  check(grants.length === 2, "a balked game pays nothing");
  check(sessionOf(owner.session) === undefined, "owner free after balk");

  // ---- lobby-launched, team-slotted games (template 3: no player prop) ----
  const four = ["t0", "t1", "t2", "t3"].map((n) => makePlayer(n, ROOM));
  for (const p of four) p.clear();
  check(canStart(3), "template 3 (lobby-launched, no player prop) can start");
  check(!canStartWith(3, [four[0]!.entry]), "template 3 needs at least 2 players");
  const crowd = Array.from({ length: 21 }, (_, i) => makePlayer(`crowd${i}`, ROOM));
  check(!canStartWith(3, crowd.map((p) => p.entry)), "template 3 allows at most 20 players");
  const slots = [{ teamId: 0, roleId: 0 }, { teamId: 1, roleId: 0 }, { teamId: 0, roleId: 1 }, { teamId: 1, roleId: 1 }];
  const d = startPartyGame(3, four.map((p) => p.entry), slots)!;
  check(!!d && isInPartyGame(four[0]!.session), "isInPartyGame is true for a player in the game");
  const dst = four[0]!.extOf("pgame.start.v2")[0]?.players?.value as string;
  check(dst === `{"Players":[${four.map((p, i) => `{"TeamId":${slots[i]!.teamId},"UserSessionId":${p.sid},"RoleId":${slots[i]!.roleId}}`).join(",")}]}`,
    `pgame.start.v2 carries the slots: ${dst}`);
  check(four.every((p) => p.vars.length === 0), "no game prop is equipped when the template has none");
  check((d as TestGame).players.map((p) => `${p.teamId}/${p.roleId}`).join() === "0/0,1/0,0/1,1/1", "session players carry teamId/roleId");
  endSession(d, new Map([[four[0]!.entry, 0], [four[1]!.entry, 1]]));
  check(four.every((p) => !isInPartyGame(p.session)), "isInPartyGame is false after the end");
  check(four.every((p) => p.vars.length === 0), "no game prop is cleared at the end either");
} catch (err) {
  check(false, `threw: ${(err as Error).stack}`);
}
finish();
