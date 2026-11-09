// Island Targets rules (smartfox-server/src/island-targets/rules.ts): hit
// points, the reward split, the clock-tower schedule, throw guards and the
// snowball trajectory test. Throws are built from the physics (gravity
// -9.81, no drag) aimed at the real SuperSetA/GroupA target from the data.
import { makeChecker } from "./lib/harness.ts";
import { targetHp, splitReward, nextGameStartMs, throwGuard, traceThrow, insideSphere, HAND_OFFSET_Y } from "../smartfox-server/src/island-targets/rules.ts";
import { playgrounds, type Vec3 } from "../smartfox-server/src/world-data.ts";

const { check, finish } = makeChecker();
const pg = playgrounds("MtBlizzard")[0]!;
const ss = pg.supersets[0]!;
const T = ss.totalReward, M = ss.minPerPlayerReward;
const target = ss.phases[0]!.targets[0]!;
const C = target.hitSphere.center;
const sphere = (path: string, center: Vec3, radius: number) => ({ path, center, radius });
const A = sphere(target.path, C, target.hitSphere.radius);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Launch velocity that puts the snowball at `aim` after `t` seconds from p's hand.
const aimV = (p: Vec3, aim: Vec3, t = 0.8): Vec3 => {
  const o = [p[0], p[1] + HAND_OFFSET_Y, p[2]];
  return [(aim[0] - o[0]!) / t, (aim[1] - o[1]! + 0.5 * 9.81 * t * t) / t, (aim[2] - o[2]!) / t];
};
const len = (v: Vec3) => Math.hypot(...v);
const rotY = (v: Vec3, deg: number): Vec3 => {
  const r = (deg * Math.PI) / 180;
  return [v[0] * Math.cos(r) + v[2] * Math.sin(r), v[1], -v[0] * Math.sin(r) + v[2] * Math.cos(r)];
};

// ---- HP ----
check(targetHp(3, 1, 0) === 3 && targetHp(3, 1, 5) === 5 && targetHp(40, 1, 12) === 40, "HP = max(minHits, multiplier x players)");

// ---- rewards ----
check(same(splitReward(T, M, 1), { coins: 100, mascotXP: { AuntArctic: 40 } }), `one player gets the total (${JSON.stringify(splitReward(T, M, 1))})`);
check(same(splitReward(T, M, 3), { coins: 33, mascotXP: { AuntArctic: 13 } }), `three split it, rounded down (${JSON.stringify(splitReward(T, M, 3))})`);
check(same(splitReward(T, M, 6), { coins: 20, mascotXP: { AuntArctic: 10 } }), `six get the minimum (${JSON.stringify(splitReward(T, M, 6))})`);
check(same(splitReward(T, M, 0), { coins: 0, mascotXP: { AuntArctic: 0 } }), "nobody eligible pays nothing");

// ---- schedule (client calculateNextMultipleAfterTheHour, UTC) ----
const at = (h: number, m: number, s = 0, ms = 0) => Date.UTC(2026, 10, 9, h, m, s, ms);
check(nextGameStartMs(at(12, 3, 10), 5) === at(12, 5), "12:03:10 -> 12:05");
check(nextGameStartMs(at(12, 5, 0, 0), 5) === at(12, 10), "exactly 12:05 -> 12:10");
check(nextGameStartMs(at(12, 57), 5) === at(13, 0), "12:57 -> 13:00");
check(nextGameStartMs(at(12, 57), 7) === at(13, 0), "every 7: 12:57 -> 13:00 (restarts on the hour)");
check(nextGameStartMs(at(12, 50), 7) === at(12, 56), "every 7: 12:50 -> 12:56");

// ---- throw guards ----
const p: Vec3 = [C[0], C[1] - 3.5, C[2] + 6];
const v = aimV(p, C);
check(throwGuard(10_000, p, v, p, 9_700) === "rate", "a throw 300 ms after a counted one is too fast");
check(throwGuard(10_000, p, [0, 0, 25], p, undefined) === "speed", "|v| 25 is too fast");
check(throwGuard(10_000, p, v, [p[0] + 4, p[1], p[2]], undefined) === "drift", "4 m from the previous position is a drift");
check(throwGuard(10_000, p, v, p, 9_000) === undefined, "a normal throw passes");
check(throwGuard(10_000, p, v, undefined, undefined) === "nopos", "no previous position fails closed");
check(throwGuard(10_000, [NaN, 0, 0], v, p, undefined) === "invalid" && throwGuard(10_000, p, [0, Infinity, 0], p, undefined) === "invalid", "non-finite p or v is invalid");
check(throwGuard(10_000, p, v, p, 9_990, 5) === undefined && throwGuard(10_000, p, v, p, 9_997, 5) === "rate", "the rate gap can be scaled");

// ---- trajectory ----
check(len(v) < 20, `the aimed throw is a real throw speed (${len(v).toFixed(2)})`);
const aimed = traceThrow(p, v, [A]);
check(aimed.hit?.path === A.path && Math.abs(aimed.hit.t - 0.8) < 0.1, `an aimed throw hits at about 0.8 s (${JSON.stringify(aimed.hit)})`);
const turned = traceThrow(p, rotY(v, 20), [A]);
check(!turned.hit && turned.nearest?.path === A.path && turned.nearest.dist > 0, `turned 20 degrees it misses (${JSON.stringify(turned.nearest)})`);
const off = (dx: number) => traceThrow(p, aimV(p, [C[0] + dx, C[1], C[2]]), [A]);
check(!off(1.6).hit, `1.6 m off-centre misses (dist ${off(1.6).nearest?.dist.toFixed(3)})`);
check(off(0.9).hit?.path === A.path, `0.9 m off-centre hits with the slack (dist ${off(0.9).nearest?.dist.toFixed(3)})`);
// A second target on the path, reached at 0.4 s, takes the hit first.
const o: Vec3 = [p[0], p[1] + HAND_OFFSET_Y, p[2]];
const mid: Vec3 = [o[0] + v[0] * 0.4, o[1] + v[1] * 0.4 - 0.5 * 9.81 * 0.16, o[2] + v[2] * 0.4];
const both = traceThrow(p, v, [A, sphere("/near", mid, 0.5)]);
check(both.hit?.path === "/near" && Math.abs(both.hit.t - 0.4) < 0.1, `the nearer target on the path takes the hit (${JSON.stringify(both.hit)})`);

// ---- reward zone ----
check(insideSphere(pg.rewardsVolume.center, pg.rewardsVolume.center, pg.rewardsVolume.radius), "the zone's centre is inside it");
check(!insideSphere([pg.rewardsVolume.center[0] + 12.5, pg.rewardsVolume.center[1], pg.rewardsVolume.center[2]], pg.rewardsVolume.center, pg.rewardsVolume.radius), "12.5 m out is outside it");

finish("");
