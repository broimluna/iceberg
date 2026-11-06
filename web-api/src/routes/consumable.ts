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
 * Request: SignedResponse<UsedConsumable> { type, partialCount }
 * Response: SignedResponse<ConsumableInventory>
 */
router.post('/consumable/v1/partial', (req, res) => {
    const { swid, username } = req.player;
    
    // Extract UsedConsumable from SignedResponse
    const usedConsumable = req.body.data || req.body.Data || req.body;
    const type = usedConsumable.type;
    const partialCount = usedConsumable.partialCount || 0;
    
    console.log(`[CONSUMABLE] ${username} storing partial: ${type} (${partialCount})`);
    
    // Get current inventory
    const inventory = db.getConsumableInventory(username);
    const currentItem = inventory.inventoryMap && inventory.inventoryMap[type];
    const currentCount = currentItem?.itemCount || 0;
    
    // Update partial count
    db.updateConsumable(username, type, currentCount, partialCount);
    
    // Get updated inventory
    const updatedInventory = db.getConsumableInventory(username);
    
    // Response: SignedResponse<ConsumableInventory>
    res.json(signedResponse(updatedInventory, swid));
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
    const count = parseInt(req.params.count) || 1;
    const { swid, username } = req.player;
    
    console.log(`[CONSUMABLE] ${username} purchasing ${count}x ${type}`);
    
    // Get price from config
    const price = config.consumablePrices[type] || 10;
    const totalCost = price * count;
    
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

// Purchase always carries a count segment in the real client
// (PurchaseConsumableOperation's path template is literally
// "/consumable/v1/{type}/{count}") - required here, not optional, so a
// count-less request can't fall through to this handler. The client this
// server actually talks to sends POST for both purchase and use (never
// the real client's PUT/DELETE), disambiguated only by whether a count
// segment is present - see useConsumable below for the count-less half
// of that split.
router.put('/consumable/v1/:type/:count', purchaseConsumable);
router.post('/consumable/v1/:type/:count', purchaseConsumable);

/**
 * DELETE /consumable/v1/:type
 * POST   /consumable/v1/:type
 * Use a consumable
 *
 * Response: SignedResponse<UsedConsumable> { type, partialCount }
 */
function useConsumable(req, res) {
    const type = req.params.type;
    const { swid, username } = req.player;

    console.log(`[CONSUMABLE] ${username} using: ${type}`);

    const inventory = db.getConsumableInventory(username);
    let partialCount = 0;

    // Check if there's a partial count to use first
    if (inventory.inventoryMap && inventory.inventoryMap[type]) {
        partialCount = inventory.inventoryMap[type].partialCount || 0;

        if (partialCount > 0) {
            // Clear partial count
            db.updateConsumable(username, type, inventory.inventoryMap[type].itemCount, 0);
        } else {
            // Decrease item count
            const newCount = (inventory.inventoryMap[type].itemCount || 1) - 1;
            if (newCount <= 0) {
                // Remove item from inventory
                db.updateConsumable(username, type, 0, 0);
            } else {
                db.updateConsumable(username, type, newCount, 0);
            }
        }
    }

    // Response: SignedResponse<UsedConsumable>
    res.json(signedResponse({
        partialCount: partialCount,
        type: type
    }, swid));
}

router.delete('/consumable/v1/:type', useConsumable);
router.post('/consumable/v1/:type', useConsumable);

export default router;
