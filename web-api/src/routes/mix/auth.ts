// Mix transport middleware: application/mix body encryption and auth.
import { logSafe } from "../../utils/logSafe.ts";
import * as db from "../../database.ts";
import { decryptAesCbc, encryptAesCbc } from "../../lib/crypto.ts";
import { isBanned } from "../../services/moderation.ts";
import { parseJson, stringifyJson } from "../../lib/bigJson.ts";

const decryptAes = decryptAesCbc;
const encryptAes = encryptAesCbc;

/**
 * Get the Mix session named by the X-Mix-UserSessionId header
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
    
    return session;
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
    console.log(`[MIX] Middleware: ${req.method} ${logSafe(req.url)} Content-Type: ${logSafe(contentType)}`);
    
    // Check if this is an encrypted request (application/mix)
    if (contentType && contentType.includes('application/mix')) {
        const session = getSessionKey(req);
        const sessionKey = session?.symmetricKey;
        
        if (!sessionKey) {
            console.error('[MIX] No session key found for encrypted request');
            return res.status(401).json({ Status: 'UNAUTHORIZED_MIX_SESSION' });
        }
        
        try {
            // req.body is a Buffer from express.raw() middleware
            const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
            const decrypted = decryptAes(rawBody, sessionKey);
            // Lossless: the SDK's 64-bit ids (ClientChatMessageId) stay exact.
            req.body = parseJson(decrypted.toString('utf8'));
            // Bodies carry players' chat and friend requests: log the size, never the contents.
            console.log(`[MIX] Decrypted body: ${decrypted.length} bytes`);
            
            // Store session key for response encryption, and whose session it
            // is so authenticateMix can check it against the token.
            req.mixSessionKey = sessionKey;
            req.mixSessionSwid = session.swid;
            
            // Override res.json to encrypt the response
            const originalJson = res.json.bind(res);
            res.json = (data) => {
                const plaintext = stringifyJson(data);
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
        console.log(`[MIX] Unencrypted request body: ${req.body === undefined ? 0 : JSON.stringify(req.body)?.length ?? 0} bytes`);
        next();
    }
}

// =============================================================================
// Mix Authentication Middleware
// =============================================================================

// Every Mix request acts as the user its X-Mix-OneIdToken (a Guest
// Controller access token) belongs to. The body's UserId and the
// encrypted session must agree with it. A failure is a 401 with the
// status the SDK routes on (MixWebCallFactory): UNAUTHORIZED_ONEID_TOKEN
// makes it refresh the token, UNAUTHORIZED_MIX_SESSION makes it redo the
// session key exchange.
export function authenticateMix(req, res, next) {
    const oneIdToken = req.headers['x-mix-oneidtoken'];
    const token = oneIdToken ? db.getGuestToken(oneIdToken) : null;
    if (!token || token.tokenType !== 'access') {
        console.warn(`[MIX] Auth failed: unknown or expired X-Mix-OneIdToken for ${req.method} ${req.url}`);
        return res.status(401).json({ Status: 'UNAUTHORIZED_ONEID_TOKEN' });
    }

    const claimed = req.body?.UserId;
    if (claimed != null && claimed !== token.swid) {
        console.warn(`[MIX] Auth failed: token belongs to ${token.swid} but body claims ${logSafe(claimed)} (${req.method} ${logSafe(req.url)})`);
        return res.status(401).json({ Status: 'UNAUTHORIZED_ONEID_TOKEN' });
    }

    if (req.mixSessionSwid && req.mixSessionSwid !== token.swid) {
        console.warn(`[MIX] Auth failed: session belongs to ${req.mixSessionSwid}, token to ${token.swid} (${req.method} ${req.url})`);
        return res.status(401).json({ Status: 'UNAUTHORIZED_MIX_SESSION' });
    }

    // A banned or locked user gets UNAUTHORIZED_BANNED: the SDK doesn't
    // retry, it logs the user out (AccountBannedEventArgs).
    if (isBanned(token.swid)) {
        console.warn(`[MIX] ${token.swid} is banned (${req.method} ${req.url})`);
        return res.status(401).json({ Status: 'UNAUTHORIZED_BANNED' });
    }

    req.mixUserId = token.swid;
    if (req.body && typeof req.body === 'object') req.body.UserId = token.swid;
    next();
}
