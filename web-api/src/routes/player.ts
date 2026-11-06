/**
 * Player Routes
 * 
 * Handles player data, profile, outfit, durable equipment, and player lookups.
 * 
 * Endpoints:
 * - GET  /player/v1/                           - GetLocalPlayerDataOperation
 * - POST /player/v1/profile                    - SetProfileOperation
 * - POST /player/v1/outfit                     - SetOutfitOperation
 * - POST /player/v1/displayName                - Set display name
 * - GET  /player/v1/durable/equip/:type        - EquipDurableOperation
 * - GET  /player/v1/preregistration            - GetPreregistrationDataOperation
 * - POST /player/v1/preregistration            - PreregisterOperation
 * - PUT  /player/v1/referral                   - SetReferralOperation
 * - POST /player/v1/legacy/migrate             - MigrateLegacyAccountOperation
 * - GET  /player/v1/id/:swid                   - GetOtherPlayerDataBySwidOperation
 * - POST /player/v1/id                         - GetOtherPlayerDataBySwidsOperation
 * - GET  /player/v1/name/:displayName          - GetOtherPlayerDataByDisplayNameOperation
 * - POST /player/v1/names                      - GetOtherPlayerDataByDisplayNamesOperation
 * - GET  /player/v1/session/:sessionId         - GetOtherPlayerDataBySessionIdOperation
 * - POST /player/v1/id/online                  - GetOnlinePlayersBySwidsOperation
 */

import express from "express";
const router = express.Router();
import * as db from "../database.ts";
import config from "../config.ts";
import { signedResponse, QuestStatus } from "../utils/response.ts";
import * as smartfox from "../smartfoxNotifier.ts";

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get the mascot level based on internal XP
 * Level is calculated as floor(internalXP / 1,000,000)
 * This matches the reference implementation: ProgressionService.GetMascotLevelFromXP
 * @param {string} mascotName - Mascot name (e.g., 'AuntArctic')
 * @param {number} xp - Internal XP amount (1,000,000 per level)
 * @returns {number} Current level (0+)
 */
function getMascotLevel(mascotName, xp) {
    // Level = internal XP / 1,000,000 (floored)
    return Math.floor((xp || 0) / 1000000);
}

/**
 * Build the complete quest state collection including available quests
 * @param {string} username - Player username
 * @param {object} mascotXP - Player's mascot XP object
 * @returns {Array} Complete quest state collection
 */
function buildCompleteQuestCollection(username, mascotXP) {
    // Get existing quests from database
    const existingQuests = db.getQuests(username);
    const existingQuestIds = new Set(existingQuests.map(q => q.questId));
    
    // Build a map of completed quests
    const completedQuests = new Set();
    for (const quest of existingQuests) {
        if (quest.status === QuestStatus.COMPLETED || quest.timesCompleted > 0) {
            completedQuests.add(quest.questId);
        }
    }
    
    // Start with existing quests
    const allQuests = [...existingQuests];
    
    // Check each quest definition to see if it should be available
    for (const [questId, questDef] of Object.entries(config.questDefinitions || {})) {
        // Skip if already in database
        if (existingQuestIds.has(questId)) {
            continue;
        }
        
        // Check level requirement
        const mascotXpAmount = mascotXP[questDef.mascot] || 0;
        const playerLevel = getMascotLevel(questDef.mascot, mascotXpAmount);
        
        if (playerLevel < questDef.levelRequirement) {
            // Player doesn't meet level requirement - quest is locked
            continue;
        }
        
        // Check prerequisites
        let prerequisitesMet = true;
        for (const prereq of questDef.prerequisites || []) {
            if (!completedQuests.has(prereq)) {
                prerequisitesMet = false;
                break;
            }
        }
        
        if (prerequisitesMet) {
            // Quest is available - add it with AVAILABLE status
            allQuests.push({
                questId: questId,
                status: QuestStatus.AVAILABLE,
                completedObjectives: [],
                timesCompleted: 0,
                unlockTime: null,
                completedTime: null
            });
            console.log(`[PLAYER] Adding available quest: ${questId}`);
        }
    }
    
    return allQuests;
}

/**
 * Build a LocalPlayerData response (used by GetLocalPlayerDataOperation)
 * @param {string} username - Player username
 * @param {string} swid - Player SWID
 * @returns {object} LocalPlayerData response
 */
function buildLocalPlayerData(username, swid) {
    const playerProgress = db.getFullPlayerData(username);
    
    // Check if player data was loaded successfully
    if (!playerProgress) {
        console.error(`[PLAYER] Failed to load player data for ${username}`);
        return null;
    }
    
    // Get display name from identity with multiple fallbacks to ensure it's never empty
    const playerIdentity = db.getPlayerBySwid(swid);
    let displayName = playerIdentity?.displayName;
    
    // Ensure display name is never null, undefined, or empty string
    if (!displayName || displayName.trim() === '') {
        displayName = username || `CP_${(swid || 'Unknown').substring(0, 6)}`;
    }
    
    console.log(`[PLAYER] Building local data for ${username}, displayName: "${displayName}"`);
    
    // Build outfit array from equipped items
    const equippedIds = playerProgress.outfit?.parts || [];
    const allEquipment = playerProgress.equipment || [];
    const outfitEquipment = allEquipment.filter(eq => equippedIds.includes(eq.equipmentId));

    const profile = playerProgress.profile || { colour: 3235500, daysOld: 1 };
    
    // Convert tutorialData to signed bytes (sbyte in C#)
    const tutorialDataRaw = playerProgress.tutorialData || [];
    const tutorialDataSigned = tutorialDataRaw.map(val => val > 127 ? val - 256 : val);
    
    // Build breadcrumbs response with proper structure
    const breadcrumbIds = playerProgress.breadcrumbs || [];
    const breadcrumbsResponse = {
        breadcrumbs: breadcrumbIds.map(id => ({
            id: String(id), // Ensure ID is string
            breadcrumbType: 0 // Generic = 0 (int)
        }))
    };
    
    return {
        // PlayerId
        id: { 
            id: swid, 
            type: 1  // SWID = 1
        },
        name: displayName,
        
        member: true,
        
        // Outfit as CustomEquipment[]
        outfit: outfitEquipment.map(eq => ({
            equipmentId: eq.equipmentId,
            dateTimeCreated: eq.dateTimeCreated,
            definitionId: eq.definitionId,
            parts: eq.parts || []
        })),
        
        // Profile
        profile: {
            colour: profile.colour,
            daysOld: profile.daysOld
        },
        
        // Mascot XP
        mascotXP: playerProgress.mascotXP || {},
        
        // ZoneId
        zoneId: { 
            name: 'DefaultIgloo', 
            instanceId: swid 
        },
        
        // Online location (null if not in a room)
        onlineLocation: null,
        
        // Minigame progress
        minigameProgress: [],
        
        // QuestStateCollection - includes available quests that haven't been started yet
        quests: buildCompleteQuestCollection(username, playerProgress.mascotXP || {}),
        
        // Membership data
        membershipExpireDate: Date.now() + 1000000000,
        subscriptionVendor: 'NONE',
        subscriptionProductId: 'NONE',
        subscriptionPaymentPending: false,
        
        // Migration data (null for non-migrated accounts)
        migrationData: null,
        
        // Tutorial data (signed bytes)
        tutorialData: tutorialDataSigned,
        
        // Breadcrumbs
        breadcrumbs: breadcrumbsResponse,
        
        // Claimed reward IDs
        claimedRewardIds: playerProgress.claimedRewardIds || [],
        
        // Igloo layouts
        iglooLayouts: {
            activeLayoutId: playerProgress.iglooData?.activeLayoutId || null,
            activeLayoutServerChangeNotification: 0, // NoServerChange
            visibility: playerProgress.iglooData?.visibility ?? 0, // Default PRIVATE
            layouts: playerProgress.iglooLayouts || []
        },
        
        // Daily spin data
        dailySpinData: playerProgress.dailySpinData || {
            currentChestId: 0,
            numChestsReceivedOfCurrentChestId: 0,
            numPunchesOnCurrentChest: 0,
            timeOfLastSpinInMilliseconds: 0
        },
        
        // Trial/recurring flags
        trialAvailable: false,
        recurring: false
    };
}

/**
 * Build an OtherPlayerData response (used for player lookups)
 * @param {string} username - Player username
 * @param {string} swid - Player SWID
 * @param {string} displayName - Player display name (optional, will look up if not provided)
 * @returns {object} OtherPlayerData response
 */
function buildOtherPlayerData(username, swid, displayName = null) {
    const playerProgress = db.getFullPlayerData(username);
    
    // Get display name from identity if not provided, with fallbacks
    if (!displayName || displayName.trim() === '') {
        const playerIdentity = db.getPlayerBySwid(swid);
        displayName = playerIdentity?.displayName;
        
        // Ensure display name is never null, undefined, or empty string
        if (!displayName || displayName.trim() === '') {
            displayName = username || `CP_${(swid || 'Unknown').substring(0, 6)}`;
        }
    }
    
    // Check if player is online (has an active session)
    const activeSession = db.getActiveSessionBySwid(swid);
    console.log(`[PLAYER] Checking online status for ${swid}: activeSession =`, activeSession);
    let onlineLocation = null;
    if (activeSession && activeSession.room_name) {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        onlineLocation = {
            world: "CPI",
            language: 1,
            zoneId: {
                name: activeSession.room_name,
                instanceId: ""
            },
            contentIdentifier: `1.13.0;1.13.0.1424;${today};NONE`,
            room: activeSession.room_name
        };
        console.log(`[PLAYER] Player ${swid} is ONLINE in room ${activeSession.room_name}`);
    } else {
        console.log(`[PLAYER] Player ${swid} is OFFLINE (no active session or no room_name)`);
    }
    
    // Build outfit array from equipped items
    const equippedIds = playerProgress.outfit?.parts || [];
    const allEquipment = playerProgress.equipment || [];
    const outfitEquipment = allEquipment.filter(eq => equippedIds.includes(eq.equipmentId));

    const profile = playerProgress.profile || { colour: 3235500, daysOld: 1 };
    
    return {
        // PlayerId
        id: { 
            id: swid, 
            type: 1  // SWID = 1
        },
        name: displayName,
        
        // Online location (null if not in a room)
        onlineLocation: onlineLocation,
        
        // Member status
        member: true,
        
        // Outfit as CustomEquipment[]
        outfit: outfitEquipment.map(eq => ({
            equipmentId: eq.equipmentId,
            dateTimeCreated: eq.dateTimeCreated,
            definitionId: eq.definitionId,
            parts: eq.parts || []
        })),
        
        // Profile
        profile: {
            colour: profile.colour,
            daysOld: profile.daysOld
        },
        
        // Mascot XP
        mascotXP: playerProgress.mascotXP || {},
        
        // ZoneId
        zoneId: { 
            name: 'DefaultIgloo', 
            instanceId: swid 
        }
    };
}

/**
 * Build a minimal OtherPlayerData for unknown players
 * @param {string} swid - Player SWID
 * @param {string} displayName - Player display name
 * @returns {object} Minimal OtherPlayerData response
 */
function buildUnknownPlayerData(swid, displayName) {
    return {
        id: { id: swid, type: 1 },
        name: displayName || 'Unknown',
        onlineLocation: null,
        member: true,
        outfit: [],
        profile: { colour: 3235500, daysOld: 1 },
        mascotXP: {},
        zoneId: null
    };
}

// =============================================================================
// GET /player/v1/ - GetLocalPlayerDataOperation
// =============================================================================

/**
 * Get local player data
 * Returns full player data including quests, inventory, mascotXP, etc.
 */
router.get('/player/v1/', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[PLAYER] Requested local player data for ${username} (${swid})`);
    
    // Check if player is authenticated and exists
    if (!username) {
        console.error(`[PLAYER] Player not found for SWID: ${swid}`);
        return res.status(401).json({ error: 'Player not found. Please register or login.' });
    }
    
    const playerData = buildLocalPlayerData(username, swid);
    
    // Check if player data was built successfully
    if (!playerData) {
        console.error(`[PLAYER] Failed to build player data for ${username}`);
        return res.status(500).json({ error: 'Failed to load player data.' });
    }
    
    // Log key fields for debugging
    console.log(`[PLAYER] Response - name: "${playerData.name}", quests: ${playerData.quests?.length || 0}, outfit: ${playerData.outfit?.length || 0}`);
    console.log(`[PLAYER] Full JSON response:`, JSON.stringify(playerData));
    
    res.json(playerData);
});

// =============================================================================
// POST /player/v1/profile - SetProfileOperation
// =============================================================================

/**
 * Set player profile
 * Request body: Profile { colour: int, daysOld: int }
 * Response: SignedResponse<Profile>
 */
router.post('/player/v1/profile', (req, res) => {
    const { username } = req.player;
    console.log(`[PLAYER] Setting profile for ${username}:`, req.body);
    
    const currentProfile = db.getPlayerProfile(username);
    
    const colour = req.body.colour ?? currentProfile.colour ?? 3235500;
    const daysOld = currentProfile.daysOld ?? 1;
    
    db.updatePlayerProfile(username, colour, daysOld);
    
    res.json(signedResponse({ 
        colour: colour, 
        daysOld: daysOld 
    }));
});

// =============================================================================
// POST /player/v1/displayName - Set Display Name
// =============================================================================

/**
 * Set display name (during tutorial)
 * Request body: { displayName: string }
 * Response: SignedResponse<{ displayName, proposedStatus }>
 */
router.post('/player/v1/displayName', (req, res) => {
    const { swid, username } = req.player;
    let displayName = req.body.displayName;
    
    // Ensure display name is never empty - use username as fallback
    if (!displayName || displayName.trim() === '') {
        displayName = username || 'Player';
    } else {
        displayName = displayName.trim();
    }
    
    console.log(`[PLAYER] Setting display name for ${username} to: ${displayName}`);
    
    // Update the display name in the database
    db.setPlayerDisplayName(swid, displayName);
    
    res.json(signedResponse({
        displayName: displayName,
        proposedStatus: 'ACCEPTED'
    }));
});

// =============================================================================
// POST /player/v1/outfit - SetOutfitOperation
// =============================================================================

/**
 * Save equipped outfit
 * Request body: PlayerOutfit { parts: long[] }
 * Response: SignedResponse<PlayerOutfitDetails>
 */
router.post('/player/v1/outfit', (req, res) => {
    const { username } = req.player;
    const outfitParts = req.body?.parts || [];
    
    console.log(`[PLAYER] Saving outfit for ${username}`);
    
    // Save outfit to database
    db.setOutfit(username, outfitParts);
    
    // Build response with full equipment details
    const allEquipment = db.getEquipment(username);
    const outfitEquipment = allEquipment.filter(eq => outfitParts.includes(eq.equipmentId));

    // Check for "Stripes is Right" daily challenge (Fabric IDs: 41=Community Stripes, 49=Beach Stripes)
    // Also checking for any item using these fabrics
    const STRIPED_FABRICS = [41, 49, 116]; // 116 etc found in other files, checking common ones
    let hasStripes = false;
    
    for (const eq of outfitEquipment) {
        // eq.parts contains [templateId, fabricId, decalId...]
        // Check if any part matches known striped fabrics
        if (eq.parts && eq.parts.some(partId => STRIPED_FABRICS.includes(partId))) {
            hasStripes = true;
            break;
        }
    }
    
    if (hasStripes) {
        console.log(`[PLAYER] ${username} is wearing stripes! Notifying Daily Task.`);
        // Notify SmartFox - using likely Task IDs. 
        // Sending multiple IDs to be safe as we don't know exact client mapping
        smartfox.notifyDailyTaskUpdate(username, 'Clothing_Catalog_1_Stripe_is_Right', 1);
        smartfox.notifyDailyTaskUpdate(username, 'StripeIsRight', 1);
    }
    
    res.json(signedResponse({
        sessionId: null,
        parts: outfitEquipment.map(eq => ({
            equipmentId: eq.equipmentId,
            dateTimeCreated: eq.dateTimeCreated,
            definitionId: eq.definitionId,
            parts: eq.parts || []
        }))
    }));
});

// =============================================================================
// GET /player/v1/durable/equip/:type - EquipDurableOperation
// =============================================================================

/**
 * Equip a durable prop (jackhammer, etc.)
 * Response: SignedResponse<EquipDurableResponse>
 */
router.get('/player/v1/durable/equip/:type', (req, res) => {
    const { username } = req.player;
    const propId = parseInt(req.params.type);
    
    console.log(`[PLAYER] ${username} equipping durable: ${propId}`);
    
    res.json(signedResponse({ propId: propId }));
});

// =============================================================================
// GET /player/v1/preregistration - GetPreregistrationDataOperation
// =============================================================================

/**
 * Get preregistration data
 * Response: PreregistrationData
 */
router.get('/player/v1/preregistration', (req, res) => {
    const { swid } = req.player;
    console.log(`[PLAYER] Requested preregistration data for ${swid}`);
    
    res.json({
        clientId: 'cpi_client',
        date: Date.now(),
        swid: swid
    });
});

// =============================================================================
// POST /player/v1/preregistration - PreregisterOperation
// =============================================================================

/**
 * Submit preregistration
 * Query param: clientId
 * Response: MigrationData
 */
router.post('/player/v1/preregistration', (req, res) => {
    const { swid, username } = req.player;
    const clientId = req.query.clientId || 'unknown_client';
    
    console.log(`[PLAYER] Preregistration submitted for ${username} with clientId: ${clientId}`);
    
    res.json({
        status: 'PREREGISTERED',
        migratedDate: Date.now(),
        legacyAccountData: null
    });
});

// =============================================================================
// PUT /player/v1/referral - SetReferralOperation
// =============================================================================

/**
 * Set referral display name
 * Request body: string (referrer display name)
 * Response: empty 200 OK
 */
router.put('/player/v1/referral', (req, res) => {
    const { username } = req.player;
    const referrerDisplayName = req.body;
    
    console.log(`[PLAYER] ${username} setting referral: ${referrerDisplayName}`);
    
    // Validate referrer display name - must be non-empty string
    if (!referrerDisplayName || typeof referrerDisplayName !== 'string' || referrerDisplayName.trim() === '') {
        console.log(`[PLAYER] ${username} referral ignored - empty or invalid referrer name`);
        return res.status(200).send();
    }
    
    // Look up the referrer by display name
    const referrer = db.getPlayerByDisplayName(referrerDisplayName.trim());
    
    if (!referrer) {
        console.log(`[PLAYER] ${username} referral ignored - referrer "${referrerDisplayName}" not found`);
        return res.status(200).send();
    }
    
    // Don't allow self-referral
    if (referrer.username === username) {
        console.log(`[PLAYER] ${username} referral ignored - cannot refer yourself`);
        return res.status(200).send();
    }
    
    // Store the referral relationship and mark both players for rewards
    db.setPlayerReferral(username, referrer.username);
    console.log(`[PLAYER] ${username} was referred by ${referrer.displayName} (${referrer.username})`);
    
    res.status(200).send();
});

// =============================================================================
// POST /player/v1/legacy/migrate - MigrateLegacyAccountOperation
// =============================================================================

/**
 * Migrate legacy Club Penguin account
 * Request body: CPIDCredentials { username: string, password: string }
 * Response: MigrationData
 */
router.post('/player/v1/legacy/migrate', (req, res) => {
    const { username } = req.player;
    const cpidCreds = req.body;
    
    console.log(`[PLAYER] Legacy migration attempt for ${username} from CP account: ${cpidCreds?.username}`);
    
    // In a full implementation, we would validate against legacy CP data
    // For now, return a successful migration response
    res.json({
        status: 'MIGRATED',
        migratedDate: Date.now(),
        legacyAccountData: {
            username: cpidCreds?.username || 'LegacyPenguin',
            member: true,
            createdDate: Date.now() - (365 * 24 * 60 * 60 * 1000) // 1 year ago
        }
    });
});

// =============================================================================
// GET /player/v1/id/:swid - GetOtherPlayerDataBySwidOperation
// =============================================================================

/**
 * Get other player data by SWID
 * Response: OtherPlayerData
 */
router.get('/player/v1/id/:swid', (req, res) => {
    const targetSwid = req.params.swid;
    console.log(`[PLAYER] Get player by SWID: ${targetSwid}`);
    
    const playerInfo = db.getPlayerBySwid(targetSwid);
    
    if (playerInfo) {
        res.json(buildOtherPlayerData(playerInfo.username, targetSwid, playerInfo.displayName));
    } else {
        // Return minimal data for unknown SWIDs
        res.json(buildUnknownPlayerData(targetSwid, null));
    }
});

// =============================================================================
// POST /player/v1/id - GetOtherPlayerDataBySwidsOperation
// =============================================================================

/**
 * Get multiple players by SWIDs
 * Request body: string[] (array of SWIDs)
 * Response: OtherPlayerData[]
 */
router.post('/player/v1/id', (req, res) => {
    const swids = req.body || [];
    console.log(`[PLAYER] Get players by SWIDs: ${swids.length} requested`);
    
    const players = swids.map(swid => {
        const playerInfo = db.getPlayerBySwid(swid);
        if (playerInfo) {
            return buildOtherPlayerData(playerInfo.username, swid, playerInfo.displayName);
        } else {
            return buildUnknownPlayerData(swid, null);
        }
    });
    
    res.json(players);
});

// =============================================================================
// GET /player/v1/name/:displayName - GetOtherPlayerDataByDisplayNameOperation
// =============================================================================

/**
 * Get player by display name
 * Response: OtherPlayerData
 */
router.get('/player/v1/name/:displayName', (req, res) => {
    const displayName = req.params.displayName;
    console.log(`[PLAYER] Get player by display name: ${displayName}`);
    
    const playerInfo = db.getPlayerByDisplayName(displayName);
    
    if (playerInfo) {
        res.json(buildOtherPlayerData(playerInfo.username, playerInfo.swid, playerInfo.displayName));
    } else {
        // Player not found - return minimal data with generated SWID
        const generatedSwid = `swid_${displayName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
        res.json(buildUnknownPlayerData(generatedSwid, displayName));
    }
});

// =============================================================================
// POST /player/v1/names - GetOtherPlayerDataByDisplayNamesOperation
// =============================================================================

/**
 * Get multiple players by display names
 * Request body: string[] (array of display names)
 * Response: OtherPlayerData[]
 */
router.post('/player/v1/names', (req, res) => {
    const displayNames = req.body || [];
    console.log(`[PLAYER] Get players by display names: ${displayNames.length} requested`);
    
    const players = displayNames.map(name => {
        const playerInfo = db.getPlayerByDisplayName(name);
        if (playerInfo) {
            return buildOtherPlayerData(playerInfo.username, playerInfo.swid, playerInfo.displayName);
        } else {
            const generatedSwid = `swid_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
            return buildUnknownPlayerData(generatedSwid, name);
        }
    });
    
    res.json(players);
});

// =============================================================================
// GET /player/v1/session/:sessionId - GetOtherPlayerDataBySessionIdOperation
// =============================================================================

/**
 * Get player by session ID
 * Response: OtherPlayerData
 */
router.get('/player/v1/session/:sessionId', (req, res) => {
    const sessionId = parseInt(req.params.sessionId);
    console.log(`[PLAYER] Get player by session ID: ${sessionId}`);
    
    const playerInfo = db.getPlayerBySessionId(sessionId);
    
    if (playerInfo) {
        res.json(buildOtherPlayerData(playerInfo.username, playerInfo.swid, playerInfo.displayName));
    } else {
        // Session not found - return empty data
        res.json(buildUnknownPlayerData(`session_${sessionId}`, null));
    }
});

// =============================================================================
// POST /player/v1/id/online - GetOnlinePlayersBySwidsOperation
// =============================================================================

/**
 * Get online players by SWIDs
 * Request body: string[] (array of SWIDs)
 * Response: string[] (array of online SWIDs)
 */
router.post('/player/v1/id/online', (req, res) => {
    const swids = req.body || [];
    console.log(`[PLAYER] Get online players by SWIDs: ${swids.length} requested`);
    
    // Query the database for online players
    const onlineSwids = db.getOnlinePlayerSwids(swids);
    
    res.json(onlineSwids);
});

export default router;
