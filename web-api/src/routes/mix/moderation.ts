import express from "express";
import * as db from "../../database.ts";
import { authenticateMix } from "./auth.ts";
import { buildResponse } from "./common.ts";
import { filterText } from "../../services/moderation.ts";

const router = express.Router();

// =============================================================================
// Moderation Endpoints
// =============================================================================

/**
 * PUT /moderation/reportPlayer
 * Report a player
 */
router.put('/moderation/reportPlayer', authenticateMix, (req, res) => {
    const { UserId, ReportedUserId, Reason } = req.body;
    
    // Log the report (in production, store in database)
    console.log(`[MODERATION] Player ${UserId} reported ${ReportedUserId} for: ${Reason}`);
    
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
