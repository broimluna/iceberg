// data/world-objects.json: Disney's ScheduledWorldObjects and IslandTargets
// server data, extracted from the CDN and checked against the scenes. Read
// once at startup. A missing or broken file is logged and leaves the server
// running with no world objects or targets.
//
// Any zone entry may carry activeDates {start, end} (inclusive YYYY-MM-DD),
// matched against the room's content date. Entries without one always run.
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
}

interface WorldData {
  scheduledWorldObjects: Record<string, GroupData[]>;
  islandTargets: Record<string, PlaygroundData[]>;
}

const DEFAULT_PATH = new URL("../data/world-objects.json", import.meta.url);
let data: WorldData = { scheduledWorldObjects: {}, islandTargets: {} };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function loadWorldData(path: string | URL = DEFAULT_PATH): void {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.scheduledWorldObjects) || !isRecord(parsed.islandTargets)) {
      throw new Error("expected {scheduledWorldObjects, islandTargets}");
    }
    data = parsed as unknown as WorldData;
  } catch (err) {
    data = { scheduledWorldObjects: {}, islandTargets: {} };
    console.log(`[${new Date().toISOString()}] [WORLD] world-objects.json unusable: ${(err as Error).message}`);
  }
}

function active(entry: { activeDates?: ActiveDates }, date: string | undefined): boolean {
  if (!entry.activeDates) return true;
  return date !== undefined && entry.activeDates.start <= date && date <= entry.activeDates.end;
}

export function scheduledGroups(zone: string, contentDate?: string): GroupData[] {
  return (data.scheduledWorldObjects[zone] ?? []).filter((g) => active(g, contentDate));
}

export function playgrounds(zone: string, contentDate?: string): PlaygroundData[] {
  return (data.islandTargets[zone] ?? []).filter((p) => active(p, contentDate));
}

// Room names are world:language:zone::<version;mode;YYYY-MM-DD;...>.
export function contentDateOf(roomName: string): string | undefined {
  const date = roomName.split(":")[4]?.split(";")[2];
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

loadWorldData();
