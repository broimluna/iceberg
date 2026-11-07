import express from "express";
import * as db from "../../database.ts";
import { inTransaction } from "../../database.ts";
import { notify } from "../../services/mixNotify.ts";
import { authenticateMix } from "./auth.ts";
import { buildResponse, generateId, mixUser, defaultAvatar } from "./common.ts";
import { onFriendshipTrustRemoved } from "../../services/mixChat.ts";
const router = express.Router();

// =============================================================================
// Friendship Endpoints
// =============================================================================

/**
 * PUT /friendship
 * Add friendship (accept invitation)
 * 
 * Response format based on cpi-web-service reference implementation
 */
router.put('/friendship', authenticateMix, (req, res) => inTransaction(() => {
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
    
    // Add friendship for both users in database
    db.addMixFriendship(UserId, friend.swid, IsTrusted || false);
    db.addMixFriendship(friend.swid, UserId, IsTrusted || false);
    
    // Remove invitation from database
    db.removeMixFriendshipInvitation(InvitationId);
    
    const accepter = db.getPlayerBySwid(UserId);
    
    // The original inviter learns the invitation was accepted.
    notify(friend.swid, 'AddFriendship', {
        Friend: mixUser(UserId, accepter),
        FriendshipInvitationId: InvitationId,
        IsTrusted: IsTrusted || false
    });
    
    console.log(`[FRIENDSHIP] Friendship created between ${UserId} and ${friend.swid}`);
    
    const response = buildResponse({
        Notification: notify(UserId, 'AddFriendship', {
            Friend: mixUser(friend.swid, friend),
            FriendshipInvitationId: InvitationId,
            IsTrusted: IsTrusted || false
        })
    });
    
    console.log(`[FRIENDSHIP] Sending accept response:`, JSON.stringify(response));
    res.json(response);
}));

/**
 * POST /friendship/delete
 * Remove friendship
 */
router.post('/friendship/delete', authenticateMix, (req, res) => inTransaction(() => {
    const { UserId, FriendUserId } = req.body;
    
    // Remove friendship from database (both directions)
    db.removeMixFriendship(UserId, FriendUserId);
    db.removeMixFriendship(FriendUserId, UserId);
    
    notify(FriendUserId, 'RemoveFriendship', { FriendUserId: UserId });
    const reply = notify(UserId, 'RemoveFriendship', { FriendUserId });
    // Ex-friends keep their old threads, but never with trust.
    onFriendshipTrustRemoved(UserId, FriendUserId);
    res.json(buildResponse({ Notification: reply }));
}));

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
            FirstName: null,
            Avatar: defaultAvatar(p.swid)
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
router.put('/friendship/invitation', authenticateMix, (req, res) => inTransaction(() => {
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
    
    console.log(`[FRIENDSHIP] Generated invitation ID: ${invitationId}`);
    
    const inviterPlayer = db.getPlayerBySwid(UserId);
    const inviterName = inviterPlayer?.displayName || inviterPlayer?.username || 'Unknown';
    
    // One row per side of the invitation.
    db.addMixFriendshipInvitation(invitationId, UserId, InviteeDisplayName, true, IsTrusted || false);
    db.addMixFriendshipInvitation(invitationId, invitee.swid, inviterName, false, IsTrusted || false);
    
    // The invitee receives it through /notifications/sinceSequence.
    notify(invitee.swid, 'AddFriendshipInvitation', {
        Invitation: {
            FriendshipInvitationId: invitationId,
            FriendDisplayName: inviterName,
            IsInviter: false,
            IsTrusted: IsTrusted || false
        },
        Friend: mixUser(UserId, inviterPlayer)
    });
    
    const response = buildResponse({
        Notification: notify(UserId, 'AddFriendshipInvitation', {
            Invitation: {
                FriendshipInvitationId: invitationId,
                FriendDisplayName: InviteeDisplayName,
                IsInviter: true,
                IsTrusted: IsTrusted || false
            },
            Friend: mixUser(invitee.swid, invitee)
        })
    });
    
    console.log(`[FRIENDSHIP] Sending response:`, JSON.stringify(response));
    res.json(response);
}));

/**
 * POST /friendship/invitation/delete
 * Remove friend invitation
 */
router.post('/friendship/invitation/delete', authenticateMix, (req, res) => inTransaction(() => {
    const { UserId, InvitationId } = req.body;
    
    // Tell the other side too, before the rows are gone.
    const invitation = db.getMixFriendshipInvitations(UserId).find(inv => String(inv.invitationId) === String(InvitationId));
    const other = invitation ? db.getPlayerByDisplayName(invitation.friendDisplayName) : null;
    
    db.removeMixFriendshipInvitation(InvitationId);
    
    if (other?.swid) notify(other.swid, 'RemoveFriendshipInvitation', { InvitationId });
    res.json(buildResponse({
        Notification: notify(UserId, 'RemoveFriendshipInvitation', { InvitationId })
    }));
}));

/**
 * POST /friendship/trust/delete
 * Remove friendship trust
 */
router.post('/friendship/trust/delete', authenticateMix, (req, res) => inTransaction(() => {
    const { UserId, FriendUserId } = req.body;

    // Only an existing friendship can lose trust. This used to upsert both
    // rows, so removing "trust" from any user made them your friend
    // without an invitation.
    const friends = db.db.query("SELECT 1 FROM mix_friendships WHERE swid = ? AND friend_user_id = ?").get(UserId, FriendUserId);
    if (typeof FriendUserId !== 'string' || !friends) {
        return res.status(400).json({ Status: 'FORBIDDEN_NOT_FRIENDS' });
    }
    db.db.query("UPDATE mix_friendships SET is_trusted = 0 WHERE (swid = ?1 AND friend_user_id = ?2) OR (swid = ?2 AND friend_user_id = ?1)").run(UserId, FriendUserId);
    
    notify(FriendUserId, 'RemoveFriendshipTrust', { FriendUserId: UserId });
    const reply = notify(UserId, 'RemoveFriendshipTrust', { FriendUserId });
    // Shared trusted chat threads lose trust too (after the reply, which the
    // SDK expects as the caller's next notification).
    onFriendshipTrustRemoved(UserId, FriendUserId);
    res.json(buildResponse({ Notification: reply }));
}));


export default router;
