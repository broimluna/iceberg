// Tube race rules, pure: score, finish validation, score modifiers along the
// racer's sampled path, placements. Field names are the client's
// TubeRaceDefinition (party-games.json gameData of templates 4 and 5).
import type { TubeRaceModifier } from "./definitions.ts";

export type Vec3 = [number, number, number];

export interface TubeRaceData {
  StartingPoints: number;
  PointsDeductedPerSecond: number;
  MinimumCompletionTimeInSeconds: number;
  MaximumCompletionTimeInSeconds: number;
  MaxValidationRadius: number;
  RaceEndPosition: { x: number; y: number; z: number };
  DefaultPoints: number;
  ShowRewardsDelayInSeconds: number;
  SinglePlayerPlacement: number;
}

// How close the path must come to a modifier for it to count. The trigger box
// is about 1.3 x 1.65 x 0.8 m; positions arrive at most every 0.2 s.
export const MODIFIER_REACH = 3;
// Placements stop at PartyGameEndPlacement.FIFTH.
const LAST_PLACEMENT = 4;

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function isValidFinish(elapsedMs: number, lastPos: Vec3 | undefined, data: TubeRaceData): boolean {
  if (!lastPos) return false;
  if (elapsedMs < data.MinimumCompletionTimeInSeconds * 1000 || elapsedMs > data.MaximumCompletionTimeInSeconds * 1000) return false;
  const e = data.RaceEndPosition;
  return dist(lastPos, [e.x, e.y, e.z]) <= data.MaxValidationRadius;
}

function segmentDistance(a: Vec3, b: Vec3, p: Vec3): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0]! + (p[1] - a[1]) * ab[1]! + (p[2] - a[2]) * ab[2]!) / len2));
  return dist([a[0] + t * ab[0]!, a[1] + t * ab[1]!, a[2] + t * ab[2]!], p);
}

export function pathReaches(path: Vec3[], point: Vec3, reach: number): boolean {
  if (path.length === 1) return dist(path[0]!, point) <= reach;
  for (let i = 1; i < path.length; i++) if (segmentDistance(path[i - 1]!, path[i]!, point) <= reach) return true;
  return false;
}

// Sum of the claimed modifiers that are in the layout and on the path, each once.
export function modifierTotal(claims: number[], layout: TubeRaceModifier[], path: Vec3[]): number {
  let total = 0;
  for (const id of new Set(claims)) {
    const m = layout.find((x) => x.id === id);
    if (m && pathReaches(path, m.pos, MODIFIER_REACH)) total += m.delta;
  }
  return total;
}

// Disney's offline server: StartingPoints - ms * PointsDeductedPerSecond / 1000 (integer) + modifiers.
export function raceScore(elapsedMs: number, modifierSum: number, data: TubeRaceData): number {
  return data.StartingPoints - Math.floor((elapsedMs * data.PointsDeductedPerSecond) / 1000) + modifierSum;
}

// Highest score first, then fastest; one racer gets SinglePlayerPlacement.
export function placeRacers<T>(rows: { key: T; score: number; elapsedMs: number }[], singlePlayerPlacement: number): Map<T, number> {
  if (rows.length === 1) return new Map([[rows[0]!.key, singlePlayerPlacement]]);
  const sorted = [...rows].sort((a, b) => b.score - a.score || a.elapsedMs - b.elapsedMs);
  return new Map(sorted.map((r, i) => [r.key, Math.min(i, LAST_PLACEMENT)]));
}
