/**
 * Igloo Routes
 * 
 * Handles igloo management, layouts, decorations, and igloo discovery.
 * 
 * Endpoints:
 * - PUT    /igloo/v1                                         - Update igloo data (UpdateIglooDataOperation)
 * - POST   /igloo/v1/layout                                  - Create igloo layout (CreateIglooLayoutOperation)
 * - GET    /igloo/v1/layout/:sceneLayoutId                   - Get specific layout (GetIglooLayoutOperation)
 * - PUT    /igloo/v1/layout/:sceneLayoutId                   - Update layout (UpdateIglooLayoutOperation)
 * - DELETE /igloo/v1/layout/:sceneLayoutId                   - Delete layout (DeleteIglooLayoutOperation)
 * - POST   /igloo/v1/iglooId/layout/active                   - Get active igloo layout (GetActiveIglooLayoutOperation)
 * - GET    /igloo/v1/decorations                             - Get decorations (GetDecorationsOperation)
 * - POST   /igloo/v1/decorations/:type/:definitionId         - Create decoration (CreateDecorationOperation)
 * - POST   /igloo/v1/decorations/:decorationId/increment/:count - Purchase decoration (PurchaseDecorationOperation)
 * - DELETE /igloo/v1/decorations/:decorationId               - Delete decoration (DeleteDecorationOperation)
 * - GET    /igloo/v1/igloos/friends                          - Get friends' igloos (GetFriendsIgloosOperation)
 * - GET    /igloo/v1/igloos/popular                          - Get popular igloos (GetPopularIgloosOperation)
 * - POST   /igloo/v1/igloos/populations/zoneIds              - Get igloo populations (GetIglooPopulationsByZoneIdsOperation)
 */

import express from "express";
import { positiveCount, NOT_ENOUGH_COINS } from "../utils/counts.ts";
import { decorationCost } from "../utils/prices.ts";
import { logSafe } from "../utils/logSafe.ts";
import lots from "../../data/lots.json";
const router = express.Router();
import * as db from "../database.ts";
import config from "../config.ts";

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

const lotMaxItems = lots as Record<string, number>;

/**
 * Why a layout can't be saved, or null. The client's own limits, checked
 * here too: the zone is a real lot, the layout holds at most that lot's
 * MaxItems, and nothing is placed more often than the player owns it.
 * Counted as DecorationInventoryService counts: per definitionId and type,
 * and the two ends of a partnered decoration (customProperties guid and
 * partner) use one.
 */
function layoutProblem(username, layout): string | null {
    if (typeof layout.zoneId !== 'string' || !Object.hasOwn(lotMaxItems, layout.zoneId)) return 'unknown lot';
    const items = layout.decorationsLayout;
    if (!Array.isArray(items)) return 'decorationsLayout is not a list';
    if (items.length > lotMaxItems[layout.zoneId]!) return 'too many items';
    if (!Number.isInteger(layout.lightingId) || !Number.isInteger(layout.musicId)) return 'bad lighting or music';
    if (typeof layout.name !== 'string' || !layout.extraInfo || typeof layout.extraInfo !== 'object' || Array.isArray(layout.extraInfo)) return 'bad name or extraInfo';

    const owned = new Map<string, number>();
    for (const item of db.getDecorationInventory(username).items) {
        const key = `${item.decorationId.type}:${item.decorationId.definitionId}`;
        owned.set(key, (owned.get(key) ?? 0) + item.count);
    }
    for (const item of items) {
        if (!item || (item.type !== 0 && item.type !== 1) || !Number.isSafeInteger(item.definitionId)) return 'bad item';
        const props = item.customProperties;
        if (props != null && (typeof props !== 'object' || Array.isArray(props))) return 'bad item';
    }
    // A pair is free only when it's mutual (each names the other's guid),
    // both ends are the same decoration, and neither end is in another pair.
    const byGuid = new Map<string, any>();
    const repeated = new Set<string>();
    for (const item of items) {
        const guid = item.customProperties?.guid;
        if (item.type !== 0 || typeof guid !== 'string') continue;
        if (byGuid.has(guid)) repeated.add(guid);
        byGuid.set(guid, item);
    }
    // Items sharing a guid are counted one by one.
    for (const guid of repeated) byGuid.delete(guid);
    const freeEnds = new Set<any>();
    for (const [guid, item] of byGuid) {
        const partner = byGuid.get(item.customProperties.partner);
        if (!partner || partner === item || partner.customProperties.partner !== guid || partner.definitionId !== item.definitionId) continue;
        if (!freeEnds.has(item)) freeEnds.add(partner);
    }

    const placed = new Map<string, number>();
    for (const item of items) {
        if (freeEnds.has(item)) continue;
        const key = `${item.type}:${item.definitionId}`;
        const n = (placed.get(key) ?? 0) + 1;
        if (n > (owned.get(key) ?? 0)) return `places ${key} more often than owned`;
        placed.set(key, n);
    }
    return null;
}

/**
 * Generate a unique layout ID (64-bit long)
 */
function generateLayoutId() {
    // Generate a random 64-bit integer (as JavaScript number)
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

/**
 * Parse decoration ID string format: "definitionId:type[:customId]"
 */
function parseDecorationId(decorationIdStr) {
    const parts = decorationIdStr.split(':');
    return {
        definitionId: parseInt(parts[0]),
        type: parseInt(parts[1]),
        customId: parts.length > 2 ? parseInt(parts[2]) : null
    };
}

/**
 * Format decoration ID to string
 */
function formatDecorationId(decorationId) {
    let str = `${decorationId.definitionId}:${decorationId.type}`;
    if (decorationId.customId !== null && decorationId.customId !== undefined) {
        str += `:${decorationId.customId}`;
    }
    return str;
}

// =============================================================================
// Igloo Data Endpoints
// =============================================================================

/**
 * PUT /igloo/v1
 * POST /igloo/v1
 * Update igloo data (visibility, active layout)
 * 
 * Request: MutableIglooData { visibility?, activeLayoutId? }
 * Response: SignedResponse<IglooData>
 */
function handleUpdateIglooData(req, res) {
    const { swid, username } = req.player;
    const update = req.body;
    
    console.log(`[IGLOO] ${username} updating igloo data: ${logSafe(JSON.stringify(update))}`);
    
    // Get current igloo data
    let iglooData = db.getIglooData ? db.getIglooData(username) : {
        visibility: 1, // Public by default
        activeLayoutId: null,
        activeLayout: null,
        maxIglooLayouts: 3
    };
    
    if (!update || typeof update !== 'object') return res.status(400).json({ error: 'Bad igloo data' });

    // Apply updates. IglooVisibility: 0 private, 1 friends only, 2 public.
    if (update.visibility !== undefined && update.visibility !== null) {
        if (![0, 1, 2].includes(update.visibility)) return res.status(400).json({ error: 'Bad visibility' });
        iglooData.visibility = update.visibility;
    }
    
    if (update.activeLayoutId !== undefined && update.activeLayoutId !== null) {
        // Only one of the player's own layouts.
        const layout = db.getIglooLayout(username, update.activeLayoutId);
        if (!layout) return res.status(404).json({ error: 'Layout not found' });
        iglooData.activeLayoutId = update.activeLayoutId;
        iglooData.activeLayout = layout;
    }
    
    // Save updated igloo data
    if (db.saveIglooData) {
        db.saveIglooData(username, iglooData);
    }
    
    // Response: SignedResponse<IglooData>
    res.json(signedResponse(iglooData, swid));
}

router.put('/igloo/v1', handleUpdateIglooData);
router.post('/igloo/v1', handleUpdateIglooData);

// =============================================================================
// Layout Endpoints
// =============================================================================

/**
 * POST /igloo/v1/layout
 * Create a new igloo layout
 * 
 * Request: MutableSceneLayout { name, zoneId, lightingId, musicId, extraInfo, decorationsLayout }
 * Response: SavedSceneLayout
 */
router.post('/igloo/v1/layout', (req, res) => {
    const { swid, username } = req.player;
    const layoutData = req.body;
    
    console.log(`[IGLOO] ${username} creating new layout: ${logSafe(layoutData?.name)}`);
    if (!layoutData || typeof layoutData !== 'object') return res.status(400).json({ error: 'Bad layout' });

    const max = db.getIglooData(username)?.maxIglooLayouts ?? 3;
    if (db.getIglooLayouts(username).length >= max) {
        console.log(`[IGLOO] ${username} already has ${max} layouts, refused`);
        return res.status(400).json({ error: 'No free igloo slot' });
    }

    const now = Date.now();
    const layoutId = generateLayoutId();
    
    // Create SavedSceneLayout
    const savedLayout = {
        layoutId: layoutId,
        name: layoutData.name || 'My Igloo',
        zoneId: layoutData.zoneId || 'DefaultIgloo',
        lightingId: layoutData.lightingId || 0,
        musicId: layoutData.musicId || 0,
        extraInfo: layoutData.extraInfo || {},
        decorationsLayout: layoutData.decorationsLayout || [],
        createdDate: now,
        lastModifiedDate: now,
        memberOnly: true
    };
    
    const problem = layoutProblem(username, savedLayout);
    if (problem) {
        console.log(`[IGLOO] ${username} layout refused: ${problem}`);
        return res.status(400).json({ error: 'Bad layout' });
    }

    // Save layout (a fresh id if it collides with someone else's)
    let saved = db.saveIglooLayout(username, savedLayout);
    for (let tries = 0; !saved && tries < 5; tries++) {
        savedLayout.layoutId = generateLayoutId();
        saved = db.saveIglooLayout(username, savedLayout);
    }
    if (!saved) return res.status(500).json({ error: 'Could not save layout' });
    
    // If this is the first layout, set it as active
    const layouts = db.getIglooLayouts ? db.getIglooLayouts(username) : [];
    if (layouts.length === 0) {
        const iglooData = db.getIglooData ? db.getIglooData(username) : {};
        iglooData.activeLayoutId = layoutId;
        iglooData.activeLayout = savedLayout;
        if (db.saveIglooData) {
            db.saveIglooData(username, iglooData);
        }
    }
    
    // Response: SavedSceneLayout (not wrapped)
    res.json(savedLayout);
});

/**
 * GET /igloo/v1/layout/:sceneLayoutId
 * Get a specific igloo layout
 * 
 * Response: SavedSceneLayout
 */
router.get('/igloo/v1/layout/:sceneLayoutId', (req, res) => {
    const { swid, username } = req.player;
    const layoutId = parseInt(req.params.sceneLayoutId);
    
    console.log(`[IGLOO] ${username} fetching layout: ${layoutId}`);
    
    const layout = db.getIglooLayout ? db.getIglooLayout(username, layoutId) : null;
    
    if (!layout) {
        // Return a default layout if not found
        res.json({
            layoutId: layoutId,
            name: 'My Igloo',
            zoneId: 'DefaultIgloo',
            lightingId: 0,
            musicId: 0,
            extraInfo: {},
            decorationsLayout: [],
            createdDate: Date.now(),
            lastModifiedDate: Date.now(),
            memberOnly: true
        });
        return;
    }
    
    res.json(layout);
});

/**
 * PUT /igloo/v1/layout/:sceneLayoutId
 * POST /igloo/v1/layout/:sceneLayoutId
 * Update an existing igloo layout
 * 
 * Request: MutableSceneLayout
 * Response: SavedSceneLayout
 */
function handleUpdateLayout(req, res) {
    const { swid, username } = req.player;
    const layoutId = parseInt(req.params.sceneLayoutId);
    const update = req.body;
    
    console.log(`[IGLOO] ${username} updating layout: ${layoutId}`);
    
    // Only the player's own existing layouts; new ones go through POST
    // /igloo/v1/layout and its slot limit.
    const layout = db.getIglooLayout(username, layoutId);
    if (!layout || !update || typeof update !== 'object') {
        return res.status(404).json({ error: 'Layout not found' });
    }
    
    // Apply updates
    layout.lastModifiedDate = Date.now();
    
    if (update.zoneId !== undefined && update.zoneId !== null) {
        layout.zoneId = update.zoneId;
    }
    if (update.name !== undefined && update.name !== null) {
        layout.name = update.name;
    }
    if (update.lightingId !== undefined) {
        layout.lightingId = update.lightingId;
    }
    if (update.musicId !== undefined) {
        layout.musicId = update.musicId;
    }
    if (update.decorationsLayout !== undefined && update.decorationsLayout !== null) {
        layout.decorationsLayout = update.decorationsLayout;
    }
    if (update.extraInfo !== undefined && update.extraInfo !== null) {
        layout.extraInfo = update.extraInfo;
    }
    
    const problem = layoutProblem(username, layout);
    if (problem) {
        console.log(`[IGLOO] ${username} layout ${layoutId} refused: ${problem}`);
        return res.status(400).json({ error: 'Bad layout' });
    }

    // Save updated layout; another player's layout id is refused.
    if (!db.saveIglooLayout(username, layout)) {
        return res.status(404).json({ error: 'Layout not found' });
    }
    
    // Response: SavedSceneLayout
    res.json(layout);
}

router.put('/igloo/v1/layout/:sceneLayoutId', handleUpdateLayout);
router.post('/igloo/v1/layout/:sceneLayoutId', handleUpdateLayout);

/**
 * DELETE /igloo/v1/layout/:sceneLayoutId
 * Delete an igloo layout
 * 
 * Response: 200 OK (empty)
 */
router.delete('/igloo/v1/layout/:sceneLayoutId', (req, res) => {
    const { swid, username } = req.player;
    const layoutId = parseInt(req.params.sceneLayoutId);
    
    console.log(`[IGLOO] ${username} deleting layout: ${layoutId}`);
    
    if (db.deleteIglooLayout) {
        db.deleteIglooLayout(username, layoutId);
    }
    
    res.status(200).send();
});

/**
 * POST /igloo/v1/iglooId/layout/active
 * Get the active igloo layout for a player (by igloo ID)
 * 
 * Request: iglooId as plain text
 * Response: SceneLayout
 */
router.post('/igloo/v1/iglooId/layout/active', (req, res) => {
    const { swid, username } = req.player;
    // The igloo ID is sent as plain text body
    const iglooId = req.body;
    
    console.log(`[IGLOO] ${username} fetching active layout for igloo: ${iglooId}`);
    
    // For now, get the player's own active layout
    // In a full implementation, this would look up by igloo owner's SWID
    const iglooData = db.getIglooData ? db.getIglooData(username) : null;
    
    if (iglooData && iglooData.activeLayout) {
        res.json(iglooData.activeLayout);
    } else {
        // Return a default layout
        res.json({
            name: 'My Igloo',
            zoneId: 'DefaultIgloo',
            lightingId: 0,
            musicId: 0,
            extraInfo: {},
            decorationsLayout: [],
            createdDate: Date.now(),
            lastModifiedDate: Date.now(),
            memberOnly: true
        });
    }
});

// =============================================================================
// Decoration Endpoints
// =============================================================================

/**
 * GET /igloo/v1/decorations
 * Get player's decoration inventory
 * 
 * Response: DecorationInventory { items: DecorationInventoryItem[] }
 */
router.get('/igloo/v1/decorations', (req, res) => {
    const { swid, username } = req.player;
    
    console.log(`[IGLOO] ${username} fetching decorations`);
    
    const inventory = db.getDecorationInventory ? db.getDecorationInventory(username) : { items: [] };
    
    // Response: DecorationInventory
    res.json(inventory);
});

/**
 * POST /igloo/v1/decorations/:type/:definitionId
 * Create (purchase) a new decoration
 * 
 * Query: count (number of items to purchase)
 * Response: CreateDecorationResponse { decorationId, assets }
 */
router.post('/igloo/v1/decorations/:type/:definitionId', (req, res) => {
    const { swid, username } = req.player;
    const type = parseInt(req.params.type);
    const definitionId = parseInt(req.params.definitionId);
    const count = req.query.count === undefined ? 1 : positiveCount(req.query.count, 99);
    if (count === null || !Number.isSafeInteger(type) || !Number.isSafeInteger(definitionId)) return res.status(400).json({ code: 'BAD_COUNT' });
    const price = decorationCost(type, definitionId);
    if (price === null) return res.status(400).json({ code: 'UNKNOWN_DECORATION' });
    if (db.getPlayerCoins(username) < price * count) return res.status(400).json({ code: NOT_ENOUGH_COINS });
    
    console.log(`[IGLOO] ${username} creating decoration: type=${type}, defId=${definitionId}, count=${count}`);
    
    const decorationId = {
        definitionId: definitionId,
        type: type,
        customId: null
    };
    
    // Add decoration to inventory
    if (db.addDecoration) {
        db.addDecoration(username, decorationId, count);
    }
    
    db.addPlayerCoins(username, -(price * count));
    
    // Get updated assets
    const assets = db.getPlayerAssets(username);
    
    // Response: CreateDecorationResponse
    res.json({
        decorationId: decorationId,
        assets: assets
    });
});

/**
 * POST /igloo/v1/decorations/:decorationId/increment/:count
 * Purchase additional count of an existing decoration
 * 
 * Response: UpdateDecorationResponse { decorationId, assets }
 */
router.post('/igloo/v1/decorations/:decorationId/increment/:count', (req, res) => {
    const { swid, username } = req.player;
    const decorationIdStr = req.params.decorationId;
    const count = positiveCount(req.params.count, 99);
    if (count === null) return res.status(400).json({ code: 'BAD_COUNT' });
    const decorationId = parseDecorationId(String(decorationIdStr));
    const price = decorationCost(decorationId.type, decorationId.definitionId);
    if (price === null) return res.status(400).json({ code: 'UNKNOWN_DECORATION' });
    if (db.getPlayerCoins(username) < price * count) return res.status(400).json({ code: NOT_ENOUGH_COINS });
    
    console.log(`[IGLOO] ${username} purchasing decoration: ${logSafe(decorationIdStr)}, count=${count}`);
    
    // Add decoration to inventory
    if (db.addDecoration) {
        db.addDecoration(username, decorationId, count);
    }
    
    db.addPlayerCoins(username, -(price * count));
    
    // Get updated assets
    const assets = db.getPlayerAssets(username);
    
    // Response: UpdateDecorationResponse
    res.json({
        decorationId: decorationId,
        assets: assets
    });
});

/**
 * DELETE /igloo/v1/decorations/:decorationId
 * Delete a decoration from inventory
 * 
 * Response: 200 OK (empty)
 */
router.delete('/igloo/v1/decorations/:decorationId', (req, res) => {
    const { swid, username } = req.player;
    const decorationIdStr = req.params.decorationId;
    
    console.log(`[IGLOO] ${username} deleting decoration: ${decorationIdStr}`);
    
    if (db.deleteDecoration) {
        db.deleteDecoration(username, decorationIdStr);
    }
    
    res.status(200).send();
});

// =============================================================================
// Igloo Discovery Endpoints
// =============================================================================

/**
 * GET /igloo/v1/igloos/friends
 * Get list of friends' igloos
 * 
 * Query: language
 * Response: List<IglooListItem>
 */
router.get('/igloo/v1/igloos/friends', (req, res) => {
    const { swid, username } = req.player;
    const language = req.query.language || 'en';
    
    console.log(`[IGLOO] ${username} fetching friends' igloos (lang=${language})`);
    
    // In a full implementation, this would query friends' igloo data
    // For now, return empty list
    const iglooList = db.getFriendsIgloos ? db.getFriendsIgloos(username, language) : [];
    
    // Response: List<IglooListItem>
    res.json(iglooList);
});

/**
 * GET /igloo/v1/igloos/popular
 * Get list of popular igloos
 * 
 * Query: language
 * Response: List<IglooListItem>
 */
router.get('/igloo/v1/igloos/popular', (req, res) => {
    const { swid, username } = req.player;
    const language = req.query.language || 'en';
    
    console.log(`[IGLOO] ${username} fetching popular igloos (lang=${language})`);
    
    // In a full implementation, this would return popular public igloos
    // For now, return empty list
    const iglooList = db.getPopularIgloos ? db.getPopularIgloos(language) : [];
    
    // Response: List<IglooListItem>
    res.json(iglooList);
});

/**
 * POST /igloo/v1/igloos/populations/zoneIds
 * Get igloo populations by zone IDs
 * 
 * Query: language
 * Request: List<ZoneId> - Array of { name, instanceId }
 * Response: List<RoomPopulation>
 */
router.post('/igloo/v1/igloos/populations/zoneIds', (req, res) => {
    const { swid, username } = req.player;
    const language = req.query.language || 'en';
    let zoneIds = req.body;
    
    // Handle various body formats
    if (!zoneIds) {
        zoneIds = [];
    } else if (!Array.isArray(zoneIds)) {
        // If it's an object with numeric keys (from some parsers), convert to array
        if (typeof zoneIds === 'object') {
            const keys = Object.keys(zoneIds);
            if (keys.length > 0 && keys.every(k => !isNaN(parseInt(k)))) {
                zoneIds = Object.values(zoneIds);
            } else {
                // Single zone object wrapped, or empty object
                zoneIds = keys.length > 0 && zoneIds.name ? [zoneIds] : [];
            }
        } else {
            zoneIds = [];
        }
    }
    
    console.log(`[IGLOO] ${username} fetching igloo populations for ${zoneIds.length} zones`);
    
    // Build room population response matching reference implementation format
    const populations = zoneIds.map(zone => {
        const zoneName = zone.name || zone;
        const instanceId = zone.instanceId || '';
        
        return {
            identifier: {
                world: 'Igloo',
                language: 1,
                zoneId: {
                    name: zoneName,
                    instanceId: instanceId
                },
                contentIdentifier: config.content ? 
                    `${config.content.clientVersion};${config.content.contentVersion};${config.content.subContentVersion};NONE` :
                    '1.13.0;1.13.0;2019-04-17;NONE',
                room: zoneName
            },
            populationScaled: 0
        };
    });
    
    // Response: List<RoomPopulation>
    res.json(populations);
});

export default router;
