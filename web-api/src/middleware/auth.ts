/**
 * Authentication Middleware
 *
 * Extracts player identity from HTTP Basic Authentication headers.
 * The CPI client sends the AccessToken as the username in Basic Auth.
 * We need to look up the access token to get the SWID, then look up the player.
 */

import type { Request, Response, NextFunction } from "express";
import * as db from "../database.ts";
import { tokenStore } from "../routes/guestcontroller.ts";
import { isBanned } from "../services/moderation.ts";

/**
 * Parse Basic Auth header and extract credentials
 */
export function parseBasicAuth(authHeader: string | undefined): { username: string; password: string } | null {
    if (!authHeader || !authHeader.startsWith('Basic ')) {
        return null;
    }

    try {
        const base64Credentials = authHeader.slice(6);
        const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
        const [username, password] = credentials.split(':');
        return { username: username || '', password: password || '' };
    } catch (e) {
        return null;
    }
}

/**
 * Authentication middleware
 * Extracts SWID from Basic Auth and attaches player info to request
 *
 * Sets req.player with:
 * - swid: The player's SWID (from auth)
 * - username: The player's display name (from database)
 * - isAuthenticated: Whether the request has valid auth
 */
export function authenticate(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    const credentials = parseBasicAuth(authHeader);

    if (credentials && credentials.username) {
        const authValue = credentials.username;
        let swid: string | null = null;

        // First, try to look up as an access token
        if (tokenStore) {
            const tokenData = tokenStore.get(authValue);
            if (tokenData && tokenData.expiry > Date.now()) {
                swid = tokenData.swid;
            }
        }

        // Unknown or expired access token: 401 with ErrorResponse code 3, which
        // makes the client refresh its token through the guest controller.
        // Treating the value as a SWID instead would let anyone act as any
        // player (SWIDs are visible to others), and turned expired tokens into
        // new auto-created accounts. Test tools can opt back in.
        if (!swid) {
            if (process.env.ALLOW_SWID_AUTH !== '1') {
                console.log(`[AUTH] ${req.method} ${req.path}: unknown or expired access token, 401 (client refreshes)`);
                return res.status(401).json({ code: 3 });
            }
            swid = authValue;
        }

        // A ban applies to tokens issued before it, too. 401 {code: 3}
        // makes the client refresh, and the guest controller's refresh
        // answers with the ban (a 400 the client shows), as Mix's
        // authenticateMix already does with UNAUTHORIZED_BANNED.
        if (isBanned(swid)) {
            console.log(`[AUTH] ${req.method} ${req.path}: ${swid} is banned, 401 (refresh shows the ban)`);
            return res.status(401).json({ code: 3 });
        }

        // Look up player by SWID
        let playerInfo = db.getPlayerBySwid(swid);

        // Auto-create player if not found (fixes issue with unknown SWIDs causing crashes)
        if (!playerInfo) {
            console.log(`[AUTH] Auto-creating player for new SWID: ${swid}`);
            const newUsername = db.createPlayerFromSwid(swid);
            playerInfo = {
                swid: swid,
                username: newUsername,
                displayName: newUsername
            };
        }

        if (playerInfo) {
            (req as any).player = {
                swid: swid,
                username: playerInfo.username,
                isAuthenticated: true
            };
        } else {
            // SWID provided but no player found - reject request
            // Players must be created via registration endpoint
            console.warn(`[AUTH] Unknown SWID attempted access: ${swid}`);
            (req as any).player = {
                swid: swid,
                username: null,
                isAuthenticated: false
            };
        }
    } else {
        // No credentials: no player. requireGameLogin refuses the game API.
        (req as any).player = { swid: null, username: null, isAuthenticated: false };
    }

    next();
}

// The CPI game API (/<service>/v1/...), which acts as the logged-in
// player. Mix routes share some first segments (/moderation/text) but
// never have /v1 and use their own tokens. Matched on the lower-cased path
// because Express routing ignores case.
const GAME_API = /^\/(game|player|quest|reward|inventory|catalog|task|consumable|tutorial|breadcrumb|igloo|chat|minigame|moderation|disneystore|tube|event|membership|iap-pc|captcha)\/v1(\/|$)/;
// Calls the client makes without credentials (its operations without
// HttpBasicAuthorization): looking up other players' public data.
const PUBLIC_GAME_API = /^\/player\/v1\/(name\/[^/]+|names|session\/[^/]+|id|id\/(?!online\/?$)[^/]+)\/?$/;

/**
 * Refuses the game API without a login: 401 {code: 3}, which makes the
 * client refresh its access token.
 */
export function requireGameLogin(req: Request, res: Response, next: NextFunction) {
    const path = req.path.toLowerCase();
    if (!GAME_API.test(path) || PUBLIC_GAME_API.test(path)) return next();
    if ((req as any).player?.isAuthenticated) return next();
    console.log(`[AUTH] ${req.method} ${req.path}: no login, 401`);
    return res.status(401).json({ code: 3 });
}

/**
 * Require authentication middleware
 * Returns 401 if not authenticated
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
    if (!(req as any).player || !(req as any).player.isAuthenticated) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
}
