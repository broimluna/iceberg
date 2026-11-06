/**
 * Response Helper Functions
 *
 * Standard response formats used by the game client.
 */

/**
 * Create a signed response wrapper
 * Used for most API responses that the game client expects
 *
 * @param {*} data - Response data
 * @param {string} swid - Player SWID (optional, uses placeholder if not provided)
 * @returns {object} Signed response object
 */
export function signedResponse(data: unknown, swid: string | null = null) {
    return {
        goodUntil: Date.now() + 100000,
        swid: swid || '{SWID}',
        data: data,
        signature: 'mock_signature'
    };
}

/**
 * Build QuestStateCollection for response
 *
 * @param {Array} quests - Array of quest objects
 * @returns {Array} Formatted quest state collection
 */
export function buildQuestStateCollection(quests: any[]) {
    return quests.map(q => ({
        questId: q.questId,
        status: q.status,
        completedObjectives: q.completedObjectives || [],
        unlockTime: q.unlockTime || null,
        timesCompleted: q.timesCompleted || 0
    }));
}

/**
 * Quest status enum values
 */
export const QuestStatus = {
    AVAILABLE: 0,
    ACTIVE: 1,
    SUSPENDED: 2,
    COMPLETED: 3,
    LOCKED: 4
};
