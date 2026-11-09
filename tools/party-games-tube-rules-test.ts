// Tube race rules (smartfox-server/src/party-games/tube-race-rules.ts):
// score, finish validation, modifier reach along a sampled path, placements.
import { makeChecker } from "./lib/harness.ts";
import { getPartyGame } from "../smartfox-server/src/party-games/definitions.ts";
import { isValidFinish, pathReaches, modifierTotal, raceScore, placeRacers, pathStats, judgeFinish, MAX_JUMP, MAX_SPEED, type TubeRaceData, type Vec3 } from "../smartfox-server/src/party-games/tube-race-rules.ts";

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

// Path plausibility: jumps between samples, average speed over spans of >= 1 s.
check(MAX_JUMP === 20 && MAX_SPEED === 30, `limits are 20 m and 30 m/s (${MAX_JUMP}, ${MAX_SPEED})`);
const line = (n: number, step: number, dtMs: number) => ({ path: Array.from({ length: n }, (_, i) => [i * step, 0, 0] as Vec3), times: Array.from({ length: n }, (_, i) => i * dtMs) });
const honest = line(50, 2.4, 200); // 12 m/s, the tube's MaxSpeed, every 0.2 s
const hs = pathStats(honest.path, honest.times);
check(Math.abs(hs.maxJump - 2.4) < 1e-9 && Math.abs(hs.maxSpeed - 12) < 1e-6, `an honest 12 m/s path: jump 2.4 m, speed 12 m/s (${JSON.stringify(hs)})`);
const jump = pathStats([[0, 0, 0], [20.5, 0, 0]], [0, 5000]);
check(jump.maxJump > 20, `a 20.5 m jump is seen even when slow (${JSON.stringify(jump)})`);
check(pathStats([[0, 0, 0], [19.9, 0, 0]], [0, 5000]).maxJump <= 20, "a 19.9 m jump is under the limit");
// Silent at the start for 5 s, then two 19 m steps 0.4 s apart: 38 m within 1 s.
const burst = pathStats([[0, 0, 0], [0, 0, 0], [19, 0, 0], [38, 0, 0]], [0, 5000, 5500, 5900]);
check(burst.maxJump <= 20 && burst.maxSpeed > 30, `a burst after silence is caught by speed, not jump (${JSON.stringify(burst)})`);
// Packets bunched by the network: 2 s of 12 m/s motion arriving within 1 s.
const bunched = pathStats([[0, 0, 0], [12, 0, 0], [24, 0, 0]], [0, 1000, 1100]);
check(bunched.maxSpeed <= 30, `bunched honest packets stay under 30 m/s (${JSON.stringify(bunched)})`);
check(pathStats([[0, 0, 0]], [0]).maxSpeed === 0 && pathStats([], []).maxJump === 0, "one or no samples: nothing to measure");

// Whole finish judgement.
const lobby: Vec3 = [END[0] - 20, END[1] + 32, END[2]];
const glide = (from: Vec3, to: Vec3, steps: number, dtMs: number) => ({
  path: Array.from({ length: steps + 1 }, (_, i) => from.map((v, k) => v + ((to[k]! - v) * i) / steps) as Vec3),
  times: Array.from({ length: steps + 1 }, (_, i) => i * dtMs),
});
const ok = glide(lobby, END, 20, 1000); // ~37.7 m in 20 s
const j1 = judgeFinish(20_000, ok.path, ok.times, false, red);
check(j1.valid && j1.reason === "ok", `a plausible run is valid (${JSON.stringify(j1)})`);
const tp = judgeFinish(20_000, [lobby, END], [0, 19_000], false, red);
check(!tp.valid && tp.reason.startsWith("jump"), `lobby to finish in one sample is a jump (${JSON.stringify(tp)})`);
const fast = glide(lobby, END, 4, 300);
const j3 = judgeFinish(1500, fast.path, fast.times, false, red);
check(!j3.valid && j3.reason.startsWith("speed"), `small steps too fast fail on speed (${JSON.stringify(j3)})`);
check(judgeFinish(20_000, ok.path, ok.times, true, red).reason === "path overflow", "an overflowed path is invalid");
check(judgeFinish(500, ok.path, ok.times, false, red).reason === "time", "under the minimum time: reason time");
const away = glide(lobby, [END[0], END[1] + 32, END[2] + 10], 20, 1000);
check(judgeFinish(20_000, away.path, away.times, false, red).reason === "position", "finishing away from the end: reason position");
check(judgeFinish(20_000, [], [], false, red).reason === "position", "no samples: reason position");

// Placements: valid racers first (score, then time), then invalid ones (time).
const row = (key: string, score: number, elapsedMs: number, valid = true) => ({ key, score, elapsedMs, valid });
const p = placeRacers([row("a", 300, 20_000), row("b", 350, 25_000), row("c", 300, 18_000)], 2);
check(p.get("b") === 0 && p.get("c") === 1 && p.get("a") === 2, `score first, then time (${[...p]})`);
const six = placeRacers([1, 2, 3, 4, 5, 6].map((n) => row(String(n), 100 - n, 1000)), 2);
check(["1", "2", "3", "4", "5", "6"].map((n) => six.get(n)).join() === "0,1,2,3,4,4", `placements cap at 4 (${[...six.values()]})`);
check(placeRacers([row("solo", 300, 20_000)], 2).get("solo") === 2, "a solo racer gets the single-player placement");
check(placeRacers([], 2).size === 0, "nobody, no placements");
const neg = placeRacers([row("slow", -50, 45_000), row("cheat", 0, 1000, false), row("quick", 200, 20_000)], 2);
check(neg.get("quick") === 0 && neg.get("slow") === 1 && neg.get("cheat") === 2, `a negative valid score still beats an invalid 0 (${[...neg]})`);
const alt = placeRacers([row("real", 300, 20_000), row("alt", 0, 45_000, false), row("alt2", 0, 2000, false)], 2);
check(alt.get("real") === 2 && alt.get("alt2") === 3 && alt.get("alt") === 4, `one valid finisher gets the single-player placement, invalid ones after (${[...alt]})`);
const none = placeRacers([row("x", 0, 3000, false), row("y", 0, 2000, false)], 2);
check(none.get("y") === 0 && none.get("x") === 1, `no valid racer: invalid ones by time (${[...none]})`);

finish();
