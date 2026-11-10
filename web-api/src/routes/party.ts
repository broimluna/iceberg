/**
 * Party Routes
 *
 * - GET  /cdn/party-schedule.json        public: calendar, mode, forced party
 * - GET  /api/internal/party             game server: mode, party, active keys
 * - POST /api/internal/party-override    game server: set mode / party
 */
import express from "express";
import { isInternalRequest } from "../utils/internalSecret.ts";
import { logSafe } from "../utils/logSafe.ts";
import {
    calendar, keyOf, resolveParty, activeParties, getOverride, setOverride, type PartyMode, type PartyOverride,
} from "../services/parties.ts";

const router = express.Router();

const state = () => {
    const ov = getOverride();
    return {
        mode: ov.mode,
        party: ov.mode === "party" ? ov.party ?? null : null,
        active: activeParties(calendar(), ov, new Date()).map(keyOf),
    };
};

router.get("/cdn/party-schedule.json", (_req, res) => {
    const ov = getOverride();
    res.set("Cache-Control", "public, max-age=60");
    res.json({
        version: 1,
        mode: ov.mode,
        party: ov.mode === "party" ? ov.party ?? null : null,
        calendar: calendar().map((e) => ({ id: e.id, name: e.name, start: e.start, end: e.end, calendar: e.calendar })),
        serverTime: Date.now(),
    });
});

router.get("/api/internal/party", (req, res) => {
    if (!isInternalRequest(req)) return res.status(403).json({ error: "Forbidden" });
    res.json(state());
});

router.post("/api/internal/party-override", express.json(), (req, res) => {
    if (!isInternalRequest(req)) return res.status(403).json({ error: "Forbidden" });
    const body = req.body ?? {};
    const mode = body.mode as PartyMode;
    if (mode !== "auto" && mode !== "party" && mode !== "none") return res.status(400).json({ error: "bad mode" });
    const setBy = typeof body.setBy === "string" ? body.setBy.slice(0, 64) : undefined;
    const ov: PartyOverride = { mode, setAt: new Date().toISOString() };
    if (setBy) ov.setBy = setBy;
    let key: string | undefined;
    if (mode === "party") {
        const entry = typeof body.party === "string" ? resolveParty(calendar(), body.party) : undefined;
        if (!entry) return res.status(400).json({ error: "unknown party", valid: calendar().map((e) => e.name) });
        key = keyOf(entry);
        ov.party = key;
    }
    setOverride(ov);
    console.log(`[${new Date().toISOString()}] [PARTY] override set mode=${mode} party=${key ?? "-"} by ${logSafe(setBy ?? "-", 64)}`);
    res.json(state());
});

export default router;
