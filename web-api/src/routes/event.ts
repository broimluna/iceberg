/**
 * Event Routes
 * 
 * Handles scheduled events like Coins for Change.
 * 
 * Endpoints:
 * - GET  /event/v1/cfc        - Get CFC donations (GetCFCDonationsOperation)
 * - POST /event/v1/cfc/:coins - Make CFC donation (PostCFCDonationOperation)
 */

import { positiveCount, NOT_ENOUGH_COINS } from "../utils/counts.ts";
import express from "express";
const router = express.Router();
import * as db from "../database.ts";

// Global CFC totals (could be stored in database)
let cfcGlobalTotal = 0;

/**
 * GET /event/v1/cfc
 * Get Coins for Change donation stats
 * 
 * Response: CFCDonations { cfcTotal, contribution }
 */
router.get('/event/v1/cfc', (req, res) => {
    const { swid, username } = req.player;
    
    console.log(`[EVENT] ${username} fetching CFC donations`);
    
    // Get player's contribution
    const contribution = db.getCFCContribution ? db.getCFCContribution(username) : 0;
    
    // Response: CFCDonations
    res.json({
        cfcTotal: cfcGlobalTotal,
        contribution: contribution
    });
});

/**
 * POST /event/v1/cfc/:coins
 * Make a Coins for Change donation
 * 
 * Response: DonationResult { cfcTotal, remainingCoinBalance, reward }
 */
router.post('/event/v1/cfc/:coins', (req, res) => {
    const { swid, username } = req.player;
    const coins = positiveCount(req.params.coins, 1_000_000);
    if (coins === null) return res.status(400).json({ code: 'BAD_COUNT' });
    if (db.getPlayerCoins(username) < coins) return res.status(400).json({ code: NOT_ENOUGH_COINS });
    
    console.log(`[EVENT] ${username} donating ${coins} coins to CFC`);
    
    // Deduct coins from player
    db.addPlayerCoins(username, -coins);
    
    // Add to global total
    cfcGlobalTotal += coins;
    
    // Track player's contribution
    if (db.addCFCContribution) {
        db.addCFCContribution(username, coins);
    }
    
    // Get remaining balance
    const remainingCoinBalance = db.getPlayerCoins(username);
    
    // Generate reward (could be based on donation amount)
    const reward = {
        coins: 0 // CFC is a donation, no direct coin reward
    };
    
    // Response: DonationResult
    res.json({
        cfcTotal: cfcGlobalTotal,
        remainingCoinBalance: remainingCoinBalance,
        reward: reward
    });
});

export default router;
