/**
 * Minigame Routes
 * 
 * Handles minigame operations like fishing.
 * 
 * Endpoints:
 * - POST /minigame/v1/fishing/cast  - Cast fishing rod (FishingCastOperation)
 * - POST /minigame/v1/fishing/catch - Catch fish (FishingCatchOperation)
 */

import express from "express";
const router = express.Router();
import * as db from "../database.ts";

/**
 * Wrap response in SignedResponse format
 */
function signedResponse(data, swid) {
    return {
        goodUntil: Date.now() + 3600000,
        swid: swid || '',
        data: data,
        signature: 'server_signature'
    };
}

// Available fishing prizes (can be configured)
const FISHING_PRIZES = {
    'common_fish': 'fish_common',
    'rare_fish': 'fish_rare',
    'epic_fish': 'fish_epic',
    'coins_small': 'coins_10',
    'coins_medium': 'coins_25',
    'coins_large': 'coins_50'
};

/**
 * POST /minigame/v1/fishing/cast
 * Cast the fishing rod
 * 
 * Request: SignedResponse<InWorldState>
 * Response: SignedResponse<FishingResult> { availablePrizeMap }
 */
router.post('/minigame/v1/fishing/cast', (req, res) => {
    const { swid, username } = req.player;
    
    console.log(`[MINIGAME] ${username} casting fishing rod`);
    
    // Generate random available prizes
    const availablePrizeMap = {};
    
    // Randomly select 3-5 prizes
    const prizeKeys = Object.keys(FISHING_PRIZES);
    const numPrizes = 3 + Math.floor(Math.random() * 3);
    
    for (let i = 0; i < numPrizes && i < prizeKeys.length; i++) {
        const randomIndex = Math.floor(Math.random() * prizeKeys.length);
        const key = prizeKeys[randomIndex];
        availablePrizeMap[key] = FISHING_PRIZES[key];
    }
    
    // Response: SignedResponse<FishingResult>
    res.json(signedResponse({
        availablePrizeMap: availablePrizeMap
    }, swid));
});

/**
 * POST /minigame/v1/fishing/catch
 * Catch a fish (complete fishing minigame)
 * 
 * Request: FishingCatchRequest { winningRewardName, inWorldState }
 * Response: FishingCatchResponse { rewards, wsEvents, ... }
 */
router.post('/minigame/v1/fishing/catch', (req, res) => {
    const { swid, username } = req.player;
    const catchRequest = req.body;
    const winningRewardName = catchRequest.winningRewardName || 'common_fish';
    
    console.log(`[MINIGAME] ${username} caught: ${winningRewardName}`);
    
    // Determine reward based on catch
    let coinReward = 10;
    if (winningRewardName.includes('rare')) {
        coinReward = 25;
    } else if (winningRewardName.includes('epic')) {
        coinReward = 50;
    } else if (winningRewardName.includes('coins')) {
        if (winningRewardName.includes('large')) coinReward = 50;
        else if (winningRewardName.includes('medium')) coinReward = 25;
        else coinReward = 10;
    }
    
    // Add coins to player
    db.addPlayerCoins(username, coinReward);
    
    // Build reward structure
    const reward = {
        coins: coinReward
    };
    
    // Response: FishingCatchResponse
    res.json({
        rewards: signedResponse({
            rewards: {
                [swid]: reward
            },
            source: 'MINI_GAME',
            sourceId: 'fishing'
        }, swid),
        wsEvents: [
            signedResponse({
                type: 1,
                details: winningRewardName
            }, swid)
        ]
    });
});

export default router;
