// Island Targets rewards and the end of a won round, in-process with fake
// players at ISLAND_TARGETS_TIME_SCALE 0.02:
//  - one account is paid once per game however many sessions it has, and
//    the share is split by distinct paid accounts;
//  - a player without a session id or a verified account doesn't shrink the share;
//  - an account paid in one room isn't paid again in another room's game
//    within the same schedule window;
//  - a won round's group goes at once (a joiner in the 2 s linger must not
//    see a live group whose removal the client reads as a timeout).
process.env.ISLAND_TARGETS_SCHEDULE = "off";
process.env.ISLAND_TARGETS_TIME_SCALE = "0.02";
import { makeChecker } from "./lib/harness.ts";
import { makePlayer, decodeItemVars, type FakePlayer } from "./lib/party-fakes.ts";
import { unregister } from "../smartfox-server/src/session-registry.ts";
import { traceThrow, HAND_OFFSET_Y } from "../smartfox-server/src/island-targets/rules.ts";
import type { SFSValue } from "../smartfox-server/src/sfs-wire.ts";
import type { HandlerContext } from "../smartfox-server/src/handlers/context.ts";
import data from "../smartfox-server/data/world-objects.json" with { type: "json" };

const T = await import("../smartfox-server/src/island-targets/playground.ts");
const { sendRoomItemsSnapshot } = await import("../smartfox-server/src/party-games/room-items.ts");
const { check, finish } = makeChecker();
const quiet = console.log;
console.log = (...a: unknown[]) => { if (!(typeof a[0] === "string" && a[0].startsWith("["))) quiet(...a); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(2); return cond(); };

type V3 = [number, number, number];
const pg = (data as any).islandTargets.MtBlizzard[0];
const ZONE: V3 = pg.rewardsVolume.center;
const targetByPath = new Map<string, any>();
for (const s of pg.supersets) for (const ph of s.phases) for (const t of ph.targets) targetByPath.set(t.path, t);
const lastPhasePaths = new Set(pg.supersets.map((s: any) => s.phases.at(-1).path));

const paid: { account: string; coins: number }[] = [];
T.setTargetsRewardGranter((account, reward) => { paid.push({ account, coins: reward.coins ?? 0 }); });

interface Item { id: number; vars: Record<string, unknown> }
function view(f: FakePlayer): Map<number, Item> {
  const live = new Map<number, Item>();
  for (const m of f.mmo) {
    if (m.a === 30) {
      for (const t of (m.p.q?.value as SFSValue[] | undefined) ?? []) {
        const [id, vl] = t.value as SFSValue[];
        live.set(id!.value as number, { id: id!.value as number, vars: decodeItemVars(vl!.value as SFSValue[]) });
      }
      for (const id of (m.p.n?.value as number[] | undefined) ?? []) live.delete(id);
    } else if (m.p.i) {
      const item = live.get(m.p.i.value as number);
      if (item) Object.assign(item.vars, decodeItemVars(m.p.v!.value as SFSValue[]));
    }
  }
  return live;
}
const group = (f: FakePlayer) => [...view(f).values()].find((i) => i.vars.category === 4);
const liveTargets = (f: FakePlayer) => [...view(f).values()]
  .filter((i) => i.vars.category === 3 && (i.vars.actioncount as number) < (i.vars.int_a as number))
  .map((i) => targetByPath.get(i.vars.path as string));
// A launch from p hitting some live target first (some are always behind others from p).
function aimAny(p: V3, live: any[]): V3 {
  for (const t of live) {
    try { return aimAt(p, t, live); } catch { /* blocked from here */ }
  }
  throw new Error(`no clean throw at any of ${live.length} targets`);
}
function aimAt(p: V3, aim: any, live: any[]): V3 {
  const o: V3 = [p[0], p[1] + HAND_OFFSET_Y, p[2]];
  const spheres = live.map((t) => ({ path: t.path, center: t.hitSphere.center, radius: t.hitSphere.radius }));
  for (let t = 0.8; t <= 2.6; t += 0.1) {
    const c = aim.hitSphere.center;
    const v: V3 = [(c[0] - o[0]) / t, (c[1] - o[1] + 4.905 * t * t) / t, (c[2] - o[2]) / t];
    if (Math.hypot(...v) < 19 && traceThrow(p, v, spheres).hit?.path === aim.path) return v;
  }
  throw new Error(`no clean throw at ${aim.path}`);
}
const throwFrom = (f: FakePlayer, v: V3) => T.onIslandTargetThrow(f.session, 4, ZONE, ZONE, v);
const inZone = (...fs: FakePlayer[]) => { for (const f of fs) f.session.lastPosition = [...ZONE]; };

// Plays a whole game in `room` (watched by `w`); each of `throwers` lands at
// least one hit per phase. Returns once the final round's items are gone.
async function playGame(room: string, w: FakePlayer, throwers: FakePlayer[], onFinalWin?: () => void) {
  check(T.startGameNow(room) === "started", `a game starts in ${room.split(":")[1]}`);
  for (;;) {
    await until(() => !!group(w));
    const g = group(w)!;
    while (Date.now() < Number(g.vars.timestamp) + 2) await sleep(1);
    let k = 0;
    while (view(w).has(g.id) && liveTargets(w).length > 0) {
      const live = liveTargets(w);
      throwFrom(throwers[k++ % throwers.length]!, aimAny(ZONE, live));
      await sleep(400 * 0.02 + 4);
    }
    const final = lastPhasePaths.has(g.vars.path);
    if (final) onFinalWin?.();
    await until(() => !view(w).has(g.id), 3000);
    if (final) {
      await until(() => [...view(w).values()].every((i) => i.vars.category === 5), 3000);
      return;
    }
  }
}

const roomA = "Alpine:en_US:MtBlizzard::1.15.1;offline;2026-11-07;NONE";
const roomB = "Beta:en_US:MtBlizzard::1.15.1;offline;2026-11-07;NONE";
const fakes: FakePlayer[] = [];
const fake = (name: string, room: string, account = name) => { const f = makePlayer(name, room); f.session.accountName = account; fakes.push(f); return f; };

try {
  // ---- one account, two sessions; a player with no session id; one with no account ----
  const a1 = fake("RwA1", roomA, "rw-alice");
  const a2 = fake("RwA2", roomA, "rw-alice");
  const bob = fake("RwBob", roomA, "rw-bob");
  const ghost = fake("RwGhost", roomA);
  ghost.session.playerSessionId = undefined as unknown as string;
  const anon = fake("RwAnon", roomA);
  anon.session.accountName = undefined;
  inZone(a1, a2, bob, ghost, anon);
  T.ensureRoomPlaygrounds(roomA);

  let lingerJoiner: FakePlayer | undefined;
  await playGame(roomA, a1, [a1, a2, bob, ghost, anon], () => {
    // ---- a joiner during the won final round's linger ----
    lingerJoiner = fake("RwLate", roomA);
    sendRoomItemsSnapshot({ session: lingerJoiner.session, peer: "late", send: lingerJoiner.entry.send } as unknown as HandlerContext, roomA);
  });
  await sleep(50);
  const lingerSnapshot = (lingerJoiner?.mmo.find((m) => m.a === 30 && m.p.q)?.p.q?.value as SFSValue[] | undefined) ?? [];
const lingerCats = lingerSnapshot.map((t) => decodeItemVars(((t.value as SFSValue[])[1]!.value as SFSValue[])).category);
check(!!lingerJoiner && lingerCats.length > 0 && !lingerCats.includes(4), `a joiner during the won round's linger gets no live group (${lingerCats})`);
  const byAccount = (acc: string) => paid.filter((x) => x.account === acc);
  check(byAccount("rw-alice").length === 1, `two sessions of one account are paid once (${byAccount("rw-alice").length})`);
  check(byAccount("rw-bob").length === 1, "the other hitter is paid");
  check(paid.length === 2 && paid.every((x) => x.coins === 50), `the share is split between 2 accounts, 50 each (${JSON.stringify(paid)})`);
  const delayed = (f: FakePlayer) => f.extOf("reward.add_delayed").map((p) => JSON.parse(p.reward!.value as string));
  check(delayed(a1).length + delayed(a2).length === 1, `one reward.add_delayed for the account (${delayed(a1).length}+${delayed(a2).length})`);
  check(delayed(ghost).length === 0 && delayed(anon).length === 0, "no reward shown to a player without a session id or account");

  // ---- the same account wins in another room in the same window ----
  const a3 = fake("RwA3", roomB, "rw-alice");
  const carol = fake("RwCarol", roomB, "rw-carol");
  inZone(a3, carol);
  T.ensureRoomPlaygrounds(roomB);
  await playGame(roomB, a3, [a3, carol]);
  check(byAccount("rw-alice").length === 1, `an account paid in one room isn't paid again in another this window (${byAccount("rw-alice").length})`);
  check(byAccount("rw-carol").length === 1 && byAccount("rw-carol")[0]!.coins === 100, `the other winner gets the whole reward (${JSON.stringify(byAccount("rw-carol"))})`);
  check(delayed(a3).length === 0, "and the repeat account is shown nothing");
} catch (err) {
  check(false, `threw: ${(err as Error).stack}`);
} finally {
  console.log = quiet;
  for (const f of fakes) unregister(f.session);
  T.releaseRoomPlaygroundsIfEmpty(roomA);
  T.releaseRoomPlaygroundsIfEmpty(roomB);
}
finish("");
