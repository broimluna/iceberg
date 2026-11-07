import express from "express";
import * as db from "../../database.ts";
import { authenticateMix } from "./auth.ts";
import { buildResponse } from "./common.ts";
import { filterText, report } from "../../services/moderation.ts";

const router = express.Router();

// =============================================================================
// Moderation Endpoints
// =============================================================================

/**
 * PUT /moderation/reportPlayer
 * Stores a report (services/moderation.ts) for operators to triage with
 * `bun tools/mod.ts reports`.
 */
router.put('/moderation/reportPlayer', authenticateMix, (req, res) => {
    const { ReportedUserId, Reason } = req.body;
    if (typeof ReportedUserId !== "string" || !ReportedUserId) {
        return res.json({ Status: "INVALID_REQUEST" });
    }
    const id = report({ reporter: req.mixUserId, reported: ReportedUserId, reason: typeof Reason === "string" ? Reason : "", source: "mix" });
    console.log(`[MODERATION] Report ${id}: ${req.mixUserId} reported ${ReportedUserId} (${Reason})`);
    res.json(buildResponse());
});

/**
 * PUT /moderation/text
 * Runs the shared text filter (services/moderation.ts). Blocked text
 * comes back fully masked, and Moderated covers both mask and block.
 */
router.put('/moderation/text', authenticateMix, (req, res) => {
    const { Text } = req.body;
    const { text, moderated, blocked } = filterText(typeof Text === "string" ? Text : "");
    res.json(buildResponse({
        Text: text,
        Moderated: moderated || blocked
    }));
});


export default router;
