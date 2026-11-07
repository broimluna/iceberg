import express from "express";
import * as db from "../../database.ts";
import { authenticateMix } from "./auth.ts";
import { buildResponse } from "./common.ts";

const router = express.Router();

// =============================================================================
// Push Notification Endpoints
// =============================================================================

/**
 * POST /pushNotificationsSetting
 * Toggle push notification
 */
router.post('/pushNotificationsSetting', authenticateMix, (req, res) => {
    const { UserId, PushToken, State, IosProvisioningId } = req.body;
    
    // Store push notification settings (in production, store in database)
    console.log(`[PUSH] User ${UserId} set push state to ${State}`);
    
    res.json(buildResponse());
});

/**
 * POST /pushNotificationsSetting/delete
 * Delete push notification setting
 */
router.post('/pushNotificationsSetting/delete', authenticateMix, (req, res) => {
    const { UserId } = req.body;
    
    console.log(`[PUSH] User ${UserId} deleted push settings`);
    
    res.json(buildResponse());
});


export default router;
