/**
 * Mix API Routes
 * 
 * Disney Mix API endpoints for friend management, notifications, moderation,
 * session management, and user search.
 * 
 * Authentication: Uses X-Mix-OneIdToken (access token) and X-Mix-ClientToken headers
 * All requests include UserId and Timestamp in the body
 * 
 * ENCRYPTION: After session start, all requests/responses are AES-256-CBC encrypted
 * using the symmetric key exchanged during PUT /session/user
 */

import express from "express";
const router = express.Router();
import * as db from "../database.ts";
import crypto from "crypto";
import { buildRsaPublicKeyFromBytes, decryptAesCbc, encryptAesCbc } from "../lib/crypto.ts";

// State variables
let notificationSequence = 0;
const presenceState = new Map();

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Generate a hashed user ID from SWID
 */
function hashUserId(userId) {
    return crypto.createHash('sha256').update(userId).digest('hex').substring(0, 32);
}

/**
 * Build a success response
 */
function buildResponse(data = {}) {
    return {
        Status: 'OK',
        ...data
    };
}

/**
 * Get current timestamp in milliseconds
 */
function getTimestamp() {
    return Date.now();
}

/**
 * Generate a unique ID
 */
function generateId() {
    return Math.floor(Math.random() * 1000000000);
}

/**
 * Generate a default avatar object matching the reference implementation
 */
function generateDefaultAvatar() {
    return {
        AvatarId: generateId(),
        SlotId: 0,
        Accessory: { SelectionKey: "3", TintIndex: 17, XOffset: 0.0, YOffset: 0.0 },
        Brow: { SelectionKey: "9", TintIndex: 0, XOffset: 0.0, YOffset: 0.004 },
        Costume: { SelectionKey: "15", TintIndex: 0, XOffset: 0.0, YOffset: 0.0 },
        Eyes: { SelectionKey: "54", TintIndex: 11, XOffset: 0.0, YOffset: 0.012 },
        Hair: { SelectionKey: "69", TintIndex: 7, XOffset: 0.0, YOffset: 0.0 },
        Hat: { SelectionKey: "257", TintIndex: 0, XOffset: 0.0, YOffset: 0.0 },
        Nose: { SelectionKey: "106", TintIndex: 0, XOffset: 0.0, YOffset: 0.012 },
        Mouth: { SelectionKey: "194", TintIndex: 0, XOffset: -0.001, YOffset: 0.0 },
        Skin: { SelectionKey: "123", TintIndex: 9, XOffset: 0.0, YOffset: 0.0 }
    };
}

const decryptAes = decryptAesCbc;
const encryptAes = encryptAesCbc;

/**
 * Get session key from X-Mix-UserSessionId header
 */
function getSessionKey(req) {
    const sessionId = req.headers['x-mix-usersessionid'];
    if (!sessionId) {
        console.error('[MIX] No X-Mix-UserSessionId header found');
        return null;
    }
    
    // Find session by sessionId in database
    const session = db.getMixSessionById(parseInt(sessionId));
    if (!session) {
        console.error(`[MIX] Session key not found for sessionId: ${sessionId}`);
        return null;
    }
    
    return session.symmetricKey;
}

// =============================================================================
// Mix Encryption Middleware
// =============================================================================

/**
 * Middleware to decrypt incoming request bodies and encrypt responses
 * Only applies to routes that expect encrypted communication (after session start)
 */
function mixEncryptionMiddleware(req, res, next) {
    const contentType = req.headers['content-type'];
    console.log(`[MIX] Middleware: ${req.method} ${req.url} Content-Type: ${contentType}`);
    
    // Check if this is an encrypted request (application/mix)
    if (contentType && contentType.includes('application/mix')) {
        const sessionKey = getSessionKey(req);
        
        if (!sessionKey) {
            console.error('[MIX] No session key found for encrypted request');
            return res.status(401).json({ Status: 'UNAUTHORIZED_MIX_SESSION' });
        }
        
        try {
            // req.body is a Buffer from express.raw() middleware
            const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
            const decrypted = decryptAes(rawBody, sessionKey);
            req.body = JSON.parse(decrypted.toString('utf8'));
            console.log(`[MIX] Decrypted body:`, JSON.stringify(req.body));
            
            // Store session key for response encryption
            req.mixSessionKey = sessionKey;
            
            // Override res.json to encrypt the response
            const originalJson = res.json.bind(res);
            res.json = (data) => {
                const plaintext = JSON.stringify(data);
                const encrypted = encryptAes(Buffer.from(plaintext, 'utf8'), sessionKey);
                res.setHeader('Content-Type', 'application/mix');
                res.send(encrypted);
            };
            
            next();
        } catch (err) {
            console.error('[MIX] Decryption error:', err.message);
            return res.status(400).json({ Status: 'DECRYPTION_ERROR' });
        }
    } else {
        // Not encrypted (session start or other unencrypted requests)
        console.log(`[MIX] Unencrypted request body:`, JSON.stringify(req.body));
        next();
    }
}

// Apply encryption middleware to all Mix routes
router.use(mixEncryptionMiddleware);

// =============================================================================
// Mix Authentication Middleware
// =============================================================================

function authenticateMix(req, res, next) {
    const oneIdToken = req.headers['x-mix-oneidtoken'];
    const clientToken = req.headers['x-mix-clienttoken'];
    
    // For development, accept any token
    // In production, validate against stored tokens
    if (!oneIdToken) {
        console.warn(`[MIX] Auth failed: Missing X-Mix-OneIdToken for ${req.method} ${req.url}`);
        return res.status(401).json({ Status: 'UNAUTHORIZED_ONEID_TOKEN' });
    }
    
    // Extract UserId from request body
    const userId = req.body?.UserId;
    if (userId) {
        req.mixUserId = userId;
    }
    
    next();
}

// =============================================================================
// User/Search Endpoints
// =============================================================================

/**
 * POST /users/byDisplayName
 * Get users by display name
 */
router.post('/users/byDisplayName', authenticateMix, (req, res) => {
    const { DisplayNames } = req.body;
    
    const users = [];
    if (DisplayNames && Array.isArray(DisplayNames)) {
        for (const displayName of DisplayNames) {
            const player = db.getPlayerByDisplayName(displayName);
            if (player) {
                users.push({
                    UserId: player.swid,
                    HashedUserId: hashUserId(player.swid),
                    DisplayName: player.displayName || player.username,
                    FirstName: null,
                    Status: 'ACTIVE'
                });
            }
        }
    }
    
    res.json(buildResponse({ Users: users }));
});

/**
 * POST /users/byUserId
 * Get users by user ID
 */
router.post('/users/byUserId', authenticateMix, (req, res) => {
    const { UserIds } = req.body;
    
    const users = [];
    if (UserIds && Array.isArray(UserIds)) {
        const players = db.getPlayersBySwids(UserIds);
        for (const player of players) {
            users.push({
                UserId: player.swid,
                HashedUserId: hashUserId(player.swid),
                DisplayName: player.displayName || player.username,
                FirstName: null,
                Status: 'ACTIVE'
            });
        }
    }
    
    res.json(buildResponse({ Users: users }));
});

/**
 * POST /search/displayname
 * Search for display names
 */
router.post('/search/displayname', authenticateMix, (req, res) => {
    const { DisplayName, UserId } = req.body;
    
    console.log(`[SEARCH] Searching for display name: ${DisplayName} (requested by ${UserId})`);
    
    // Search for player by display name
    const player = db.getPlayerByDisplayName(DisplayName);
    
    console.log(`[SEARCH] Player lookup result:`, player);
    
    // Check if the found player is the same as the requesting user (can't be your own friend!)
    if (player && player.swid === UserId) {
        console.log(`[SEARCH] Player found is the requesting user themselves, returning not found`);
        const response = buildResponse({
            DisplayName: null,
            FirstName: null
        });
        res.json(response);
    } else if (player) {
        const response = buildResponse({
            DisplayName: player.displayName || player.username,
            FirstName: null
        });
        console.log(`[SEARCH] Found player, responding with:`, JSON.stringify(response));
        res.json(response);
    } else {
        const response = buildResponse({
            DisplayName: null,
            FirstName: null
        });
        console.log(`[SEARCH] Player not found, responding with:`, JSON.stringify(response));
        res.json(response);
    }
});

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
                Status: 'ACTIVE'
            });
        }
    }
    
    res.json(buildResponse({
        Users: users,
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
        NotificationSequenceCounter: notificationSequence,
        NotificationSequenceThreshold: 100,
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
// Display Name Endpoints
// =============================================================================

/**
 * PUT /displayname
 * Set display name
 */
router.put('/displayname', authenticateMix, (req, res) => {
    const { UserId, DisplayName, Language } = req.body;
    
    // Update display name in database
    db.setPlayerDisplayName(UserId, DisplayName);
    
    res.json(buildResponse({
        DisplayName: DisplayName
    }));
});

/**
 * POST /displayname/validate
 * Validate display names (batch)
 */
router.post('/displayname/validate', authenticateMix, (req, res) => {
    const { DisplayNames } = req.body;
    
    // For development, accept all display names
    // In production, filter inappropriate names
    const validNames = DisplayNames || [];
    
    res.json(buildResponse({
        DisplayNames: validNames
    }));
});

/**
 * POST /displayname/validate/v2
 * Validate single display name
 */
router.post('/displayname/validate/v2', authenticateMix, (req, res) => {
    const { DisplayName } = req.body;
    
    // Check if display name is valid
    let status = 'VALID';
    const suggestions = [];
    
    // Check for blocked words
    const blocked = ['admin', 'moderator', 'disney', 'penguin'];
    if (blocked.some(word => DisplayName?.toLowerCase().includes(word))) {
        status = 'MODERATED';
        // Generate suggestions
        for (let i = 1; i <= 3; i++) {
            suggestions.push(`${DisplayName}${Math.floor(Math.random() * 1000)}`);
        }
    }
    
    // Check length
    if (DisplayName && (DisplayName.length < 3 || DisplayName.length > 20)) {
        status = 'INVALID_LENGTH';
    }
    
    // Check if already taken
    const existing = db.getPlayerByDisplayName(DisplayName);
    if (existing) {
        status = 'TAKEN';
        for (let i = 1; i <= 3; i++) {
            suggestions.push(`${DisplayName}${Math.floor(Math.random() * 1000)}`);
        }
    }
    
    res.json(buildResponse({
        DisplayNameStatus: status,
        DisplayNames: suggestions
    }));
});

// =============================================================================
// Friendship Endpoints
// =============================================================================

/**
 * PUT /friendship
 * Add friendship (accept invitation)
 * 
 * Response format based on cpi-web-service reference implementation
 */
router.put('/friendship', authenticateMix, (req, res) => {
    const { UserId, InvitationId, IsTrusted } = req.body;
    
    console.log(`[FRIENDSHIP] Accept invitation request from ${UserId}, InvitationId: ${InvitationId} (type: ${typeof InvitationId})`);
    
    // Find the invitation from database
    const userInvitations = db.getMixFriendshipInvitations(UserId);
    console.log(`[FRIENDSHIP] User has ${userInvitations.length} pending invitations:`, userInvitations.map(i => `${i.invitationId} (${typeof i.invitationId})`));
    
    // Try to find by exact match first, then by string comparison
    let invitation = userInvitations.find(inv => inv.invitationId === InvitationId);
    if (!invitation) {
        // Try string comparison in case of type mismatch
        invitation = userInvitations.find(inv => String(inv.invitationId) === String(InvitationId));
        if (invitation) {
            console.log(`[FRIENDSHIP] Found invitation via string comparison`);
        }
    }
    
    if (!invitation) {
        console.log(`[FRIENDSHIP] Invitation ${InvitationId} not found for user ${UserId}`);
        return res.json({
            Status: 'INVITATION_DOES_NOT_EXIST',
            Message: 'A friendship invitation with this ID does not exist.'
        });
    }
    
    // Get friend's user ID from display name
    const friend = db.getPlayerByDisplayName(invitation.friendDisplayName);
    if (!friend) {
        console.log(`[FRIENDSHIP] Friend ${invitation.friendDisplayName} not found`);
        return res.json({
            Status: 'INVITATION_DOES_NOT_EXIST',
            Message: 'A friendship invitation with this ID does not exist.'
        });
    }
    
    const created = Date.now();
    const notificationId = generateId();
    const sequenceNumber = notificationSequence++;
    
    // Add friendship for both users in database
    db.addMixFriendship(UserId, friend.swid, IsTrusted || false);
    db.addMixFriendship(friend.swid, UserId, IsTrusted || false);
    
    // Remove invitation from database
    db.removeMixFriendshipInvitation(InvitationId);
    
    // Get the accepter's info for notifications
    const accepter = db.getPlayerBySwid(UserId);
    
    // Add notification for the friend (the original inviter) that their invitation was accepted
    const friendNotificationSeq = db.addMixPendingNotification(friend.swid, 'AddFriendship', {
        Created: created,
        NotificationId: generateId(),
        SequenceNumber: 0, // Will be set by database function
        Friend: {
            UserId: UserId,
            HashedUserId: hashUserId(UserId),
            DisplayName: accepter?.displayName || accepter?.username,
            FirstName: accepter?.displayName || accepter?.username,
            Avatar: generateDefaultAvatar(),
            Status: null,
            Nickname: null
        },
        FriendshipInvitationId: InvitationId,
        IsTrusted: IsTrusted || false
    });
    
    console.log(`[FRIENDSHIP] Friendship created between ${UserId} and ${friend.swid}`);
    
    // Build response matching cpi-web-service format
    const response = buildResponse({
        Notification: {
            Created: created,
            NotificationId: notificationId,
            SequenceNumber: sequenceNumber,
            Invitation: {
                FriendshipInvitationId: InvitationId,
                FriendDisplayName: friend.displayName || friend.username,
                IsInviter: true,
                IsTrusted: IsTrusted || false
            },
            Friend: {
                UserId: friend.swid,
                HashedUserId: hashUserId(friend.swid),
                DisplayName: friend.displayName || friend.username,
                FirstName: friend.displayName || friend.username,
                Avatar: generateDefaultAvatar(),
                Status: null,
                Nickname: null
            },
            FriendshipInvitationId: InvitationId,
            IsTrusted: IsTrusted || false
        }
    });
    
    console.log(`[FRIENDSHIP] Sending accept response:`, JSON.stringify(response));
    res.json(response);
});

/**
 * POST /friendship/delete
 * Remove friendship
 */
router.post('/friendship/delete', authenticateMix, (req, res) => {
    const { UserId, FriendUserId } = req.body;
    
    // Remove friendship from database (both directions)
    db.removeMixFriendship(UserId, FriendUserId);
    db.removeMixFriendship(FriendUserId, UserId);
    
    res.json(buildResponse({
        Notification: {
            FriendUserId: FriendUserId
        }
    }));
});

/**
 * POST /friendship/recommend
 * Get friend recommendations
 */
router.post('/friendship/recommend', authenticateMix, (req, res) => {
    const { UserId } = req.body;
    
    // Get some random players as recommendations
    const allPlayers = db.getAllPlayers();
    const userFriendships = db.getMixFriendships(UserId);
    const friendIds = userFriendships.map(f => f.friendUserId);
    
    const recommendations = allPlayers
        .filter(p => p.swid !== UserId && !friendIds.includes(p.swid))
        .slice(0, 5)
        .map(p => ({
            DisplayName: p.display_name || p.username,
            FirstName: null
        }));
    
    res.json(buildResponse({
        FriendRecommendations: recommendations
    }));
});

/**
 * PUT /friendship/invitation
 * Send friend invitation
 * 
 * Response format based on cpi-web-service reference implementation
 */
router.put('/friendship/invitation', authenticateMix, (req, res) => {
    const { UserId, InviteeDisplayName, IsTrusted } = req.body;
    
    console.log(`[FRIENDSHIP] Send invitation request from ${UserId} to ${InviteeDisplayName}`);
    
    if (!InviteeDisplayName) {
        console.log('[FRIENDSHIP] Error: InviteeDisplayName is missing');
        return res.json({ Status: 'INVALID_REQUEST' });
    }
    
    const invitee = db.getPlayerByDisplayName(InviteeDisplayName);
    console.log(`[FRIENDSHIP] Invitee lookup result:`, invitee);
    
    if (!invitee) {
        console.log(`[FRIENDSHIP] User not found: ${InviteeDisplayName}`);
        return res.json({ Status: 'USER_NOT_FOUND' });
    }
    
    // Check if invitation already exists in database
    const existingInvitations = db.getMixFriendshipInvitations(UserId);
    const alreadyExists = existingInvitations.some(inv => 
        inv.friendDisplayName.toLowerCase() === InviteeDisplayName.toLowerCase()
    );
    if (alreadyExists) {
        console.log(`[FRIENDSHIP] Invitation already exists for ${InviteeDisplayName}`);
        return res.json({ 
            Status: 'INVITATION_ALREADY_EXISTS',
            Message: 'A friendship invitation already exists for this user.'
        });
    }
    
    const invitationId = generateId();
    const notificationId = generateId();
    const sequenceNumber = notificationSequence++;
    const created = Date.now();
    
    console.log(`[FRIENDSHIP] Generated invitation ID: ${invitationId}`);
    
    // Add invitation for both users in database
    db.addMixFriendshipInvitation(invitationId, UserId, InviteeDisplayName, true, IsTrusted || false);
    
    const inviterPlayer = db.getPlayerBySwid(UserId);
    console.log(`[FRIENDSHIP] Inviter player lookup:`, inviterPlayer);
    
    db.addMixFriendshipInvitation(invitationId, invitee.swid, inviterPlayer?.displayName || inviterPlayer?.username || 'Unknown', false, IsTrusted || false);
    
    // Store pending notification in database for invitee to receive via /notifications/sinceSequence
    const inviteeNotificationSeq = db.addMixPendingNotification(invitee.swid, 'AddFriendshipInvitation', {
        Created: created,
        NotificationId: generateId(),
        SequenceNumber: 0, // Will be set by database function
        Invitation: {
            FriendshipInvitationId: invitationId,
            FriendDisplayName: inviterPlayer?.displayName || inviterPlayer?.username || 'Unknown',
            IsInviter: false,
            IsTrusted: IsTrusted || false
        },
        Friend: {
            UserId: UserId,
            HashedUserId: hashUserId(UserId),
            DisplayName: inviterPlayer?.displayName || inviterPlayer?.username,
            FirstName: inviterPlayer?.displayName || inviterPlayer?.username,
            Avatar: generateDefaultAvatar(),
            Status: null,
            Nickname: null
        }
    });
    
    // Build response matching cpi-web-service format
    const response = buildResponse({
        Notification: {
            Created: created,
            NotificationId: notificationId,
            SequenceNumber: sequenceNumber,
            Invitation: {
                FriendshipInvitationId: invitationId,
                FriendDisplayName: InviteeDisplayName,
                IsInviter: true,
                IsTrusted: IsTrusted || false
            },
            Friend: {
                UserId: invitee.swid,
                HashedUserId: hashUserId(invitee.swid),
                DisplayName: invitee.displayName || invitee.username,
                FirstName: invitee.displayName || invitee.username,
                Avatar: generateDefaultAvatar(),
                Status: null,
                Nickname: null
            }
        }
    });
    
    console.log(`[FRIENDSHIP] Sending response:`, JSON.stringify(response));
    res.json(response);
});

/**
 * POST /friendship/invitation/delete
 * Remove friend invitation
 */
router.post('/friendship/invitation/delete', authenticateMix, (req, res) => {
    const { UserId, InvitationId } = req.body;
    
    // Remove invitation from database
    db.removeMixFriendshipInvitation(InvitationId);
    
    res.json(buildResponse({
        Notification: {
            InvitationId: InvitationId
        }
    }));
});

/**
 * POST /friendship/trust/delete
 * Remove friendship trust
 */
router.post('/friendship/trust/delete', authenticateMix, (req, res) => {
    const { UserId, FriendUserId } = req.body;
    
    // Update trust status in database by re-adding with updated trust value
    db.addMixFriendship(UserId, FriendUserId, false);
    
    res.json(buildResponse({
        Notification: {
            FriendUserId: FriendUserId
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
        NotificationSequenceCounter: notificationSequence++,
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
    
    // Get pending notifications for this user from database
    const userNotifications = db.getMixPendingNotifications(UserId, SequenceNumber);
    
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
    
    // Get latest sequence number
    const allNotifications = db.getMixPendingNotifications(UserId, 0);
    const maxSeq = allNotifications.length > 0 ? Math.max(...allNotifications.map(n => n.sequence)) : 0;
    
    res.json(buildResponse({
        LastNotificationTimestamp: getTimestamp(),
        NotificationSequenceCounter: maxSeq,
        AddFriendship: addFriendships,
        AddFriendshipInvitation: addFriendshipInvitations,
        AddAlert: addAlerts,
        ClearAlert: clearAlerts,
        RemoveFriendshipInvitation: removeFriendshipInvitations,
        RemoveFriendship: removeFriendships,
        RemoveFriendshipTrust: removeFriendshipTrust
    }));
});

// =============================================================================
// Session Endpoints
// =============================================================================

/**
 * Build an RSA public key from modulus and exponent (Base64 encoded)
 * Returns a Node.js crypto KeyObject
 */
function buildRsaPublicKey(modulusBase64, exponentBase64) {
    return buildRsaPublicKeyFromBytes(
        Buffer.from(modulusBase64, 'base64'),
        Buffer.from(exponentBase64, 'base64')
    );
}

/**
 * PUT /session/user
 * Start user session
 * 
 * The client sends its RSA public key (modulus + exponent).
 * The server generates a symmetric key, encrypts it with the client's public key,
 * and returns it. The client decrypts it with its private key.
 */
router.put('/session/user', authenticateMix, (req, res) => {
    const { UserId, PublicKeyModulus, PublicKeyExponent, SessionGroupId, ProtocolVersion } = req.body;
    
    const sessionId = generateId();
    const hashedUserId = hashUserId(UserId);
    
    try {
        // Build the client's RSA public key from modulus and exponent
        const publicKey = buildRsaPublicKey(PublicKeyModulus, PublicKeyExponent);
        
        // Generate a 32-byte (256-bit) symmetric key for AES-256
        const symmetricKey = crypto.randomBytes(32);
        
        // Encrypt the symmetric key with the client's public key using PKCS#1 v1.5 padding
        const encryptedSymmetricKey = crypto.publicEncrypt(
            {
                key: publicKey,
                padding: crypto.constants.RSA_PKCS1_PADDING
            },
            symmetricKey
        );
        
        // Store session in database with the symmetric key for later use
        db.storeMixSession(UserId, sessionId, hashedUserId, symmetricKey);
        
        // Set presence to ACTIVE when session is created
        db.setMixPresenceState(UserId, 'ACTIVE');
        
        res.json(buildResponse({
            EncryptedSymmetricKey: encryptedSymmetricKey.toString('base64'),
            SessionId: sessionId,
            HashedUserId: hashedUserId
        }));
    } catch (err) {
        console.error('[MIX] Error creating session:', err.message);
        res.status(500).json({ Status: 'INTERNAL_ERROR', Message: err.message });
    }
});

/**
 * POST /session/user/delete
 * Delete user session
 */
router.post('/session/user/delete', authenticateMix, (req, res) => {
    const { UserId } = req.body;
    
    // Clear all Mix data for user from database
    db.clearAllMixDataForUser(UserId);
    
    res.json(buildResponse());
});

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
 * Moderate text (chat filter)
 */
router.put('/moderation/text', authenticateMix, (req, res) => {
    const { Text, Language, ChatThreadId, ModerationPolicy } = req.body;
    
    // Simple profanity filter (in production, use a proper filter)
    const badWords = ['badword1', 'badword2']; // Add actual bad words
    let moderated = false;
    let moderatedText = Text;
    
    for (const word of badWords) {
        if (Text?.toLowerCase().includes(word)) {
            moderated = true;
            moderatedText = moderatedText.replace(new RegExp(word, 'gi'), '*'.repeat(word.length));
        }
    }
    
    res.json(buildResponse({
        Text: moderatedText,
        Moderated: moderated
    }));
});

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

// =============================================================================
// Geolocation Endpoints
// =============================================================================

/**
 * POST /geolocation
 * Get geolocation
 */
router.post('/geolocation', authenticateMix, (req, res) => {
    const { UserId } = req.body;
    
    // Return default country code
    res.json(buildResponse({
        CountryCode: 'US'
    }));
});

// =============================================================================
// Language Endpoints
// =============================================================================

/**
 * POST /languagePreference
 * Set language preference
 */
router.post('/languagePreference', authenticateMix, (req, res) => {
    const { UserId, LanguageCode } = req.body;
    
    // Store language preference (in production, store in database)
    console.log(`[LANGUAGE] User ${UserId} set language to ${LanguageCode}`);
    
    res.json(buildResponse());
});

// =============================================================================
// Registration Endpoints (Guest/Public - No Auth Required)
// =============================================================================

/**
 * POST /registration/text
 * Get registration text
 * 
 * NOTE: This is a PUBLIC endpoint - no authentication required.
 * It's called during registration before the user has an account or token.
 * Reference: cpi-web-service/src/main/java/me/ryan/api/auth/mix/MixRegistrationText.java
 */
router.post(['/registration/text', '/mix/registration/text'], (req, res) => {
    // console.log('[MIX] POST /registration/text (public) body:', JSON.stringify(req.body));

    // Match headers from user provided snippet (emulating Google Frontend / Prod Env)
    res.removeHeader('Transfer-Encoding');
    res.set({
        "Content-Type": "application/json",
        "X-Cloud-Trace-Context": "f02d741cfb2578b7d0ff9f230429c25c",
        "Alt-Svc": 'quic=":443"; ma=2592000; v="44,43,39,35"',
        "Server": "Google Frontend",
        "Connection": "Keep-alive"
    });

    // Return hardcoded response matching the EXACT TextCode requested by client
    // The client requests "gtou_ppv2_proxy_create" which is a combined ToU + Privacy Policy text
    const responseData = {
        "Status": "OK",
        "RegistrationText": [
            {
                "TextCode": "gtou_ppv2_proxy_create",
                "Text": "By creating an account, I agree to the <a target=\"_blank\" href=\"https://disneytermsofuse.com/english/\">Terms of Use</a> and acknowledge the <a target=\"_blank\" href=\"https://privacy.thewaltdisneycompany.com/en/current-privacy-policy/\">Privacy Policy</a>."
            }
        ]
    };

    res.json(responseData);
});

// =============================================================================
// PIL Check Endpoints
// =============================================================================

/**
 * POST /pil/check
 * Check PIL status
 */
router.post('/pil/check', authenticateMix, (req, res) => {
    const { UserId, CountryCode, PersonalInformationUsage } = req.body;
    
    // PIL (Personal Information Location) check
    // For development, no adult verification required
    res.json(buildResponse({
        AdultVerificationRequired: false,
        AdultVerificationAvailable: true
    }));
});

export default router;
