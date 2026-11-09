// smartfox-server/src/world-data.ts (the world-objects.json loader) and
// selection.ts (the client's SelectionBehaviour picks).
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeChecker } from "./lib/harness.ts";
import { loadWorldData, scheduledGroups, playgrounds, contentDateOf } from "../smartfox-server/src/world-data.ts";
import { createPicker } from "../smartfox-server/src/selection.ts";

const { check, finish } = makeChecker();
const quiet = console.log;
const logged: string[] = [];

// ---- the shipped data ----
check(scheduledGroups("Boardwalk").length === 1, "Boardwalk has the geyser group");
check(["Town", "MtBlizzard", "Diving"].every((z) => scheduledGroups(z).length === 0), "no other zone has scheduled objects");
check(playgrounds("MtBlizzard").length === 1 && playgrounds("Town").length === 0, "Mt Blizzard has the playground");

// ---- content date ----
check(contentDateOf("Alpine:en_US:Town::1.15.1;offline;2026-11-07;NONE") === "2026-11-07", "content date read from the room name");
check(contentDateOf("x:y:Town") === undefined && contentDateOf("a:b:Town::1.0;x;notadate;NONE") === undefined, "no date without one in the name");

// ---- a bad file never throws ----
const dir = tmpdir();
const bad = (name: string, text: string) => { const p = join(dir, `world-data-test-${process.pid}-${name}.json`); writeFileSync(p, text); return p; };
console.log = (...a: unknown[]) => { const line = a.join(" "); if (line.includes("[WORLD]")) logged.push(line); else quiet(...a); };
for (const [label, path] of [["missing", join(dir, `world-data-test-${process.pid}-nope.json`)], ["truncated", bad("trunc", "{")], ["an array", bad("arr", "[]")]] as const) {
  let threw = false;
  try { loadWorldData(path); } catch { threw = true; }
  check(!threw && scheduledGroups("Boardwalk").length === 0 && playgrounds("MtBlizzard").length === 0, `a ${label} file leaves empty data without throwing`);
}
console.log = quiet;
const worldLines = logged.filter((l) => l.includes("[WORLD] world-objects.json unusable"));
check(worldLines.length === 3, `each bad file is logged (${worldLines.length})`);

// ---- date windows ----
const windowed = bad("dates", JSON.stringify({
  scheduledWorldObjects: { Boardwalk: [{ path: "/G", behaviour: "ordered", cycleSeconds: 5, children: [], activeDates: { start: "2026-10-01", end: "2026-10-31" } }] },
  islandTargets: {},
}));
loadWorldData(windowed);
check(scheduledGroups("Boardwalk", "2026-10-15").length === 1 && scheduledGroups("Boardwalk", "2026-10-31").length === 1, "a windowed entry is served inside its dates");
check(scheduledGroups("Boardwalk", "2026-11-01").length === 0 && scheduledGroups("Boardwalk").length === 0, "and not outside them or with no date");
loadWorldData();
check(scheduledGroups("Boardwalk").length === 1, "the default reload restores the shipped data");

// ---- picker ----
const ordered = createPicker("ordered", 3);
check(JSON.stringify([ordered(), ordered(), ordered(), ordered()]) === "[0,1,2,0]", "ordered cycles 0,1,2,0");
const nrr = createPicker("nonRepeatingRandom", 8);
let permutations = true, repeatAtSeam = false, last = -1;
for (let pass = 0; pass < 50; pass++) {
  const block = Array.from({ length: 8 }, () => nrr());
  if ([...block].sort().join() !== "0,1,2,3,4,5,6,7") permutations = false;
  if (block[0] === last) repeatAtSeam = true;
  last = block[7]!;
}
check(permutations, "nonRepeatingRandom: every pass of 8 is a permutation");
check(!repeatAtSeam, "nonRepeatingRandom: a new pass never starts with the previous pass's last pick");
const rnd = createPicker("random", 5);
check(Array.from({ length: 200 }, () => rnd()).every((i) => Number.isInteger(i) && i >= 0 && i < 5), "random stays in range");
const one = createPicker("nonRepeatingRandom", 1);
check(one() === 0 && one() === 0, "a single child is always picked");

finish("");
