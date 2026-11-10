// The admin's party override, stored in the settings table.
import { getSetting, setSetting } from "../database.ts";
import type { PartyOverride } from "./parties.ts";

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
