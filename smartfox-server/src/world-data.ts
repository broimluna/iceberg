// data/world-objects.json: Disney's ScheduledWorldObjects and IslandTargets
// server data, extracted from the CDN and checked against the scenes. Read
// once at startup. A missing or broken file is logged and leaves the server
// running with no world objects or targets.
//
// Any zone entry may carry activeDates {start, end} (inclusive YYYY-MM-DD),
// matched against the room's content date, and/or parties (names, e.g.
// "halloween2026"): it runs only while one of them is active. Entries
// without either always run.
import { readFileSync } from "node:fs";

export type Vec3 = [number, number, number];
export type Behaviour = "random" | "ordered" | "nonRepeatingRandom";
export interface Reward { coins: number; mascotXP: Record<string, number> }
export interface ActiveDates { start: string; end: string }

export interface GroupData {
  path: string;
  behaviour: Behaviour;
  cycleSeconds: number;
  children: { path: string; position: Vec3 }[];
  activeDates?: ActiveDates;
  parties?: string[];
}

export interface TargetData {
  path: string;
  position: Vec3;
  minHits: number;
  populationMultiplier: number;
  hitSphere: { center: Vec3; radius: number; rawRadius: number };
}

export interface PhaseData { path: string; position: Vec3; sessionSeconds: number; targets: TargetData[] }

export interface SupersetData {
  path: string;
  position: Vec3;
  totalReward: Reward;
  minPerPlayerReward: Reward;
  phases: PhaseData[];
}

export interface PlaygroundData {
  path: string;
  position: Vec3;
  everyXMinutes: number;
  behaviour: Behaviour;
  rewardsVolume: { center: Vec3; radius: number };
  supersets: SupersetData[];
  activeDates?: ActiveDates;
  parties?: string[];
}

interface WorldData {
  scheduledWorldObjects: Record<string, GroupData[]>;
  islandTargets: Record<string, PlaygroundData[]>;
}

const DEFAULT_PATH = new URL("../data/world-objects.json", import.meta.url);
let data: WorldData = { scheduledWorldObjects: {}, islandTargets: {} };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isVec3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));
const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
const BEHAVIOURS = new Set(["random", "ordered", "nonRepeatingRandom"]);
const isReward = (r: unknown) => isRecord(r) && typeof r.coins === "number" && Number.isFinite(r.coins) && isRecord(r.mascotXP)
  && Object.values(r.mascotXP).every((x) => typeof x === "number" && Number.isFinite(x));

// Why an entry can't be served, or undefined. A bad entry is dropped (and
// logged) instead of throwing later inside a player's join.
function badDates(e: Record<string, unknown>): string | undefined {
  if (e.activeDates === undefined) return undefined;
  const d = e.activeDates;
  const day = (x: unknown) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);
  if (!(isRecord(d) && day(d.start) && day(d.end))) return "bad activeDates";
  return undefined;
}

function badParties(e: Record<string, unknown>): string | undefined {
  if (e.parties === undefined) return undefined;
  const p = e.parties;
  return Array.isArray(p) && p.length >= 1 && p.length <= 20 && p.every((x) => typeof x === "string" && /^[a-z0-9]+$/.test(x)) ? undefined : "bad parties";
}

function badGroup(g: unknown): string | undefined {
  if (!isRecord(g) || typeof g.path !== "string") return "not a group";
  if (!BEHAVIOURS.has(g.behaviour as string)) return "unknown behaviour";
  if (!positive(g.cycleSeconds)) return "cycleSeconds not positive";
  if (!Array.isArray(g.children) || g.children.length === 0) return "no children";
  if (!g.children.every((c) => isRecord(c) && typeof c.path === "string" && isVec3(c.position))) return "bad child";
  return badDates(g) ?? badParties(g);
}

function badTarget(t: unknown): string | undefined {
  if (!isRecord(t) || typeof t.path !== "string" || !isVec3(t.position)) return "bad target";
  if (!positive(t.minHits) || typeof t.populationMultiplier !== "number" || !Number.isFinite(t.populationMultiplier) || t.populationMultiplier < 0) return "bad target hits";
  const h = t.hitSphere;
  if (!isRecord(h) || !isVec3(h.center) || !positive(h.radius)) return "bad hitSphere";
  return undefined;
}

function badPlayground(p: unknown): string | undefined {
  if (!isRecord(p) || typeof p.path !== "string" || !isVec3(p.position)) return "not a playground";
  if (!BEHAVIOURS.has(p.behaviour as string)) return "unknown behaviour";
  if (!positive(p.everyXMinutes) || (p.everyXMinutes as number) > 60) return "everyXMinutes not in 1..60";
  const rv = p.rewardsVolume;
  if (!isRecord(rv) || !isVec3(rv.center) || !positive(rv.radius)) return "bad rewardsVolume";
  if (!Array.isArray(p.supersets) || p.supersets.length === 0) return "no supersets";
  for (const ss of p.supersets) {
    if (!isRecord(ss) || typeof ss.path !== "string" || !isReward(ss.totalReward) || !isReward(ss.minPerPlayerReward)) return "bad superset";
    if (!Array.isArray(ss.phases) || ss.phases.length === 0) return "superset without phases";
    for (const ph of ss.phases) {
      if (!isRecord(ph) || typeof ph.path !== "string" || !isVec3(ph.position) || !positive(ph.sessionSeconds)) return "bad phase";
      if (!Array.isArray(ph.targets) || ph.targets.length === 0) return "phase without targets";
      for (const t of ph.targets) {
        const why = badTarget(t);
        if (why) return why;
      }
    }
  }
  return badDates(p) ?? badParties(p);
}

function keepGood<T>(section: string, zones: Record<string, unknown>, bad: (e: unknown) => string | undefined): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const [zone, list] of Object.entries(zones)) {
    if (!Array.isArray(list)) {
      console.log(`[${new Date().toISOString()}] [WORLD] ${section}.${zone} dropped: not a list`);
      continue;
    }
    out[zone] = list.filter((e) => {
      const why = bad(e);
      if (why) console.log(`[${new Date().toISOString()}] [WORLD] ${section}.${zone} entry dropped (${isRecord(e) ? String(e.path) : "?"}): ${why}`);
      return !why;
    }) as T[];
  }
  return out;
}

export function loadWorldData(path: string | URL = DEFAULT_PATH): void {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.scheduledWorldObjects) || !isRecord(parsed.islandTargets)) {
      throw new Error("expected {scheduledWorldObjects, islandTargets}");
    }
    data = {
      scheduledWorldObjects: keepGood<GroupData>("scheduledWorldObjects", parsed.scheduledWorldObjects, badGroup),
      islandTargets: keepGood<PlaygroundData>("islandTargets", parsed.islandTargets, badPlayground),
    };
  } catch (err) {
    data = { scheduledWorldObjects: {}, islandTargets: {} };
    console.log(`[${new Date().toISOString()}] [WORLD] world-objects.json unusable: ${(err as Error).message}`);
  }
}

function active(entry: { activeDates?: ActiveDates; parties?: string[] }, date: string | undefined, parties: readonly string[]): boolean {
  if (entry.parties && !entry.parties.some((p) => parties.includes(p))) return false;
  if (!entry.activeDates) return true;
  return date !== undefined && entry.activeDates.start <= date && date <= entry.activeDates.end;
}

export function scheduledGroups(zone: string, contentDate?: string, parties: readonly string[] = []): GroupData[] {
  return (data.scheduledWorldObjects[zone] ?? []).filter((g) => active(g, contentDate, parties));
}

export function playgrounds(zone: string, contentDate?: string, parties: readonly string[] = []): PlaygroundData[] {
  return (data.islandTargets[zone] ?? []).filter((p) => active(p, contentDate, parties));
}

// Room names are world:language:zone::<version;mode;YYYY-MM-DD;...>.
export function contentDateOf(roomName: string): string | undefined {
  const date = roomName.split(":")[4]?.split(";")[2];
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

loadWorldData();
