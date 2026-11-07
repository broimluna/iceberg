import express from "express";
import * as db from "../../database.ts";
import { authenticateMix } from "./auth.ts";
import { buildResponse, getTimestamp } from "./common.ts";

const router = express.Router();

// =============================================================================
// Alert Endpoints
// =============================================================================

/**
 * PUT /alert/clear
 * Clear alerts
 */
router.put('/alert/clear', authenticateMix, (req, res) => {
    const { UserId, AlertIds } = req.body;
    
    const userAlerts = alerts.get(UserId) || [];
    
    if (AlertIds && Array.isArray(AlertIds)) {
        const filteredAlerts = userAlerts.filter(a => !AlertIds.includes(a.alertId));
        alerts.set(UserId, filteredAlerts);
    }
    
    res.json(buildResponse({
        Notification: {
            AlertIds: AlertIds || []
        }
    }));
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
