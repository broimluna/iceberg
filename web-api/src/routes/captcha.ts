/**
 * Captcha Routes
 * 
 * Handles captcha challenges and solutions.
 * 
 * Endpoints:
 * - GET  /captcha/v1          - Get captcha challenge (GetCaptchaOperation)
 * - POST /captcha/v1/solution - Submit captcha solution (PostCaptchaSolutionOperation)
 */

import express from "express";
const router = express.Router();

/**
 * GET /captcha/v1
 * Get captcha challenge
 * 
 * Query: type (CaptchaType), width, height
 * Response: CaptchaData { id, type, retryTimestamp, challengeImageData, captchaImageData, 
 *                         captchaDimensions, challengeToken, solutionSize }
 */
router.get('/captcha/v1', (req, res) => {
    const { swid, username } = req.player;
    const type = req.query.type || 0;
    const width = parseInt(req.query.width) || 200;
    const height = parseInt(req.query.height) || 100;
    
    console.log(`[CAPTCHA] ${username} requesting captcha type=${type}`);
    
    // Generate a simple captcha ID
    const captchaId = `captcha_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // For a private server, we can return a simple/auto-solvable captcha
    // or return placeholder data since captcha isn't needed for moderation
    
    // Response: CaptchaData
    res.json({
        id: captchaId,
        type: parseInt(type),
        retryTimestamp: 0,
        challengeImageData: '', // Base64 encoded image
        captchaImageData: '',   // Base64 encoded image
        captchaDimensions: {
            width: width,
            height: height
        },
        challengeToken: captchaId,
        solutionSize: 0  // 0 means no solution needed (auto-pass)
    });
});

/**
 * POST /captcha/v1/solution
 * Submit captcha solution
 * 
 * Query: type (CaptchaType)
 * Request: CaptchaSolution
 * Response: 200 OK (empty) on success
 */
router.post('/captcha/v1/solution', (req, res) => {
    const { swid, username } = req.player;
    const type = req.query.type || 0;
    const solution = req.body;
    
    console.log(`[CAPTCHA] ${username} submitting solution for type=${type}`);
    
    // For a private server, always accept the solution
    // In production, this would verify against the challenge
    
    res.status(200).send();
});

export default router;
