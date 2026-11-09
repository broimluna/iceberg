// Shared helpers for the Mix API routes.
import crypto from "crypto";
import * as db from "../../database.ts";
import { MixError } from "../../services/mixErrors.ts";

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
        Avatar: userAvatar(swid),
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

export const AVATAR_PARTS = ["Accessory", "Brow", "Costume", "Eyes", "Hair", "Hat", "Nose", "Mouth", "Skin"] as const;

// The Mix app keys its local avatar store by AvatarId and applies a
// SetAvatar notification to whichever user has that id
// (LocalUser.UpdateAvatar), so each user keeps one id for good: 48 bits of
// the SWID's hash, which stays a safe JSON integer.
function avatarId(swid) {
    return parseInt(crypto.createHash('sha256').update(String(swid)).digest('hex').slice(0, 12), 16);
}

// A user's avatar: what they last saved with PUT /avatar, else the default.
// The app dereferences Avatar on every user it receives (FriendRecommender,
// DisplayNameSearcher, chat members), so there always is one.
export function userAvatar(swid) {
    return { ...generateDefaultAvatar(), ...(db.getMixAvatar(swid) ?? {}), AvatarId: avatarId(swid), SlotId: 0 };
}

const SELECTION_KEY = /^[A-Za-z0-9_.-]{0,32}$/;
const OFFSET_LIMIT = 10;

// The parts of a PUT /avatar body, checked. A part left out keeps the
// default, because AvatarBuilder reads every part's values without a null
// check. The client's AvatarId and SlotId are ignored (see userAvatar).
export function parseAvatar(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MixError("INVALID_REQUEST");
    const defaults = generateDefaultAvatar();
    const parts = {};
    for (const name of AVATAR_PARTS) {
        const p = input[name];
        if (p === undefined || p === null) { parts[name] = defaults[name]; continue; }
        const { SelectionKey, TintIndex, XOffset, YOffset } = p;
        if (typeof SelectionKey !== 'string' || !SELECTION_KEY.test(SelectionKey)
            || !Number.isInteger(TintIndex) || TintIndex < 0 || TintIndex > 1000
            || ![XOffset, YOffset].every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= OFFSET_LIMIT)) {
            throw new MixError("INVALID_REQUEST");
        }
        parts[name] = { SelectionKey, TintIndex, XOffset, YOffset };
    }
    return parts;
}
