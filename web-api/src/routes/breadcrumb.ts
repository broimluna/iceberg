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
    
    // Add each breadcrumb
    if (Array.isArray(breadcrumbList)) {
        for (const breadcrumb of breadcrumbList) {
            if (db.addBreadcrumb) {
                // Breadcrumb is an object with { breadcrumbType, id } - extract the id
                const breadcrumbId = typeof breadcrumb === 'object' ? breadcrumb.id : breadcrumb;
                db.addBreadcrumb(username, breadcrumbId);
            }
        }
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
    if (Array.isArray(breadcrumbList)) {
        if (db.removeBreadcrumbs) {
            // Extract IDs from breadcrumb objects { breadcrumbType, id }
            const breadcrumbIds = breadcrumbList.map(b => typeof b === 'object' ? b.id : b);
            db.removeBreadcrumbs(username, breadcrumbIds);
        }
    }
    
    // Get current count
    const breadcrumbs = db.getBreadcrumbs ? db.getBreadcrumbs(username) : [];
    const breadcrumbCount = breadcrumbs.length;
    
    // Response: BreadcrumbCountResponse
    res.json({
        breadcrumbCount: breadcrumbCount
    });
});

export default router;
