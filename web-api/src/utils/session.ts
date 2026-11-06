/**
 * Session Utility Functions
 *
 * Handles session management for SFS2X integration.
 */

import fs from "fs";
import crypto from "crypto";
import config from "../config.ts";

/**
 * Save session ID for SFS2X to read
 *
 * @param {string} username - Player username
 * @param {number} sessionId - Session ID
 * @param {string} roomName - Room name
 */
export function saveSessionForUser(username: string, sessionId: number, roomName: string) {
    let sessions: Record<string, unknown> = {};

    try {
        if (fs.existsSync(config.sessionFile)) {
            sessions = JSON.parse(fs.readFileSync(config.sessionFile, 'utf8'));
        }
    } catch (e) {
        console.log('[SESSION] Could not read existing sessions file, creating new one');
    }

    sessions[username] = {
        sessionId: sessionId,
        room: roomName,
        timestamp: Date.now()
    };

    try {
        fs.writeFileSync(config.sessionFile, JSON.stringify(sessions, null, 2));
        console.log(`[SESSION] Saved session for ${username}: ${sessionId}`);
    } catch (e) {
        console.error('[SESSION] Failed to write session file:', (e as Error).message);
    }
}

/**
 * Generate a session ID that fits in 32-bit int range
 *
 * Randomly generated (crypto.randomInt), not time-derived, to avoid the
 * collisions a Date.now()-based scheme risks between near-simultaneous
 * calls. Kept under 2^31 for the same LitJson large-long parsing
 * constraint as before.
 *
 * @returns {number} Session ID
 */
export function generateSessionId(): number {
    return crypto.randomInt(100000000, 2147483647);
}

/**
 * Generate a unique equipment ID
 *
 * @returns {number} Equipment ID
 */
export function generateEquipmentId(): number {
    return crypto.randomInt(100000000, 2147483647);
}
