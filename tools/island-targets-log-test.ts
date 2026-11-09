// Island Targets log lines can't be forged by a player's name: names are
// written through logSafe (one line, control characters escaped). Dropped
// throws can't flood the log either: one line a second per player.
process.env.ISLAND_TARGETS_SCHEDULE = "off";
import { makeChecker } from "./lib/harness.ts";
import { makePlayer } from "./lib/party-fakes.ts";
import { unregister } from "../smartfox-server/src/session-registry.ts";

const { ensureRoomPlaygrounds, startGameNow, onIslandTargetThrow, releaseRoomPlaygroundsIfEmpty } = await import("../smartfox-server/src/island-targets/playground.ts");
const { check, finish } = makeChecker();
const quiet = console.log;
const lines: string[] = [];
console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };

const room = "Alpine:en_US:MtBlizzard::1.15.1;offline;2026-11-07;NONE";
const p = makePlayer("Evil\n[2026-01-01T00:00:00.000Z] [TARGETS] game won\x1b[2J", room);
let started = "";
try {
  ensureRoomPlaygrounds(room);
  started = startGameNow(room);
  p.session.lastPosition = [-3.65, -0.99, -4.41];
  // Before the round's Starts: logged (reason=early) without counting.
  onIslandTargetThrow(p.session, 4, [-3.65, -0.99, -4.41], [-3.65, -0.99, -4.41], [0, 5, 5]);
  // A flood of dropped throws logs at most one line a second per player.
  for (let i = 0; i < 200; i++) onIslandTargetThrow(p.session, 4, [-3.65, -0.99, -4.41], [-3.65, -0.99, -4.41], [0, 5, 5]);
} finally {
  console.log = quiet;
  unregister(p.session);
  releaseRoomPlaygroundsIfEmpty(room);
}
const throwLines = lines.filter((l) => l.includes("[TARGETS] throw"));
check(started === "started" && throwLines.length === 1, `the throw is logged, and 200 more dropped ones within the second aren't (${started}, ${throwLines.length})`);
check(throwLines.every((l) => !l.includes("\n") && !l.includes("\x1b")), "a name can't break the log line or send escapes");
check(throwLines.some((l) => l.includes("user=Evil\\n[2026")), `the name is escaped, not dropped (${JSON.stringify(throwLines[0])})`);
finish("");
