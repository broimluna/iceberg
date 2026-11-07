/**
 * Game Routes
 * 
 * Handles room joining, session management, and room population queries.
 * 
 * Endpoints:
 * - GET  /game/v1/rooms                                              - List available rooms
 * - POST /game/v1/worlds/:world/language/:language/rooms/:room/players - Join a room
 * - POST /game/v1/igloos/language/:language/players                  - Join an igloo
 * - DELETE /game/v1/session/:sessionId                               - End session / leave room
 * - GET  /game/v1/roomPopulation/:world                              - Get room populations for a world
 * - GET  /game/v1/world/roomPopulation/:room                         - Get room population across worlds
 */

import express from "express";
const router = express.Router();
import * as db from "../database.ts";
import config from "../config.ts";
import { saveSessionForUser, generateSessionId } from "../utils/session.ts";
import { QuestStatus } from "../utils/response.ts";

// ========== CONSTANTS ==========

/**
 * Available game worlds
 */
const AVAILABLE_WORLDS = ['Alpine', 'Blizzard', 'Glacier', 'Iceberg', 'Summit'];

/**
 * Available game rooms/zones
 */
const AVAILABLE_ROOMS = [
    'Boardwalk', 'Beach', 'CoveLookout', 'MtBlizzard', 'MeringueZip', 
    'Lagoon', 'Reef', 'ShipLagoon', 'Lighthouse', 'TownCenter', 
    'ClothingDesign', 'Dojo', 'Volcano', 'VolcanoLobby', 'IglooLookout',
    'PizzaParlor', 'CoffeeShop', 'DanceClub', 'GiftShop', 'Stadium',
    'SkiHill', 'SkiVillage', 'HerbertLair', 'MineShack', 'PenguinBand'
];

/**
 * Language code mapping
 * Client sends language as integer enum
 */
const LANGUAGE_MAP = {
    'en': 1,
    'en_US': 1,
    'pt': 2,
    'pt_BR': 2,
    'fr': 3,
    'fr_FR': 3,
    'es': 4,
    'es_LA': 4
};

/**
 * Population scale thresholds
 */
const POPULATION_THRESHOLDS = {
    ZERO: 0,
    ONE: 1,
    TWO: 5,
    THREE: 10,
    FOUR: 20,
    FIVE: 30
};

// ========== HELPER FUNCTIONS ==========

/**
 * Build content identifier string
 */
export function buildContentIdentifier() {
    const { clientVersion, contentVersion, subContentVersion, abTestGroup } = config.content;
    return `${clientVersion};${contentVersion};${subContentVersion};${abTestGroup}`;
}

/**
 * Build room identifier string
 * Format: world:language:roomName:instanceId:contentIdentifier
 */
function buildRoomIdentifier(world, language, roomName, instanceId = '') {
    return `${world}:${language}:${roomName}:${instanceId}:${buildContentIdentifier()}`;
}

/**
 * Get language integer from string
 */
function getLanguageInt(languageStr) {
    return LANGUAGE_MAP[languageStr] || 1;
}

/**
 * Calculate population scale from player count
 */
function getPopulationScale(count) {
    if (count >= POPULATION_THRESHOLDS.FIVE) return 'FIVE';
    if (count >= POPULATION_THRESHOLDS.FOUR) return 'FOUR';
    if (count >= POPULATION_THRESHOLDS.THREE) return 'THREE';
    if (count >= POPULATION_THRESHOLDS.TWO) return 'TWO';
    if (count >= POPULATION_THRESHOLDS.ONE) return 'ONE';
    return 'ZERO';
}

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
 * @param {Array} existingQuests - Quests from database
 * @param {object} mascotXP - Player's mascot XP object
 * @returns {Array} Complete quest state collection
 */
function buildCompleteQuestCollection(username, existingQuests, mascotXP) {
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
        }
    }
    
    return allQuests;
}

/**
 * Build JoinRoomData structure for room join response
 */
function buildJoinRoomData(swid, username, displayName, sessionId, roomIdentifier, playerProgress, extraOptions = {}) {
    const profile = playerProgress.profile || { colour: 3235500, daysOld: 1 };

    // Resolve outfit parts (IDs to Objects)
    const equippedIds = playerProgress.outfit?.parts || [];
    const allEquipment = playerProgress.equipment || [];
    const outfitEquipment = allEquipment.filter(eq => equippedIds.includes(eq.equipmentId));
    
    // Build complete quest collection including available quests
    const mascotXP = playerProgress.mascotXP || {};
    const quests = buildCompleteQuestCollection(username, playerProgress.quests || [], mascotXP);

    return {
        swid: swid,
        host: config.gameServer.ip,
        tcpPort: config.gameServer.tcpPort,
        httpsPort: config.gameServer.httpsPort,
        room: roomIdentifier,
        sessionId: sessionId,
        playerRoomData: {
            assets: playerProgress.assets,
            consumableInventory: playerProgress.consumableInventory || { inventoryMap: {} },
            dailyTaskProgress: playerProgress.dailyTaskProgress || [],
            member: true,
            outfit: { 
                parts: outfitEquipment,
                sessionId: sessionId
            },
            profile: profile,
            quests: quests
        },
        earnedRewards: extraOptions.earnedRewards || {},
        userName: displayName,
        membershipRights: { 
            swid: swid,
            member: true,
            recurring: false,
            recurDate: 0,
            expireDate: Date.now() + 1000000000
        },
        selectedTubeId: extraOptions.selectedTubeId || 0,
        roomOwnerName: extraOptions.roomOwnerName || '',
        roomOwner: extraOptions.roomOwner || false,
        extraLayoutData: extraOptions.extraLayoutData || null
    };
}

/**
 * Wrap response in SignedResponse format
 */
function signedResponse(data, swid) {
    return {
        goodUntil: Date.now() + 3600000, // 1 hour
        swid: swid,
        data: data,
        signature: 'server_signature'
    };
}

// ========== ROUTES ==========

/**
 * GET /game/v1/rooms
 * List available rooms
 * 
 * Query params:
 * - language: Language code (e.g., 'en')
 * - worlds: Comma-separated list of worlds to check
 * - rooms: Comma-separated list of rooms to check
 * - limit: Max results (optional)
 * 
 * Response: RoomIdentifier[]
 */
router.get('/game/v1/rooms', (req, res) => {
    const { language, worlds, rooms, limit } = req.query;
    
    console.log(`[GET ROOMS] language=${language}, worlds=${worlds}, rooms=${rooms}, limit=${limit}`);
    
    // Parse world and room filters
    const worldFilter = worlds ? worlds.split(',').map(w => w.trim()) : AVAILABLE_WORLDS;
    const roomFilter = rooms ? rooms.split(',').map(r => r.trim()) : AVAILABLE_ROOMS;
    const resultLimit = limit ? parseInt(limit) : 0;
    
    // Get active session counts by room
    const activeRooms = db.getActiveSessionsByRoom();
    
    // Build RoomIdentifier list
    const roomIdentifiers = [];
    const languageInt = getLanguageInt(language || 'en');
    
    for (const world of worldFilter) {
        for (const room of roomFilter) {
            // Skip if we've hit the limit
            if (resultLimit > 0 && roomIdentifiers.length >= resultLimit) {
                break;
            }
            
            roomIdentifiers.push({
                world: world,
                language: languageInt,
                zoneId: {
                    name: room,
                    instanceId: ''
                },
                contentIdentifier: buildContentIdentifier()
            });
        }
        
        if (resultLimit > 0 && roomIdentifiers.length >= resultLimit) {
            break;
        }
    }
    
    res.json(roomIdentifiers);
});

/**
 * POST /game/v1/worlds/:world/language/:language/rooms/:room/players
 * Join a room - returns game server connection info
 * 
 * Response: SignedResponse<JoinRoomData>
 */
router.post('/game/v1/worlds/:world/language/:language/rooms/:room/players', (req, res) => {
    const { world, language, room } = req.params;
    const { bypassCaptcha } = req.query;
    const { swid, username } = req.player;
    
    // Check if player is authenticated and exists
    if (!username) {
        console.error(`[JOIN ROOM] Player not found for SWID: ${swid}`);
        return res.status(401).json({ error: 'Player not found. Please register or login.' });
    }
    
    const sessionId = generateSessionId();
    
    // Get display name from identity
    const playerIdentity = db.getPlayerBySwid(swid);
    const displayName = playerIdentity?.displayName || username;
    
    console.log(`[JOIN ROOM] ${displayName} (swid=${swid}) joining ${room} in ${world}`);
    
    // Save session for SFS2X file-based integration
    saveSessionForUser(username, sessionId, room);
    
    // Register session in database for player lookups
    console.log(`[JOIN ROOM] Registering session for SWID=${swid}, sessionId=${sessionId}, room=${room}`);
    db.registerPlayerSession(swid, sessionId, room, world);
    
    // Load player data from database
    const playerProgress = db.getFullPlayerData(username);
    
    // Check if player data was loaded successfully
    if (!playerProgress) {
        console.error(`[JOIN ROOM] Failed to load player data for ${username}`);
        return res.status(500).json({ error: 'Failed to load player data.' });
    }

    // Build room identifier
    const roomIdentifier = buildRoomIdentifier(world, language, room);

    // Build join room response
    const joinRoomData = buildJoinRoomData(
        swid, 
        username, 
        displayName, 
        sessionId, 
        roomIdentifier, 
        playerProgress
    );

    res.json(signedResponse(joinRoomData, swid));
});

/**
 * POST /game/v1/igloos/language/:language/players
 * Join an igloo
 * 
 * Request body: ZoneId (igloo identifier) - { name, instanceId }
 * Response: SignedResponse<JoinRoomData>
 */
router.post('/game/v1/igloos/language/:language/players', (req, res) => {
    const { language } = req.params;
    const { bypassCaptcha } = req.query;
    const iglooId = req.body; // ZoneId: { name, instanceId }
    const { swid, username } = req.player;
    
    const sessionId = generateSessionId();
    
    // Get display name from identity
    const playerIdentity = db.getPlayerBySwid(swid);
    const displayName = playerIdentity?.displayName || username;
    
    // Determine igloo zone name and owner
    const iglooZoneName = iglooId?.name || 'DefaultIgloo';
    const iglooOwnerId = iglooId?.instanceId || swid; // instanceId is the owner's SWID
    
    console.log(`[JOIN IGLOO] ${displayName} (swid=${swid}) joining igloo ${iglooZoneName} owned by ${iglooOwnerId}`);
    
    // Use "Igloo" as the world name for igloos
    let iglooWorld = 'Igloo';
    
    // Save session for SFS2X file-based integration
    saveSessionForUser(username, sessionId, iglooZoneName);
    
    // Register session in database
    db.registerPlayerSession(swid, sessionId, iglooZoneName, 'Igloo', iglooOwnerId);
    
    // Load player data
    const playerProgress = db.getFullPlayerData(username);

    // Build room identifier for igloo
    const roomIdentifier = buildRoomIdentifier('Igloo', language, iglooZoneName, iglooOwnerId);

    // Determine if this is the player's own igloo
    const isOwnIgloo = (iglooOwnerId === swid);
    
    // Get igloo owner's data for layout
    let roomOwnerName = displayName;
    let extraLayoutData = null;
    
    if (isOwnIgloo) {
        // Get player's own igloo layout
        const iglooData = db.getIglooData ? db.getIglooData(username) : null;
        if (iglooData && iglooData.activeLayout) {
            extraLayoutData = iglooData.activeLayout;
        }
    } else {
        // Get igloo owner's data
        const ownerIdentity = db.getPlayerBySwid(iglooOwnerId);
        if (ownerIdentity) {
            roomOwnerName = ownerIdentity.displayName || ownerIdentity.username;
            // Get owner's igloo layout
            const ownerIglooData = db.getIglooData ? db.getIglooData(ownerIdentity.username) : null;
            if (ownerIglooData && ownerIglooData.activeLayout) {
                extraLayoutData = ownerIglooData.activeLayout;
            }
        }
    }
    
    // Build default layout if none exists
    if (!extraLayoutData) {
        extraLayoutData = {
            zoneId: 'DefaultIgloo',
            name: '',
            lightingId: 0,
            musicId: 0,
            decorationsLayout: [],
            extraInfo: {},
            createdDate: null,
            lastModifiedDate: null,
            memberOnly: false
        };
    }

    // Build join room response with igloo-specific options
    const joinRoomData = buildJoinRoomData(
        swid, 
        username, 
        displayName, 
        sessionId, 
        roomIdentifier, 
        playerProgress,
        {
            roomOwnerName: roomOwnerName,
            roomOwner: isOwnIgloo,
            extraLayoutData: extraLayoutData
        }
    );

    res.json(signedResponse(joinRoomData, swid));
});

/**
 * DELETE /game/v1/session/:sessionId
 * End session / leave room
 * 
 * Response: Empty (204 No Content)
 */
router.delete('/game/v1/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { swid } = req.player;
    
    console.log(`[END SESSION] swid=${swid} ending session ${sessionId}`);
    
    // Get session info before deletion
    const session = db.getSession(parseInt(sessionId));
    
    if (session) {
        // Verify session belongs to this player
        if (session.swid !== swid) {
            console.log(`[END SESSION] Unauthorized: session ${sessionId} belongs to ${session.swid}, not ${swid}`);
            return res.status(403).json({ error: 'Unauthorized to delete this session' });
        }
        
        // Delete the session
        db.deleteSession(parseInt(sessionId));
        console.log(`[END SESSION] Session ${sessionId} deleted for ${session.username}`);
    } else {
        console.log(`[END SESSION] Session ${sessionId} not found (may already be expired)`);
    }
    
    // Return 204 No Content on success
    res.status(204).send();
});

/**
 * GET /game/v1/roomPopulation/:world
 * Get room populations for a world
 * 
 * Query params:
 * - language: Language code
 * 
 * Response: GetRoomPopulationResponse { roomPopulations: RoomPopulation[] }
 */
router.get('/game/v1/roomPopulation/:world', (req, res) => {
    const { world } = req.params;
    const { language } = req.query;
    
    console.log(`[ROOM POPULATION] Querying populations for world=${world}, language=${language}`);
    
    // Get active session counts
    const activeRooms = db.getActiveSessionsByRoom();
    
    // Build room population list
    const roomPopulations = AVAILABLE_ROOMS.map(roomName => {
        const count = activeRooms[roomName] || 0;
        const languageInt = getLanguageInt(language || 'en');
        
        return {
            identifier: {
                world: world,
                language: languageInt,
                zoneId: {
                    name: roomName,
                    instanceId: ''
                },
                contentIdentifier: buildContentIdentifier()
            },
            populationScaled: getPopulationScale(count)
        };
    });
    
    res.json({
        roomPopulations: roomPopulations
    });
});

/**
 * GET /game/v1/world/roomPopulation/:room
 * Get room population across all worlds
 * 
 * Query params:
 * - language: Language code
 * 
 * Response: GetRoomPopulationForWorldsResponse { worldRoomPopulations: WorldRoomPopulation[] }
 */
router.get('/game/v1/world/roomPopulation/:room', (req, res) => {
    const { room } = req.params;
    const { language } = req.query;
    
    console.log(`[WORLD POPULATION] Querying population across worlds for room=${room}, language=${language}`);
    
    // Get population for this room
    const activeRooms = db.getActiveSessionsByRoom();
    const totalCount = activeRooms[room] || 0;
    
    // Distribute across worlds (simplified approach - equal distribution)
    const countPerWorld = Math.floor(totalCount / AVAILABLE_WORLDS.length);
    const remainder = totalCount % AVAILABLE_WORLDS.length;
    
    const worldRoomPopulations = AVAILABLE_WORLDS.map((worldName, index) => {
        // Add remainder to first worlds
        const worldCount = countPerWorld + (index < remainder ? 1 : 0);
        
        return {
            worldName: worldName,
            populationScaled: getPopulationScale(worldCount)
        };
    });
    
    res.json({
        worldRoomPopulations: worldRoomPopulations
    });
});

export default router;
