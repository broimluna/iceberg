/**
 * Tube Routes
 * 
 * Handles snow tube equipment.
 * 
 * Endpoints:
 * - PUT /tube/v1/equip/:type - Equip snow tube (EquipTubeOperation)
 */

import express from "express";
const router = express.Router();
import * as db from "../database.ts";

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
 * PUT /tube/v1/equip/:type
 * Equip a snow tube
 * 
 * Response: SignedResponse<EquipTubeResponse> { tubeId }
 */
router.put('/tube/v1/equip/:type', (req, res) => {
    const { swid, username } = req.player;
    const tubeId = parseInt(req.params.type);
    
    console.log(`[TUBE] ${username} equipping tube: ${tubeId}`);
    
    // Save equipped tube
    if (db.setEquippedTube) {
        db.setEquippedTube(username, tubeId);
    }
    
    // Response: SignedResponse<EquipTubeResponse>
    res.json(signedResponse({
        tubeId: tubeId
    }, swid));
});

export default router;
