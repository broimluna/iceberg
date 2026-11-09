/**
 * Disney Store Routes
 * 
 * Handles Disney Store item purchases.
 * 
 * Endpoints:
 * - PUT /disneystore/v1/purchase/:type/:count - Purchase item (PurchaseDisneyStoreItemOperation)
 */

import { positiveCount, NOT_ENOUGH_COINS } from "../utils/counts.ts";
import express from "express";
const router = express.Router();
import * as db from "../database.ts";
import { generateEquipmentId } from "../utils/session.ts";
import disneyStoreFranchises from "../../data/DisneyStoreFranchises.json";

console.log(`[DISNEYSTORE] Loaded ${disneyStoreFranchises.length} franchises`);

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
 * Find a Disney Store item by ID
 */
function findDisneyStoreItem(itemId) {
    for (const franchise of disneyStoreFranchises) {
        if (franchise.Items) {
            for (const item of franchise.Items) {
                if (item.Id === itemId) {
                    return item;
                }
            }
        }
    }
    return null;
}

/**
 * Apply Disney Store reward to player
 * Returns array of created equipment for the response
 */
function applyReward(username, reward, count) {
    const createdEquipment = [];
    
    if (!reward) return createdEquipment;
    
    // Add coins if any
    if (reward.coins) {
        db.addPlayerCoins(username, reward.coins * count);
    }
    
    // Add equipment templates (unlocks for creating new items)
    if (reward.equipmentTemplates) {
        for (const templateId of reward.equipmentTemplates) {
            db.addEquipmentTemplate(username, templateId);
        }
    }
    
    // Add equipment instances - these are ACTUAL clothing items that appear in closet!
    if (reward.equipmentInstances) {
        for (const instance of reward.equipmentInstances) {
            // Also add as template so player "owns" this design
            db.addEquipmentTemplate(username, instance.definitionId);
            
            // Create actual equipment item(s) based on count
            for (let i = 0; i < count; i++) {
                const newEquipment = {
                    equipmentId: generateEquipmentId(),
                    dateTimeCreated: Date.now(),
                    definitionId: instance.definitionId,
                    parts: instance.parts || []
                };
                db.saveEquipment(username, newEquipment);
                createdEquipment.push(newEquipment);
                console.log(`[DISNEYSTORE] Created equipment item: id=${newEquipment.equipmentId}, definitionId=${instance.definitionId}`);
            }
        }
    }
    
    // Add consumables
    if (reward.consumables) {
        for (const [consumableType, amount] of Object.entries(reward.consumables)) {
            db.addConsumable(username, consumableType, amount * count);
        }
    }
    
    // Add decoration instances (decorationId is just the definitionId, type defaults to 0)
    if (reward.decorationInstances) {
        for (const [definitionId, amount] of Object.entries(reward.decorationInstances)) {
            const decorationId = {
                definitionId: parseInt(definitionId),
                type: 0,  // Default decoration type
                customId: null
            };
            db.addDecoration(username, decorationId, amount * count);
        }
    }
    
    // Add structure instances (similar to decorations but type 1)
    if (reward.structureInstances) {
        for (const [definitionId, amount] of Object.entries(reward.structureInstances)) {
            const decorationId = {
                definitionId: parseInt(definitionId),
                type: 1,  // Structure type
                customId: null
            };
            db.addDecoration(username, decorationId, amount * count);
        }
    }
    
    // Add fabrics
    if (reward.fabrics) {
        for (const fabricId of reward.fabrics) {
            db.addFabric(username, fabricId);
        }
    }
    
    // Add decals
    if (reward.decals) {
        for (const decalId of reward.decals) {
            db.addDecal(username, decalId);
        }
    }
    
    // Add durables
    if (reward.durables) {
        for (const durableId of reward.durables) {
            db.addDurable(username, durableId);
        }
    }
    
    // Add tubes
    if (reward.tubes) {
        for (const tubeId of reward.tubes) {
            db.addTube(username, tubeId);
        }
    }
    
    return createdEquipment;
}

/**
 * PUT /disneystore/v1/purchase/:type/:count
 * Purchase a Disney Store item
 * 
 * Response: PurchaseDisneyStoreItemResponse { assets, inventory, decorationInventory, wsEvents? }
 */
router.put('/disneystore/v1/purchase/:type/:count', (req, res) => {
    const { swid, username } = req.player;
    const itemId = parseInt(req.params.type);
    const count = positiveCount(req.params.count, 99);
    if (count === null) return res.status(400).json({ code: 'BAD_COUNT' });
    
    console.log(`[DISNEYSTORE] ${username} purchasing item ${itemId} x${count}`);
    
    // Find the item in Disney Store data
    const storeItem = findDisneyStoreItem(itemId);
    
    if (!storeItem) {
        console.error(`[DISNEYSTORE] Item ${itemId} not found in store data`);
        return res.status(404).json({ error: 'Item not found' });
    }
    
    // Calculate total cost
    const totalCost = storeItem.Cost * count;
    if (!Number.isSafeInteger(totalCost) || totalCost < 0) return res.status(400).json({ code: 'BAD_COUNT' });
    if (db.getPlayerCoins(username) < totalCost) return res.status(400).json({ code: NOT_ENOUGH_COINS });
    
    console.log(`[DISNEYSTORE] Item found: Cost=${storeItem.Cost}, Total=${totalCost}`);
    console.log(`[DISNEYSTORE] Reward:`, JSON.stringify(storeItem.Reward));
    
    // Apply the reward FIRST (before deducting coins, so they get the item)
    const createdEquipment = applyReward(username, storeItem.Reward, count);
    
    // Then deduct coins
    db.addPlayerCoins(username, -totalCost);
    
    // Ensure all equipment the player owns has corresponding templates
    // This prevents the closet from being "stripped" when assets are updated
    const allEquipment = db.getEquipment(username);
    for (const eq of allEquipment) {
        db.addEquipmentTemplate(username, eq.definitionId);
    }
    
    // Get updated assets
    const assets = db.getPlayerAssets(username);
    console.log(`[DISNEYSTORE] Updated assets - equipmentTemplates:`, assets.equipmentTemplates);
    console.log(`[DISNEYSTORE] Created ${createdEquipment.length} equipment items`);
    
    // Get consumable inventory
    const consumableInventory = db.getConsumableInventory(username);
    
    // Get decoration inventory
    const decorationInventory = db.getDecorationInventory(username);
    
    // Response: PurchaseDisneyStoreItemResponse
    // Note: wsEvents must be empty array - client doesn't handle custom events
    res.json({
        assets: assets,
        inventory: signedResponse(consumableInventory, swid),
        decorationInventory: signedResponse(decorationInventory, swid),
        wsEvents: []
    });
});

export default router;
