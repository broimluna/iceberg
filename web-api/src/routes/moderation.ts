/**
 * Moderation Routes
 * 
 * Handles player reporting and moderation.
 * 
 * Endpoints:
 * - POST /moderation/v1/report/name/:displayName - Report a player (ReportPlayerOperation)
 */

import express from "express";
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

    console.log(req.body)

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

    console.log(`[MODERATION] ${username} reported ${reportedPlayer}: ${reason}`);

    // In a full implementation, this would:
    // 1. Log the report to a database
    // 2. Potentially notify moderators
    // 3. Track report frequency for abuse prevention

    // For now, just acknowledge the report
    res.status(200).send();
});

export default router;
