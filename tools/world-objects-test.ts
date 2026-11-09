// Scheduled world objects (smartfox-server/src/world-objects.ts), from
// Disney's data: the Boardwalk geysers, one active at a time, the next one
// every cycleSeconds (non-repeating), late joiners get each item's real
// transition time, other zones get nothing, and a room's timers run only
// while someone is in it.
process.env.WORLD_OBJECTS_TIME_SCALE = "0.02"; // 17 s cycle -> 0.34 s
import { makeChecker } from "./lib/harness.ts";
import { makePlayer, decodeItemTuple, decodeItemVars, type FakePlayer } from "./lib/party-fakes.ts";
import { unregister } from "../smartfox-server/src/session-registry.ts";
import type { SFSValue } from "../smartfox-server/src/sfs-wire.ts";
import type { HandlerContext } from "../smartfox-server/src/handlers/context.ts";

const { ensureRoomWorldObjects, releaseRoomIfEmpty, worldObjectStats, sendWorldObjectsSnapshot } = await import("../smartfox-server/src/world-objects.ts");

const { check, finish } = makeChecker();
const quiet = console.log;
// The scheduler logs every state change with a [timestamp] prefix; drop those.
console.log = (...a: unknown[]) => { if (!(typeof a[0] === "string" && a[0].startsWith("["))) quiet(...a); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CYCLE_MS = 17 * 1000 * 0.02;
const room = (zone: string) => `Alpine:en_US:${zone}::1.15.1;offline;2026-11-07;NONE`;
const ctxOf = (p: FakePlayer) => ({ session: p.session, peer: p.entry.peer, send: p.entry.send }) as unknown as HandlerContext;
const changes = (p: FakePlayer) => p.mmo.filter((m) => m.a === 1007).map((m) => ({ i: m.p.i!.value as number, ...decodeItemVars(m.p.v!.value as SFSValue[]) }));
const snapshotItems = (p: FakePlayer) => p.mmo.filter((m) => m.a === 30 && m.p.q).flatMap((m) => (m.p.q!.value as SFSValue[]).map(decodeItemTuple));

try {
  const boardwalk = room("Boardwalk");
  const a = makePlayer("WoA", boardwalk);
  const state = ensureRoomWorldObjects(boardwalk);
  const items = [...state.items.values()];
  check(items.length === 8, `8 geysers (${items.length})`);
  check(items.filter((i) => i.state === 1).length === 1, "exactly one geyser active at once");
  check(items.every((i) => i.path.startsWith("/Minigames/AquaFunHut/GeyserLocations/")), "paths from Disney's data");

  // ---- the cycle ----
  const activations: string[] = [];
  let alwaysOne = true;
  for (let n = 0; n < 9; n++) {
    await sleep(CYCLE_MS);
    if ([...state.items.values()].filter((i) => i.state === 1).length !== 1) alwaysOne = false;
  }
  check(alwaysOne, "still exactly one active after every cycle");
  const byId = new Map(items.map((i) => [i.itemId, i.path]));
  const ch = changes(a);
  // The first change is the creation-time activation; then off/on pairs.
  check(ch[0]?.scheduledworldobjectstate === 1, "the first geyser goes active at creation");
  const cycles = ch.slice(1);
  check(cycles.length >= 16 && cycles.every((c, k) => c.scheduledworldobjectstate === (k % 2 === 0 ? 0 : 1)), `each cycle is off then on (${cycles.map((c) => c.scheduledworldobjectstate).join("")})`);
  check(ch.every((c) => Object.keys(c).sort().join() === "i,scheduledworldobjectstate,statetimestamp"), "a change carries only state and statetimestamp");
  for (const c of ch) if (c.scheduledworldobjectstate === 1) activations.push(byId.get(c.i)!);
  check(new Set(activations.slice(0, 8)).size === 8, `the first 8 activations are all 8 geysers (${activations.slice(0, 8).join(" ").replace(/\/Minigames\/AquaFunHut\/GeyserLocations\/GeyserLocation/g, "")})`);
  check(worldObjectStats().timers === 1, `one timer per group (${worldObjectStats().timers})`);

  // ---- late joiner ----
  await sleep(CYCLE_MS / 2); // mid-cycle: the active one switched well before the join
  const b = makePlayer("WoB", boardwalk);
  const before = Date.now();
  sendWorldObjectsSnapshot(ctxOf(b), boardwalk);
  const snap = snapshotItems(b);
  check(snap.length === 8, `late joiner gets all 8 (${snap.length})`);
  const live = new Map([...state.items.values()].map((i) => [i.itemId, i]));
  check(snap.every((s) => s.vars.statetimestamp === String(live.get(s.id)!.stateChangedMs)), "snapshot statetimestamp is each item's last transition");
  const activeSnap = snap.find((s) => s.vars.scheduledworldobjectstate === 1);
  check(!!activeSnap && Number(activeSnap.vars.statetimestamp) < before, "the active geyser's timestamp is from before the join");

  // ---- other zones ----
  for (const zone of ["Town", "MtBlizzard", "Diving"]) {
    const p = makePlayer(`Wo${zone}`, room(zone));
    sendWorldObjectsSnapshot(ctxOf(p), room(zone));
    check(ensureRoomWorldObjects(room(zone)).items.size === 0 && snapshotItems(p).length === 0, `${zone} gets no scheduled objects`);
    unregister(p.session);
    releaseRoomIfEmpty(room(zone));
  }

  // ---- release ----
  releaseRoomIfEmpty(boardwalk);
  check(worldObjectStats().rooms === 1, "room kept while players are in it");
  unregister(a.session);
  unregister(b.session);
  releaseRoomIfEmpty(boardwalk);
  const end = worldObjectStats();
  check(end.rooms === 0 && end.timers === 0, `empty room torn down (${JSON.stringify(end)})`);
  const c = makePlayer("WoC", boardwalk);
  check(ensureRoomWorldObjects(boardwalk).items.size === 8 && worldObjectStats().rooms === 1, "rejoining recreates the room's objects");
  unregister(c.session);
  releaseRoomIfEmpty(boardwalk);
} finally {
  console.log = quiet;
}
finish("");
