// Scheduled world objects (smartfox-server/src/world-objects.ts): a room's
// geyser/light timers run only while someone is in the room, and a running
// room's timer bookkeeping doesn't grow with every state change.
import { makeChecker } from "./lib/harness.ts";
import { ensureRoomWorldObjects, releaseRoomIfEmpty, worldObjectStats } from "../smartfox-server/src/world-objects.ts";
import { register, unregister } from "../smartfox-server/src/session-registry.ts";
import { Session } from "../smartfox-server/src/session.ts";

const { check, finish } = makeChecker();
const quiet = console.log;
// The scheduler logs every state change with a [timestamp] prefix; drop those.
console.log = (...a: unknown[]) => { if (!(typeof a[0] === "string" && a[0].startsWith("["))) quiet(...a); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  const room = "Alpine:en_US:Town::1.15.1;offline;2026-11-07;NONE";
  const player = new Session();
  player.roomName = room;
  register({ session: player, peer: "test", send: () => {} });

  ensureRoomWorldObjects(room);
  const start = worldObjectStats();
  check(start.rooms === 1 && start.timers > 0, `room created with timers (${JSON.stringify(start)})`);

  // Town lights flip every 2 s: after a few flips the live timer count must
  // be unchanged (fired timers are dropped, not kept forever).
  await sleep(4500);
  const later = worldObjectStats();
  check(later.timers === start.timers, `timer count stays flat while running (${start.timers} -> ${later.timers})`);

  releaseRoomIfEmpty(room);
  check(worldObjectStats().rooms === 1, "room kept while a player is still in it");

  unregister(player);
  releaseRoomIfEmpty(room);
  const end = worldObjectStats();
  check(end.rooms === 0 && end.timers === 0, `empty room torn down (${JSON.stringify(end)})`);

  // A later join starts fresh.
  register({ session: player, peer: "test", send: () => {} });
  check(ensureRoomWorldObjects(room).items.size > 0 && worldObjectStats().rooms === 1, "rejoining recreates the room's objects");
  unregister(player);
  releaseRoomIfEmpty(room);
} finally {
  console.log = quiet;
}
finish("");
