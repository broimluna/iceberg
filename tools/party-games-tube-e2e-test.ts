// Tube races end to end: a real web API and game server. A moderator in Mt
// Blizzard opens the red and blue lobbies with :tuberace; two racers join red,
// race (moves + finish) and are paid by placement. Also the command's refusals.
import { makeChecker } from "./lib/harness.ts";
import { startServers, Client, sleep, coins } from "./lib/staff-client.ts";
import { decodeItemTuple } from "./lib/party-fakes.ts";
import { getPartyGame } from "../smartfox-server/src/party-games/definitions.ts";
import type { SFSValue } from "../smartfox-server/src/sfs-wire.ts";

const { check, finish } = makeChecker();
const until = async (cond: () => boolean, ms = 20000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(20); return cond(); };
const parseIds = (text: string) => JSON.parse(text.replace(/"(PlayerId|PlayerSessionId|UserSessionId)":(\d+)/g, '"$1":"$2"'));
const INT = 2; // SFS2X VariableType INT

const servers = await startServers({ sfsEnv: { PARTY_GAME_TIME_SCALE: "0.05" } });
const logs = () => servers.api.logs() + "\n" + servers.sfsLog();

const mod = new Client(servers, "{tre-mod}", "TreMod", "MtBlizzard");
const townMod = new Client(servers, "{tre-town}", "TreTown", "Town");
const R = ["r1", "r2"].map((n) => new Client(servers, `{tre-${n}}`, `Tre${n}`, "MtBlizzard"));
const everyone = [mod, townMod, ...R];
for (const c of everyone) await c.account();
await servers.setStaffAdmins([mod.username, townMod.username]);

const lobbyItems = () => {
  const out: { id: number; template: number; types: Record<string, number> }[] = [];
  for (const m of mod.mmo) if (m.a === 30 && m.p.q) for (const t of m.p.q.value as SFSValue[]) {
    const d = decodeItemTuple(t);
    const types = Object.fromEntries(((t.value as SFSValue[])[1]!.value as SFSValue[]).map((v) => { const e = v.value as SFSValue[]; return [e[0]!.value as string, e[1]!.value as number]; }));
    if (d.vars.category === 6) out.push({ id: d.id, template: d.vars.int_a as number, types });
  }
  return out;
};
const replied = (c: Client) => until(() => c.bubbles.length + c.errors.length > 0, 3000);
const locOf = (c: Client) => c.userVars.filter((x) => x.u === c.myId).flatMap((x) => x.vl).filter((e) => e[0]!.value === "loc").at(-1);
const red = getPartyGame(4)!.gameData as any;
const END: [number, number, number] = [red.RaceEndPosition.x, red.RaceEndPosition.y, red.RaceEndPosition.z];

try {
  for (const c of everyone) await c.connect();
  check(everyone.every((c) => c.myId > 0), "four players logged in");
  const before = R.map((c) => coins(servers.api.dbPath, c.username) ?? -1);

  // ---- the command ----
  await mod.chat(":tuberace green"); await replied(mod);
  check(mod.errors.some((e) => e.includes(":tuberace red|blue")), `a bad argument shows the usage (${mod.errors})`);
  await townMod.chat(":tuberace red"); await replied(townMod);
  check(townMod.errors.includes("Tube races run on Mt Blizzard"), `refused outside Mt Blizzard (${townMod.errors})`);
  await R[0]!.chat(":tuberace red"); await sleep(300);
  check(lobbyItems().length === 0 && mod.roomChats.includes(":tuberace red"), "a player's :tuberace is plain chat and opens nothing");
  mod.reset();
  await mod.chat(":tuberace red"); await replied(mod);
  check(mod.bubbles.some((b) => b.includes("Red tube race lobby opened")), `:tuberace red opens a lobby (${mod.bubbles}, ${mod.errors})`);
  mod.bubbles = []; mod.errors = [];
  await mod.chat(":tuberace red"); await replied(mod);
  check(mod.errors.includes("A lobby or game is already running here"), `a second red lobby is refused (${mod.errors})`);
  mod.bubbles = []; mod.errors = [];
  await mod.chat(":tuberace blue"); await replied(mod);
  check(mod.bubbles.some((b) => b.includes("Blue tube race lobby opened")), `blue opens alongside red (${mod.bubbles}, ${mod.errors})`);
  await until(() => lobbyItems().length === 2, 3000);
  const items = lobbyItems();
  const redItem = items.find((i) => i.template === 4)!;
  check(items.length === 2 && !!redItem && items.some((i) => i.template === 5), "the room sees both lobby items");
  check(items.every((i) => ["ttl", "int_a", "category", "creator"].every((k) => i.types[k] === INT)), `lobby ttl/int_a/category/creator are ints on the wire (${JSON.stringify(items.map((i) => i.types))})`);

  // ---- two racers join red ----
  for (const c of R) { c.interactItem(redItem.id); await sleep(60); }
  check(await until(() => R.every((c) => locOf(c)?.[2]?.value === 1), 3000) && R.every((c) => locOf(c)![1]!.value === INT), "joiners get loc Slide (1) as an int");

  // ---- the race ----
  check(await until(() => R.every((c) => c.ext.some((e) => e.cmd === "pgame.start.v2"))), "both racers get pgame.start.v2 when the lobby ends");
  const start = R[0]!.ext.find((e) => e.cmd === "pgame.start.v2")!.p;
  const sessionId = start.id!.value as number;
  check(start.template!.value === 4, `the red template starts (${start.template!.value})`);
  check(await until(() => R.every((c) => c.ext.some((e) => e.cmd === "pgame.message" && e.p.type!.value === 10))), "both racers get the layout message");
  check(await until(() => R.every((c) => locOf(c)?.[2]?.value === 7), 2000), "racers get loc Racing (7)");
  await sleep(150);
  R[0]!.move([END[0], END[1] + 5, END[2]]); R[0]!.move(END);
  await sleep(50);
  R[0]!.pgame(sessionId, 12, "{}");
  await sleep(150);
  R[1]!.move(END);
  await sleep(50);
  R[1]!.pgame(sessionId, 12, "{}");
  const resultsOf = (c: Client) => c.ext.filter((e) => e.cmd === "pgame.message" && e.p.type!.value === 13).map((e) => parseIds(e.p.message!.value as string));
  check(await until(() => R.every((c) => resultsOf(c).length === 2), 3000), "both racers get both results");
  const res = resultsOf(R[1]!);
  const r1 = res.find((r) => r.PlayerId === R[0]!.sid), r2 = res.find((r) => r.PlayerId === R[1]!.sid);
  check(!!r1 && !!r2 && r1.OverallScore > r2.OverallScore && r1.OverallScore === 400 - Math.floor(r1.CompletionTimeInMilliseconds / 100),
    `the faster racer scores higher (${JSON.stringify(res)})`);

  check(await until(() => R.every((c) => c.ext.some((e) => e.cmd === "pgame.end"))), "both racers get pgame.end");
  const end = parseIds(R[0]!.ext.find((e) => e.cmd === "pgame.end")!.p.results!.value as string) as { PlayerSessionId: string; Placement: number }[];
  check(end.find((e) => e.PlayerSessionId === R[0]!.sid)?.Placement === 0 && end.find((e) => e.PlayerSessionId === R[1]!.sid)?.Placement === 1, `r1 first, r2 second (${JSON.stringify(end)})`);
  check(R.every((c) => c.ext.some((e) => e.cmd === "reward.add_delayed")), "both racers get reward.add_delayed");
  await sleep(400);
  const after = R.map((c) => coins(servers.api.dbPath, c.username) ?? -1);
  check(after[0]! - before[0]! === 15 && after[1]! - before[1]! === 10, `coins moved by the placement rewards (${before} -> ${after})`);
  check(!mod.ext.some((e) => e.cmd === "pgame.end"), "the moderator watching gets no pgame.end");
} catch (err) {
  check(false, `threw: ${(err as Error).stack}`);
} finally {
  await servers.stop();
}
if (process.env.DEBUG_LOGS) console.log(logs());
finish(logs());
