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

        // If not a token, treat as a SWID directly (for backward compatibility)
        if (!swid) {
            swid = authValue;
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
        // No auth provided - use default for backward compatibility
        (req as any).player = {
            swid: 'debug_swid_123',
            username: 'DebugPenguin',
            isAuthenticated: false
        };
    }

    next();
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
