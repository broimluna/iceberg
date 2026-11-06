/**
 * XP Utility Functions
 *
 * Handles mascot XP calculations and conversions.
 */

import config from "../config.ts";

/**
 * Convert raw XP to internal XP format (1,000,000 per level)
 * The client uses: level = internalXP / 1,000,000
 *
 * @param {string} mascot - Mascot name (e.g., 'AuntArctic')
 * @param {number} rawXpToAdd - Raw XP amount to add
 * @param {number} currentInternalXp - Current internal XP value
 * @returns {number} New internal XP value
 */
export function addXpToInternal(mascot: string, rawXpToAdd: number, currentInternalXp: number): number {
    const thresholds = config.mascotXPThresholds[mascot] || [0, 100, 200, 300, 400, 500, 600, 700, 800, 900];
    const currentLevel = Math.floor(currentInternalXp / 1000000);

    // Get XP thresholds for current and next level
    const currentThreshold = thresholds[currentLevel] || 0;
    const nextThreshold = thresholds[currentLevel + 1] || (currentThreshold + 100);

    // If at max level, don't add more XP
    if (currentThreshold >= nextThreshold) {
        return currentInternalXp;
    }

    // Convert raw XP to internal format
    const xpRange = nextThreshold - currentThreshold;
    const internalXpToAdd = Math.floor((rawXpToAdd * 1000000) / xpRange);
    let newInternalXp = currentInternalXp + internalXpToAdd;

    // Handle level-up overflow recursively
    if (Math.floor(newInternalXp / 1000000) > currentLevel) {
        const xpUsedForLevelUp = 1000000 - (currentInternalXp % 1000000);
        const rawXpUsed = Math.floor((xpUsedForLevelUp * xpRange) / 1000000);
        const remainingRawXp = rawXpToAdd - rawXpUsed;
        newInternalXp = (currentLevel + 1) * 1000000;
        if (remainingRawXp > 0) {
            return addXpToInternal(mascot, remainingRawXp, newInternalXp);
        }
    }

    return newInternalXp;
}

/**
 * Get the current level from internal XP
 *
 * @param {number} internalXp - Internal XP value
 * @returns {number} Current level
 */
export function getLevelFromXp(internalXp: number): number {
    return Math.floor(internalXp / 1000000);
}

/**
 * Get mascot name from quest ID prefix
 *
 * @param {string} questId - Quest ID (e.g., 'AAC001Q001LeakyShip')
 * @returns {string} Mascot name
 */
export function getMascotFromQuestId(questId: string): string {
    if (questId.startsWith('AAC')) return 'AuntArctic';
    if (questId.startsWith('DJC')) return 'DJCadence';
    if (questId.startsWith('RHC')) return 'Rockhopper';
    if (questId.startsWith('RKC')) return 'Rookie';
    if (questId.startsWith('GRY')) return 'Gary';
    return 'AuntArctic'; // Default
}
