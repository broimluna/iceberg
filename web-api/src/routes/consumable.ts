/**
 * Consumable Routes
 * 
 * Handles consumable item inventory, purchasing, and usage.
 * 
 * Endpoints:
 * - GET    /consumable/v1                 - Get consumable inventory (GetConsumableInventoryOperation)
 * - PUT    /consumable/v1/:type/:count    - Purchase consumables (PurchaseConsumableOperation)
 * - DELETE /consumable/v1/:type           - Use a consumable (UseConsumableOperation)
 * - POST   /consumable/v1/partial         - Store partial consumable usage (StorePartialConsumableOperation)
 */

import express from "express";
const router = express.Router();
import * as db from "../database.ts";
import config from "../config.ts";
import { signConsumable, checkConsumable, claimConsumable, claimsFrom } from "../utils/consumableSignature.ts";

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

/**
 * GET /consumable/v1
 * Get consumable inventory
 * 
 * Response: SignedResponse<ConsumableInventory>
 */
router.get('/consumable/v1', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[CONSUMABLE] ${username} requested inventory`);
    
    const inventory = db.getConsumableInventory(username);
    
    // Response: SignedResponse<ConsumableInventory>
    res.json(signedResponse(inventory, swid));
});

/**
 * POST /consumable/v1/partial
 * Store partial consumable usage
 *
 * Request: SignedResponse<UsedConsumable> { type, partialCount }, the
 * SmartFox server's con.partial payload passed through by the client. Only
 * stored when SmartFox signed it for this player and it hasn't been stored
 * before; otherwise a client could store any count and spend it for free.
 * Response: SignedResponse<ConsumableInventory>
 */
router.post('/consumable/v1/partial', (req, res) => {
    const { swid, username } = req.player;

    const claims = claimsFrom(req.body);
    const refused = checkConsumable('partial', claims)
        ?? (claims.swid !== swid ? 'wrong swid' : null)
        ?? (claimConsumable(claims.signature as string, claims.goodUntil as number) ? null : 'replayed');
    if (refused) {
        console.log(`[CONSUMABLE] ${username} partial refused (${refused})`);
        return res.status(400).json({ code: 'BAD_SIGNATURE' });
    }
    const type = claims.type as string;
    const partialCount = claims.partialCount as number;

    console.log(`[CONSUMABLE] ${username} storing partial: ${type} (${partialCount})`);

    const inventory = db.getConsumableInventory(username);
    const currentCount = inventory.inventoryMap[type]?.itemCount || 0;
    db.updateConsumable(username, type, currentCount, partialCount);

    // Response: SignedResponse<ConsumableInventory>
    res.json(signedResponse(db.getConsumableInventory(username), swid));
});

/**
 * FishBucketGroup specific handler
 * The client requests this when equipping the fishing rod.
 */
router.post('/consumable/v1/FishBucketGroup', (req, res) => {
    req.params.type = 'FishBucketGroup';
    req.params.count = 1; // Default to 1
    purchaseConsumable(req, res);
});

/**
 * PUT /consumable/v1/:type/:count
 * POST /consumable/v1/:type/:count
 * Purchase consumables
 * 
 * Response: PurchaseConsumableResponse { assets, inventory: SignedResponse<ConsumableInventory> }
 */
function purchaseConsumable(req, res) {
    const type = req.params.type;
    const count = Number(req.params.count);
    const { swid, username } = req.player;

    if (!Number.isSafeInteger(count) || count < 1) {
        console.log(`[CONSUMABLE] ${username} purchase refused (count ${JSON.stringify(req.params.count)})`);
        return res.status(400).json({ code: 'BAD_COUNT' });
    }
    console.log(`[CONSUMABLE] ${username} purchasing ${count}x ${type}`);

    // Get price from config
    const price = config.consumablePrices[type] || 10;
    const totalCost = price * count;
    // 707 is the code the client shows as "not enough coins".
    if (db.getPlayerCoins(username) < totalCost) {
        console.log(`[CONSUMABLE] ${username} can't afford ${count}x ${type} (${totalCost})`);
        return res.status(400).json({ code: 707 });
    }
    
    // Deduct coins and add consumable
    db.addPlayerCoins(username, -totalCost);
    db.addConsumable(username, type, count);
    
    console.log(`[CONSUMABLE] ${username} spent ${totalCost} coins on ${count}x ${type}`);
    
    const inventory = db.getConsumableInventory(username);
    
    // Response: PurchaseConsumableResponse
    res.json({
        assets: db.getPlayerAssets(username),
        inventory: signedResponse(inventory, swid)
    });
}

// Purchase is /{type}/{count}; use is /{type} with no count. The client
// sends POST for both, so the count segment is what tells them apart.
router.put('/consumable/v1/:type/:count', purchaseConsumable);
router.post('/consumable/v1/:type/:count', purchaseConsumable);

/**
 * DELETE /consumable/v1/:type
 * POST   /consumable/v1/:type
 * Use a consumable: a stored partial first, else one item.
 *
 * Response: SignedResponse<UsedConsumable> { type, partialCount }, signed
 * for the SmartFox server, which only plays con.use with this signature.
 * 400 CONSUMABLE_NOT_OWNED when the player has none.
 */
function useConsumable(req, res) {
    const type = req.params.type;
    const { swid, username } = req.player;

    const stock = db.getConsumableInventory(username).inventoryMap[type];
    const itemCount = stock?.itemCount || 0;
    const partialCount = stock?.partialCount || 0;
    if (itemCount <= 0 && partialCount <= 0) {
        console.log(`[CONSUMABLE] ${username} tried to use ${type} without having one`);
        return res.status(400).json({ code: 'CONSUMABLE_NOT_OWNED' });
    }

    console.log(`[CONSUMABLE] ${username} using: ${type}`);
    if (partialCount > 0) db.updateConsumable(username, type, itemCount, 0);
    else db.updateConsumable(username, type, itemCount - 1, 0);

    const { goodUntil, signature } = signConsumable('use', swid, type, partialCount);
    res.json({ goodUntil, swid, data: { partialCount, type }, signature });
}

router.delete('/consumable/v1/:type', useConsumable);
router.post('/consumable/v1/:type', useConsumable);

export default router;
