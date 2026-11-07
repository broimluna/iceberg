// Shared helpers for the Mix API routes.
import crypto from "crypto";

// State variables
export const presenceState = new Map();

/**
 * Generate a hashed user ID from SWID
 */
export function hashUserId(userId) {
    return crypto.createHash('sha256').update(userId).digest('hex').substring(0, 32);
}

/**
 * Build a success response
 */
export function buildResponse(data = {}) {
    return {
        Status: 'OK',
        ...data
    };
}

/**
 * Get current timestamp in milliseconds
 */
export function getTimestamp() {
    return Date.now();
}

/**
 * Generate a unique ID
 */
export function generateId() {
    return Math.floor(Math.random() * 1000000000);
}


// The Friend (Mix User) object for a player.
export function mixUser(swid, player) {
    const name = player?.displayName || player?.username || 'Unknown';
    return {
        UserId: swid,
        HashedUserId: hashUserId(swid),
        DisplayName: name,
        FirstName: name,
        Avatar: defaultAvatar(swid),
        Status: null,
        Nickname: null
    };
}

export function generateDefaultAvatar() {
    return {
        AvatarId: generateId(),
        SlotId: 0,
        Accessory: { SelectionKey: "3", TintIndex: 17, XOffset: 0.0, YOffset: 0.0 },
        Brow: { SelectionKey: "9", TintIndex: 0, XOffset: 0.0, YOffset: 0.004 },
        Costume: { SelectionKey: "15", TintIndex: 0, XOffset: 0.0, YOffset: 0.0 },
        Eyes: { SelectionKey: "54", TintIndex: 11, XOffset: 0.0, YOffset: 0.012 },
        Hair: { SelectionKey: "69", TintIndex: 7, XOffset: 0.0, YOffset: 0.0 },
        Hat: { SelectionKey: "257", TintIndex: 0, XOffset: 0.0, YOffset: 0.0 },
        Nose: { SelectionKey: "106", TintIndex: 0, XOffset: 0.0, YOffset: 0.012 },
        Mouth: { SelectionKey: "194", TintIndex: 0, XOffset: -0.001, YOffset: 0.0 },
        Skin: { SelectionKey: "123", TintIndex: 9, XOffset: 0.0, YOffset: 0.0 }
    };
}

// A user's avatar until real avatars exist (PUT /avatar, phase 5). The
// Mix app dereferences Avatar on every user it receives (FriendRecommender,
// DisplayNameSearcher, chat members) and keys its local avatar store by
// AvatarId, so the id is stable per user: 48 bits of the SWID's hash,
// which stays a safe JSON integer.
export function defaultAvatar(swid) {
    const id = parseInt(crypto.createHash('sha256').update(String(swid)).digest('hex').slice(0, 12), 16);
    return { ...generateDefaultAvatar(), AvatarId: id };
}
