/**
 * Guest Controller Routes
 * 
 * Disney Guest Controller API endpoints for authentication, profile management,
 * adult verification, guardian/child linking, and permissions.
 * 
 * Base path: /jgc/v5
 * Authentication types:
 * - None: Public endpoints
 * - APIKEY: Requires "Authorization: APIKEY {api-key}" header  
 * - BEARER: Requires "Authorization: BEARER {access-token}" header
 */

import { hashPassword, verifyPassword, MIN_PASSWORD, MAX_PASSWORD } from '../utils/passwords.ts';
import { rateLimit, accountFailureLimit, clientAddress } from '../utils/rateLimit.ts';
import { checkName } from '../utils/names.ts';
import express from "express";
const router = express.Router();
import * as db from "../database.ts";
import crypto from "crypto";
import { isBanned } from "../services/moderation.ts";

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Generate a UUID-style SWID
 */
function generateSwid() {
    return '{' + crypto.randomUUID().toUpperCase() + '}';
}

/**
 * Generate access/refresh tokens
 */
function generateTokens(swid) {
    const accessToken = crypto.randomBytes(32).toString('hex');
    const refreshToken = crypto.randomBytes(32).toString('hex');
    
    return {
        access_token: accessToken,
        refresh_token: refreshToken,
        refresh_ttl: 2592000, // 30 days in seconds
        ttl: 3600, // 1 hour in seconds
        swid: swid
    };
}

/**
 * Generate an API key
 */
function generateApiKey() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate ETags for profile and displayName
 * @param {string} swid - The player's SWID
 * @param {string} username - The player's username
 * @returns {object} Object containing profileETag and displayNameETag
 */
function generateEtags(swid, username) {
    // profileETag is SWID without - and {}
    const profileETag = swid.replace(/[-{}]/g, '');
    
    // displayNameETag is MD5 hash of username
    const displayNameETag = crypto.createHash('md5').update(username).digest('hex');
    
    return {
        profileETag,
        displayNameETag
    };
}

/**
 * Build a GuestControllerWebCallResponse error
 */
/** Why a name was refused, for developerMessage. */
function nameProblem(reason) {
    return {
        length: 'Names must be 3 to 20 characters',
        chars: 'Names may use letters, digits, spaces, "_", "-" and "." only',
        mixed: 'Names may use letters from only one alphabet',
        spacing: 'Names may not contain double spaces',
    }[reason];
}

// Unauthenticated endpoints that cost the server (password hashing) or
// create things are rate limited per address.
const tooMany = (res) => res.status(429).json(buildError('RATE_LIMIT', 'TOO_MANY_REQUESTS'));
const loginLimit = rateLimit({ name: 'login', envVar: 'AUTH_LOGIN_PER_MIN', defaultLimit: 10, windowMs: 60_000, onLimited: tooMany });
const registerLimit = rateLimit({ name: 'register', envVar: 'AUTH_REGISTER_PER_HOUR', defaultLimit: 5, windowMs: 3_600_000, onLimited: tooMany });
const accountFails = accountFailureLimit();
const apiKeyLimit = rateLimit({ name: 'api-key', envVar: 'AUTH_APIKEY_PER_MIN', defaultLimit: 30, windowMs: 60_000, onLimited: tooMany });

function buildError(keyCategory, errorCode, inputName = null, message = null) {
    return {
        error: {
            keyCategory: keyCategory,
            errors: [{
                code: errorCode,
                inputName: inputName,
                developerMessage: message
            }]
        }
    };
}

/**
 * Moderation bans at the Guest Controller (docs/MIX_API.md section 9).
 * GuestControllerErrorParser maps PROFILE_USER_BANNED to the temporary-ban
 * results and PROFILE_DISABLED to the profile-disabled ones. The SDK only
 * reads an error body on HTTP 400 or 2xx; on 401-499 it gives up without
 * parsing, so a ban must be a 400 or the app never shows it as a ban.
 */
function banError(swid) {
    const ban = isBanned(swid);
    if (!ban) return null;
    return ban.kind === 'ban' && ban.until
        ? buildError('LOGIN', 'PROFILE_USER_BANNED', null, `Banned until ${ban.until}`)
        : buildError('LOGIN', 'PROFILE_DISABLED', null, 'Profile disabled');
}

/**
 * Build a successful response with data
 */
function buildSuccess(data) {
    return { data: data };
}

// Export stores for backward compatibility (they're now just thin wrappers)
// These are kept for any middleware that might reference them
const tokenStore = {
    get: (token) => {
        const data = db.getGuestToken(token);
        if (!data) return null;
        return { swid: data.swid, expiry: new Date(data.expiresAt).getTime() };
    },
    set: (token, data) => {
        const ttlSeconds = Math.floor((data.expiry - Date.now()) / 1000);
        db.storeGuestToken(token, 'access', data.swid, ttlSeconds);
    },
    delete: (token) => db.deleteGuestToken(token),
    has: (token) => db.getGuestToken(token) !== null
};

const refreshStore = {
    get: (token) => {
        const data = db.getGuestToken(token);
        if (!data) return null;
        return { swid: data.swid, expiry: new Date(data.expiresAt).getTime() };
    },
    set: (token, data) => {
        const ttlSeconds = Math.floor((data.expiry - Date.now()) / 1000);
        db.storeGuestToken(token, 'refresh', data.swid, ttlSeconds);
    },
    delete: (token) => db.deleteGuestToken(token),
    has: (token) => db.getGuestToken(token) !== null
};


// =============================================================================
// APIKEY Authentication Middleware
// =============================================================================

function authenticateApiKey(req, res, next) {
    const authHeader = req.headers.authorization;
    
    console.log(`[APIKEY] ${req.method} ${req.path} - Authorization header: ${authHeader ? authHeader.substring(0, 50) + '...' : 'MISSING'}`);
    
    if (!authHeader || !authHeader.startsWith('APIKEY ')) {
        console.log(`[APIKEY] Rejected - Invalid or missing APIKEY header`);
        return res.status(401).json(buildError('AUTHORIZATION', 'API_KEY_INVALID'));
    }
    
    const apiKey = authHeader.slice(7);
    
    // Only keys this server issued (POST /api-key; kept in the database, so
    // they survive restarts) are accepted.
    const stored = apiKey ? db.getGuestApiKey(apiKey) : null;
    if (!stored) {
        return res.status(401).json(buildError('AUTHORIZATION', 'API_KEY_INVALID'));
    }

    if (new Date(stored.expiresAt) < new Date()) {
        // Refresh expired key instead of rejecting
        db.storeGuestApiKey(apiKey, 24 * 60 * 60);
    }
    
    db.incrementApiKeyRequestCount(apiKey);
    next();
}

// =============================================================================
// BEARER Token Authentication Middleware
// =============================================================================

function authenticateBearer(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('BEARER ')) {
        return res.status(401).json(buildError('AUTHORIZATION', 'ACCESS_TOKEN_NOT_FOUND'));
    }
    
    const accessToken = authHeader.slice(7);
    const stored = db.getGuestToken(accessToken);
    
    if (!stored) {
        return res.status(401).json(buildError('AUTHORIZATION', 'ACCESS_TOKEN_NOT_FOUND'));
    }
    
    if (new Date(stored.expiresAt) < new Date()) {
        db.deleteGuestToken(accessToken);
        return res.status(401).json(buildError('AUTHORIZATION', 'AUTHORIZATION_INVALID_OR_EXPIRED_TOKEN'));
    }
    
    // Attach SWID to request for route handlers
    req.guestSwid = stored.swid;
    next();
}

// =============================================================================
// API Key Endpoint
// =============================================================================

/**
 * POST /jgc/v5/client/:clientId/api-key
 * 
 * Get a new API key for making authenticated requests.
 * No authentication required.
 * Returns API key in response header.
 */
router.post('/jgc/v5/client/:clientId/api-key', apiKeyLimit, (req, res) => {
    // START FIX: Use hardcoded reference key to ensure client acceptance
    // The client may have strict validation on key format/length
    // This key is from the reference Java implementation (APIKey.java)
    const apiKey = "aqnA9p/GHYcMJnHGPld3WUYS6xVbbkaizQIgUOXxUTV1ty0kGcIvQkRHMBiO89jAF+h6Bp6jWCj0KDdy71nsYSAhDpDV/5Y9AYDhQ/2efdB5XCWilW5q2g==";
    
    // Store API key with 24-hour expiry
    db.storeGuestApiKey(apiKey, 24 * 60 * 60);
    
    // Return API key in header (as expected by client)
    // Set both lowercase and uppercase to cover all bases
    res.setHeader('api-key', apiKey);
    res.setHeader('API-KEY', apiKey); 
    
    // Explicitly expose headers for CORS/WebView contexts
    res.setHeader('Access-Control-Expose-Headers', 'api-key, API-KEY');
    
    // Match reference implementation response body strict structure
    res.json({
        data: null,
        error: null
    });
});

// =============================================================================
// Authentication Endpoints
// =============================================================================

/**
 * POST /jgc/v5/client/:clientId/guest/login
 * 
 * Log in with email/username and password.
 * Requires APIKEY authentication.
 * Query params: expand=profile,displayName,marketing
 */
router.post('/jgc/v5/client/:clientId/guest/login', loginLimit, authenticateApiKey, async (req, res) => {
    try {
        // Never log the body: it carries the plaintext password.
        console.log(`[LOGIN] Login attempt for loginValue: ${JSON.stringify(req.body?.loginValue ?? null)}`);
        
        const { loginValue, password } = req.body;
        
        if (!loginValue || !password) {
            console.log(`[LOGIN] Missing loginValue or password`);
            return res.status(400).json(buildError('LOGIN', 'INVALID_CREDENTIALS', 'loginValue'));
        }
        
        // Login should not implicitly create accounts.
        // New accounts should be created via /guest/register.
        // If an account doesn't exist, return INVALID_CREDENTIALS so the client
        // can present the proper error instead of continuing into a broken flow.
        console.log(`[LOGIN] Looking up player by displayName: ${loginValue}`);
        const playerInfo = db.getPlayerByDisplayName(loginValue);
        console.log(`[LOGIN] Player lookup result:`, JSON.stringify(playerInfo));
        
        if (!playerInfo) {
            console.log(`[LOGIN] Player not found for displayName: ${loginValue}`);
            // Use 400 (not 401) because the CPI client tends to treat 401 as a generic
            // account/service failure, which results in a confusing popup.
            return res
                .status(400)
                .json(buildError('LOGIN', 'INVALID_CREDENTIALS', 'password', 'Invalid username or password'));
        }

        // Use the existing SWID from the database - this is critical!
        // If we generate a new SWID, the player will lose access to their data.
        const swid = playerInfo.swid;
        console.log(`[LOGIN] Found SWID: ${swid}`);
    
        const attempt = accountFails.begin(swid, clientAddress(req));
        if (!attempt) {
            console.log(`[LOGIN] ${loginValue} has too many failed logins; locked for now`);
            return res.status(429).json(buildError('RATE_LIMIT', 'TOO_MANY_REQUESTS'));
        }
        // Whatever path the request takes (an error included), the attempt is
        // released when the response ends; an earlier done() decides the result.
        res.on('close', () => attempt.done(false));

        // Verify password
        console.log(`[LOGIN] Getting stored password hash for SWID: ${swid}`);
        const storedHash = db.getPlayerPassword(swid);
        console.log(`[LOGIN] Stored hash exists: ${!!storedHash}`);
    
        // An account with no password can't be logged into: claiming it with
        // the first password anyone types would let anyone take it.
        // LEGACY_PASSWORD_CLAIM=1 restores that for databases from before
        // passwords existed.
        if (!storedHash) {
            if (process.env.LEGACY_PASSWORD_CLAIM !== '1') {
                attempt.done(false);
                console.log(`[LOGIN] ${loginValue} has no password; refusing (LEGACY_PASSWORD_CLAIM is off)`);
                return res
                    .status(400)
                    .json(buildError('LOGIN', 'INVALID_CREDENTIALS', 'password', 'Invalid username or password'));
            }
            attempt.done(true);
            console.log(`[LOGIN] No password set for ${loginValue}, setting it now (LEGACY_PASSWORD_CLAIM).`);
            db.setPlayerPassword(swid, await hashPassword(password));
        } else {
            console.log(`[LOGIN] Verifying password...`);
            const verified = await verifyPassword(password, storedHash);
            if (verified.upgrade) db.setPlayerPassword(swid, await hashPassword(password));
            attempt.done(verified.ok);
            if (!verified.ok) {
                console.log(`[LOGIN] Password verification FAILED for ${loginValue}`);
                return res
                    .status(400)
                    .json(buildError('LOGIN', 'INVALID_CREDENTIALS', 'password', 'Invalid username or password'));
            }
            console.log(`[LOGIN] Password verification PASSED`);
        }

        const banned = banError(swid);
        if (banned) {
            console.log(`[LOGIN] ${loginValue} is banned: ${banned.error.errors[0].code}`);
            return res.status(400).json(banned);
        }
    
        console.log(`[LOGIN] User "${loginValue}" logging in with existing SWID: ${swid}`);
        console.log(`[LOGIN] playerInfo from DB: username=${playerInfo?.username}, displayName=${playerInfo?.displayName}`);
    
        // Generate tokens
        const token = generateTokens(swid);
        
        // Store tokens in database
        db.storeGuestToken(token.access_token, 'access', swid, token.ttl);
        db.storeGuestToken(token.refresh_token, 'refresh', swid, token.refresh_ttl);
        
        const etags = generateEtags(swid, playerInfo.username);
        
        // Ensure displayName is never null or empty - use multiple fallbacks
        let finalDisplayName = playerInfo?.displayName;
        if (!finalDisplayName || finalDisplayName.trim() === '') {
            finalDisplayName = playerInfo?.username || loginValue;
        }
        if (!finalDisplayName || finalDisplayName.trim() === '') {
            finalDisplayName = `Penguin${swid.replace(/[^a-zA-Z0-9]/g, '').substring(0, 8)}`;
        }
        
        // Build response matching LogInData structure
        // IMPORTANT: proposedStatus must be 'ACCEPTED' for existing accounts
        // otherwise the client will show the "set your penguin name" prompt every login
        const responseData = {
            etag: JSON.stringify(etags),
            profile: {
                swid: swid,
                username: playerInfo?.username || loginValue,
                email: loginValue.includes('@') ? loginValue : null,
                emailVerified: true,
                firstName: null,
                lastName: null,
                middleName: null,
                parentEmail: null,
                parentEmailVerified: false,
                dateOfBirth: null,
                ageBand: 'ADULT',
                ageBandAssumed: true,
                countryCodeDetected: 'US',
                isAdultVerified: true,
                languagePreference: 'en',
                region: 'US',
                status: 'ACTIVE'
            },
            displayName: {
                displayName: finalDisplayName,
                moderatedStatusDate: new Date().toISOString(),
                proposedDisplayName: finalDisplayName,
                proposedStatus: 'ACCEPTED'
            },
            token: token,
            marketing: []
        };
    
        console.log(`[LOGIN] Sending success response for ${loginValue}`);
        res.json(buildSuccess(responseData));
    } catch (err) {
        console.error(`[LOGIN] Exception in login handler:`, err);
        res.status(500).json(buildError('LOGIN', 'INTERNAL_ERROR', null, err.message));
    }
});

/**
 * POST /jgc/v5/client/:clientId/guest/refresh-auth/:refreshToken
 * 
 * Refresh authentication tokens using a refresh token.
 * No authentication required.
 */
router.post('/jgc/v5/client/:clientId/guest/refresh-auth/:refreshToken', (req, res) => {
    const { refreshToken } = req.params;
    
    const stored = db.getGuestToken(refreshToken);
    
    if (!stored) {
        return res.status(401).json(buildError('AUTHORIZATION', 'REFRESH_TOKEN_INVALID'));
    }
    
    if (new Date(stored.expiresAt) < new Date()) {
        db.deleteGuestToken(refreshToken);
        return res.status(401).json(buildError('AUTHORIZATION', 'REFRESH_TOKEN_EXPIRED'));
    }
    
    const swid = stored.swid;

    const banned = banError(swid);
    if (banned) {
        console.log(`[REFRESH] ${swid} is banned: ${banned.error.errors[0].code}`);
        return res.status(400).json(banned);
    }
    
    // Clean up any old tokens for this SWID to prevent conflicts
    db.deleteGuestTokensBySwid(swid);
    
    // Generate new tokens
    const newToken = generateTokens(swid);
    
    // Store new tokens in database
    db.storeGuestToken(newToken.access_token, 'access', swid, newToken.ttl);
    db.storeGuestToken(newToken.refresh_token, 'refresh', swid, newToken.refresh_ttl);
    
    // Get username for ETag generation
    const playerInfo = db.getPlayerBySwid(swid);
    const etags = generateEtags(swid, playerInfo.username);
    
    // Build response matching RefreshData structure
    const responseData = {
        etag: JSON.stringify(etags),
        token: newToken
    };
    
    res.json(buildSuccess(responseData));
});

/**
 * POST /jgc/v5/client/:clientId/guest/register
 * 
 * Register a new account.
 * Requires APIKEY authentication.
 * Query params: autogenerateUsername=true, langPref=en
 */
router.post('/jgc/v5/client/:clientId/guest/register', registerLimit, authenticateApiKey, async (req, res) => {
    const { password, profile, marketing, displayName, legalAssertions } = req.body;
    const autogenerateUsername = req.query.autogenerateUsername === 'true';
    
    if (!password) {
        return res.status(400).json(buildError('REGISTER', 'PASSWORD_REQUIRED', 'password'));
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
        return res.status(400).json(buildError('REGISTER', 'PASSWORD_TOO_SHORT', 'password'));
    }
    if (password.length > MAX_PASSWORD) {
        return res.status(400).json(buildError('REGISTER', 'PASSWORD_TOO_LONG', 'password'));
    }
    
    // Both names follow the shared name rule (utils/names.ts), and names
    // other players already use (as a username or display name) are refused:
    // name lookups (friend search, moderation) would be ambiguous. Every
    // check runs on exactly the value that's stored.
    let proposed = '';
    if (displayName?.proposedDisplayName != null && displayName.proposedDisplayName !== '') {
        const c = checkName(displayName.proposedDisplayName);
        if (!c.ok) return res.status(400).json(buildError('REGISTER', c.reason === 'length' ? 'DISPLAY_NAME_INVALID_LENGTH' : 'INVALID_VALUE', 'displayName.proposedDisplayName', nameProblem(c.reason)));
        proposed = c.name;
    }
    let chosenUsername = '';
    if (!autogenerateUsername && profile?.username != null && profile.username !== '') {
        const c = checkName(profile.username);
        if (!c.ok) return res.status(400).json(buildError('REGISTER', c.reason === 'length' ? 'USERNAME_INVALID_LENGTH' : 'INVALID_VALUE', 'profile.username', nameProblem(c.reason)));
        chosenUsername = c.name;
    }
    if (proposed && db.isDisplayNameTaken(proposed, '')) {
        return res.status(400).json(buildError('REGISTER', 'INUSE_VALUE', 'displayName.proposedDisplayName', 'The display name already exists in the system.'));
    }
    if (!autogenerateUsername && chosenUsername && db.isDisplayNameTaken(chosenUsername, '')) {
        return res.status(400).json(buildError('REGISTER', 'INUSE_VALUE', 'profile.username', 'The username already exists in the system.'));
    }

    // Generate SWID for new user
    const swid = generateSwid();
    
    // Determine username
    let username;
    if (autogenerateUsername || !chosenUsername) {
        username = db.createPlayerFromSwid(swid);
    } else {
        username = chosenUsername;
        // A taken username (in any case) is refused: registering it must
        // never repoint an existing account, and its role, at a new swid.
        if (db.usernameTakenNoCase(username)) {
            return res.status(400).json(buildError('REGISTER', 'INUSE_VALUE', 'profile.username', 'The username already exists in the system.'));
        }
        db.getOrCreatePlayer(username);
        db.db.prepare(`
            INSERT INTO player_identity (swid, username, display_name)
            VALUES (?, ?, ?)
        `).run(swid, username, proposed || username);
    }
    
    // Set password
    db.setPlayerPassword(swid, await hashPassword(password));
    
    // Set display name if provided
    if (proposed) {
        db.setPlayerDisplayName(swid, proposed);
    }
    
    // Generate ETags and tokens
    const etags = generateEtags(swid, username);
    const token = generateTokens(swid);
    
    // Store tokens in database
    db.storeGuestToken(token.access_token, 'access', swid, token.ttl);
    db.storeGuestToken(token.refresh_token, 'refresh', swid, token.refresh_ttl);
    
    // Build response matching LogInData structure (register returns same as login)
    const responseData = {
        etag: JSON.stringify(etags),
        profile: {
            swid: swid,
            username: username,
            email: profile?.email || null,
            emailVerified: false,
            firstName: profile?.firstName || null,
            lastName: profile?.lastName || null,
            middleName: null,
            parentEmail: profile?.parentEmail || null,
            parentEmailVerified: false,
            dateOfBirth: null,
            ageBand: 'ADULT',
            ageBandAssumed: true,
            countryCodeDetected: 'US',
            isAdultVerified: false,
            languagePreference: profile?.languagePreference || 'en',
            region: profile?.region || 'US',
            status: 'ACTIVE'
        },
        displayName: {
            displayName: displayName?.proposedDisplayName || username,
            moderatedStatusDate: null,
            proposedDisplayName: displayName?.proposedDisplayName || null,
            proposedStatus: displayName?.proposedDisplayName ? 'PENDING' : null
        },
        token: token,
        marketing: marketing || []
    };
    
    res.json(buildSuccess(responseData));
});

// =============================================================================
// Configuration Endpoints
// =============================================================================

/**
 * GET /jgc/v5/client/:clientId/configuration/site
 * 
 * Get site configuration including age bands, marketing, and legal info.
 * No authentication required.
 * Query params: countryCode=XX
 * 
 * IMPORTANT: This returns the EXACT JSON from the reference cpi-web-service implementation.
 * The client SDK is very strict about the format.
 */
router.get('/jgc/v5/client/:clientId/configuration/site', (req, res) => {
    // Return the exact JSON string from the reference Java implementation
    // This ensures byte-for-byte compatibility with what the client expects
    // Use res.end() instead of res.send() to avoid any Express JSON processing
    res.writeHead(200, {
        'Content-Type': 'application/json;charset=utf-8',
        'Content-Length': Buffer.byteLength('{"data":{"compliance":{"defaultAgeBand":"CHILD","defaultCountryCode":"US","ageBands":{"TEEN":{"country":"US","minAge":13,"maxAge":17,"legalRequirements":{"cookiePermissions":{"FUNCTIONALITY":"ALLOWED","PERFORMANCE":"ALLOWED","STRICTLY_NECESSARY":"ALLOWED","TARGETING_ADVERTISING":"NOT_ALLOWED"},"marketingPermissions":{"LOB":"OPT_OUT","FOB":"OPT_OUT","EMAIL_NEWSLETTER":"OPT_OUT","3RD_PARTY":"NOT_ALLOWED"}},"CREATE":{"parentEmail":{"editable":"WRITE_ONCE","required":true},"gender":{"editable":"EDITABLE","required":false},"firstName":{"editable":"EDITABLE","required":true},"username":{"editable":"EDITABLE","required":true},"password":{"editable":"EDITABLE","required":true},"ageBandAssumed":{"editable":"WRITE_ONCE","required":false},"countryCodeDetected":{"editable":"EDITABLE","required":false}},"UPDATE":{"gender":{"editable":"EDITABLE","required":false},"firstName":{"editable":"EDITABLE","required":true},"username":{"editable":"EDITABLE","required":true},"password":{"editable":"EDITABLE","required":true}}},"CHILD":{"country":"US","minAge":0,"maxAge":12,"legalRequirements":{"cookiePermissions":{"FUNCTIONALITY":"ALLOWED","PERFORMANCE":"ALLOWED","STRICTLY_NECESSARY":"ALLOWED","TARGETING_ADVERTISING":"NOT_ALLOWED"},"marketingPermissions":{"LOB":"NOT_ALLOWED","FOB":"NOT_ALLOWED","EMAIL_NEWSLETTER":"NOT_ALLOWED","3RD_PARTY":"NOT_ALLOWED"}},"CREATE":{"parentEmail":{"editable":"WRITE_ONCE","required":true},"firstName":{"editable":"EDITABLE","required":true},"username":{"editable":"EDITABLE","required":true},"password":{"editable":"EDITABLE","required":true},"ageBandAssumed":{"editable":"WRITE_ONCE","required":false},"countryCodeDetected":{"editable":"EDITABLE","required":false}},"UPDATE":{"parentEmail":{"editable":"WRITE_ONCE","required":true},"firstName":{"editable":"EDITABLE","required":true},"username":{"editable":"EDITABLE","required":true},"password":{"editable":"EDITABLE","required":true}}},"ADULT":{"country":"US","minAge":18,"maxAge":200,"legalRequirements":{"cookiePermissions":{"FUNCTIONALITY":"ALLOWED","PERFORMANCE":"ALLOWED","STRICTLY_NECESSARY":"ALLOWED","TARGETING_ADVERTISING":"OPT_OUT"},"marketingPermissions":{"LOB":"OPT_OUT","FOB":"OPT_OUT","EMAIL_NEWSLETTER":"OPT_OUT","3RD_PARTY":"OPT_IN"}},"CREATE":{"parentEmail":{"editable":"WRITE_ONCE","required":true},"gender":{"editable":"EDITABLE","required":false},"firstName":{"editable":"EDITABLE","required":true},"username":{"editable":"EDITABLE","required":true},"password":{"editable":"EDITABLE","required":true},"ageBandAssumed":{"editable":"WRITE_ONCE","required":false},"countryCodeDetected":{"editable":"EDITABLE","required":false}},"UPDATE":{"gender":{"editable":"EDITABLE","required":false},"firstName":{"editable":"EDITABLE","required":true},"username":{"editable":"EDITABLE","required":true},"password":{"editable":"EDITABLE","required":true}}}},"countries":["AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR","AS","AT","AU","AW","AX","AZ","BA","BB","BD","BE","BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ","BR","BS","BT","BV","BW","BY","BZ","CA","CC","CD","CF","CG","CH","CI","CK","CL","CM","CN","CO","CR","CV","CW","CX","CY","CZ","DE","DJ","DK","DM","DO","DZ","EC","EE","EG","EH","ER","ES","ET","FI","FJ","FK","FM","FO","FR","GA","GB","GD","GE","GF","GG","GH","GI","GL","GM","GN","GP","GQ","GR","GS","GT","GU","GW","GY","HK","HM","HN","HR","HT","HU","ID","IE","IL","IM","IN","IO","IQ","IS","IT","JE","JM","JO","JP","KE","KG","KH","KI","KM","KN","KR","KW","KY","KZ","LA","LB","LC","LI","LK","LR","LS","LT","LU","LV","LY","MA","MC","MD","ME","MF","MG","MH","MK","ML","MM","MN","MO","MP","MQ","MR","MS","MT","MU","MV","MW","MX","MY","MZ","NA","NC","NE","NF","NG","NI","NL","NO","NP","NR","NU","NZ","OM","PA","PE","PF","PG","PH","PK","PL","PM","PN","PR","PS","PT","PW","PY","QA","RE","RO","RS","RU","RW","SA","SB","SC","SE","SG","SH","SI","SJ","SK","SL","SM","SN","SO","SR","SS","ST","SV","SX","SZ","TC","TD","TF","TG","TH","TJ","TK","TL","TM","TN","TO","TR","TT","TV","TW","TZ","UA","UG","UK","UM","US","UY","UZ","VA","VC","VE","VG","VI","VN","VU","WF","WS","XK","YE","YT","ZA","ZM","ZW"],"embargoedCountries":["CU","IR","KP","SD","SY"]},"clientInfo":{"s2-namespace":null,"s2-domain":null,"carbonDomain":null,"unid":{"enabled":false,"siteClassification":"PK"},"recaptchaSiteKey":"6LfyKw4UAAAAAMwlnUwQavp8PTXQwCan02J5h-aR"},"recovery":null,"enhancedLogin":{"allowMobileLogin":{"enabled":false}},"unid":null,"epcenabled":true,"adultVerification":{"fields":{"firstName":{"required":true},"lastName":{"required":true},"ssn":{"required":false},"address":{"postalCode":{"required":true},"addressLine1":{"required":true}}}},"marketing":{"ADULT":{"CREATE":{"WDIGFamilySites":{"code":"WDIGFamilySites","type":"FOB","displayCheckbox":false,"order":1,"checked":true}},"UPDATE":{"WDIGFamilySites":{"code":"WDIGFamilySites","type":"FOB","displayCheckbox":false,"order":1,"checked":true}},"PARTIAL":{"WDIGFamilySites":{"code":"WDIGFamilySites","type":"FOB","displayCheckbox":false,"order":1,"checked":true}}},"TEEN":{"CREATE":{"WDIGFamilySites":{"code":"WDIGFamilySites","type":"FOB","displayCheckbox":false,"order":1,"checked":true}},"UPDATE":{"WDIGFamilySites":{"code":"WDIGFamilySites","type":"FOB","displayCheckbox":false,"order":1,"checked":true}},"PARTIAL":{"WDIGFamilySites":{"code":"WDIGFamilySites","type":"FOB","displayCheckbox":false,"order":1,"checked":true}}},"CHILD":{"CREATE":{},"UPDATE":{},"PARTIAL":{}}},"newsletters":{"ADULT":{},"TEEN":{},"CHILD":{}},"legal":{"ADULT":{"documents":{"GTOU":{"displayCheckbox":false,"displayStyle":"separate","type":"tou"},"ppV2":{"displayCheckbox":false,"displayStyle":"separate","type":"privacy"}},"documentTypeOrder":["combined","tou","privacy","cookie"],"CREATE":[{"key":"gtou_ppv2_proxy","displayCheckbox":false,"type":"grouping","groupingRule":"GENERIC","sortingTag":"tou"}]},"TEEN":{"documents":{"GTOU":{"displayCheckbox":false,"displayStyle":"separate","type":"tou"},"ppV2":{"displayCheckbox":false,"displayStyle":"separate","type":"privacy"}},"documentTypeOrder":["combined","tou","privacy","cookie"],"CREATE":[{"key":"gtou_ppv2_proxy","displayCheckbox":false,"type":"grouping","groupingRule":"GENERIC","sortingTag":"tou"}]},"CHILD":{"documents":{"GTOU":{"displayCheckbox":false,"displayStyle":"separate","type":"tou"},"ppV2":{"displayCheckbox":false,"displayStyle":"separate","type":"privacy"}},"documentTypeOrder":["combined","tou","privacy","cookie"],"CREATE":[{"key":"gtou_ppv2_proxy","displayCheckbox":false,"type":"grouping","groupingRule":"GENERIC","sortingTag":"tou"}]}},"displayName":{"suffixLength":10,"display":{"default":{"visible":true},"create":{"visible":true},"update":{"visible":true},"login":{"visible":true}},"enabled":true,"generationPrefix":"CP","moderation":true},"uiConfig":{"brandedExperience":false,"adultAudience":false,"audience":"PK","showDOB":false,"ssoBLUECookieFallback":false,"inlineLabels":true,"disableDOBCookie":false,"passwordConfirmation":false,"passwordUpdate":true,"passwordRulesValidate":true,"autoGenerateUsername":true,"enableDeleteProfile":true,"localizedNameOrder":false,"defaultAddressFieldOrder":"US","geoLocationAddressFieldOrder":true,"blueCookieAllowedReferrers":[],"genderDefault":null,"useGenderRadioButtons":false,"oneClickAccountCreation":false,"pronunciationName":false,"features":{"enableDeactivateAccount":true,"createInterstitial":{"enabled":true,"carousel":{"enabled":true,"logoCollection":["babble","disney-interactive","disney-junior","disney-movie-rewards","disney-movies-anywhere","disney-stores","disney-weddings","disney-xd","infinity","parks","radio-disney","story-central"]}},"valuePropositions":{"enabled":false,"primary":false,"secondary":false,"imageName":null,"imageAltText":null},"inputMask":{"dateOfBirth":true},"productLogo":{"enabled":false,"imageName":null,"imageAltText":null}},"touchId":{"enabled":false},"isCastMember":{"contexts":[{"enabled":false,"context":"CREATE"}]}},"accountMapping":{"AM-XBOX-LIVE":{"enabled":false,"clientId":"","clientSecretEncrypted":null,"applicationFriendlyName":null,"autoLogin":null,"scope":null,"formMode":null,"applicationId":null,"applicationName":null,"cookiePolicy":null,"sandboxId":"","deauthUrl":null},"AM-STEAM":{"enabled":false,"clientId":null,"clientSecretEncrypted":null,"applicationFriendlyName":null,"autoLogin":null,"scope":null,"formMode":null,"applicationId":null,"applicationName":null,"cookiePolicy":null,"sandboxId":null,"deauthUrl":null},"AM-FACEBOOK":{"enabled":false,"clientId":null,"clientSecretEncrypted":null,"applicationFriendlyName":null,"autoLogin":false,"scope":"offline_access,email,user_birthday,user_location","formMode":"fb-full","applicationId":null,"applicationName":null,"cookiePolicy":null,"sandboxId":null,"deauthUrl":null},"AM-NINTENDO-NETWORK":{"enabled":false,"clientId":"","clientSecretEncrypted":null,"applicationFriendlyName":null,"autoLogin":null,"scope":null,"formMode":null,"applicationId":null,"applicationName":null,"cookiePolicy":null,"sandboxId":null,"deauthUrl":null},"AM-PLAYSTATION-NETWORK":{"enabled":false,"clientId":"","clientSecretEncrypted":null,"applicationFriendlyName":null,"autoLogin":null,"scope":null,"formMode":null,"applicationId":null,"applicationName":null,"cookiePolicy":null,"sandboxId":null,"deauthUrl":null},"AM-GOOGLE":{"enabled":false,"clientId":null,"clientSecretEncrypted":null,"applicationFriendlyName":null,"autoLogin":null,"scope":null,"formMode":null,"applicationId":null,"applicationName":null,"cookiePolicy":"http://go.com","sandboxId":null,"deauthUrl":null}},"entitlements":null,"gating":{"globalGates":null,"ageBandGates":{"TEEN":{"LOGIN":null,"CREATE":null,"UPDATE":null},"CHILD":{"LOGIN":null,"CREATE":null,"UPDATE":null},"ADULT":{"LOGIN":null,"CREATE":null,"UPDATE":null}}},"activityPermissions":{"CHILD":[{"activityCode":"INFINITY_CHAT"},{"activityCode":"DTSS-TEST-UGC_SHARE"},{"activityCode":"PIGGYBANK-UGC"},{"activityCode":"MIX_TRUSTEDFRIENDSCOMMUNICATIONS"},{"activityCode":"DTSS-TEST-PERSONALIZATION"},{"activityCode":"DTSS-GUIDED-CHAT"},{"activityCode":"DTSS-TEST-LOCATION"},{"activityCode":"MIX_PUSHNOTIFICATIONS"},{"activityCode":"DTSS-TEST-UGC_CREATE_UPDATE"},{"activityCode":"IN-FORUMS-POST"},{"activityCode":"DTSS-TEST-CHAT"},{"activityCode":"INFINITY_NEWSLETTER"},{"activityCode":"DTSS-TEST-NEWSLETTER"}],"TEEN":[],"ADULT":[]},"metadata":{"version":5,"build":"7.2.91"}},"error":null}', 'utf8')
    });
    res.end('{"data":{"compliance":{"defaultAgeBand":"CHILD","defaultCountryCode":"US","ageBands":{"TEEN":{"country":"US","minAge":13,"maxAge":17,"legalRequirements":{"cookiePermissions":{"FUNCTIONALITY":"ALLOWED","PERFORMANCE":"ALLOWED","STRICTLY_NECESSARY":"ALLOWED","TARGETING_ADVERTISING":"NOT_ALLOWED"},"marketingPermissions":{"LOB":"OPT_OUT","FOB":"OPT_OUT","EMAIL_NEWSLETTER":"OPT_OUT","3RD_PARTY":"NOT_ALLOWED"}},"CREATE":{"parentEmail":{"editable":"WRITE_ONCE","required":true},"gender":{"editable":"EDITABLE","required":false},"firstName":{"editable":"EDITABLE","required":true},"username":{"editable":"EDITABLE","required":true},"password":{"editable":"EDITABLE","required":true},"ageBandAssumed":{"editable":"WRITE_ONCE","required":false},"countryCodeDetected":{"editable":"EDITABLE","required":false}},"UPDATE":{"gender":{"editable":"EDITABLE","required":false},"firstName":{"editable":"EDITABLE","required":true},"username":{"editable":"EDITABLE","required":true},"password":{"editable":"EDITABLE","required":true}}},"CHILD":{"country":"US","minAge":0,"maxAge":12,"legalRequirements":{"cookiePermissions":{"FUNCTIONALITY":"ALLOWED","PERFORMANCE":"ALLOWED","STRICTLY_NECESSARY":"ALLOWED","TARGETING_ADVERTISING":"NOT_ALLOWED"},"marketingPermissions":{"LOB":"NOT_ALLOWED","FOB":"NOT_ALLOWED","EMAIL_NEWSLETTER":"NOT_ALLOWED","3RD_PARTY":"NOT_ALLOWED"}},"CREATE":{"parentEmail":{"editable":"WRITE_ONCE","required":true},"firstName":{"editable":"EDITABLE","required":true},"username":{"editable":"EDITABLE","required":true},"password":{"editable":"EDITABLE","required":true},"ageBandAssumed":{"editable":"WRITE_ONCE","required":false},"countryCodeDetected":{"editable":"EDITABLE","required":false}},"UPDATE":{"parentEmail":{"editable":"WRITE_ONCE","required":true},"firstName":{"editable":"EDITABLE","required":true},"username":{"editable":"EDITABLE","required":true},"password":{"editable":"EDITABLE","required":true}}},"ADULT":{"country":"US","minAge":18,"maxAge":200,"legalRequirements":{"cookiePermissions":{"FUNCTIONALITY":"ALLOWED","PERFORMANCE":"ALLOWED","STRICTLY_NECESSARY":"ALLOWED","TARGETING_ADVERTISING":"OPT_OUT"},"marketingPermissions":{"LOB":"OPT_OUT","FOB":"OPT_OUT","EMAIL_NEWSLETTER":"OPT_OUT","3RD_PARTY":"OPT_IN"}},"CREATE":{"parentEmail":{"editable":"WRITE_ONCE","required":true},"gender":{"editable":"EDITABLE","required":false},"firstName":{"editable":"EDITABLE","required":true},"username":{"editable":"EDITABLE","required":true},"password":{"editable":"EDITABLE","required":true},"ageBandAssumed":{"editable":"WRITE_ONCE","required":false},"countryCodeDetected":{"editable":"EDITABLE","required":false}},"UPDATE":{"gender":{"editable":"EDITABLE","required":false},"firstName":{"editable":"EDITABLE","required":true},"username":{"editable":"EDITABLE","required":true},"password":{"editable":"EDITABLE","required":true}}}},"countries":["AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR","AS","AT","AU","AW","AX","AZ","BA","BB","BD","BE","BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ","BR","BS","BT","BV","BW","BY","BZ","CA","CC","CD","CF","CG","CH","CI","CK","CL","CM","CN","CO","CR","CV","CW","CX","CY","CZ","DE","DJ","DK","DM","DO","DZ","EC","EE","EG","EH","ER","ES","ET","FI","FJ","FK","FM","FO","FR","GA","GB","GD","GE","GF","GG","GH","GI","GL","GM","GN","GP","GQ","GR","GS","GT","GU","GW","GY","HK","HM","HN","HR","HT","HU","ID","IE","IL","IM","IN","IO","IQ","IS","IT","JE","JM","JO","JP","KE","KG","KH","KI","KM","KN","KR","KW","KY","KZ","LA","LB","LC","LI","LK","LR","LS","LT","LU","LV","LY","MA","MC","MD","ME","MF","MG","MH","MK","ML","MM","MN","MO","MP","MQ","MR","MS","MT","MU","MV","MW","MX","MY","MZ","NA","NC","NE","NF","NG","NI","NL","NO","NP","NR","NU","NZ","OM","PA","PE","PF","PG","PH","PK","PL","PM","PN","PR","PS","PT","PW","PY","QA","RE","RO","RS","RU","RW","SA","SB","SC","SE","SG","SH","SI","SJ","SK","SL","SM","SN","SO","SR","SS","ST","SV","SX","SZ","TC","TD","TF","TG","TH","TJ","TK","TL","TM","TN","TO","TR","TT","TV","TW","TZ","UA","UG","UK","UM","US","UY","UZ","VA","VC","VE","VG","VI","VN","VU","WF","WS","XK","YE","YT","ZA","ZM","ZW"],"embargoedCountries":["CU","IR","KP","SD","SY"]},"clientInfo":{"s2-namespace":null,"s2-domain":null,"carbonDomain":null,"unid":{"enabled":false,"siteClassification":"PK"},"recaptchaSiteKey":"6LfyKw4UAAAAAMwlnUwQavp8PTXQwCan02J5h-aR"},"recovery":null,"enhancedLogin":{"allowMobileLogin":{"enabled":false}},"unid":null,"epcenabled":true,"adultVerification":{"fields":{"firstName":{"required":true},"lastName":{"required":true},"ssn":{"required":false},"address":{"postalCode":{"required":true},"addressLine1":{"required":true}}}},"marketing":{"ADULT":{"CREATE":{"WDIGFamilySites":{"code":"WDIGFamilySites","type":"FOB","displayCheckbox":false,"order":1,"checked":true}},"UPDATE":{"WDIGFamilySites":{"code":"WDIGFamilySites","type":"FOB","displayCheckbox":false,"order":1,"checked":true}},"PARTIAL":{"WDIGFamilySites":{"code":"WDIGFamilySites","type":"FOB","displayCheckbox":false,"order":1,"checked":true}}},"TEEN":{"CREATE":{"WDIGFamilySites":{"code":"WDIGFamilySites","type":"FOB","displayCheckbox":false,"order":1,"checked":true}},"UPDATE":{"WDIGFamilySites":{"code":"WDIGFamilySites","type":"FOB","displayCheckbox":false,"order":1,"checked":true}},"PARTIAL":{"WDIGFamilySites":{"code":"WDIGFamilySites","type":"FOB","displayCheckbox":false,"order":1,"checked":true}}},"CHILD":{"CREATE":{},"UPDATE":{},"PARTIAL":{}}},"newsletters":{"ADULT":{},"TEEN":{},"CHILD":{}},"legal":{"ADULT":{"documents":{"GTOU":{"displayCheckbox":false,"displayStyle":"separate","type":"tou"},"ppV2":{"displayCheckbox":false,"displayStyle":"separate","type":"privacy"}},"documentTypeOrder":["combined","tou","privacy","cookie"],"CREATE":[{"key":"gtou_ppv2_proxy","displayCheckbox":false,"type":"grouping","groupingRule":"GENERIC","sortingTag":"tou"}]},"TEEN":{"documents":{"GTOU":{"displayCheckbox":false,"displayStyle":"separate","type":"tou"},"ppV2":{"displayCheckbox":false,"displayStyle":"separate","type":"privacy"}},"documentTypeOrder":["combined","tou","privacy","cookie"],"CREATE":[{"key":"gtou_ppv2_proxy","displayCheckbox":false,"type":"grouping","groupingRule":"GENERIC","sortingTag":"tou"}]},"CHILD":{"documents":{"GTOU":{"displayCheckbox":false,"displayStyle":"separate","type":"tou"},"ppV2":{"displayCheckbox":false,"displayStyle":"separate","type":"privacy"}},"documentTypeOrder":["combined","tou","privacy","cookie"],"CREATE":[{"key":"gtou_ppv2_proxy","displayCheckbox":false,"type":"grouping","groupingRule":"GENERIC","sortingTag":"tou"}]}},"displayName":{"suffixLength":10,"display":{"default":{"visible":true},"create":{"visible":true},"update":{"visible":true},"login":{"visible":true}},"enabled":true,"generationPrefix":"CP","moderation":true},"uiConfig":{"brandedExperience":false,"adultAudience":false,"audience":"PK","showDOB":false,"ssoBLUECookieFallback":false,"inlineLabels":true,"disableDOBCookie":false,"passwordConfirmation":false,"passwordUpdate":true,"passwordRulesValidate":true,"autoGenerateUsername":true,"enableDeleteProfile":true,"localizedNameOrder":false,"defaultAddressFieldOrder":"US","geoLocationAddressFieldOrder":true,"blueCookieAllowedReferrers":[],"genderDefault":null,"useGenderRadioButtons":false,"oneClickAccountCreation":false,"pronunciationName":false,"features":{"enableDeactivateAccount":true,"createInterstitial":{"enabled":true,"carousel":{"enabled":true,"logoCollection":["babble","disney-interactive","disney-junior","disney-movie-rewards","disney-movies-anywhere","disney-stores","disney-weddings","disney-xd","infinity","parks","radio-disney","story-central"]}},"valuePropositions":{"enabled":false,"primary":false,"secondary":false,"imageName":null,"imageAltText":null},"inputMask":{"dateOfBirth":true},"productLogo":{"enabled":false,"imageName":null,"imageAltText":null}},"touchId":{"enabled":false},"isCastMember":{"contexts":[{"enabled":false,"context":"CREATE"}]}},"accountMapping":{"AM-XBOX-LIVE":{"enabled":false,"clientId":"","clientSecretEncrypted":null,"applicationFriendlyName":null,"autoLogin":null,"scope":null,"formMode":null,"applicationId":null,"applicationName":null,"cookiePolicy":null,"sandboxId":"","deauthUrl":null},"AM-STEAM":{"enabled":false,"clientId":null,"clientSecretEncrypted":null,"applicationFriendlyName":null,"autoLogin":null,"scope":null,"formMode":null,"applicationId":null,"applicationName":null,"cookiePolicy":null,"sandboxId":null,"deauthUrl":null},"AM-FACEBOOK":{"enabled":false,"clientId":null,"clientSecretEncrypted":null,"applicationFriendlyName":null,"autoLogin":false,"scope":"offline_access,email,user_birthday,user_location","formMode":"fb-full","applicationId":null,"applicationName":null,"cookiePolicy":null,"sandboxId":null,"deauthUrl":null},"AM-NINTENDO-NETWORK":{"enabled":false,"clientId":"","clientSecretEncrypted":null,"applicationFriendlyName":null,"autoLogin":null,"scope":null,"formMode":null,"applicationId":null,"applicationName":null,"cookiePolicy":null,"sandboxId":null,"deauthUrl":null},"AM-PLAYSTATION-NETWORK":{"enabled":false,"clientId":"","clientSecretEncrypted":null,"applicationFriendlyName":null,"autoLogin":null,"scope":null,"formMode":null,"applicationId":null,"applicationName":null,"cookiePolicy":null,"sandboxId":null,"deauthUrl":null},"AM-GOOGLE":{"enabled":false,"clientId":null,"clientSecretEncrypted":null,"applicationFriendlyName":null,"autoLogin":null,"scope":null,"formMode":null,"applicationId":null,"applicationName":null,"cookiePolicy":"http://go.com","sandboxId":null,"deauthUrl":null}},"entitlements":null,"gating":{"globalGates":null,"ageBandGates":{"TEEN":{"LOGIN":null,"CREATE":null,"UPDATE":null},"CHILD":{"LOGIN":null,"CREATE":null,"UPDATE":null},"ADULT":{"LOGIN":null,"CREATE":null,"UPDATE":null}}},"activityPermissions":{"CHILD":[{"activityCode":"INFINITY_CHAT"},{"activityCode":"DTSS-TEST-UGC_SHARE"},{"activityCode":"PIGGYBANK-UGC"},{"activityCode":"MIX_TRUSTEDFRIENDSCOMMUNICATIONS"},{"activityCode":"DTSS-TEST-PERSONALIZATION"},{"activityCode":"DTSS-GUIDED-CHAT"},{"activityCode":"DTSS-TEST-LOCATION"},{"activityCode":"MIX_PUSHNOTIFICATIONS"},{"activityCode":"DTSS-TEST-UGC_CREATE_UPDATE"},{"activityCode":"IN-FORUMS-POST"},{"activityCode":"DTSS-TEST-CHAT"},{"activityCode":"INFINITY_NEWSLETTER"},{"activityCode":"DTSS-TEST-NEWSLETTER"}],"TEEN":[],"ADULT":[]},"metadata":{"version":5,"build":"7.2.91"}},"error":null}');
});

// =============================================================================
// Validation Endpoints
// =============================================================================

/**
 * POST /jgc/v5/client/:clientId/validate
 * 
 * Validate registration fields (email, displayName, username, password).
 * Requires APIKEY authentication.
 * 
 * NOTE: The CPI client sends a dummy username when validating passwords:
 * "K4fR0VfK4MToQslVupGkGvAKFqw3HBXOfkpXalYUX1Kv5kbKL08MNxk3W2gfjk0"
 * We must skip username validation when this placeholder is detected.
 */
router.post('/jgc/v5/client/:clientId/validate', authenticateApiKey, (req, res) => {
    const { email, displayName, username, password } = req.body;
    
    const errors = [];
    
    // Known dummy username used by CPI client for password-only validation
    const DUMMY_USERNAME = 'K4fR0VfK4MToQslVupGkGvAKFqw3HBXOfkpXalYUX1Kv5kbKL08MNxk3W2gfjk0';
    const isDummyUsername = username === DUMMY_USERNAME;
    
    // Validate email if provided
    if (email) {
        if (!email.includes('@') || email.length < 5) {
            errors.push({
                code: 'EMAIL_INVALID',
                inputName: 'email',
                developerMessage: 'Email format is invalid'
            });
        }
    }
    
    // Validate display name if provided
    if (displayName) {
        const c = checkName(displayName);
        if (!c.ok && c.reason !== 'length') {
            errors.push({ code: 'INVALID_VALUE', inputName: 'displayName', developerMessage: nameProblem(c.reason) });
        }
        if (displayName.length < 3 || displayName.length > 20) {
            errors.push({
                code: 'DISPLAY_NAME_INVALID_LENGTH',
                inputName: 'displayName',
                developerMessage: 'Display name must be between 3 and 20 characters'
            });
        }
        // Check for profanity/blocked words (simplified)
        const blocked = ['admin', 'moderator', 'disney'];
        if (blocked.some(word => displayName.toLowerCase().includes(word))) {
            errors.push({
                code: 'DISPLAY_NAME_MODERATED',
                inputName: 'displayName',
                developerMessage: 'Display name contains blocked words'
            });
        }
        // Check if display name is already taken
        const existingDisplayName = db.getPlayerByDisplayName(displayName);
        if (existingDisplayName) {
            console.log(`[VALIDATE] Display name "${displayName}" already exists (SWID: ${existingDisplayName.swid})`);
            errors.push({
                code: 'INUSE_VALUE',
                inputName: 'displayName.proposedDisplayName',
                developerMessage: 'The display name already exists in the system.'
            });
        }
    }
    
    // Validate username if provided (skip if it's the dummy placeholder)
    if (username && !isDummyUsername) {
        const c = checkName(username);
        if (!c.ok && c.reason !== 'length') {
            errors.push({ code: 'INVALID_VALUE', inputName: 'username', developerMessage: nameProblem(c.reason) });
        }
        if (username.length < 3 || username.length > 20) {
            errors.push({
                code: 'USERNAME_INVALID_LENGTH',
                inputName: 'username',
                developerMessage: 'Username must be between 3 and 20 characters'
            });
        }
        // Check if username is already taken
        const existingUsername = db.getPlayerByDisplayName(username);
        if (existingUsername) {
            console.log(`[VALIDATE] Username "${username}" already exists (SWID: ${existingUsername.swid})`);
            errors.push({
                code: 'INUSE_VALUE',
                inputName: 'profile.username',
                developerMessage: 'The username already exists in the system.'
            });
        }
    }
    
    // Validate password if provided
    if (password) {
        if (password.length < 6) {
            errors.push({
                code: 'PASSWORD_TOO_SHORT',
                inputName: 'password',
                developerMessage: 'Password must be at least 6 characters'
            });
        }
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            error: {
                keyCategory: 'VALIDATION',
                errors: errors
            }
        });
    }
    
    // Validation passed - ValidateResponse expects { error: null } on success
    res.json({ error: null });
});

// =============================================================================
// Profile Endpoints
// =============================================================================

/**
 * GET /jgc/v5/client/:clientId/guest/:swid
 * 
 * Get guest profile.
 * Requires BEARER authentication.
 */
router.get('/jgc/v5/client/:clientId/guest/:swid', authenticateBearer, (req, res) => {
    const { swid } = req.params;
    
    console.log(`[PROFILE] GET guest profile for SWID: ${swid}`);
    
    // Verify the requesting user is accessing their own profile
    if (swid !== req.guestSwid) {
        console.log(`[PROFILE] Access denied - requesting SWID ${req.guestSwid} != ${swid}`);
        return res.status(403).json(buildError('AUTHORIZATION', 'ACCESS_DENIED'));
    }
    
    const playerInfo = db.getPlayerBySwid(swid);
    
    if (!playerInfo) {
        console.log(`[PROFILE] Player not found for SWID: ${swid}`);
        return res.status(404).json(buildError('PROFILE', 'PROFILE_NOT_FOUND'));
    }
    
    console.log(`[PROFILE] Found player: username=${playerInfo.username}, displayName=${playerInfo.displayName}`);
    
    // Ensure displayName is never null or empty - use multiple fallbacks
    let displayName = playerInfo.displayName;
    if (!displayName || displayName.trim() === '') {
        displayName = playerInfo.username;
    }
    if (!displayName || displayName.trim() === '') {
        displayName = `Penguin${swid.replace(/[^a-zA-Z0-9]/g, '').substring(0, 8)}`;
    }
    
    const etags = generateEtags(swid, playerInfo.username);
    
    // Build response matching ProfileData structure
    // IMPORTANT: proposedStatus must be 'ACCEPTED' for existing accounts
    // otherwise the client will show the "set your penguin name" prompt every login
    const responseData = {
        etag: JSON.stringify(etags),
        displayName: {
            displayName: displayName,
            moderatedStatusDate: new Date().toISOString(),
            proposedDisplayName: displayName,
            proposedStatus: 'ACCEPTED'
        },
        profile: {
            swid: swid,
            username: playerInfo.username,
            email: null,
            emailVerified: true,
            firstName: null,
            lastName: null,
            middleName: null,
            parentEmail: null,
            parentEmailVerified: false,
            dateOfBirth: null,
            ageBand: 'ADULT',
            ageBandAssumed: true,
            countryCodeDetected: 'US',
            isAdultVerified: true,
            languagePreference: 'en',
            region: 'US',
            status: 'ACTIVE'
        },
        marketing: []
    };
    
    res.json(buildSuccess(responseData));
});

/**
 * POST /jgc/v5/client/:clientId/guest/:swid
 * 
 * Update guest profile.
 * Requires BEARER authentication.
 */
router.post('/jgc/v5/client/:clientId/guest/:swid', authenticateBearer, (req, res) => {
    const { swid } = req.params;
    const { profile, displayName, marketing } = req.body;
    
    // Verify the requesting user is updating their own profile
    if (swid !== req.guestSwid) {
        return res.status(403).json(buildError('AUTHORIZATION', 'ACCESS_DENIED'));
    }
    
    const playerInfo = db.getPlayerBySwid(swid);
    
    if (!playerInfo) {
        return res.status(404).json(buildError('PROFILE', 'PROFILE_NOT_FOUND'));
    }
    
    // Update display name if provided
    if (displayName?.proposedDisplayName) {
        const c = checkName(displayName.proposedDisplayName);
        if (!c.ok) return res.status(400).json(buildError('PROFILE', c.reason === 'length' ? 'DISPLAY_NAME_INVALID_LENGTH' : 'INVALID_VALUE', 'displayName.proposedDisplayName', nameProblem(c.reason)));
    }
    if (displayName?.proposedDisplayName && !db.setPlayerDisplayName(swid, displayName.proposedDisplayName)) {
        return res.status(400).json(buildError('PROFILE', 'INUSE_VALUE', 'displayName.proposedDisplayName', 'The display name already exists in the system.'));
    }
    
    const updatedPlayer = db.getPlayerBySwid(swid);
    const etags = generateEtags(swid, updatedPlayer.username);
    
    // Ensure displayName is never null or empty - use multiple fallbacks
    let finalDisplayName = updatedPlayer.displayName;
    if (!finalDisplayName || finalDisplayName.trim() === '') {
        finalDisplayName = updatedPlayer.username;
    }
    if (!finalDisplayName || finalDisplayName.trim() === '') {
        finalDisplayName = `Penguin${swid.replace(/[^a-zA-Z0-9]/g, '').substring(0, 8)}`;
    }
    
    // Build response matching ProfileData structure
    const responseData = {
        etag: JSON.stringify(etags),
        displayName: {
            displayName: finalDisplayName,
            moderatedStatusDate: new Date().toISOString(),
            proposedDisplayName: displayName?.proposedDisplayName || finalDisplayName,
            proposedStatus: 'ACCEPTED'
        },
        profile: {
            swid: swid,
            username: updatedPlayer.username,
            email: profile?.email || null,
            emailVerified: true,
            firstName: profile?.firstName || null,
            lastName: profile?.lastName || null,
            middleName: null,
            parentEmail: profile?.parentEmail || null,
            parentEmailVerified: false,
            dateOfBirth: null,
            ageBand: 'ADULT',
            ageBandAssumed: true,
            countryCodeDetected: 'US',
            isAdultVerified: true,
            languagePreference: profile?.languagePreference || 'en',
            region: profile?.region || 'US',
            status: 'ACTIVE'
        },
        marketing: marketing || []
    };
    
    res.json(buildSuccess(responseData));
});

// =============================================================================
// Notification/Recovery Endpoints
// =============================================================================

/**
 * POST /jgc/v5/client/:clientId/notification/recover-password
 * 
 * Send password recovery email.
 * Requires APIKEY authentication.
 * Query params: langPref=en
 */
router.post('/jgc/v5/client/:clientId/notification/recover-password', authenticateApiKey, (req, res) => {
    const { email, lookupValue } = req.body;
    
    // NotificationResponse with empty broadcasts (email sent)
    res.json(buildSuccess({
        broadcasts: []
    }));
});

/**
 * POST /jgc/v5/client/:clientId/notification/recover-username
 * 
 * Send username recovery email.
 * Requires APIKEY authentication.
 * Query params: langPref=en
 */
router.post('/jgc/v5/client/:clientId/notification/recover-username', authenticateApiKey, (req, res) => {
    const { email, lookupValue } = req.body;
    
    res.json(buildSuccess({
        broadcasts: []
    }));
});

/**
 * POST /jgc/v5/client/:clientId/notification/resolve-mase
 * 
 * Resolve MASE (Minor Account Status Enforcement).
 * Requires APIKEY authentication.
 * Query params: langPref=en
 */
router.post('/jgc/v5/client/:clientId/notification/resolve-mase', authenticateApiKey, (req, res) => {
    const { email, lookupValue } = req.body;
    
    res.json(buildSuccess({
        broadcasts: []
    }));
});

/**
 * POST /jgc/v5/client/:clientId/notification/upgrade-nrt
 * 
 * Send upgrade notification for NRT (Non-Registered Teen).
 * Requires APIKEY authentication.
 * Query params: langPref=en
 */
router.post('/jgc/v5/client/:clientId/notification/upgrade-nrt', authenticateApiKey, (req, res) => {
    const { email, lookupValue } = req.body;
    
    res.json(buildSuccess({
        broadcasts: []
    }));
});

/**
 * POST /jgc/v5/client/:clientId/notification/parental-approval/:swid
 * 
 * Send parental approval email.
 * Requires BEARER authentication.
 * Query params: langPref=en
 */
router.post('/jgc/v5/client/:clientId/notification/parental-approval/:swid', authenticateBearer, (req, res) => {
    const { swid } = req.params;
    
    if (swid !== req.guestSwid) {
        return res.status(403).json(buildError('AUTHORIZATION', 'ACCESS_DENIED'));
    }
    
    res.json(buildSuccess({
        broadcasts: []
    }));
});

/**
 * POST /jgc/v5/client/:clientId/notification/email-verification
 * 
 * Send email verification email.
 * Requires BEARER authentication.
 * Query params: langPref=en
 */
router.post('/jgc/v5/client/:clientId/notification/email-verification', authenticateBearer, (req, res) => {
    res.json(buildSuccess({
        broadcasts: []
    }));
});

// =============================================================================
// Adult Verification Endpoints
// =============================================================================

/**
 * GET /jgc/v5/client/:clientId/guest/:swid/adult-verification-status
 * 
 * Get adult verification status.
 * Requires BEARER authentication.
 */
router.get('/jgc/v5/client/:clientId/guest/:swid/adult-verification-status', authenticateBearer, (req, res) => {
    const { swid } = req.params;
    
    if (swid !== req.guestSwid) {
        return res.status(403).json(buildError('AUTHORIZATION', 'ACCESS_DENIED'));
    }
    
    // Build response matching AdultVerificationStatusData structure
    // For development, assume all users are adult verified
    const responseData = {
        verified: true,
        maxAttempts: false
    };
    
    res.json(buildSuccess(responseData));
});

/**
 * POST /jgc/v5/client/:clientId/guest/:swid/adult-verification-ssn
 * 
 * Verify adult using SSN (US only).
 * Requires BEARER authentication.
 */
router.post('/jgc/v5/client/:clientId/guest/:swid/adult-verification-ssn', authenticateBearer, (req, res) => {
    const { swid } = req.params;
    const { ssn, dateOfBirth, firstName, lastName, refId, address } = req.body;
    
    if (swid !== req.guestSwid) {
        return res.status(403).json(buildError('AUTHORIZATION', 'ACCESS_DENIED'));
    }
    
    // Build response matching AdultVerificationData structure
    // For development, auto-approve verification
    const responseData = {
        applicationId: crypto.randomUUID(),
        refId: refId || crypto.randomUUID(),
        verified: true,
        maxAttempts: false,
        questions: null
    };
    
    res.json(buildSuccess(responseData));
});

/**
 * POST /jgc/v5/client/:clientId/guest/:swid/adult-verification-quiz
 * 
 * Submit adult verification quiz answers.
 * Requires BEARER authentication.
 */
router.post('/jgc/v5/client/:clientId/guest/:swid/adult-verification-quiz', authenticateBearer, (req, res) => {
    const { swid } = req.params;
    const { refId, answers } = req.body;
    
    if (swid !== req.guestSwid) {
        return res.status(403).json(buildError('AUTHORIZATION', 'ACCESS_DENIED'));
    }
    
    // Build response matching AdultVerificationQuizData structure
    // For development, auto-approve quiz
    const responseData = {
        verified: true,
        maxAttempts: false
    };
    
    res.json(buildSuccess(responseData));
});

// =============================================================================
// Guardian/Child Linking Endpoints
// =============================================================================

/**
 * GET /jgc/v5/client/:clientId/guardian/:swid/children
 * 
 * Get claimable children for a guardian.
 * Requires BEARER authentication.
 */
router.get('/jgc/v5/client/:clientId/guardian/:swid/children', authenticateBearer, (req, res) => {
    const { swid } = req.params;
    
    if (swid !== req.guestSwid) {
        return res.status(403).json(buildError('AUTHORIZATION', 'ACCESS_DENIED'));
    }
    
    // Build response matching ChildrenData structure
    // Return empty list for development
    const responseData = {
        children: []
    };
    
    res.json(buildSuccess(responseData));
});

/**
 * GET /jgc/v5/client/:clientId/guardian/:swid/children/linked
 * 
 * Get linked children for a guardian.
 * Requires BEARER authentication.
 */
router.get('/jgc/v5/client/:clientId/guardian/:swid/children/linked', authenticateBearer, (req, res) => {
    const { swid } = req.params;
    
    if (swid !== req.guestSwid) {
        return res.status(403).json(buildError('AUTHORIZATION', 'ACCESS_DENIED'));
    }
    
    // Build response matching ChildrenData structure
    const responseData = {
        children: []
    };
    
    res.json(buildSuccess(responseData));
});

/**
 * POST /jgc/v5/client/:clientId/guardian/:swid/children/child/:childSwid
 * 
 * Link a child to the guardian.
 * Requires BEARER authentication.
 */
router.post('/jgc/v5/client/:clientId/guardian/:swid/children/child/:childSwid', authenticateBearer, (req, res) => {
    const { swid, childSwid } = req.params;
    const { authZToken } = req.body;
    
    if (swid !== req.guestSwid) {
        return res.status(403).json(buildError('AUTHORIZATION', 'ACCESS_DENIED'));
    }
    
    // For development, accept the link request
    res.json({});
});

/**
 * PUT /jgc/v5/client/:clientId/guardian/:swid/children
 * 
 * Link claimable children to the guardian.
 * Requires BEARER authentication.
 */
router.put('/jgc/v5/client/:clientId/guardian/:swid/children', authenticateBearer, (req, res) => {
    const { swid } = req.params;
    const { children } = req.body;
    
    if (swid !== req.guestSwid) {
        return res.status(403).json(buildError('AUTHORIZATION', 'ACCESS_DENIED'));
    }
    
    // For development, accept the link request
    res.json({});
});

/**
 * GET /jgc/v5/client/:clientId/guardian/guardians/child/:swid
 * 
 * Get guardians for a child.
 * Requires BEARER authentication.
 */
router.get('/jgc/v5/client/:clientId/guardian/guardians/child/:swid', authenticateBearer, (req, res) => {
    const { swid } = req.params;
    
    if (swid !== req.guestSwid) {
        return res.status(403).json(buildError('AUTHORIZATION', 'ACCESS_DENIED'));
    }
    
    // Build response matching GuardiansData structure
    const responseData = {
        guardians: []
    };
    
    res.json(buildSuccess(responseData));
});

// =============================================================================
// Permission Endpoints
// =============================================================================

/**
 * POST /jgc/v5/client/:clientId/guest/activity-permission/:swid
 * 
 * Request a permission.
 * Requires BEARER authentication.
 */
router.post('/jgc/v5/client/:clientId/guest/activity-permission/:swid', authenticateBearer, (req, res) => {
    const { swid } = req.params;
    const { activityCode } = req.body;
    
    // Build response matching Permission structure
    const responseData = {
        activityCode: activityCode,
        blanketApproved: false,
        dateRequested: new Date().toISOString(),
        activityPermimssionGuid: crypto.randomUUID(),
        approvalStatus: 'PENDING',
        swid: swid
    };
    
    res.json(buildSuccess(responseData));
});

/**
 * PUT /jgc/v5/client/:clientId/guest/activity-permission/:childSwid
 * 
 * Approve a permission request (guardian action).
 * Requires BEARER authentication.
 */
router.put('/jgc/v5/client/:clientId/guest/activity-permission/:childSwid', authenticateBearer, (req, res) => {
    const { childSwid } = req.params;
    const { activityCode, blanketApproved, dateRequested, activityPermimssionGuid, approvalStatus, swid } = req.body;
    
    // Build response matching Permission structure
    const responseData = {
        activityCode: activityCode,
        blanketApproved: blanketApproved || false,
        dateRequested: dateRequested || new Date().toISOString(),
        activityPermimssionGuid: activityPermimssionGuid || crypto.randomUUID(),
        approvalStatus: 'APPROVED',
        swid: childSwid
    };
    
    res.json(buildSuccess(responseData));
});

/**
 * GET /jgc/v5/client/:clientId/guest/activity-permission/:childSwid
 * 
 * Get permissions for a child/user.
 * Requires BEARER authentication.
 */
router.get('/jgc/v5/client/:clientId/guest/activity-permission/:childSwid', authenticateBearer, (req, res) => {
    const { childSwid } = req.params;
    
    // Build response matching GetPermissionsData structure
    const responseData = {
        activityPermissions: []
    };
    
    res.json(buildSuccess(responseData));
});

export default router;
export { tokenStore, refreshStore };
