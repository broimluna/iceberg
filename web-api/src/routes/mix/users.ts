import express from "express";
import * as db from "../../database.ts";
import { authenticateMix } from "./auth.ts";
import { hashUserId, buildResponse, defaultAvatar } from "./common.ts";

const router = express.Router();

// =============================================================================
// User/Search Endpoints
// =============================================================================

/**
 * POST /users/byDisplayName
 * Get users by display name
 */
router.post('/users/byDisplayName', authenticateMix, (req, res) => {
    const { DisplayNames } = req.body;
    
    const users = [];
    if (DisplayNames && Array.isArray(DisplayNames)) {
        for (const displayName of DisplayNames) {
            const player = db.getPlayerByDisplayName(displayName);
            if (player) {
                users.push({
                    UserId: player.swid,
                    HashedUserId: hashUserId(player.swid),
                    DisplayName: player.displayName || player.username,
                    FirstName: null,
                    Avatar: defaultAvatar(player.swid),
                    Status: 'ACTIVE'
                });
            }
        }
    }
    
    res.json(buildResponse({ Users: users }));
});

/**
 * POST /users/byUserId
 * Get users by user ID
 */
router.post('/users/byUserId', authenticateMix, (req, res) => {
    const { UserIds } = req.body;
    
    const users = [];
    if (UserIds && Array.isArray(UserIds)) {
        const players = db.getPlayersBySwids(UserIds);
        for (const player of players) {
            users.push({
                UserId: player.swid,
                HashedUserId: hashUserId(player.swid),
                DisplayName: player.displayName || player.username,
                FirstName: null,
                Avatar: defaultAvatar(player.swid),
                Status: 'ACTIVE'
            });
        }
    }
    
    res.json(buildResponse({ Users: users }));
});

/**
 * POST /search/displayname
 * Search for display names
 */
router.post('/search/displayname', authenticateMix, (req, res) => {
    const { DisplayName, UserId } = req.body;
    
    console.log(`[SEARCH] Searching for display name: ${DisplayName} (requested by ${UserId})`);
    
    // Search for player by display name
    const player = db.getPlayerByDisplayName(DisplayName);
    
    console.log(`[SEARCH] Player lookup result:`, player);
    
    // Check if the found player is the same as the requesting user (can't be your own friend!)
    if (player && player.swid === UserId) {
        console.log(`[SEARCH] Player found is the requesting user themselves, returning not found`);
        const response = buildResponse({
            DisplayName: null,
            FirstName: null
        });
        res.json(response);
    } else if (player) {
        const response = buildResponse({
            DisplayName: player.displayName || player.username,
            FirstName: null,
            Avatar: defaultAvatar(player.swid)
        });
        console.log(`[SEARCH] Found player, responding with:`, JSON.stringify(response));
        res.json(response);
    } else {
        const response = buildResponse({
            DisplayName: null,
            FirstName: null
        });
        console.log(`[SEARCH] Player not found, responding with:`, JSON.stringify(response));
        res.json(response);
    }
});


// =============================================================================
// Display Name Endpoints
// =============================================================================

/**
 * PUT /displayname
 * Set display name
 */
router.put('/displayname', authenticateMix, (req, res) => {
    const { UserId, DisplayName, Language } = req.body;
    
    // Update display name in database
    db.setPlayerDisplayName(UserId, DisplayName);
    
    res.json(buildResponse({
        DisplayName: DisplayName
    }));
});

/**
 * POST /displayname/validate
 * Validate display names (batch)
 */
router.post('/displayname/validate', authenticateMix, (req, res) => {
    const { DisplayNames } = req.body;
    
    // For development, accept all display names
    // In production, filter inappropriate names
    const validNames = DisplayNames || [];
    
    res.json(buildResponse({
        DisplayNames: validNames
    }));
});

/**
 * POST /displayname/validate/v2
 * Validate single display name
 */
router.post('/displayname/validate/v2', authenticateMix, (req, res) => {
    const { DisplayName } = req.body;
    
    // Check if display name is valid
    let status = 'VALID';
    const suggestions = [];
    
    // Check for blocked words
    const blocked = ['admin', 'moderator', 'disney', 'penguin'];
    if (blocked.some(word => DisplayName?.toLowerCase().includes(word))) {
        status = 'MODERATED';
        // Generate suggestions
        for (let i = 1; i <= 3; i++) {
            suggestions.push(`${DisplayName}${Math.floor(Math.random() * 1000)}`);
        }
    }
    
    // Check length
    if (DisplayName && (DisplayName.length < 3 || DisplayName.length > 20)) {
        status = 'INVALID_LENGTH';
    }
    
    // Check if already taken
    const existing = db.getPlayerByDisplayName(DisplayName);
    if (existing) {
        status = 'TAKEN';
        for (let i = 1; i <= 3; i++) {
            suggestions.push(`${DisplayName}${Math.floor(Math.random() * 1000)}`);
        }
    }
    
    res.json(buildResponse({
        DisplayNameStatus: status,
        DisplayNames: suggestions
    }));
});


// =============================================================================
// Geolocation Endpoints
// =============================================================================

/**
 * POST /geolocation
 * Get geolocation
 */
router.post('/geolocation', authenticateMix, (req, res) => {
    const { UserId } = req.body;
    
    // Return default country code
    res.json(buildResponse({
        CountryCode: 'US'
    }));
});

// =============================================================================
// Language Endpoints
// =============================================================================

/**
 * POST /languagePreference
 * Set language preference
 */
router.post('/languagePreference', authenticateMix, (req, res) => {
    const { UserId, LanguageCode } = req.body;
    
    // Store language preference (in production, store in database)
    console.log(`[LANGUAGE] User ${UserId} set language to ${LanguageCode}`);
    
    res.json(buildResponse());
});

// =============================================================================
// Registration Endpoints (Guest/Public - No Auth Required)
// =============================================================================

/**
 * POST /registration/text
 * Get registration text
 * 
 * NOTE: This is a PUBLIC endpoint - no authentication required.
 * It's called during registration before the user has an account or token.
 * Reference: cpi-web-service/src/main/java/me/ryan/api/auth/mix/MixRegistrationText.java
 */
router.post(['/registration/text', '/mix/registration/text'], (req, res) => {
    // console.log('[MIX] POST /registration/text (public) body:', JSON.stringify(req.body));

    // Match headers from user provided snippet (emulating Google Frontend / Prod Env)
    res.removeHeader('Transfer-Encoding');
    res.set({
        "Content-Type": "application/json",
        "X-Cloud-Trace-Context": "f02d741cfb2578b7d0ff9f230429c25c",
        "Alt-Svc": 'quic=":443"; ma=2592000; v="44,43,39,35"',
        "Server": "Google Frontend",
        "Connection": "Keep-alive"
    });

    // Return hardcoded response matching the EXACT TextCode requested by client
    // The client requests "gtou_ppv2_proxy_create" which is a combined ToU + Privacy Policy text
    const responseData = {
        "Status": "OK",
        "RegistrationText": [
            {
                "TextCode": "gtou_ppv2_proxy_create",
                "Text": "By creating an account, I agree to the <a target=\"_blank\" href=\"https://disneytermsofuse.com/english/\">Terms of Use</a> and acknowledge the <a target=\"_blank\" href=\"https://privacy.thewaltdisneycompany.com/en/current-privacy-policy/\">Privacy Policy</a>."
            },
            {
                "TextCode": "WDIGFamilySites",
                "Text": "Yes! Send me Disney updates and offers."
            }
        ]
    };

    res.json(responseData);
});


// =============================================================================
// PIL Check Endpoints
// =============================================================================

/**
 * POST /pil/check
 * Check PIL status
 */
router.post('/pil/check', authenticateMix, (req, res) => {
    const { UserId, CountryCode, PersonalInformationUsage } = req.body;
    
    // PIL (Personal Information Location) check
    // For development, no adult verification required
    res.json(buildResponse({
        AdultVerificationRequired: false,
        AdultVerificationAvailable: true
    }));
});


export default router;
