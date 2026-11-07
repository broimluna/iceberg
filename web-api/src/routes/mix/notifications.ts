import express from "express";
import * as db from "../../database.ts";
import { authenticateMix } from "./auth.ts";
import { buildResponse, getTimestamp } from "./common.ts";
import { notify } from "../../services/mixNotify.ts";

const router = express.Router();

// =============================================================================
// Alert Endpoints
// =============================================================================

/**
 * PUT /alert/clear
 * The app calls this when the user dismisses an alert (a moderation
 * warning, docs/MIX_API.md section 9). Only the caller's own alerts are
 * removed. The reply's Notification is a ClearAlert the SDK validates
 * and runs through its sequence queue (LocalUser.ClearAlerts), so it is
 * stored like any other notification and gets the next sequence number.
 */
router.put('/alert/clear', authenticateMix, (req, res) => {
    const swid = req.mixUserId;
    const requested = Array.isArray(req.body.AlertIds) ? req.body.AlertIds : [];
    const notification = db.inTransaction(() => {
        const own = new Set(db.getMixAlerts(swid).map((a) => Number(a.alertId)));
        const cleared = requested.map(Number).filter((id) => own.has(id));
        for (const id of cleared) db.removeMixAlert(id);
        return notify(swid, "ClearAlert", { AlertIds: cleared });
    });
    res.json(buildResponse({ Notification: notification }));
});


// =============================================================================
// Notification Endpoints
// =============================================================================

/**
 * POST /notifications
 * Get notifications
 */
router.post('/notifications', authenticateMix, (req, res) => {
    const { UserId, CreatedAfter, ExcludeNotificationIds } = req.body;
    
    // Return empty notifications for development
    res.json(buildResponse({
        LastNotificationTimestamp: getTimestamp(),
        NotificationSequenceCounter: db.getMixNotificationSequence(UserId),
        AddFriendship: [],
        AddFriendshipInvitation: [],
        AddAlert: [],
        ClearAlert: [],
        RemoveFriendshipInvitation: [],
        RemoveFriendship: [],
        RemoveFriendshipTrust: []
    }));
});

/**
 * POST /notifications/sinceSequence
 * Get notifications since sequence
 * 
 * Returns pending notifications for the user (friend invitations, etc.)
 */
router.post('/notifications/sinceSequence', authenticateMix, (req, res) => {
    const { UserId, SequenceNumber, ExcludeNotificationSequenceNumbers } = req.body;
    
    // SequenceNumber is inclusive: the SDK asks for "latest + 1 onward"
    // (NotificationPoller.Poll), so return everything from it, not after it.
    // Treating it as exclusive skipped the one notification the client was
    // waiting for, which it saw as a gap and recovered from by resyncing.
    const since = Number.isFinite(SequenceNumber) ? SequenceNumber - 1 : 0;
    const userNotifications = db.getMixPendingNotifications(UserId, since);
    
    console.log(`[NOTIFICATIONS] User ${UserId} polling with SequenceNumber: ${SequenceNumber}, pending notifications: ${userNotifications.length}`);
    
    // Separate notifications by type
    const addFriendshipInvitations = [];
    const addFriendships = [];
    const removeFriendshipInvitations = [];
    const removeFriendships = [];
    const addAlerts = [];
    const clearAlerts = [];
    const removeFriendshipTrust = [];
    
    for (const notification of userNotifications) {
        console.log(`[NOTIFICATIONS] Checking notification type=${notification.type}, seq=${notification.sequence} vs client seq=${SequenceNumber}`);
        
        // Skip notifications that are in the exclude list
        if (ExcludeNotificationSequenceNumbers && 
            ExcludeNotificationSequenceNumbers.includes(notification.sequence)) {
            console.log(`[NOTIFICATIONS] Skipping - in exclude list`);
            continue;
        }
        
        console.log(`[NOTIFICATIONS] Including notification type=${notification.type}`);
        
        // Update data to use sequence from database
        const notificationData = { ...notification.data, SequenceNumber: notification.sequence };
        
        switch (notification.type) {
            case 'AddFriendshipInvitation':
                addFriendshipInvitations.push(notificationData);
                break;
            case 'AddFriendship':
                addFriendships.push(notificationData);
                break;
            case 'RemoveFriendshipInvitation':
                removeFriendshipInvitations.push(notificationData);
                break;
            case 'RemoveFriendship':
                removeFriendships.push(notificationData);
                break;
            case 'AddAlert':
                addAlerts.push(notificationData);
                break;
            case 'ClearAlert':
                clearAlerts.push(notificationData);
                break;
            case 'RemoveFriendshipTrust':
                removeFriendshipTrust.push(notificationData);
                break;
        }
    }
    
    // Clean up old notifications for this user (older than 1 hour)
    db.cleanupOldMixNotifications(UserId, 3600);
    
    res.json(buildResponse({
        LastNotificationTimestamp: getTimestamp(),
        NotificationSequenceCounter: db.getMixNotificationSequence(UserId),
        AddFriendship: addFriendships,
        AddFriendshipInvitation: addFriendshipInvitations,
        AddAlert: addAlerts,
        ClearAlert: clearAlerts,
        RemoveFriendshipInvitation: removeFriendshipInvitations,
        RemoveFriendship: removeFriendships,
        RemoveFriendshipTrust: removeFriendshipTrust
    }));
});


export default router;
