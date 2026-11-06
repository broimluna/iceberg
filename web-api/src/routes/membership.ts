/**
 * Membership Routes
 * 
 * Handles membership grants and status.
 * 
 * Endpoints:
 * - POST /membership/v1/qa/membershipgrant - Grant membership (QAMembershipGrantOperation)
 */

import express from "express";
const router = express.Router();
import * as db from "../database.ts";

/**
 * POST /membership/v1/qa/membershipgrant
 * Grant membership to a player (QA/Debug endpoint)
 * 
 * Request: MembershipGrantRequest { membershipStatus, daysOfMembership }
 * Response: PurchaseResponse
 */
router.post('/membership/v1/qa/membershipgrant', (req, res) => {
    const { swid, username } = req.player;
    const grantRequest = req.body;
    
    const membershipStatus = grantRequest.membershipStatus !== undefined ? 
        grantRequest.membershipStatus : true;
    const daysOfMembership = grantRequest.daysOfMembership || 30;
    
    console.log(`[MEMBERSHIP] Granting ${daysOfMembership} days membership to ${username}: ${membershipStatus}`);
    
    // Calculate expiration date
    const expirationDate = membershipStatus ? 
        Date.now() + (daysOfMembership * 24 * 60 * 60 * 1000) : 0;
    
    // Update player membership status
    if (db.setMembershipStatus) {
        db.setMembershipStatus(username, membershipStatus, expirationDate);
    }
    
    // Response: PurchaseResponse
    res.json({
        membershipExpireDate: expirationDate,
        membershipType: membershipStatus ? 'AllAccessPass' : 'None',
        assets: db.getPlayerAssets(username)
    });
});

export default router;
