// Tube race score-modifier layouts (smartfox-server/data/tube-races.json).
import { makeChecker } from "./lib/harness.ts";
import { tubeRaceLayouts } from "../smartfox-server/src/party-games/definitions.ts";

const { check, finish } = makeChecker();

let total = 0;
for (const t of [4, 5]) {
  const layouts = tubeRaceLayouts(t);
  check(layouts.size === 3 && [...layouts.keys()].sort().join() === "0,1,2", `template ${t} has layouts 0, 1, 2 (${[...layouts.keys()]})`);
  for (const [id, mods] of layouts) {
    total += mods.length;
    check(mods.every((m) => m.delta === 25 || m.delta === -25), `template ${t} layout ${id}: deltas are +-25`);
    check(new Set(mods.map((m) => m.id)).size === mods.length, `template ${t} layout ${id}: ids unique`);
    check(mods.every((m) => m.pos.length === 3 && m.pos.every(Number.isFinite)), `template ${t} layout ${id}: positions are 3 numbers`);
    const plus = mods.filter((m) => m.delta > 0).reduce((s, m) => s + m.delta, 0);
    check(plus <= 200, `template ${t} layout ${id}: at most +200 (${plus})`);
  }
}
check(total === 65, `65 modifiers in all (${total})`);
check(tubeRaceLayouts(3).size === 0, "a template without a race has no layouts");

finish();
