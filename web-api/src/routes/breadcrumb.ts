/**
 * Breadcrumb Routes
 * 
 * Handles breadcrumb tracking for tutorials and hints.
 * 
 * Endpoints:
 * - POST /breadcrumb/v1/breadcrumb       - Add breadcrumbs (AddBreadcrumbIdsOperation)
 * - POST /breadcrumb/v1/removebreadcrumbs - Remove breadcrumbs (RemoveBreadcrumbIdsOperation)
 */

import express from "express";
const router = express.Router();
import * as db from "../database.ts";

// Breadcrumb ids are short strings (or numbers); anything else in the list
// is skipped, and one account keeps a bounded number of them.
const MAX_ID_CHARS = 128;
const MAX_IDS_PER_REQUEST = 500;
const MAX_BREADCRUMBS_PER_PLAYER = 5000;
function breadcrumbIds(list: unknown): (string | number)[] {
    if (!Array.isArray(list)) return [];
    return list.slice(0, MAX_IDS_PER_REQUEST)
        .map((b) => (b !== null && typeof b === 'object' ? (b as any).id : b))
        .filter((id) => (typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_CHARS) || Number.isSafeInteger(id));
}

/**
 * POST /breadcrumb/v1/breadcrumb
 * Add breadcrumbs (UI hints)
 * 
 * Request: List<Breadcrumb> [{ breadcrumbType, id }]
 * Response: BreadcrumbCountResponse { breadcrumbCount }
 */
router.post('/breadcrumb/v1/breadcrumb', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[BREADCRUMB] ${username} adding breadcrumbs`);
    
    const breadcrumbList = req.body;
    
    // Add each breadcrumb (an object { breadcrumbType, id } or a bare id)
    const ids = breadcrumbIds(breadcrumbList);
    let room = MAX_BREADCRUMBS_PER_PLAYER - db.getBreadcrumbs(username).length;
    for (const id of ids) {
        if (room <= 0) {
            console.log(`[BREADCRUMB] ${username} already has ${MAX_BREADCRUMBS_PER_PLAYER} breadcrumbs, the rest are not stored`);
            break;
        }
        db.addBreadcrumb(username, id);
        room--;
    }
    
    // Get current count (max 50)
    const breadcrumbs = db.getBreadcrumbs ? db.getBreadcrumbs(username) : [];
    const breadcrumbCount = Math.min(breadcrumbs.length, 50);
    
    // Response: BreadcrumbCountResponse
    res.json({
        breadcrumbCount: breadcrumbCount
    });
});

/**
 * POST /breadcrumb/v1/removebreadcrumbs
 * Remove breadcrumbs
 * 
 * Request: List<Breadcrumb> [{ breadcrumbType, id }]
 * Response: BreadcrumbCountResponse { breadcrumbCount }
 */
router.post('/breadcrumb/v1/removebreadcrumbs', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[BREADCRUMB] ${username} removing breadcrumbs`);
    
    const breadcrumbList = req.body;
    
    // Remove each breadcrumb
    const ids = breadcrumbIds(breadcrumbList);
    if (ids.length > 0) db.removeBreadcrumbs(username, ids);
    
    // Get current count
    const breadcrumbs = db.getBreadcrumbs ? db.getBreadcrumbs(username) : [];
    const breadcrumbCount = breadcrumbs.length;
    
    // Response: BreadcrumbCountResponse
    res.json({
        breadcrumbCount: breadcrumbCount
    });
});

export default router;
