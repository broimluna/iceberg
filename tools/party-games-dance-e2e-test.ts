// Dance Battle end to end: a real web API and game server, a moderator who
// watches from the room and opens the lobby with :dancebattle, and four
// players who join by interacting with it. Team 0 plays perfectly, team 1
// plays wrong; the coins in the web API move by the placement rewards.
import { makeChecker } from "./lib/harness.ts";
import { startServers, Client, sleep, coins } from "./lib/staff-client.ts";
import { decodeItemTuple, decodeItemVars } from "./lib/party-fakes.ts";
import type { SFSValue } from "../smartfox-server/src/sfs-wire.ts";

const { check, finish } = makeChecker();
const until = async (cond: () => boolean, ms = 20000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(20); return cond(); };
const parseIds = (text: string) => JSON.parse(text.replace(/"(PlayerSessionId|UserSessionId)":(\d+)/g, '"$1":"$2"'));

const servers = await startServers({ sfsEnv: { PARTY_GAME_TIME_SCALE: "0.05" } });
const logs = () => servers.api.logs() + "\n" + servers.sfsLog();

const mod = new Client(servers, "{dbe-mod}", "DbeMod");
const P = ["a1", "a2", "b1", "b2"].map((n) => new Client(servers, `{dbe-${n}}`, `Dbe${n}`));
const everyone = [mod, ...P];
for (const c of everyone) await c.account();
await servers.setStaffAdmins([mod.username]);

// The latest value of an item variable as the moderator (a spectator) saw it.
const itemVar = (name: string): any => {
  let value: unknown;
  for (const m of mod.mmo) {
    if (m.a === 30 && m.p.q) for (const t of m.p.q.value as SFSValue[]) value = decodeItemTuple(t).vars[name] ?? value;
    if (m.a === 1007 && m.p.v) { const v = decodeItemVars(m.p.v.value as SFSValue[]); if (name in v) value = v[name]; }
  }
  return typeof value === "string" ? parseIds(value) : value;
};
const lobbyItemId = (): number | undefined => {
  for (const m of mod.mmo) if (m.a === 30 && m.p.q) for (const t of m.p.q.value as SFSValue[]) { const d = decodeItemTuple(t); if (d.vars.int_a === 3 && d.vars.category === 6) return d.id; }
};

try {
  for (const c of everyone) await c.connect();
  check(everyone.every((c) => c.myId > 0), "five players logged in");
  const before = P.map((c) => coins(servers.api.dbPath, c.username) ?? -1);

  // ---- the lobby ----
  mod.reset();
  await mod.chat(":dancebattle");
  await until(() => lobbyItemId() !== undefined);
  const lobbyId = lobbyItemId()!;
  check(mod.bubbles.some((b) => b.includes("Dance Battle lobby opened")), `:dancebattle answers (${mod.bubbles})`);
  check(P.every((c) => c.mmo.some((m) => m.a === 30 && m.p.q)), "every player sees the lobby item");
  for (const c of P) { c.interactItem(lobbyId); await sleep(60); }
  await until(() => itemVar("score")?.Players?.length === 4, 3000);
  const roster = itemVar("score").Players as { TeamId: number; RoleId: number; UserSessionId: string }[];
  const teamOf = (c: Client) => roster.find((p) => p.UserSessionId === c.sid)?.TeamId;
  check(roster.length === 4 && P.filter((c) => teamOf(c) === 0).length === 2 && P.filter((c) => teamOf(c) === 1).length === 2,
    `four joiners are split 2 and 2 (${JSON.stringify(roster)})`);

  // ---- the lobby ends and the game starts ----
  check(await until(() => P.every((c) => c.ext.some((e) => e.cmd === "pgame.start.v2"))), "when the lobby runs out every player gets pgame.start.v2");
  check(!mod.ext.some((e) => e.cmd === "pgame.start.v2"), "the moderator watching from the room doesn't");
  const start = P[0]!.ext.find((e) => e.cmd === "pgame.start.v2")!.p;
  const sessionId = start.id!.value as number;
  const startPlayers = parseIds(start.players!.value as string).Players as { TeamId: number; UserSessionId: string }[];
  check(startPlayers.every((p) => p.TeamId === teamOf(P.find((c) => c.sid === p.UserSessionId)!)), "pgame.start.v2 carries the lobby's teams");
  check(await until(() => itemVar("turn")?.Moves !== undefined, 5000), "the game item shows up for the watcher");

  // ---- four rounds: team 0 perfect, team 1 wrong ----
  const displaySeconds = [10, 12, 13, 14]; // data: SequenceDisplayTimeInSeconds, x0.05 below
  for (let round = 0; round < 4; round++) {
    await until(() => itemVar("turn")?.RoundNum === round, 10000);
    const turn = itemVar("turn");
    await sleep(displaySeconds[round]! * 50 + 120); // let the sequence display finish, then input opens
    for (const m of turn.Moves as number[]) {
      for (const c of P) c.pgame(sessionId, 5, `{"PlayerId":${c.sid},"ScoreDelta":${teamOf(c) === 0 ? m : (m % 3) + 1}}`);
    }
    await until(() => itemVar("score")?.Team1Score === round + 1, 10000);
    check(itemVar("score").Team1Score === round + 1 && itemVar("score").Team2Score === 0, `round ${round} scored: team 0 ${itemVar("score").Team1Score}, team 1 ${itemVar("score").Team2Score}`);
  }

  // ---- the end ----
  check(await until(() => P.every((c) => c.ext.some((e) => e.cmd === "pgame.end"))), "every player gets pgame.end");
  const end = parseIds(P[0]!.ext.find((e) => e.cmd === "pgame.end")!.p.results!.value as string) as { PlayerSessionId: string; Placement: number }[];
  check(P.every((c) => end.find((e) => e.PlayerSessionId === c.sid)?.Placement === (teamOf(c) === 0 ? 0 : 1)), `team 0 first, team 1 second (${JSON.stringify(end)})`);
  check(!mod.ext.some((e) => e.cmd === "pgame.end"), "the watcher gets no pgame.end");
  await sleep(400);
  const after = P.map((c) => coins(servers.api.dbPath, c.username) ?? -1);
  check(P.every((c, i) => after[i]! - before[i]! === (teamOf(c) === 0 ? 20 : 10)), `coins moved by the placement rewards (${before} -> ${after})`);
  check(await until(() => mod.mmo.some((m) => m.a === 30 && m.p.n), 5000), "the game item is removed afterwards");

  // ---- and the room can run another ----
  mod.reset();
  await mod.chat(":dancebattle");
  await until(() => mod.bubbles.length + mod.errors.length > 0, 3000);
  check(mod.bubbles.some((b) => b.includes("Dance Battle lobby opened")), `a new lobby can open (${mod.bubbles}, ${mod.errors})`);
} catch (err) {
  check(false, `threw: ${(err as Error).stack}`);
} finally {
  await servers.stop();
}
if (process.env.DEBUG_LOGS) console.log(logs());
finish(logs());
