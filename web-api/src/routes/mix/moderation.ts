import express from "express";
import * as db from "../../database.ts";
import { authenticateMix } from "./auth.ts";
import { buildResponse } from "./common.ts";

const router = express.Router();

// =============================================================================
// Moderation Endpoints
// =============================================================================

/**
 * PUT /moderation/reportPlayer
 * Report a player
 */
router.put('/moderation/reportPlayer', authenticateMix, (req, res) => {
    const { UserId, ReportedUserId, Reason } = req.body;
    
    // Log the report (in production, store in database)
    console.log(`[MODERATION] Player ${UserId} reported ${ReportedUserId} for: ${Reason}`);
    
    res.json(buildResponse());
});

/**
 * PUT /moderation/text
 * Moderate text (chat filter)
 */
router.put('/moderation/text', authenticateMix, (req, res) => {
    const { Text, Language, ChatThreadId, ModerationPolicy } = req.body;
    
    // Simple profanity filter (in production, use a proper filter)
    const badWords = ['badword1', 'badword2']; // Add actual bad words
    let moderated = false;
    let moderatedText = Text;
    
    for (const word of badWords) {
        if (Text?.toLowerCase().includes(word)) {
            moderated = true;
            moderatedText = moderatedText.replace(new RegExp(word, 'gi'), '*'.repeat(word.length));
        }
    }
    
    res.json(buildResponse({
        Text: moderatedText,
        Moderated: moderated
    }));
});


export default router;
