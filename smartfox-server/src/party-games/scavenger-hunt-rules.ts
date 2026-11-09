// Scavenger Hunt rules: what a marble drop or pickup must satisfy, and who
// wins. Positions are world space.
import type { Vec3 } from "./tube-race-rules.ts";

// Furthest a marble may be from where the Hider was last seen.
export const MAX_DROP_STEP = 3;
export const MIN_MARBLE_GAP = 1;
// How near the Finder's last reported position must be to a marble they pick up.
export const PICKUP_RADIUS = 6;

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

export type DropVerdict = "ok" | "max" | "bad-position" | "too-far" | "too-close";

export function validateDrop(position: Vec3, previous: Vec3 | undefined, existing: Vec3[], max: number): DropVerdict {
  if (existing.length >= max) return "max";
  if (!isVec3(position)) return "bad-position";
  if (previous && dist(position, previous) > MAX_DROP_STEP) return "too-far";
  if (existing.some((m) => dist(position, m) < MIN_MARBLE_GAP)) return "too-close";
  return "ok";
}

export function validatePickup(finder: Vec3 | undefined, item: Vec3): "ok" | "unknown-position" | "too-far" {
  if (!finder) return "unknown-position";
  return dist(finder, item) > PICKUP_RADIUS ? "too-far" : "ok";
}

// The Finder wins by finding every marble; a Hider who hid none loses.
export function decideWinner(hidden: number, found: number): "hider" | "finder" {
  return found >= hidden ? "finder" : "hider";
}

// ItemId of a RemoveItem message: a non-negative safe integer.
export function parseItemId(message: unknown): number | undefined {
  const id = (message as { ItemId?: unknown } | null)?.ItemId;
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}
