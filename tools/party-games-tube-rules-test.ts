// Tube race rules (smartfox-server/src/party-games/tube-race-rules.ts):
// score, finish validation, modifier reach along a sampled path, placements.
import { makeChecker } from "./lib/harness.ts";
import { getPartyGame } from "../smartfox-server/src/party-games/definitions.ts";
import { isValidFinish, pathReaches, modifierTotal, raceScore, placeRacers, type TubeRaceData, type Vec3 } from "../smartfox-server/src/party-games/tube-race-rules.ts";

const { check, finish } = makeChecker();
const red = getPartyGame(4)!.gameData as unknown as TubeRaceData;
const e = red.RaceEndPosition;
const END: Vec3 = [e.x, e.y, e.z];

// Score: Disney's integer formula.
check(raceScore(20_000, 0, red) === 200, `400 - 20 s * 10 = 200 (${raceScore(20_000, 0, red)})`);
check(raceScore(20_999, 50, red) === 241, `partial seconds round down, modifiers add (${raceScore(20_999, 50, red)})`);

// Finish validation.
check(!isValidFinish(999, END, red), "under the minimum time: invalid");
check(isValidFinish(1000, END, red), "exactly the minimum: valid");
check(isValidFinish(45_000, END, red), "exactly the maximum: valid");
check(!isValidFinish(45_001, END, red), "over the maximum: invalid");
check(!isValidFinish(20_000, [END[0] + 31, END[1], END[2]], red), "31 m from the finish: invalid");
check(isValidFinish(20_000, [END[0] + 29, END[1], END[2]], red), "29 m from the finish: valid");
check(!isValidFinish(20_000, undefined, red), "no known position: invalid");

// Path reach.
const seg: Vec3[] = [[0, 0, 0], [10, 0, 0]];
check(pathReaches(seg, [5, 2.9, 0], 3), "a point 2.9 m from a segment is reached");
check(!pathReaches(seg, [5, 3.1, 0], 3), "3.1 m away is not");
check(pathReaches([[0, 0, 0]], [0, 2, 0], 3), "a single sample reaches what's near it");
check(!pathReaches([], [0, 0, 0], 3), "an empty path reaches nothing");
check(pathReaches(seg, [12, 0, 0], 3), "beyond the end: distance to the endpoint (2 m)");
check(!pathReaches(seg, [13.1, 0, 0], 3), "beyond the end: 3.1 m from the endpoint is out");

// Modifiers.
const layout = [
  { id: 1, delta: 25, pos: [5, 1, 0] as Vec3 },
  { id: 2, delta: -25, pos: [8, 0, 1] as Vec3 },
  { id: 3, delta: 25, pos: [5, 50, 0] as Vec3 },
];
check(modifierTotal([1], layout, seg) === 25, "a claimed modifier on the path counts");
check(modifierTotal([1, 1], layout, seg) === 25, "a repeated claim counts once");
check(modifierTotal([1, 9], layout, seg) === 25, "an id outside the layout is ignored");
check(modifierTotal([1, 3], layout, seg) === 25, "a claimed modifier off the path is ignored");
check(modifierTotal([1, 2], layout, seg) === 0, "a negative modifier on the path subtracts");
check(modifierTotal([], layout, seg) === 0, "no claims, no modifier");

// Placements.
const p = placeRacers([{ key: "a", score: 300, elapsedMs: 20_000 }, { key: "b", score: 350, elapsedMs: 25_000 }, { key: "c", score: 300, elapsedMs: 18_000 }], 2);
check(p.get("b") === 0 && p.get("c") === 1 && p.get("a") === 2, `score first, then time (${[...p]})`);
const six = placeRacers([1, 2, 3, 4, 5, 6].map((n) => ({ key: n, score: 100 - n, elapsedMs: 1000 })), 2);
check([1, 2, 3, 4, 5, 6].map((n) => six.get(n)).join() === "0,1,2,3,4,4", `placements cap at 4 (${[...six.values()]})`);
check(placeRacers([{ key: "solo", score: 300, elapsedMs: 20_000 }], 2).get("solo") === 2, "a solo racer gets the single-player placement");
check(placeRacers([], 2).size === 0, "nobody, no placements");

finish();
