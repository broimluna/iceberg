// Party schedule: which parties are running. The calendar is a data file; an
// admin override (stored elsewhere) can pick one party or turn them all off.
import { readFileSync } from "node:fs";
import { logSafe } from "../utils/logSafe";
import { getSetting, setSetting } from "../database.ts";

export interface CalendarEntry { id: number; name: string; start: string; end: string; calendar: boolean }
export type PartyMode = "auto" | "party" | "none";
export interface PartyOverride { mode: PartyMode; party?: string; setBy?: string; setAt?: string }

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DEFAULT_PATH = new URL("../../data/party-calendar.json", import.meta.url);

const log = (msg: string) => console.log(`[${new Date().toISOString()}] [PARTY] ${msg}`);

export const keyOf = (e: CalendarEntry): string => `${e.id}|${e.name}`;

function validMonthDay(s: unknown): s is string {
    if (typeof s !== "string" || !/^\d\d-\d\d$/.test(s)) return false;
    const month = Number(s.slice(0, 2));
    const day = Number(s.slice(3));
    return month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1]!;
}

export function parseCalendar(raw: unknown, logLine: (msg: string) => void): CalendarEntry[] {
    if (!Array.isArray(raw)) {
        logLine("party calendar is not a list, using an empty calendar");
        return [];
    }
    const out: CalendarEntry[] = [];
    const ids = new Set<number>();
    const names = new Set<string>();
    for (const item of raw as any[]) {
        const label = logSafe(item && typeof item === "object" ? `${item.id}|${item.name}` : item, 60);
        let reason = "";
        if (!item || typeof item !== "object") reason = "not an object";
        else if (!Number.isInteger(item.id) || item.id <= 0) reason = "bad id";
        else if (typeof item.name !== "string" || !/^[a-z0-9]+$/.test(item.name)) reason = "bad name";
        else if (!validMonthDay(item.start)) reason = "bad start date";
        else if (!validMonthDay(item.end)) reason = "bad end date";
        else if (typeof item.calendar !== "boolean") reason = "bad calendar flag";
        else if (ids.has(item.id)) reason = "duplicate id";
        else if (names.has(item.name)) reason = "duplicate name";
        if (reason) { logLine(`dropped calendar entry ${label}: ${reason}`); continue; }
        ids.add(item.id);
        names.add(item.name);
        out.push({ id: item.id, name: item.name, start: item.start, end: item.end, calendar: item.calendar });
    }
    return out;
}

export function loadCalendar(path: string | URL = DEFAULT_PATH): CalendarEntry[] {
    try {
        return parseCalendar(JSON.parse(readFileSync(path, "utf8")), log);
    } catch (e) {
        log(`couldn't read the party calendar: ${logSafe(e instanceof Error ? e.message : e, 120)}`);
        return [];
    }
}

let cached: CalendarEntry[] | null = null;
export function calendar(): CalendarEntry[] {
    return (cached ??= loadCalendar());
}

export function resolveParty(cal: CalendarEntry[], text: string): CalendarEntry | undefined {
    if (typeof text !== "string" || !text) return undefined;
    const t = text.toLowerCase();
    return cal.find((e) => keyOf(e) === t || e.name === t || String(e.id) === t);
}

const md = (d: Date) => (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
const num = (s: string) => Number(s.slice(0, 2)) * 100 + Number(s.slice(3));

/** Date rules only: start inclusive, end exclusive, wrapping past the new year when end < start. */
export function inRange(e: CalendarEntry, now: Date): boolean {
    const today = md(now), start = num(e.start), end = num(e.end);
    return start <= end ? today >= start && today < end : today >= start || today < end;
}

export function activeParties(cal: CalendarEntry[], ov: PartyOverride, now: Date): CalendarEntry[] {
    if (ov.mode === "none") return [];
    if (ov.mode === "party") {
        const e = ov.party ? resolveParty(cal, ov.party) : undefined;
        return e ? [e] : [];
    }
    return cal.filter((e) => e.calendar && inRange(e, now));
}

const OVERRIDE_KEY = "party_override";

export function getOverride(): PartyOverride {
    try {
        const raw = getSetting(OVERRIDE_KEY);
        if (!raw) return { mode: "auto" };
        const v = JSON.parse(raw);
        if (v && (v.mode === "auto" || v.mode === "party" || v.mode === "none")) {
            const ov: PartyOverride = { mode: v.mode };
            if (typeof v.party === "string") ov.party = v.party;
            if (typeof v.setBy === "string") ov.setBy = v.setBy;
            if (typeof v.setAt === "string") ov.setAt = v.setAt;
            return ov;
        }
    } catch { /* fall through to the default */ }
    return { mode: "auto" };
}

export function setOverride(ov: PartyOverride): void {
    setSetting(OVERRIDE_KEY, JSON.stringify(ov));
}
