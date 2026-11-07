import express from "express";
import * as db from "../../database.ts";
import { authenticateMix } from "./auth.ts";
import { hashUserId, buildResponse, getTimestamp, presenceState, defaultAvatar } from "./common.ts";

const router = express.Router();

// =============================================================================
// State Endpoints
// =============================================================================

/**
 * POST /state
 * Get full user state (friends, invitations, alerts)
 */
router.post('/state', authenticateMix, (req, res) => {
    const { UserId, ClientVersion } = req.body;
    
    console.log(`[STATE] Getting state for UserId: ${UserId}`);
    
    // Get user's friends from database
    const userFriendships = db.getMixFriendships(UserId);
    console.log(`[STATE] User has ${userFriendships.length} friendships:`, userFriendships);
    
    // Get user's friend invitations from database
    const userInvitations = db.getMixFriendshipInvitations(UserId);
    console.log(`[STATE] User has ${userInvitations.length} invitations:`, userInvitations);
    
    // Get user's alerts from database
    const userAlerts = db.getMixAlerts(UserId);
    
    // Build users list - include the local user AND their friends
    const users = [];
    
    // IMPORTANT: Always include the local user themselves in the Users array
    // The client's LocalUser.HashedId property depends on this being in the database
    const localPlayer = db.getPlayerBySwid(UserId);
    console.log(`[STATE] localPlayer lookup result:`, localPlayer);
    
    if (localPlayer) {
        const displayName = localPlayer.displayName || localPlayer.username || 'UnknownPenguin';
        console.log(`[STATE] Adding local user to Users array with DisplayName: ${displayName}`);
        users.push({
            UserId: UserId,
            HashedUserId: hashUserId(UserId),
            DisplayName: displayName,
            FirstName: null,
            Avatar: defaultAvatar(UserId),
            Status: 'ACTIVE'
        });
    } else {
        console.error(`[STATE] ERROR: localPlayer not found for UserId: ${UserId}`);
    }
    
    // Add friends to users list
    for (const friendship of userFriendships) {
        const player = db.getPlayerBySwid(friendship.friendUserId);
        if (player) {
            users.push({
                UserId: friendship.friendUserId,
                HashedUserId: hashUserId(friendship.friendUserId),
                DisplayName: player.displayName || player.username,
                FirstName: null,
                Avatar: defaultAvatar(friendship.friendUserId),
                Status: 'ACTIVE'
            });
        }
    }
    
    res.json(buildResponse({
        Users: users,
        // Mix app fields (GetStateResponse). Empty until chat, nicknames
        // and official accounts exist; the app expects the lists present.
        UserNicknames: [],
        OfficialAccounts: [],
        ChatThreads: [],
        ChatThreadNicknames: [],
        ChatThreadUnreadMessageCount: [],
        ChatThreadLatestMessageSequenceNumbers: [],
        ChatThreadLastSeenMessageSequenceNumbers: [],
        GameStateChatMessages: [],
        Friendships: userFriendships.map(f => ({
            FriendUserId: f.friendUserId,
            IsTrusted: f.isTrusted
        })),
        FriendshipInvitations: userInvitations.map(inv => ({
            FriendshipInvitationId: inv.invitationId,
            FriendDisplayName: inv.friendDisplayName,
            IsInviter: inv.isInviter,
            IsTrusted: inv.isTrusted
        })),
        Alerts: userAlerts.map(a => ({
            AlertId: a.alertId,
            Level: a.level,
            Text: a.text,
            Timestamp: a.timestamp
        })),
        // PollIntervals and PokeIntervals are in SECONDS - client multiplies by 1000
        // Use shorter intervals for more responsive real-time updates
        PollIntervals: [2, 5, 10],
        PokeIntervals: [2, 3, 5],
        Timestamp: getTimestamp(),
        NotificationSequenceCounter: db.getMixNotificationSequence(UserId),
        // Milliseconds: the client uses it as MaximumMissingNotificationTime
        // (SessionResumer), how long a sequence gap may stay open before it
        // gives up and resyncs from /state. See docs/MIX_API.md section 5.
        NotificationSequenceThreshold: 10000,
        NotificationIntervalsJitter: 1000
    }));
});

/**
 * PUT /presence
 * Set presence status
 */
router.put('/presence', authenticateMix, (req, res) => {
    const { UserId, State } = req.body;
    
    presenceState.set(UserId, State);
    
    res.json(buildResponse());
});

/**
 * POST /presence
 * Get presence status
 */
router.post('/presence', authenticateMix, (req, res) => {
    const { UserId } = req.body;
    
    const state = presenceState.get(UserId) || 'AWAY';
    
    res.json(buildResponse({ State: state }));
});


export default router;
