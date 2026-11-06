import express from "express";
const router = express.Router();

/**
 * POST /diagnostics/v1/log
 * Receive diagnostic logs from the client
 */
router.post('/diagnostics/v1/log', (req, res) => {
    // Determine connection info (simplified)
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    // Log basic info that we received logs
    console.log(`[DIAGNOSTICS] Received logs from ${clientIp}`);
    
    // If body is array, iterate and log important errors
    if (Array.isArray(req.body)) {
        req.body.forEach(entry => {
            if (entry.severity === 'ERROR' || entry.severity === 'CRITICAL') {
                console.error(`[CLIENT LOG] [${entry.severity}] ${entry.message}`);
            }
        });
    }

    res.json({});
});

export default router;
