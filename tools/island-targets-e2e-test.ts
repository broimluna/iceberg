// Island Targets (Crate Co, Mt Blizzard) end to end: a real web API and game
// server at ISLAND_TARGETS_TIME_SCALE 0.2 with the schedule off. A moderator
// starts games with :crateco; a player throws snowballs (l.a LaunchThrow)
// aimed with the server's own trajectory rules; the server counts hits,
// advances rounds, pays the final win and keeps the room's win streak.
import { makeChecker } from "./lib/harness.ts";
import { startServers, Client, sleep, coins } from "./lib/staff-client.ts";
import { decodeItemVars } from "./lib/party-fakes.ts";
import { SFSObjectWriter, type SFSValue } from "../smartfox-server/src/sfs-wire.ts";
import { traceThrow, HAND_OFFSET_Y } from "../smartfox-server/src/island-targets/rules.ts";
import data from "../smartfox-server/data/world-objects.json" with { type: "json" };

type V3 = [number, number, number];
const SCALE = 0.2;
const INT = 2, STRING = 4; // SFS2X VariableType
const { check, finish } = makeChecker();
const until = async (cond: () => boolean, ms = 15000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(10); return cond(); };
const pg = (data as any).islandTargets.MtBlizzard[0];
const ZONE: V3 = pg.rewardsVolume.center;
const phaseByPath = new Map<string, any>();
const supersetOf = new Map<string, any>();
for (const s of pg.supersets) for (const ph of s.phases) { phaseByPath.set(ph.path, ph); supersetOf.set(ph.path, s); }
const targetByPath = new Map<string, any>();
for (const ph of phaseByPath.values()) for (const t of ph.targets) targetByPath.set(t.path, t);

const servers = await startServers({ sfsEnv: { ISLAND_TARGETS_SCHEDULE: "off", ISLAND_TARGETS_TIME_SCALE: String(SCALE) } });
const logs = () => servers.sfsLog();

// ---- a client's view of the room items, replayed from its a=30 / a=1007 ----
interface Item { id: number; vars: Record<string, unknown>; types: Record<string, number> }
function view(c: Client): Map<number, Item> {
  const live = new Map<number, Item>();
  for (const m of c.mmo) {
    if (m.a === 30) {
      for (const t of (m.p.q?.value as SFSValue[] | undefined) ?? []) {
        const [id, vl] = t.value as SFSValue[];
        const entries = (vl!.value as SFSValue[]).map((e) => e.value as SFSValue[]);
        live.set(id!.value as number, {
          id: id!.value as number, vars: decodeItemVars(vl!.value as SFSValue[]),
          types: Object.fromEntries(entries.map((e) => [e[0]!.value as string, e[1]!.value as number])),
        });
      }
      for (const id of (m.p.n?.value as number[] | undefined) ?? []) live.delete(id);
    } else if (m.p.i) {
      const item = live.get(m.p.i.value as number);
      if (item) Object.assign(item.vars, decodeItemVars(m.p.v!.value as SFSValue[]));
    }
  }
  return live;
}
const ofCategory = (c: Client, cat: number) => [...view(c).values()].filter((i) => i.vars.category === cat);
const stats = (c: Client) => ofCategory(c, 5)[0];
const group = (c: Client) => ofCategory(c, 4)[0];
const targets = (c: Client) => ofCategory(c, 3);
const updatesFor = (c: Client, id: number) => c.mmo.filter((m) => m.a === 1007 && m.p.i?.value === id).length;

function launchThrow(c: Client, p: V3, v: V3) {
  c.ext13("l.a", new SFSObjectWriter().putFloatArray("p", p).putByte("a", 4).putFloatArray("d", [0, 0, 1]).putFloatArray("v", v));
}
// A launch from p that the server's rules say hits `aim` first among `live`.
function aimAt(p: V3, aim: any, live: any[], minFlight = 0.8): V3 {
  const o: V3 = [p[0], p[1] + HAND_OFFSET_Y, p[2]];
  const spheres = live.map((t) => ({ path: t.path, center: t.hitSphere.center, radius: t.hitSphere.radius }));
  for (let T = minFlight; T <= 2.6; T += 0.1) {
    const c = aim.hitSphere.center;
    const v: V3 = [(c[0] - o[0]) / T, (c[1] - o[1] + 4.905 * T * T) / T, (c[2] - o[2]) / T];
    if (Math.hypot(...v) < 19 && traceThrow(p, v, spheres).hit?.path === aim.path) return v;
  }
  throw new Error(`no clean throw at ${aim.path}`);
}
const liveTargets = (c: Client) => targets(c).filter((t) => (t.vars.actioncount as number) < (t.vars.int_a as number)).map((t) => targetByPath.get(t.vars.path as string));
const idOf = (c: Client, path: string) => targets(c).find((t) => t.vars.path === path)!.id;
const countOf = (c: Client, path: string) => targets(c).find((t) => t.vars.path === path)?.vars.actioncount as number | undefined;
const waitStarts = async (c: Client) => { const s = Number(group(c)!.vars.timestamp); while (Date.now() < s + 20) await sleep(5); };
const GAP = 400 * SCALE + 10;

// Lands every hit on every target of the current phase, from p, one throw
// per rate gap (not waiting for each count: the final 40-hit target has
// only 30 s). Returns when the phase's items are gone.
async function clearPhase(c: Client, watcher: Client, p: V3) {
  const g = group(watcher)!;
  await waitStarts(watcher);
  const end = Number(g.vars.statetimestamp) + 500;
  while (view(watcher).has(g.id) && Date.now() < end) {
    const live = liveTargets(watcher);
    if (live.length > 0) launchThrow(c, p, aimAt(p, live[0], live));
    await sleep(GAP);
  }
  await until(() => !view(watcher).has(g.id), 3000);
}

const mod = new Client(servers, "{it-mod}", "ItMod", "MtBlizzard");
const townMod = new Client(servers, "{it-town}", "ItTown", "Town");
const P1 = new Client(servers, "{it-p1}", "ItP1", "MtBlizzard");
const P2 = new Client(servers, "{it-p2}", "ItP2", "MtBlizzard");
const L = new Client(servers, "{it-late}", "ItLate", "MtBlizzard");
for (const c of [mod, townMod, P1, P2, L]) await c.account();
await servers.setStaffAdmins([mod.username, townMod.username]);
const replied = (c: Client) => until(() => c.bubbles.length + c.errors.length > 0, 3000);
const command = async (c: Client, text: string) => { c.bubbles = []; c.errors = []; await c.chat(text); await replied(c); };

try {
  for (const c of [mod, townMod, P1, P2]) await c.connect();
  check([mod, townMod, P1, P2].every((c) => c.myId > 0), "four players logged in");

  // ---- the stats item on join ----
  await until(() => !!stats(P1) && !!stats(P2));
  const s0 = stats(P1);
  check(s0?.vars.path === pg.path && s0.vars.int_a === 0 && s0.vars.actioncount === 0 && s0.vars.creator === 0, `joiners get the playground stats item (${JSON.stringify(s0?.vars)})`);
  check(s0?.types.int_a === INT && s0.types.actioncount === INT && s0.types.path === STRING, "stats variable types");
  check(view(P1).size === 1 && !stats(townMod), "nothing else in Mt Blizzard yet, nothing in Town");

  // ---- the command ----
  await P1.chat(":crateco"); await sleep(400);
  check(!group(P1) && mod.roomChats.includes(":crateco"), "a player's :crateco is plain chat and starts nothing");
  await command(townMod, ":crateco");
  check(townMod.errors.includes("Crate Co targets run on Mt Blizzard"), `refused outside Mt Blizzard (${townMod.errors})`);

  // Three players stand in the reward zone (only P1 will hit).
  const p: V3 = [ZONE[0], ZONE[1], ZONE[2]];
  for (const c of [mod, P1, P2]) c.move(p);
  await sleep(200);
  await command(mod, ":crateco");
  check(mod.bubbles.some((b) => b.includes("Crate Co targets started")), `:crateco starts a game (${mod.bubbles}, ${mod.errors})`);
  await command(mod, ":crateco");
  check(mod.errors.includes("A Crate Co game is already running here"), `a second :crateco is refused (${mod.errors})`);

  // ---- phase 1: wire ----
  await until(() => !!group(P1) && targets(P1).length > 0);
  const g1 = group(P1)!;
  const phase1 = phaseByPath.get(g1.vars.path as string);
  const superset = supersetOf.get(g1.vars.path as string);
  check(!!phase1, `the group is a phase from the data (${g1.vars.path})`);
  const starts = Number(g1.vars.timestamp), expires = Number(g1.vars.statetimestamp);
  check(g1.types.timestamp === STRING && g1.types.statetimestamp === STRING && g1.types.path === STRING && g1.vars.creator === 0, "group variable types");
  check(Math.abs(expires - starts - phase1.sessionSeconds * 1000 * SCALE) < 2, `Expires - Starts = sessionSeconds (${expires - starts})`);
  check(starts - Date.now() < 3000 * SCALE && starts - Date.now() > -200, `Starts is about 3 s (scaled) after the add (${starts - Date.now()})`);
  const firstQ = P1.mmo.find((m) => m.a === 30 && (m.p.q?.value as SFSValue[] | undefined)?.some((t) => decodeItemVars(((t.value as SFSValue[])[1]!.value as SFSValue[])).category === 4));
  const firstCats = ((firstQ?.p.q?.value as SFSValue[]) ?? []).map((t) => decodeItemVars(((t.value as SFSValue[])[1]!.value as SFSValue[])).category);
  check(firstCats[0] === 4, `the group arrives before its targets (${firstCats})`);
  const t1 = targets(P1);
  check(t1.length === phase1.targets.length, `all of the phase's targets (${t1.length}/${phase1.targets.length})`);
  check(t1.every((t) => t.vars.actioncount === 0 && t.types.int_a === INT && t.types.actioncount === INT && t.vars.creator === 0), "targets start at 0 hits, INT variables");
  check(t1.every((t) => t.vars.int_a === Math.max(targetByPath.get(t.vars.path as string).minHits, 3)), `HP = max(minHits, 3 players in the zone) (${t1.map((t) => t.vars.int_a)})`);

  // ---- guards ----
  await waitStarts(P1);
  const aim0 = liveTargets(P1)[0];
  const v0 = aimAt(p, aim0, liveTargets(P1));
  // Dropped throws are logged at most once a (scaled) second each.
  const DROP_LOG = 1000 * SCALE + 30;
  launchThrow(P1, p, v0);
  launchThrow(P1, p, v0); // straight after: rate
  await sleep(Math.max(GAP, DROP_LOG));
  launchThrow(P1, p, [0, 0, 25]); // speed
  await sleep(DROP_LOG);
  launchThrow(P1, [p[0] + 4, p[1], p[2]], v0); // drift
  await sleep(300);
  check(countOf(P1, aim0.path) === 1, `only the first of the guarded throws counts (${countOf(P1, aim0.path)})`);
  check(/\[TARGETS\] throw user=\S+ .*hit=no reason=rate/.test(logs()), "a rate-limited throw is logged");
  check(/\[TARGETS\] throw user=\S+ .*hit=no reason=speed/.test(logs()), "a too-fast throw is logged");
  check(/\[TARGETS\] throw user=\S+ .*hit=no reason=drift/.test(logs()), "a drifted throw is logged");
  check(/\[TARGETS\] throw user=\S+ nearest=\/Minigames.* dist=-?[\d.]+ t=[\d.]+ hit=yes/.test(logs()), "a counted throw is logged with nearest, dist and t");
  P1.move(p); await sleep(GAP);

  // ---- a target at capacity takes no more hits ----
  const capId = idOf(P1, aim0.path);
  while ((countOf(P1, aim0.path) ?? 0) < (targets(P1).find((t) => t.id === capId)!.vars.int_a as number)) {
    const before = countOf(P1, aim0.path)!;
    launchThrow(P1, p, aimAt(p, aim0, liveTargets(P1)));
    await until(() => countOf(P1, aim0.path)! > before, 2000);
    await sleep(GAP);
  }
  const capUpdates = updatesFor(P1, capId);
  const others = liveTargets(P1);
  const vDead = aimAt(p, aim0, [aim0]); // aimed at the downed target only
  if (!traceThrow(p, vDead, others.map((t) => ({ path: t.path, center: t.hitSphere.center, radius: t.hitSphere.radius }))).hit) {
    launchThrow(P1, p, vDead);
    await sleep(400);
    check(updatesFor(P1, capId) === capUpdates, "a downed target gets no more updates");
  } else check(true, "a downed target gets no more updates (skipped: the throw would hit another target)");
  await sleep(GAP);

  // ---- phase 1 cleared -> phase 2 ----
  await clearPhase(P1, P1, p);
  check(!view(P1).has(g1.id) && t1.some((t) => view(P1).has(t.id)), "a won round's group goes at once, its fallen targets stay up");
  await until(() => t1.every((t) => !view(P1).has(t.id)), 3000);
  check(t1.every((t) => !view(P1).has(t.id)), "and the targets go after the linger");
  await until(() => !!group(P1), 3000 + 3000 * SCALE);
  const g2 = group(P1);
  check(g2?.vars.path === superset.phases[1].path, `the next phase follows (${g2?.vars.path})`);

  // ---- late joiner ----
  await waitStarts(P1);
  const aim2 = liveTargets(P1)[0];
  launchThrow(P1, p, aimAt(p, aim2, liveTargets(P1)));
  await until(() => countOf(P1, aim2.path) === 1, 2000);
  await L.connect();
  await until(() => !!group(L));
  check(group(L)?.vars.path === g2?.vars.path && countOf(L, aim2.path) === 1 && targets(L).length === targets(P1).length, `a late joiner gets the live group and targets with their counts (${countOf(L, aim2.path)})`);
  check(!!stats(L), "and the stats item");
  await sleep(GAP);

  // ---- the rest, to the final win ----
  const coinsBefore = coins(servers.api.dbPath, P1.username) ?? -1;
  const p2Before = coins(servers.api.dbPath, P2.username) ?? -1;
  for (let i = 1; i < superset.phases.length; i++) {
    if (i > 1) await until(() => group(P1)?.vars.path === superset.phases[i].path, 3000 + 3000 * SCALE);
    await clearPhase(P1, P1, p);
  }
  await until(() => P1.ext.some((e) => e.cmd === "reward.add_delayed"), 3000);
  const rewards = P1.ext.filter((e) => e.cmd === "reward.add_delayed").map((e) => JSON.parse(e.p.reward!.value as string));
  check(rewards.length === 1 && rewards[0].data.source === 5 && rewards[0].data.sourceId === "Targets", `the hitter gets reward.add_delayed source 5 "Targets" (${JSON.stringify(rewards)})`);
  check(JSON.stringify(rewards[0]?.data.rewards[P1.sid]) === JSON.stringify({ coins: 100, mascotXP: { AuntArctic: 40 } }), `alone, the whole reward (${JSON.stringify(rewards[0]?.data.rewards)})`);
  check([mod, P2, L].every((c) => !c.ext.some((e) => e.cmd === "reward.add_delayed")), "players who didn't hit, or weren't in the zone, get nothing");
  await until(() => (coins(servers.api.dbPath, P1.username) ?? -1) === coinsBefore + 100, 3000);
  check((coins(servers.api.dbPath, P1.username) ?? -1) === coinsBefore + 100, `the hitter's coins rose by 100 (${coinsBefore} -> ${coins(servers.api.dbPath, P1.username)})`);
  check((coins(servers.api.dbPath, P2.username) ?? -1) === p2Before, "the stander's coins didn't change");
  await until(() => stats(P1)?.vars.int_a === 1);
  check(stats(P1)?.vars.int_a === 1 && stats(P1)?.vars.actioncount === 1, `win streak 1, best today 1 (${JSON.stringify(stats(P1)?.vars)})`);
  await until(() => !group(P1) && targets(P1).length === 0, 3000);

  // ---- timeout ----
  await command(mod, ":crateco");
  check(mod.bubbles.some((b) => b.includes("Crate Co targets started")), `a new game starts after the win (${mod.errors})`);
  await until(() => !!group(P1));
  const gt = group(P1)!;
  const tExpires = Number(gt.vars.statetimestamp);
  await until(() => !view(P1).has(gt.id), tExpires - Date.now() + 2000);
  check(!view(P1).has(gt.id) && targets(P1).length === 0, "a timed-out round's items are removed");
  await until(() => stats(P1)?.vars.int_a === 0, 1000);
  check(stats(P1)?.vars.int_a === 0 && stats(P1)?.vars.actioncount === 1, `the streak resets, best today stays (${JSON.stringify(stats(P1)?.vars)})`);

  // ---- a throw landing after Expires doesn't count ----
  await command(mod, ":crateco");
  await until(() => !!group(P1));
  const gl = group(P1)!;
  const lExpires = Number(gl.vars.statetimestamp);
  const lateAim = liveTargets(P1)[0];
  const lateId = idOf(P1, lateAim.path);
  const vLate = aimAt(p, lateAim, liveTargets(P1), 1.6); // ~0.24 s of scaled flight
  while (Date.now() < lExpires - 80) await sleep(5);
  P1.move(p);
  await sleep(GAP);
  launchThrow(P1, p, vLate);
  await until(() => !view(P1).has(gl.id), 2000);
  await sleep(400);
  check(P1.mmo.filter((m) => m.a === 1007 && m.p.i?.value === lateId).length === 0, "a hit landing after the round expired isn't counted");

  // ---- an emptied room drops its game ----
  await command(mod, ":crateco");
  await until(() => !!group(P1));
  for (const c of [mod, P1, P2, L]) c.disconnect();
  await sleep(500);
  P2.reset(); P2.mmo = [];
  await P2.connect();
  await until(() => !!stats(P2));
  check(!!stats(P2) && !group(P2) && targets(P2).length === 0, "a fresh joiner of an emptied room gets only the stats item");
  check(stats(P2)?.vars.int_a === 0 && stats(P2)?.vars.actioncount === 0, `with a fresh streak (${JSON.stringify(stats(P2)?.vars)})`);
} catch (err) {
  check(false, `threw: ${(err as Error).stack}`);
} finally {
  await servers.stop();
  // TARGETS_E2E_LOG=<file> keeps the game server's whole log.
  if (process.env.TARGETS_E2E_LOG) await Bun.write(process.env.TARGETS_E2E_LOG, logs());
}
finish(logs());

