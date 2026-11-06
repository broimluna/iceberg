/**
 * Tutorial Routes
 * 
 * Handles tutorial progress tracking.
 * 
 * Endpoints:
 * - POST /tutorial/v1/tutorial - Set tutorial state (SetTutorialOperation)
 */

import express from "express";
const router = express.Router();
import * as db from "../database.ts";

/**
 * POST /tutorial/v1/tutorial
 * Mark tutorial step complete
 * 
 * Request: Tutorial { tutorialID, isComplete }
 * Response: TutorialResponse { tutorialBytes }
 */
router.post('/tutorial/v1/tutorial', (req, res) => {
    const { swid, username } = req.player;
    const tutorial = req.body;
    
    console.log(`[TUTORIAL] ${username} setting tutorial state:`, tutorial);
    
    if (tutorial.tutorialID !== undefined && tutorial.isComplete) {
        if (db.completeTutorial) {
            db.completeTutorial(username, tutorial.tutorialID);
        }
        console.log(`[TUTORIAL] ${username} completed tutorial ${tutorial.tutorialID}`);
    }
    
    // Get tutorial bytes as signed byte array
    const tutorialBytes = db.getTutorialData ? db.getTutorialData(username) : [];
    
    // Response: TutorialResponse
    res.json({
        tutorialBytes: tutorialBytes
    });
});

export default router;
