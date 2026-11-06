/**
 * Catalog Routes
 * 
 * Handles clothing catalog browsing, submissions, and purchases.
 * 
 * Endpoints:
 * - GET  /catalog/v1/clothing/themes/stats        - Get current theme stats (GetCurrentThemeOperation)
 * - GET  /catalog/v1/clothing/user/stats          - Get user catalog stats (GetUserStatsOperation)
 * - POST /catalog/v1/clothing/items/:catalogSection - Get catalog items (BaseCatalogSectionOperation)
 * - POST /catalog/v1/clothing/purchase            - Purchase item (ItemPurchaseOperation)
 * - POST /catalog/v1/clothing/submit              - Submit item (ItemSubmissionOperation)
 */

import express from "express";
const router = express.Router();
import * as db from "../database.ts";
import * as smartfox from "../smartfoxNotifier.ts";
import { generateEquipmentId } from "../utils/session.ts";

/**
 * GET /catalog/v1/clothing/themes/stats
 * Get current theme challenge stats
 * 
 * Response: CurrentThemeResponse { themes: CurrentThemeData[] }
 */
router.get('/catalog/v1/clothing/themes/stats', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[CATALOG] ${username} requested themes stats`);
    
    // Response: CurrentThemeResponse
    res.json({
        themes: [{
            scheduledThemeChallengeId: 1,
            userSubmissionClothingCatalogId: 0,
            mostPopularItem: null,
            submissionRewardCoinAmount: 100
        }]
    });
});

/**
 * GET /catalog/v1/clothing/user/stats
 * Get user catalog stats
 * 
 * Response: UserStatsResponse { totalItemsSold, totalItemsPurchased, mostPopularItem, currentItems }
 */
router.get('/catalog/v1/clothing/user/stats', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[CATALOG] ${username} requested user stats`);
    
    // Get user's catalog statistics
    const userSubmissions = db.getCatalogSubmissions ? 
        db.getCatalogSubmissions(null).filter(s => s.creatorName === username) : [];
    
    const totalItemsSold = userSubmissions.reduce((sum, item) => sum + (item.numberSold || 0), 0);
    
    // Response: UserStatsResponse
    res.json({
        totalItemsSold: totalItemsSold,
        totalItemsPurchased: 0, // Could track this in database
        mostPopularItem: userSubmissions.length > 0 ? 
            userSubmissions.reduce((best, item) => 
                (item.numberSold || 0) > (best.numberSold || 0) ? item : best, userSubmissions[0]) : null,
        currentItems: userSubmissions.slice(0, 10)
    });
});

/**
 * POST /catalog/v1/clothing/items/:catalogSection
 * Get catalog items for a section (recent, popular, friends, category)
 * 
 * Response: CatalogSectionResponse { cursor, items }
 */
router.post('/catalog/v1/clothing/items/:catalogSection', (req, res) => {
    const { catalogSection } = req.params;
    const { swid, username } = req.player;
    console.log(`[CATALOG] ${username} requested section: ${catalogSection}`);
    
    const scheduledThemeChallengeId = req.body.scheduledThemeChallengeId || 0;
    let allSubmissions = db.getCatalogSubmissions ? 
        db.getCatalogSubmissions(scheduledThemeChallengeId === 0 ? null : scheduledThemeChallengeId) : [];
    
    // Sort based on section type
    if (catalogSection === 'recent') {
        allSubmissions.sort((a, b) => b.clothingCatalogItemId - a.clothingCatalogItemId);
    } else if (catalogSection === 'popular') {
        allSubmissions.sort((a, b) => (b.numberSold || 0) - (a.numberSold || 0));
    } else if (catalogSection === 'friends') {
        // Filter to friends only - for now return all
        allSubmissions = allSubmissions.filter(s => s.creatorName !== username);
    }
    
    // Response: CatalogSectionResponse
    res.json({
        cursor: '',
        items: allSubmissions
    });
});

/**
 * POST /catalog/v1/clothing/purchase
 * Purchase a clothing item from the catalog
 * 
 * Request: ItemPurchaseRequest { clothingCatalogItemId }
 * Response: ItemPurchaseResponse { clothingCatalogItemId, equipment }
 */
router.post('/catalog/v1/clothing/purchase', (req, res) => {
    const { swid, username } = req.player;
    const clothingCatalogItemId = req.body.clothingCatalogItemId;
    
    console.log(`[CATALOG] ${username} purchasing item: ${clothingCatalogItemId}`);
    
    // Find the catalog item
    const allSubmissions = db.getCatalogSubmissions ? db.getCatalogSubmissions(null) : [];
    const item = allSubmissions.find(s => s.clothingCatalogItemId === clothingCatalogItemId);
    
    if (!item) {
        res.status(404).json({ error: 'Item not found' });
        return;
    }
    
    // Deduct cost and add equipment
    const cost = item.cost || 100;
    db.addPlayerCoins(username, -cost);
    
    // Create a copy of the equipment for the buyer
    const newEquipment = {
        equipmentId: generateEquipmentId(),
        dateTimeCreated: Date.now(),
        definitionId: item.equipment?.definitionId || 0,
        parts: item.equipment?.parts || []
    };
    
    db.saveEquipment(username, newEquipment);
    
    // Ensure the template is owned (so item shows in closet)
    if (newEquipment.definitionId) {
        db.addEquipmentTemplate(username, newEquipment.definitionId);
    }
    
    // Increment sales counter for the item
    if (db.incrementCatalogSales) {
        db.incrementCatalogSales(clothingCatalogItemId);
    }
    
    console.log(`[CATALOG] ${username} purchased item ${clothingCatalogItemId} for ${cost} coins`);
    
    // Response: ItemPurchaseResponse
    res.json({
        clothingCatalogItemId: clothingCatalogItemId,
        equipment: newEquipment
    });
});

/**
 * POST /catalog/v1/clothing/submit
 * Submit clothing to catalog
 * 
 * Request: ItemSubmissionRequest { scheduledThemeChallengeId, equipment }
 * Response: ItemSubmissionResponse { clothingCatalogItemId, newCoinTotal }
 */
router.post('/catalog/v1/clothing/submit', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[CATALOG] ${username} submitting clothing`);
    
    const scheduledThemeChallengeId = req.body.scheduledThemeChallengeId || 0;
    const equipment = req.body.equipment || {};
    
    const clothingCatalogItemId = generateEquipmentId();
    
    const newEquipment = {
        equipmentId: clothingCatalogItemId,
        dateTimeCreated: Date.now(),
        definitionId: equipment.definitionId || 0,
        parts: equipment.parts || []
    };
    
    db.saveEquipment(username, newEquipment);
    
    // Ensure the template is owned (so item shows in closet)
    if (newEquipment.definitionId) {
        db.addEquipmentTemplate(username, newEquipment.definitionId);
    }
    
    const submissionReward = 100;
    db.addPlayerCoins(username, submissionReward);
    
    // Update catalog task
    if (db.updateDailyTask) {
        db.updateDailyTask(username, 'ClothingCatalogSubmission', 1, Date.now(), false);
    }
    
    if (db.addCatalogSubmission) {
        db.addCatalogSubmission(username, {
            clothingCatalogItemId,
            creatorName: username,
            cost: 100,
            numberSold: 0,
            scheduledThemeChallengeId,
            dateSubmitted: Date.now(),
            equipment: newEquipment
        });
    }
    
    console.log(`[CATALOG] ${username} created item ${clothingCatalogItemId}`);
    
    // Get updated coin total
    const newCoinTotal = db.getPlayerCoins(username);
    
    // Notify SmartFox server of updates (send reward amount, not total)
    smartfox.notifyDailyTaskUpdate(username, 'ClothingCatalogSubmission', 1);
    smartfox.notifyCoinsUpdate(username, submissionReward);
    
    // Response: ItemSubmissionResponse
    res.json({
        clothingCatalogItemId,
        newCoinTotal: newCoinTotal
    });
});

export default router;
