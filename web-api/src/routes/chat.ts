/**
 * Chat Routes
 * 
 * Handles chat message verification and moderation.
 * 
 * Endpoints:
 * - POST /chat/v1/message/verify - Verify/moderate chat message (VerifyChatMessageOperation)
 */

import express from "express";
const router = express.Router();

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
 * POST /chat/v1/message/verify
 * Verify/moderate a chat message
 * 
 * Request: ChatMessage { senderSessionId, message, emotion, moderated, questId, objective }
 * Response: SignedResponse<ChatMessage>
 */
router.post('/chat/v1/message/verify', (req, res) => {
    const { swid, username } = req.player;
    const chatMessage = req.body;
    
    console.log(`[CHAT] ${username} verifying message: "${chatMessage.message}"`);
    
    // For a private server, we can pass through messages unmodified
    // In production, this would check against a word filter
    
    const verifiedMessage = {
        senderSessionId: chatMessage.senderSessionId,
        message: chatMessage.message,
        emotion: chatMessage.emotion || 0,
        moderated: false, // Not moderated - message is allowed
        questId: chatMessage.questId || '',
        objective: chatMessage.objective || ''
    };
    
    // Response: SignedResponse<ChatMessage>
    res.json(signedResponse(verifiedMessage, swid));
});

export default router;
