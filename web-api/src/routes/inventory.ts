/**
 * Inventory Routes
 * 
 * Handles equipment inventory and saved outfits.
 * 
 * Endpoints:
 * - GET    /inventory/v1/equipment              - Get player's custom equipment (GetInventoryOperation)
 * - POST   /inventory/v1/equipment              - Create new custom equipment (CreateCustomEquipmentOperation)
 * - DELETE /inventory/v1/equipment/:equipmentId - Delete custom equipment (DeleteCustomEquipmentOperation)
 * - GET    /inventory/v1/outfits                - Get saved outfit slots (GetSavedOutfitsOperation)
 * - POST   /inventory/v1/outfit                 - Save outfit to slot (SaveSavedOutfitOperation)
 * - DELETE /inventory/v1/outfit/:outfitSlot     - Delete saved outfit (DeleteSavedOutfitOperation)
 */

import express from "express";
const router = express.Router();
import * as db from "../database.ts";
import { generateEquipmentId } from "../utils/session.ts";

// ========== EQUIPMENT ENDPOINTS ==========

/**
 * GET /inventory/v1/equipment
 * Get player's custom equipment
 * 
 * Response: CustomEquipment[]
 */
router.get('/inventory/v1/equipment', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[INVENTORY] ${username} requested equipment`);
    
    const equipment = db.getEquipment(username);
    
    console.log(`[INVENTORY] Returning ${equipment.length} equipment items`);
    res.json(equipment);
});

/**
 * POST /inventory/v1/equipment
 * Create custom equipment
 * 
 * Request: CustomEquipment { definitionId, parts[] }
 * Response: CreateEquipmentResponse { equipmentId, assets }
 */
router.post('/inventory/v1/equipment', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[INVENTORY] ${username} creating equipment`);
    
    const newEquipment = req.body;
    
    // Generate new equipment ID if not provided
    if (!newEquipment.equipmentId || newEquipment.equipmentId === 0) {
        newEquipment.equipmentId = generateEquipmentId();
    }
    if (!newEquipment.dateTimeCreated) {
        newEquipment.dateTimeCreated = Date.now();
    }
    
    // Save equipment to database
    db.saveEquipment(username, newEquipment);
    
    // Ensure the template is owned (so item shows in closet)
    if (newEquipment.definitionId) {
        db.addEquipmentTemplate(username, newEquipment.definitionId);
    }
    
    console.log(`[INVENTORY] ${username} created equipment ID ${newEquipment.equipmentId}, definitionId=${newEquipment.definitionId}`);
    
    // Response: CreateEquipmentResponse
    res.json({
        equipmentId: newEquipment.equipmentId,
        assets: db.getPlayerAssets(username)
    });
});

/**
 * DELETE /inventory/v1/equipment/:equipmentId
 * Delete custom equipment
 * 
 * Response: CustomEquipmentId { equipmentId }
 */
router.delete('/inventory/v1/equipment/:equipmentId', (req, res) => {
    const equipmentId = parseInt(req.params.equipmentId);
    const { swid, username } = req.player;
    
    console.log(`[INVENTORY] ${username} deleting equipment ${equipmentId}`);
    
    db.deleteEquipment(username, equipmentId);
    
    // Response: CustomEquipmentId
    res.json({ 
        equipmentId: equipmentId 
    });
});

// ========== SAVED OUTFITS ENDPOINTS ==========

/**
 * GET /inventory/v1/outfits
 * Get saved outfit slots
 * 
 * Response: SavedOutfit[] - array of { outfitSlot, parts[] }
 */
router.get('/inventory/v1/outfits', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[INVENTORY] ${username} requested saved outfits`);
    
    const savedOutfits = db.getSavedOutfits ? db.getSavedOutfits(username) : [];
    
    console.log(`[INVENTORY] Returning ${savedOutfits.length} saved outfits`);
    res.json(savedOutfits);
});

/**
 * POST /inventory/v1/outfit
 * Save outfit to a slot
 * 
 * Request: SavedOutfit { outfitSlot, parts[] }
 * Response: SavedOutfitResponse { outfitSlot }
 */
router.post('/inventory/v1/outfit', (req, res) => {
    const { swid, username } = req.player;
    const savedOutfit = req.body;
    
    console.log(`[INVENTORY] ${username} saving outfit to slot ${savedOutfit.outfitSlot}`);
    
    // Save outfit to database
    if (db.saveSavedOutfit) {
        db.saveSavedOutfit(username, savedOutfit.outfitSlot, savedOutfit.parts || []);
    }
    
    // Response: SavedOutfitResponse
    res.json({
        outfitSlot: savedOutfit.outfitSlot
    });
});

/**
 * DELETE /inventory/v1/outfit/:outfitSlot
 * Delete saved outfit from slot
 * 
 * Response: SavedOutfitResponse { outfitSlot }
 */
router.delete('/inventory/v1/outfit/:outfitSlot', (req, res) => {
    const outfitSlot = parseInt(req.params.outfitSlot);
    const { swid, username } = req.player;
    
    console.log(`[INVENTORY] ${username} deleting saved outfit from slot ${outfitSlot}`);
    
    // Delete outfit from database
    if (db.deleteSavedOutfit) {
        db.deleteSavedOutfit(username, outfitSlot);
    }
    
    // Response: SavedOutfitResponse
    res.json({
        outfitSlot: outfitSlot
    });
});

export default router;
