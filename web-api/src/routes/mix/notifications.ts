import express from "express";
import * as db from "../../database.ts";
import { authenticateMix } from "./auth.ts";
import { buildResponse, getTimestamp } from "./common.ts";
import { notify } from "../../services/mixNotify.ts";

const router = express.Router();

// Every list field of MixDomain/GetNotificationsResponse.cs. A stored
// notification goes in the list named by its type. This used to be a
// fixed switch over the friendship and alert types, so any other type
// (chat) was silently dropped and the client saw a sequence gap.
const NOTIFICATION_LISTS = [
    "AddChatThread", "AddChatThreadMembership", "AddChatThreadGagMessage", "AddChatThreadMemberListChangedMessage",
    "AddChatThreadPhotoMessage", "AddChatThreadStickerMessage", "AddChatThreadTextMessage", "AddChatThreadVideoMessage",
    "AddChatThreadNickname", "AddChatThreadGameStateMessage", "UpdateChatThreadGameStateMessage", "AddChatThreadGameEventMessage",
    "AddFriendship", "AddFollowship", "AddFriendshipInvitation", "AddNickname", "AddAlert", "ClearAlert",
    "ClearMemberChatHistory", "ClearUnreadMessageCount", "RemoveChatThreadMembership", "RemoveChatThreadNickname",
    "RemoveFriendshipInvitation", "RemoveFriendship", "RemoveFollowship", "RemoveFriendshipTrust", "RemoveNickname",
    "SetAvatar", "UpdateChatThreadTrustStatus",
];

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
    
    // One list per notification type, named as in GetNotificationsResponse.
    // A stored notification's type is its list name. All lists are sent,
    // empty when nothing is pending.
    const lists = Object.fromEntries(NOTIFICATION_LISTS.map((name) => [name, []]));
    for (const notification of userNotifications) {
        if (ExcludeNotificationSequenceNumbers &&
            ExcludeNotificationSequenceNumbers.includes(notification.sequence)) {
            continue;
        }
        const list = lists[notification.type];
        if (!list) {
            console.warn(`[NOTIFICATIONS] ${UserId}: stored notification type ${notification.type} has no list in GetNotificationsResponse, not sent`);
            continue;
        }
        list.push({ ...notification.data, SequenceNumber: notification.sequence });
    }
    
    // Clean up old notifications for this user (older than 1 hour)
    db.cleanupOldMixNotifications(UserId, 3600);
    
    res.json(buildResponse({
        LastNotificationTimestamp: getTimestamp(),
        NotificationSequenceCounter: db.getMixNotificationSequence(UserId),
        ...lists
    }));
});


export default router;
