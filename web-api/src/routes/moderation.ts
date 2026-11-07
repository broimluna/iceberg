/**
 * Moderation Routes
 * 
 * Handles player reporting and moderation.
 * 
 * Endpoints:
 * - POST /moderation/v1/report/name/:displayName - Report a player (ReportPlayerOperation)
 */

import express from "express";
import * as db from "../database.ts";
import { report } from "../services/moderation.ts";
const router = express.Router();

/**
 * POST /moderation/v1/report/name/:displayName
 * Report a player
 * 
 * Request: reason (string as JSON body)
 * Response: 200 OK (empty)
 */
router.post('/moderation/v1/report/name/:displayName', (req, res) => {
    const { swid, username } = req.player;
    const reportedPlayer = req.params.displayName;

    let reason = req.body;
    // If body-parser failed (invalid JSON), try to recover the raw body
    if (typeof reason === 'object' && reason !== null && reason.reason) {
        reason = reason.reason;
    } else if (typeof reason === 'string') {
        // Accept plain string as reason
    } else if (typeof req.rawBody === 'object' && Buffer.isBuffer(req.rawBody)) {
        // Try to decode raw body as string (for invalid JSON, e.g. 'ChatSwearing')
        reason = req.rawBody.toString('utf8');
    } else {
        // Invalid body
        console.log(`[MODERATION] Invalid report body from ${username}:`, req.body);
        return res.status(400).json({ error: 'Invalid report body' });
    }

    // Resolve the name to a swid. An unknown name is still accepted (and
    // stored as "name:<displayName>") so the reply never confirms whether
    // an account exists.
    const target = db.getPlayerByDisplayName(reportedPlayer);
    const id = report({ reporter: swid, reported: target?.swid ?? `name:${reportedPlayer}`, reason: String(reason), source: "cpi" });
    console.log(`[MODERATION] Report ${id}: ${username} reported ${reportedPlayer}: ${reason}`);

    res.status(200).send();
});

export default router;
