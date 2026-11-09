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
import tubes from "../../data/tubes.json";

// Tube ids from the client's Tubes definitions.
const KNOWN_TUBES = new Set<number>(tubes.ids);

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
    const tubeId = /^\d{1,9}$/.test(req.params.type) ? Number(req.params.type) : NaN;
    // Any tube the client defines. Ownership isn't checked: the tube screen
    // also offers progression-unlocked tubes, which the server doesn't track.
    if (!KNOWN_TUBES.has(tubeId)) {
        return res.status(400).json({ error: 'Unknown tube' });
    }

    console.log(`[TUBE] ${username} equipping tube: ${tubeId}`);
    db.setEquippedTube(username, tubeId);
    
    // Response: SignedResponse<EquipTubeResponse>
    res.json(signedResponse({
        tubeId: tubeId
    }, swid));
});

export default router;
