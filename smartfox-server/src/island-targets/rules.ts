// Island Targets rules with no state: hit points, the reward split, the
// clock-tower schedule, throw guards and the snowball trajectory test.
//
// The client has no hit command, so the server decides hits from the
// thrower's l.a LaunchThrow: p (feet), v (launch velocity). The snowball is a
// 0.1 m sphere with gravity and no drag (the client's Rigidbody), thrown
// from the hand. The hand offset and slack are first guesses, logged per
// throw so the live test can tune them; the server can't see walls.
import type { Reward, Vec3 } from "../world-data.ts";

export const GRAVITY = -9.81;
export const HAND_OFFSET_Y = 0.75;
export const SNOWBALL_RADIUS = 0.1;
export const HIT_SLACK = 0.35;
export const MAX_FLIGHT_SECONDS = 3;
export const MIN_THROW_GAP_MS = 400;
export const MAX_THROW_SPEED = 20;
export const MAX_THROW_DRIFT = 3;
const STEP_SECONDS = 1 / 240;

// IslandTargetConfiguration: "Minimum hit count", raised by players present.
export function targetHp(minHits: number, multiplier: number, playersInZone: number): number {
  return Math.max(minHits, multiplier * playersInZone);
}

export function insideSphere(p: readonly number[], center: Vec3, radius: number): boolean {
  return Math.hypot(p[0]! - center[0], p[1]! - center[1], p[2]! - center[2]) <= radius;
}

// Each field: the total shared out, rounded down, but never below the minimum.
export function splitReward(total: Reward, minPer: Reward, n: number): Reward {
  const share = (t: number, m: number) => (n <= 0 ? 0 : Math.max(m, Math.floor(t / n)));
  const mascotXP: Record<string, number> = {};
  for (const name of new Set([...Object.keys(total.mascotXP), ...Object.keys(minPer.mascotXP)])) {
    mascotXP[name] = share(total.mascotXP[name] ?? 0, minPer.mascotXP[name] ?? 0);
  }
  return { coins: share(total.coins, minPer.coins), mascotXP };
}

// The client's TimeUtils.calculateNextMultipleAfterTheHour (UTC): the next
// :mm:00 with mm a multiple of everyMinutes, strictly after now, restarting
// at the top of the hour.
export function nextGameStartMs(nowMs: number, everyMinutes: number): number {
  const d = new Date(nowMs);
  const hourStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
  const mm = everyMinutes * (1 + Math.floor(d.getUTCMinutes() / everyMinutes));
  return mm < 60 ? hourStart + mm * 60_000 : hourStart + 3_600_000;
}

// Why a throw can't count, or undefined. previousPos is the player's last
// position before this packet (none yet fails closed: a first packet could
// otherwise throw from anywhere); lastCountedThrowMs their last counted
// throw; minGapMs the spam gap (scaled in tests).
export function throwGuard(
  nowMs: number, p: readonly number[], v: readonly number[], previousPos: readonly number[] | undefined,
  lastCountedThrowMs: number | undefined, minGapMs = MIN_THROW_GAP_MS,
): string | undefined {
  if (p.length !== 3 || v.length !== 3 || ![...p, ...v].every(Number.isFinite)) return "invalid";
  if (lastCountedThrowMs !== undefined && nowMs - lastCountedThrowMs < minGapMs) return "rate";
  if (Math.hypot(v[0]!, v[1]!, v[2]!) > MAX_THROW_SPEED) return "speed";
  if (!previousPos || previousPos.length !== 3 || !previousPos.every(Number.isFinite)) return "nopos";
  if (Math.hypot(p[0]! - previousPos[0]!, p[1]! - previousPos[1]!, p[2]! - previousPos[2]!) > MAX_THROW_DRIFT) return "drift";
  return undefined;
}

export interface HitSphere { path: string; center: Vec3; radius: number }
export interface TraceResult {
  // The first target whose sphere (radius + snowball + slack) the path
  // enters. t is when the snowball really touches it (or, for a hit only
  // the slack allows, its closest approach): when the client would see it.
  hit?: { path: string; t: number };
  // The closest approach over all targets: distance from the snowball's
  // surface to the target's sphere (negative inside), and when.
  nearest?: { path: string; dist: number; t: number };
}

export function traceThrow(p: Vec3, v: Vec3, targets: HitSphere[]): TraceResult {
  const o = [p[0], p[1] + HAND_OFFSET_Y, p[2]];
  const best = targets.map(() => ({ dist: Infinity, t: 0 }));
  const contact: (number | undefined)[] = targets.map(() => undefined);
  let hitIndex: number | undefined;
  for (let step = 0; step * STEP_SECONDS <= MAX_FLIGHT_SECONDS; step++) {
    const t = step * STEP_SECONDS;
    const x = o[0]! + v[0] * t, y = o[1]! + v[1] * t + 0.5 * GRAVITY * t * t, z = o[2]! + v[2] * t;
    targets.forEach((target, i) => {
      const dist = Math.hypot(x - target.center[0], y - target.center[1], z - target.center[2]) - target.radius - SNOWBALL_RADIUS;
      if (dist < best[i]!.dist) best[i] = { dist, t };
      if (contact[i] === undefined && dist <= 0) contact[i] = t;
      if (hitIndex === undefined && dist <= HIT_SLACK) hitIndex = i;
    });
  }
  const hit = hitIndex === undefined ? undefined : { path: targets[hitIndex]!.path, t: contact[hitIndex] ?? best[hitIndex]!.t };
  let nearest: TraceResult["nearest"];
  targets.forEach((target, i) => {
    if (!nearest || best[i]!.dist < nearest.dist) nearest = { path: target.path, dist: best[i]!.dist, t: best[i]!.t };
  });
  return { hit, nearest };
}
