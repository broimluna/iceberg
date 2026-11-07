// Mix transport middleware: application/mix body encryption and auth.
import * as db from "../../database.ts";
import { decryptAesCbc, encryptAesCbc } from "../../lib/crypto.ts";

const decryptAes = decryptAesCbc;
const encryptAes = encryptAesCbc;

/**
 * Get session key from X-Mix-UserSessionId header
 */
function getSessionKey(req) {
    const sessionId = req.headers['x-mix-usersessionid'];
    if (!sessionId) {
        console.error('[MIX] No X-Mix-UserSessionId header found');
        return null;
    }
    
    // Find session by sessionId in database
    const session = db.getMixSessionById(parseInt(sessionId));
    if (!session) {
        console.error(`[MIX] Session key not found for sessionId: ${sessionId}`);
        return null;
    }
    
    return session.symmetricKey;
}

// =============================================================================
// Mix Encryption Middleware
// =============================================================================

/**
 * Middleware to decrypt incoming request bodies and encrypt responses
 * Only applies to routes that expect encrypted communication (after session start)
 */
export function mixEncryptionMiddleware(req, res, next) {
    const contentType = req.headers['content-type'];
    console.log(`[MIX] Middleware: ${req.method} ${req.url} Content-Type: ${contentType}`);
    
    // Check if this is an encrypted request (application/mix)
    if (contentType && contentType.includes('application/mix')) {
        const sessionKey = getSessionKey(req);
        
        if (!sessionKey) {
            console.error('[MIX] No session key found for encrypted request');
            return res.status(401).json({ Status: 'UNAUTHORIZED_MIX_SESSION' });
        }
        
        try {
            // req.body is a Buffer from express.raw() middleware
            const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
            const decrypted = decryptAes(rawBody, sessionKey);
            req.body = JSON.parse(decrypted.toString('utf8'));
            console.log(`[MIX] Decrypted body:`, JSON.stringify(req.body));
            
            // Store session key for response encryption
            req.mixSessionKey = sessionKey;
            
            // Override res.json to encrypt the response
            const originalJson = res.json.bind(res);
            res.json = (data) => {
                const plaintext = JSON.stringify(data);
                const encrypted = encryptAes(Buffer.from(plaintext, 'utf8'), sessionKey);
                res.setHeader('Content-Type', 'application/mix');
                res.send(encrypted);
            };
            
            next();
        } catch (err) {
            console.error('[MIX] Decryption error:', err.message);
            return res.status(400).json({ Status: 'DECRYPTION_ERROR' });
        }
    } else {
        // Not encrypted (session start or other unencrypted requests)
        console.log(`[MIX] Unencrypted request body:`, JSON.stringify(req.body));
        next();
    }
}

// =============================================================================
// Mix Authentication Middleware
// =============================================================================

export function authenticateMix(req, res, next) {
    const oneIdToken = req.headers['x-mix-oneidtoken'];
    const clientToken = req.headers['x-mix-clienttoken'];
    
    // For development, accept any token
    // In production, validate against stored tokens
    if (!oneIdToken) {
        console.warn(`[MIX] Auth failed: Missing X-Mix-OneIdToken for ${req.method} ${req.url}`);
        return res.status(401).json({ Status: 'UNAUTHORIZED_ONEID_TOKEN' });
    }
    
    // Extract UserId from request body
    const userId = req.body?.UserId;
    if (userId) {
        req.mixUserId = userId;
    }
    
    next();
}
