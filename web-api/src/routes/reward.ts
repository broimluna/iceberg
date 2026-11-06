/**
 * Reward Routes
 * 
 * Handles all reward operations including claiming, daily spin, and server-added rewards.
 * 
 * Endpoints:
 * - PUT  /reward/v1                       - Add rewards from game server (AddRewardOperation)
 * - POST /reward/v1/room                  - Add in-room rewards (AddRoomRewardsOperation)
 * - PUT  /reward/v1/claim/:type           - Claim a reward by type/ID (ClaimRewardOperation)
 * - GET  /reward/v1/preregistration       - Claim preregistration rewards (ClaimPreregistrationRewardOperation)
 * - POST /reward/v1/claimServerAdded      - Claim server-added rewards (ClaimServerAddedRewardsOperation)
 * - POST /reward/v1/claimDailySpin        - Claim daily spin reward (ClaimDailySpinRewardOperation)
 * - POST /reward/v1/claimQuickNotification - Claim quick notification reward (ClaimQuickNotificationRewardOperation)
 * - POST /reward/v1/exchangeall           - Exchange items for coins (ExchangeAllForCoinsOperation)
 * - GET  /reward/v1/calculateexchangeall  - Calculate exchange value (CalculateExchangeForCoinsOperation)
 */

import express from "express";
const router = express.Router();
import * as db from "../database.ts";
import config from "../config.ts";
import { addXpToInternal, getMascotFromQuestId } from "../utils/xp.ts";
import { generateEquipmentId } from "../utils/session.ts";

// ========== HELPER FUNCTIONS ==========

/**
 * Apply rewards to player and update assets
 */
function applyRewards(username, reward) {
    if (reward.coins) db.addPlayerCoins(username, reward.coins);
    
    if (reward.mascotXP) {
        for (const [mascot, rawXp] of Object.entries(reward.mascotXP)) {
            const currentXp = db.getMascotXP(username)[mascot] || 0;
            const newXp = addXpToInternal(mascot, rawXp, currentXp);
            db.setMascotXP(username, mascot, newXp);
        }
    }
    
    if (reward.equipmentTemplates) reward.equipmentTemplates.forEach(t => db.addEquipmentTemplate(username, t));

    if (reward.equipmentInstances) {
        for (const item of reward.equipmentInstances) {
            if (item.definitionId) {
                db.addEquipmentTemplate(username, item.definitionId);
                db.saveEquipment(username, {
                    equipmentId: null,
                    dateTimeCreated: Date.now(),
                    definitionId: item.definitionId,
                    parts: item.parts || []
                });
            }
        }
    }

    if (reward.decals) reward.decals.forEach(d => db.addDecal(username, d));
    if (reward.fabrics) reward.fabrics.forEach(f => db.addFabric(username, f));
    if (reward.durables) reward.durables.forEach(d => db.addDurable(username, d));
    if (reward.tubes) reward.tubes.forEach(t => db.addTube(username, t));
    if (reward.emotePacks) reward.emotePacks.forEach(e => db.addEmotePack(username, e));
    if (reward.colourPacks) reward.colourPacks.forEach(c => db.addColourPack(username, c));
    if (reward.sizzleClips) reward.sizzleClips.forEach(s => db.addSizzleClip(username, s));
    
    if (reward.collectibleCurrencies) {
        for (const [currency, amount] of Object.entries(reward.collectibleCurrencies)) {
            db.addCollectibleCurrency(username, currency, amount);
        }
    }
}

// ========== REWARD ENDPOINTS ==========

/**
 * PUT /reward/v1
 * Add rewards from game server events
 * 
 * Request: SignedResponse<RewardedUserCollectionJsonHelper> { rewards: { sessionId: RewardJsonReader } }
 * Response: RewardGrantedResponse { assets }
 */
router.put('/reward/v1', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[REWARD] ${username} persisting rewards from game server`);
    
    const rewardsData = req.body.data || req.body.Data || (req.body.rewards ? req.body : null);
    
    if (rewardsData?.rewards) {
        for (const [sessionId, reward] of Object.entries(rewardsData.rewards)) {
            console.log(`[REWARD] Applying reward for session ${sessionId}`);
            applyRewards(username, reward);
        }
    }
    
    // Response: RewardGrantedResponse
    res.json({ 
        assets: db.getPlayerAssets(username) 
    });
});

/**
 * POST /reward/v1/room
 * Add in-room rewards (collectibles picked up in rooms)
 * 
 * Request: SignedResponse<InRoomRewards> { room, collected: { rewardKey: timestamp } }
 * Response: RewardGrantedResponse { assets }
 */
router.post('/reward/v1/room', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[REWARD] ${username} claiming in-room rewards`);
    
    const inRoomRewards = req.body.data || req.body.Data || req.body;
    const room = inRoomRewards.room || 'Unknown';
    const collected = inRoomRewards.collected || {};
    
    console.log(`[REWARD] Room: ${room}, collected items: ${Object.keys(collected).length}`);
    
    // Look up pickupables for this room
    const roomPickupables = config.pickupables[room] || {};
    
    let totalCoins = 0;
    let collectibleCurrenciesGranted = {};
    
    // Process each collected item
    for (const rewardPath of Object.keys(collected)) {
        const pickupable = roomPickupables[rewardPath];
        
        if (pickupable && pickupable.reward) {
            const reward = pickupable.reward;
            
            // Add coins
            if (reward.coins > 0) {
                totalCoins += reward.coins;
            }
            
            // Add collectible currencies
            if (reward.collectibleCurrency) {
                for (const [currencyType, amount] of Object.entries(reward.collectibleCurrency)) {
                    if (amount > 0) {
                        db.addCollectibleCurrency(username, currencyType, amount);
                        collectibleCurrenciesGranted[currencyType] = (collectibleCurrenciesGranted[currencyType] || 0) + amount;
                    }
                }
            }
        } else {
            // Fallback for unknown collectibles - grant 1 coin
            totalCoins += 1;
            console.log(`[REWARD] Unknown pickupable in ${room}: ${rewardPath}`);
        }
    }
    
    if (totalCoins > 0) {
        db.addPlayerCoins(username, totalCoins);
        console.log(`[REWARD] Granted ${totalCoins} coins for room collectibles`);
    }
    
    if (Object.keys(collectibleCurrenciesGranted).length > 0) {
        console.log(`[REWARD] Granted collectible currencies:`, collectibleCurrenciesGranted);
    }
    
    // Response: RewardGrantedResponse
    res.json({ 
        assets: db.getPlayerAssets(username) 
    });
});

/**
 * PUT /reward/v1/claim/:type
 * Claim a reward by type/ID
 * 
 * Response: ClaimRewardResponse { reward } or 410 Gone if already claimed
 */
router.put('/reward/v1/claim/:type', claimRewardHandler);

/**
 * POST /reward/v1/claim/:rewardId
 * Claim a reward by ID (alternate method used by client)
 * 
 * Response: ClaimRewardResponse { reward } or 410 Gone if already claimed
 */
router.post('/reward/v1/claim/:type', claimRewardHandler);

/**
 * POST /reward/v1
 * Generic reward claim endpoint
 * 
 * Request: { rewards: { xp?, coins?, ... } }
 * Response: { wsEvents: [], reward }
 */
router.post('/reward/v1', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[REWARD] ${username} claiming generic reward:`, JSON.stringify(req.body));
    
    const rewards = req.body.rewards || req.body || {};
    
    // Apply XP rewards
    if (rewards.xp) {
        for (const [mascot, xp] of Object.entries(rewards.xp)) {
            const currentXp = db.getMascotXP(username)[mascot] || 0;
            const newXp = addXpToInternal(mascot, xp, currentXp);
            db.setMascotXP(username, mascot, newXp);
            console.log(`[REWARD] Granted ${xp} XP to ${mascot}`);
        }
    }
    
    // Apply mascotXP rewards (alternate format)
    if (rewards.mascotXP) {
        for (const [mascot, xp] of Object.entries(rewards.mascotXP)) {
            const currentXp = db.getMascotXP(username)[mascot] || 0;
            const newXp = addXpToInternal(mascot, xp, currentXp);
            db.setMascotXP(username, mascot, newXp);
            console.log(`[REWARD] Granted ${xp} XP to ${mascot}`);
        }
    }
    
    // Apply coin rewards
    if (rewards.coins) {
        db.addPlayerCoins(username, rewards.coins);
        console.log(`[REWARD] Granted ${rewards.coins} coins`);
    }
    
    res.json({
        wsEvents: [],
        reward: rewards
    });
});

/**
 * Shared handler for claiming rewards by ID
 */
function claimRewardHandler(req, res) {
    const rewardId = parseInt(req.params.type);
    const { swid, username } = req.player;
    
    console.log(`[REWARD] ${username} claiming reward ID ${rewardId}`);
    
    // Check if already claimed
    const claimedRewards = db.getClaimedRewards(username);
    if (claimedRewards.includes(rewardId)) {
        console.log(`[REWARD] Reward ${rewardId} already claimed`);
        return res.status(410).json({ error: 'Reward already claimed' });
    }
    
    // Get reward definition
    const rewardDef = config.rewardDefinitions[rewardId];
    
    if (!rewardDef) {
        // Fallback: treat as equipment template
        db.addEquipmentTemplate(username, rewardId);
        
        const newEquipment = {
            equipmentId: generateEquipmentId(),
            dateTimeCreated: Date.now(),
            definitionId: rewardId,
            parts: []
        };
        db.saveEquipment(username, newEquipment);
        db.addClaimedReward(username, rewardId);
        
        console.log(`[REWARD] ${username} claimed reward ${rewardId} (fallback as equipment template)`);
        
        return res.json({
            reward: { equipmentTemplates: [rewardId] }
        });
    }
    
    // Build reward response object
    const reward = {};
    
    // Apply equipment templates
    if (rewardDef.equipmentTemplates && rewardDef.equipmentTemplates.length > 0) {
        reward.equipmentTemplates = rewardDef.equipmentTemplates;
        rewardDef.equipmentTemplates.forEach(templateId => {
            db.addEquipmentTemplate(username, templateId);
            
            const existing = db.getEquipment(username).find(e => e.definitionId === templateId);
            if (!existing) {
                db.saveEquipment(username, {
                    equipmentId: generateEquipmentId(),
                    dateTimeCreated: Date.now(),
                    definitionId: templateId,
                    parts: []
                });
            }
        });
    }
    
    // Apply emote packs
    if (rewardDef.emotePacks && rewardDef.emotePacks.length > 0) {
        reward.emotePacks = rewardDef.emotePacks;
        rewardDef.emotePacks.forEach(e => db.addEmotePack(username, e));
    }
    
    // Apply tubes
    if (rewardDef.tubes && rewardDef.tubes.length > 0) {
        reward.tubes = rewardDef.tubes;
        rewardDef.tubes.forEach(t => db.addTube(username, t));
        console.log(`[REWARD] ${username} granted tubes: ${rewardDef.tubes.join(', ')}`);
    }
    
    // Apply decals
    if (rewardDef.decals && rewardDef.decals.length > 0) {
        reward.decals = rewardDef.decals;
        rewardDef.decals.forEach(d => db.addDecal(username, d));
    }
    
    // Apply fabrics
    if (rewardDef.fabrics && rewardDef.fabrics.length > 0) {
        reward.fabrics = rewardDef.fabrics;
        rewardDef.fabrics.forEach(f => db.addFabric(username, f));
    }
    
    // Apply durables
    if (rewardDef.durables && rewardDef.durables.length > 0) {
        reward.durables = rewardDef.durables;
        rewardDef.durables.forEach(d => db.addDurable(username, d));
    }
    
    // Apply coins
    if (rewardDef.coins) {
        reward.coins = rewardDef.coins;
        db.addPlayerCoins(username, rewardDef.coins);
    }
    
    db.addClaimedReward(username, rewardId);
    
    console.log(`[REWARD] ${username} claimed reward ${rewardId}`);
    
    // Response: ClaimRewardResponse
    res.json({ reward });
}

/**
 * GET /reward/v1/preregistration
 * Claim preregistration rewards
 * 
 * Response: ClaimPreregistrationRewardResponse { reward, wsEvents[] }
 */
router.get('/reward/v1/preregistration', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[REWARD] ${username} requesting preregistration reward`);
    
    // Response: ClaimPreregistrationRewardResponse
    res.json({ 
        reward: {}, 
        wsEvents: [] 
    });
});

/**
 * POST /reward/v1/claimServerAdded
 * Claim server-added rewards (referral rewards)
 * Only gives rewards if the player has a pending referral reward
 * 
 * Response: ClaimServerAddedRewardsResponse { claimedRewards[] }
 */
router.post('/reward/v1/claimServerAdded', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[REWARD] ${username} claiming server added rewards`);
    
    // Check if user has a pending referral reward
    const hasReferralReward = db.hasReferralReward(username);
    
    if (!hasReferralReward) {
        console.log(`[REWARD] ${username} has no pending referral rewards`);
        return res.json({ claimedRewards: [] });
    }
    
    // Clear the pending reward flag
    db.clearReferralReward(username);
    
    // Referral reward: consumables (matching the reference implementation)
    const referralReward = {
        consumables: {
            'GlowStickRainbowNonMember': 3,
            'HotChocolateGroupNonMember': 3,
            'PizzaGroupNonMember': 3,
            'SuperFireworkNonMember': 3
        }
    };
    
    // Apply consumable rewards
    for (const [consumableType, count] of Object.entries(referralReward.consumables)) {
        db.addConsumable(username, consumableType, count);
    }
    
    console.log(`[REWARD] ${username} granted referral reward: consumables`);
    
    // Response: ClaimServerAddedRewardsResponse
    res.json({
        claimedRewards: [{
            rewardId: { definitionId: 0, instanceId: username },
            reward: referralReward
        }]
    });
});

/**
 * POST /reward/v1/claimDailySpin
 * Claim daily spin reward using DailySpin.json configuration
 * 
 * Response: ClaimDailySpinRewardResponse { spinOutcomeId, reward, chestReward? }
 */
router.post('/reward/v1/claimDailySpin', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[REWARD] ${username} claiming daily spin`);
    
    const spinData = db.getDailySpinData(username);
    const dailySpinConfig = config.dailySpinConfig;
    const isMember = true; // All players are members in this private server
    
    if (!dailySpinConfig) {
        console.error(`[REWARD] DailySpin.json not loaded!`);
        return res.status(500).json({ error: 'Daily spin configuration not available' });
    }
    
    // Check if this is the first time spin
    const isFirstTimeSpin = spinData.timeOfLastSpinInMilliseconds === 0;
    
    let spinOutcomeId;
    let reward;
    
    if (isFirstTimeSpin && dailySpinConfig.FirstTimeSpinReward) {
        // First time spin - give the special first time reward
        spinOutcomeId = dailySpinConfig.FirstTimeSpinReward.SpinOutcomeId;
        reward = { ...dailySpinConfig.FirstTimeSpinReward.Reward };
        console.log(`[REWARD] ${username} first time spin, outcome: ${spinOutcomeId}`);
    } else {
        // Calculate weights for regular spin
        const chestWeight = dailySpinConfig.InitialChestWeight + 
            (spinData.numSpinsSinceReceivedChest || 0) * dailySpinConfig.ChestWeightIncreasePerSpin;
        const respinWeight = dailySpinConfig.InitialRespinWeight +
            (spinData.numSpinsSinceRespin || 0) * dailySpinConfig.RespinWeightIncreasePerSpin;
        
        const spinRewards = dailySpinConfig.SpinRewards || [];
        const totalRegularWeight = spinRewards.reduce((sum, sr) => sum + sr.Weight, 0);
        const totalWeight = totalRegularWeight + chestWeight + respinWeight;
        
        let roll = Math.random() * totalWeight;
        
        if (roll < chestWeight) {
            // Won a chest via spin (ChestSpinOutcomeId = 0)
            spinOutcomeId = dailySpinConfig.ChestSpinOutcomeId;
            reward = dailySpinConfig.DefaultReward ? { ...dailySpinConfig.DefaultReward } : { coins: 0, iglooSlots: 0 };
            spinData.numSpinsSinceReceivedChest = 0;
            spinData.numSpinsSinceRespin = (spinData.numSpinsSinceRespin || 0) + 1;
            console.log(`[REWARD] ${username} won chest via spin`);
        } else if (roll < chestWeight + respinWeight) {
            // Won a respin (free spin)
            spinOutcomeId = dailySpinConfig.RespinSpinOutcomeId;
            reward = dailySpinConfig.RespinReward ? { ...dailySpinConfig.RespinReward } : { coins: 50, iglooSlots: 0 };
            spinData.numSpinsSinceRespin = 0;
            spinData.numSpinsSinceReceivedChest = (spinData.numSpinsSinceReceivedChest || 0) + 1;
            console.log(`[REWARD] ${username} won respin`);
        } else {
            // Regular spin outcome
            roll -= (chestWeight + respinWeight);
            let selectedReward = null;
            
            for (const sr of spinRewards) {
                roll -= sr.Weight;
                if (roll <= 0) {
                    selectedReward = sr;
                    break;
                }
            }
            
            // Fallback to last reward if nothing selected
            if (!selectedReward && spinRewards.length > 0) {
                selectedReward = spinRewards[spinRewards.length - 1];
            }
            
            if (selectedReward) {
                spinOutcomeId = selectedReward.SpinOutcomeId;
                reward = { ...selectedReward.Reward };
            } else {
                // Ultimate fallback
                spinOutcomeId = 6;
                reward = { coins: 25, iglooSlots: 0 };
            }
            
            spinData.numSpinsSinceReceivedChest = (spinData.numSpinsSinceReceivedChest || 0) + 1;
            spinData.numSpinsSinceRespin = (spinData.numSpinsSinceRespin || 0) + 1;
        }
    }
    
    // Apply spin reward to player
    applyDailySpinReward(username, reward);
    
    // Update spin data
    spinData.timeOfLastSpinInMilliseconds = Date.now();
    spinData.numPunchesOnCurrentChest = (spinData.numPunchesOnCurrentChest || 0) + 1;
    
    // Check for chest completion reward
    const currentChestId = spinData.currentChestId || 0;
    const chestDefinitions = dailySpinConfig.ChestDefinitions || [];
    const chestDef = chestDefinitions.find(c => c.ChestId === currentChestId) || 
                     chestDefinitions[Math.min(currentChestId, chestDefinitions.length - 1)];
    
    let chestReward = null;
    
    if (chestDef && spinData.numPunchesOnCurrentChest >= chestDef.NumPunchesPerChest) {
        // Player completed a chest! Determine the reward
        const numChestsReceived = spinData.numChestsReceivedOfCurrentChestId || 0;
        const nonRepeatableRewards = (chestDef.NonRepeatableChestRewards || []).filter(r => !r.IsMemberOnly || isMember);
        const repeatableRewards = (chestDef.RepeatableChestRewards || []).filter(r => !r.IsMemberOnly || isMember);
        
        // Check if player should get first time reward for this chest level
        const isFirstChestOfLevel = numChestsReceived === 0;
        
        if (isFirstChestOfLevel && chestDef.FirstTimeClaimedReward) {
            // First time opening this chest level - give first time reward
            chestReward = { ...chestDef.FirstTimeClaimedReward };
            console.log(`[REWARD] ${username} first time chest ${currentChestId} reward`);
        } else if (nonRepeatableRewards.length > numChestsReceived && numChestsReceived < nonRepeatableRewards.length) {
            // Give non-repeatable reward based on how many chests of this level opened
            const rewardEntry = nonRepeatableRewards[numChestsReceived];
            if (rewardEntry) {
                chestReward = { ...rewardEntry.Reward };
                console.log(`[REWARD] ${username} non-repeatable chest ${currentChestId} reward #${numChestsReceived}`);
            }
        } else if (repeatableRewards.length > 0) {
            // Give random repeatable reward
            const randomIndex = Math.floor(Math.random() * repeatableRewards.length);
            chestReward = { ...repeatableRewards[randomIndex].Reward };
            console.log(`[REWARD] ${username} repeatable chest ${currentChestId} reward`);
        }
        
        // Fallback if no reward found
        if (!chestReward) {
            chestReward = { coins: 100, iglooSlots: 0 };
            console.log(`[REWARD] ${username} fallback chest reward`);
        }
        
        // Apply chest reward
        applyDailySpinReward(username, chestReward);
        
        // Update chest tracking
        spinData.numPunchesOnCurrentChest = 0;
        spinData.numChestsReceivedOfCurrentChestId = numChestsReceived + 1;
        
        // Level up chest after NumChestsToNextLevel of same type
        const chestsToNextLevel = chestDef.NumChestsToNextLevel || 3;
        if (chestsToNextLevel > 0 && spinData.numChestsReceivedOfCurrentChestId >= chestsToNextLevel) {
            // Move to next chest level (max is 5 = Eternal)
            if (currentChestId < 5) {
                spinData.currentChestId = currentChestId + 1;
                spinData.numChestsReceivedOfCurrentChestId = 0;
                console.log(`[REWARD] ${username} leveled up to chest ${spinData.currentChestId}`);
            }
        }
    }
    
    db.saveDailySpinData(username, spinData);
    
    console.log(`[REWARD] ${username} spin outcome: ${spinOutcomeId}, reward: ${JSON.stringify(reward)}`);
    
    // Response: ClaimDailySpinRewardResponse
    // Ensure reward has required fields for client
    const finalReward = normalizeRewardForClient(reward);
    const response = { spinOutcomeId, reward: finalReward };
    
    if (chestReward) {
        response.chestReward = normalizeRewardForClient(chestReward);
    }
    
    res.json(response);
});

/**
 * Apply daily spin reward to player (handles the specific reward format from DailySpin.json)
 */
function applyDailySpinReward(username, reward) {
    if (!reward) return;
    
    if (reward.coins) {
        db.addPlayerCoins(username, reward.coins);
    }
    
    if (reward.mascotXP) {
        for (const [mascot, rawXp] of Object.entries(reward.mascotXP)) {
            const currentXp = db.getMascotXP(username)[mascot] || 0;
            const newXp = addXpToInternal(mascot, rawXp, currentXp);
            db.setMascotXP(username, mascot, newXp);
            console.log(`[REWARD] Daily Spin XP: ${mascot} ${rawXp} raw XP -> ${newXp} internal (was ${currentXp})`);
        }
    }
    
    if (reward.consumables) {
        for (const [consumableType, quantity] of Object.entries(reward.consumables)) {
            db.addConsumable(username, consumableType, quantity);
        }
    }
    
    if (reward.equipmentInstances) {
        for (const equipment of reward.equipmentInstances) {
            const equipmentId = generateEquipmentId();
            db.saveEquipment(username, {
                equipmentId: equipmentId,
                definitionId: equipment.definitionId,
                dateTimeCreated: Date.now(),
                parts: equipment.parts || []
            });
            db.addEquipmentTemplate(username, equipment.definitionId);
        }
    }
    
    if (reward.decorationInstances) {
        for (const [definitionId, quantity] of Object.entries(reward.decorationInstances)) {
            const decorationId = {
                definitionId: parseInt(definitionId),
                type: 0,  // Default decoration type
                customId: null
            };
            db.addDecoration(username, decorationId, quantity);
        }
    }
    
    if (reward.fabrics) {
        for (const fabricId of reward.fabrics) {
            db.addFabric(username, fabricId);
        }
    }
}

/**
 * Normalize reward object to ensure all expected client fields exist
 * Only includes fields that have values - JSON.stringify will omit undefined fields anyway
 */
function normalizeRewardForClient(reward) {
    if (!reward) return { coins: 0, iglooSlots: 0 };
    
    const normalized = {
        coins: reward.coins || 0,
        iglooSlots: reward.iglooSlots || 0
    };
    
    // Only add optional fields if they have values
    if (reward.mascotXP && Object.keys(reward.mascotXP).length > 0) {
        normalized.mascotXP = reward.mascotXP;
    }
    if (reward.consumables && Object.keys(reward.consumables).length > 0) {
        normalized.consumables = reward.consumables;
    }
    if (reward.equipmentInstances && reward.equipmentInstances.length > 0) {
        normalized.equipmentInstances = reward.equipmentInstances;
    }
    if (reward.decorationInstances && Object.keys(reward.decorationInstances).length > 0) {
        normalized.decorationInstances = reward.decorationInstances;
    }
    if (reward.fabrics && reward.fabrics.length > 0) {
        normalized.fabrics = reward.fabrics;
    }
    
    return normalized;
}

/**
 * POST /reward/v1/claimQuickNotification
 * Claim quick notification reward
 * 
 * Response: ClaimRewardResponse { reward }
 */
router.post('/reward/v1/claimQuickNotification', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[REWARD] ${username} claiming quick notification reward`);
    
    // Default quick notification reward
    const reward = {
        coins: 25,
        mascotXP: { AuntArctic: 10 }
    };
    
    applyRewards(username, reward);
    
    console.log(`[REWARD] ${username} granted quick notification reward`);
    
    // Response: ClaimRewardResponse
    res.json({ reward });
});

/**
 * POST /reward/v1/exchangeall
 * Exchange all collectible currencies for coins
 * 
 * Response: RewardGrantedResponse { assets }
 */
router.post('/reward/v1/exchangeall', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[REWARD] ${username} exchanging all collectibles for coins`);
    
    const assets = db.getPlayerAssets(username);
    const collectibles = assets.collectibleCurrencies || {};
    const exchangeRates = config.collectibleExchangeRates || {};
    
    // Calculate total coins using exchange rates
    let totalCoins = 0;
    for (const [currency, amount] of Object.entries(collectibles)) {
        const exchangeRate = exchangeRates[currency] || 1.0;
        const coinsForThisCurrency = Math.ceil(exchangeRate * amount);
        totalCoins += coinsForThisCurrency;
        console.log(`[REWARD] ${currency}: ${amount} × ${exchangeRate} = ${coinsForThisCurrency} coins`);
        // Clear the collectible currency
        db.addCollectibleCurrency(username, currency, -amount);
    }
    
    if (totalCoins > 0) {
        db.addPlayerCoins(username, totalCoins);
        console.log(`[REWARD] ${username} exchanged collectibles for ${totalCoins} coins`);
    }
    
    // Response: RewardGrantedResponse
    res.json({ 
        assets: db.getPlayerAssets(username) 
    });
});

/**
 * GET /reward/v1/calculateexchangeall
 * Calculate exchange value for all collectibles
 * 
 * Response: RewardCalculatedResponse { coins }
 */
router.get('/reward/v1/calculateexchangeall', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[REWARD] ${username} calculating exchange value`);
    
    const assets = db.getPlayerAssets(username);
    const collectibles = assets.collectibleCurrencies || {};
    const exchangeRates = config.collectibleExchangeRates || {};
    
    // Calculate total coins using exchange rates
    let totalCoins = 0;
    for (const [currency, amount] of Object.entries(collectibles)) {
        const exchangeRate = exchangeRates[currency] || 1.0;
        const coinsForThisCurrency = Math.ceil(exchangeRate * amount);
        totalCoins += coinsForThisCurrency;
        console.log(`[REWARD] ${currency}: ${amount} × ${exchangeRate} = ${coinsForThisCurrency} coins`);
    }
    
    console.log(`[REWARD] Exchange value: ${totalCoins} coins`);
    
    // Response: RewardCalculatedResponse
    res.json({ 
        coins: totalCoins 
    });
});

// Exposed for server.ts's /api/internal/grant-reward - lets the SFS2X
// game server grant a reward directly (server-to-server) when its own
// game logic decides one is earned, instead of relying solely on the
// client to relay a reward.add push into PUT /reward/v1 above (which has
// no validation at all - a modified client can grant itself anything).
export default router;
export { applyRewards };
