/**
 * Quest Routes
 * 
 * Handles quest progress, status changes, and objective completion.
 * 
 * Endpoints:
 * - POST /quest/v1/progress       - Update quest objectives (SetProgressOperation)
 * - POST /quest/v1/:questId       - Set quest status (SetStatusOperation)
 */

import express from "express";
const router = express.Router();
import * as db from "../database.ts";
import config from "../config.ts";
import { signedResponse, buildQuestStateCollection, QuestStatus } from "../utils/response.ts";
import { getMascotFromQuestId, addXpToInternal } from "../utils/xp.ts";
import { logSafe } from "../utils/logSafe.ts";

/**
 * Helper to grant various rewards from quest definitions
 * Returns the object that was actually granted (with generated IDs)
 */
function grantRewards(username, rewardData) {
    if (!rewardData) return null;

    const granted = {
        coins: 0,
        mascotXP: {},
        equipmentTemplates: [],
        equipmentInstances: [],
        fabrics: [],
        decals: [],
        emotePacks: [],
        durables: [],
        tubes: []
    };

    // Coins
    if (rewardData.coins) {
        db.addPlayerCoins(username, rewardData.coins);
        granted.coins = rewardData.coins;
        console.log(`[QUEST] Granted ${rewardData.coins} coins to ${username}`);
    }

    // Mascot XP
    if (rewardData.mascotXP) {
        for (const [mascot, rawXp] of Object.entries(rewardData.mascotXP)) {
            const currentXp = db.getMascotXP(username)[mascot] || 0;
            const newXp = addXpToInternal(mascot, rawXp, currentXp);
            db.setMascotXP(username, mascot, newXp);
            granted.mascotXP[mascot] = rawXp;
            console.log(`[QUEST] Granted ${rawXp} raw XP (${newXp} internal) for ${mascot} to ${username}`);
        }
    }

    // Equipment Templates
    if (rewardData.equipmentTemplates) {
        for (const id of rewardData.equipmentTemplates) {
            db.addEquipmentTemplate(username, id);
            granted.equipmentTemplates.push(id);
            console.log(`[QUEST] Granted equipment template ${id} to ${username}`);
        }
    }

    // Equipment Instances
    if (rewardData.equipmentInstances) {
        for (const item of rewardData.equipmentInstances) {
            if (item.definitionId) {
                // Add as template
                db.addEquipmentTemplate(username, item.definitionId);
                
                // Add as instance
                const instance = {
                    equipmentId: null, // Let DB generate ID
                    dateTimeCreated: Date.now(),
                    definitionId: item.definitionId,
                    parts: item.parts || []
                };
                const result = db.saveEquipment(username, instance);
                
                // Add validated instance with ID to result
                granted.equipmentInstances.push({
                    ...instance,
                    equipmentId: result.lastInsertRowid
                });
                
                console.log(`[QUEST] Granted equipment instance ${item.definitionId} to ${username} (ID: ${result.lastInsertRowid})`);
            }
        }
    }

    // Fabrics
    if (rewardData.fabrics) {
        for (const id of rewardData.fabrics) {
            db.addFabric(username, id);
            granted.fabrics.push(id);
            console.log(`[QUEST] Granted fabric ${id} to ${username}`);
        }
    }

    // Decals
    if (rewardData.decals) {
        for (const id of rewardData.decals) {
            db.addDecal(username, id);
            granted.decals.push(id);
            console.log(`[QUEST] Granted decal ${id} to ${username}`);
        }
    }

    // Emote Packs
    if (rewardData.emotePacks) {
        for (const id of rewardData.emotePacks) {
            db.addEmotePack(username, id);
            granted.emotePacks.push(id);
            console.log(`[QUEST] Granted emote pack ${id} to ${username}`);
        }
    }

    // Durables
    if (rewardData.durables) {
        for (const id of rewardData.durables) {
            db.addDurable(username, id);
            granted.durables.push(id);
            console.log(`[QUEST] Granted durable ${id} to ${username}`);
        }
    }

    // Tubes
    if (rewardData.tubes) {
        for (const id of rewardData.tubes) {
            db.addTube(username, id);
            granted.tubes.push(id);
            console.log(`[QUEST] Granted tube ${id} to ${username}`);
        }
    }

    return granted;
}

/**
 * POST /quest/v1/progress
 * Update quest objectives
 * 
 * Request: SignedResponse<QuestObjectives> (array of objective IDs)
 * Response: QuestChangeResponse { questId, questStateCollection, reward? }
 */
router.post('/quest/v1/progress', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[QUEST] Updating quest progress for ${username}`);
    
    const quests = db.getQuests(username);
    const activeQuest = quests.find(q => q.status === QuestStatus.ACTIVE);
    
    if (!activeQuest) {
        return res.json({
            questId: null,
            questStateCollection: signedResponse(buildQuestStateCollection(quests), swid)
        });
    }
    
    // Extract objectives from SignedResponse<QuestObjectives>
    let objectives = [];
    if (req.body.data || req.body.Data) {
        objectives = req.body.data || req.body.Data;
    } else if (Array.isArray(req.body)) {
        objectives = req.body;
    }
    
    console.log(`[QUEST] Objectives received: ${JSON.stringify(objectives)}`);
    
    // Add new objectives
    let newObjectives = [];
    let recoveryObjectives = [];
    
    for (const obj of objectives) {
        if (!activeQuest.completedObjectives.includes(obj)) {
            db.addQuestObjective(username, activeQuest.questId, obj);
            newObjectives.push(obj);
        } else {
            recoveryObjectives.push(obj);
        }
    }
    
    let reward = null;
    
    // Helper to merge granted rewards into the main reward object
    const mergeRewards = (granted) => {
        if (!granted) return;
        if (!reward) reward = {};
        
        // Merge coins
        if (granted.coins) {
            reward.coins = (reward.coins || 0) + granted.coins;
        }
        
        // Merge mascotXP
        if (granted.mascotXP) {
            if (!reward.mascotXP) reward.mascotXP = {};
            for (const [mascot, xp] of Object.entries(granted.mascotXP)) {
                reward.mascotXP[mascot] = (reward.mascotXP[mascot] || 0) + xp;
            }
        }
        
        // Merge equipmentInstances
        if (granted.equipmentInstances && granted.equipmentInstances.length > 0) {
            if (!reward.equipmentInstances) reward.equipmentInstances = [];
            reward.equipmentInstances.push(...granted.equipmentInstances);
        }
        
        // Merge equipmentTemplates
        if (granted.equipmentTemplates && granted.equipmentTemplates.length > 0) {
            if (!reward.equipmentTemplates) reward.equipmentTemplates = [];
            reward.equipmentTemplates.push(...granted.equipmentTemplates);
        }
        
        // Merge other arrays
        ['fabrics', 'decals', 'emotePacks', 'durables', 'tubes'].forEach(key => {
            if (granted[key] && granted[key].length > 0) {
                if (!reward[key]) reward[key] = [];
                reward[key].push(...granted[key]);
            }
        });
    };

    // Generate rewards for new objectives on first completion
    if (newObjectives.length > 0 && activeQuest.timesCompleted === 0) {
        const questDef = config.questDefinitions[activeQuest.questId];
        
        // If we have a definition, use it for rewards
        if (questDef && questDef.objectives) {
            for (const objId of newObjectives) {
                const objDef = questDef.objectives[objId];
                if (objDef && objDef.reward) {
                    const granted = grantRewards(username, objDef.reward);
                    mergeRewards(granted);
                }
            }
        } else {
            // Fallback for quests not in config: Default XP
            const mascotName = getMascotFromQuestId(activeQuest.questId);
            const totalRawXp = config.rewards.objectiveXP * newObjectives.length;
            
            const currentXp = db.getMascotXP(username)[mascotName] || 0;
            const newXp = addXpToInternal(mascotName, totalRawXp, currentXp);
            db.setMascotXP(username, mascotName, newXp);
            
            reward = { mascotXP: { [mascotName]: totalRawXp } };
            console.log(`[QUEST] ${username} completed ${newObjectives.length} objectives (fallback), granted ${totalRawXp} raw XP (${newXp} internal) to ${mascotName}`);
        }
    }
    
    // RECOVERY LOGIC: Check already completed objectives for missing equipment rewards
    // This handles cases where a previous request failed to grant/return the item properly
    if (recoveryObjectives.length > 0) {
        const questDef = config.questDefinitions[activeQuest.questId];
        if (questDef && questDef.objectives) {
            const userEquipment = db.getEquipment(username);
            
            for (const objId of recoveryObjectives) {
                const objDef = questDef.objectives[objId];
                if (objDef && objDef.reward && objDef.reward.equipmentInstances) {
                    for (const item of objDef.reward.equipmentInstances) {
                        if (item.definitionId) {
                            // Check if user owns this item
                            const hasItem = userEquipment.some(e => e.definitionId === item.definitionId);
                            if (!hasItem) {
                                console.log(`[QUEST] RECOVERY: User ${username} completed objective ${objId} but missing item ${item.definitionId}. Granting now.`);
                                
                                // Grant this specific item
                                const recoveryReward = {
                                    equipmentInstances: [item],
                                    // Add corresponding template too
                                    equipmentTemplates: [item.definitionId]
                                };
                                const granted = grantRewards(username, recoveryReward);
                                mergeRewards(granted);
                            }
                        }
                    }
                }
            }
        }
    }
    
    const response = {
        questId: activeQuest.questId,
        questStateCollection: signedResponse(buildQuestStateCollection(db.getQuests(username)), swid)
    };
    
    if (reward) response.reward = reward;
    res.json(response);
});

/**
 * POST /quest/v1/:questId
 * Set quest status
 * 
 * Request: Status number as plain text (0=AVAILABLE, 1=ACTIVE, 2=SUSPENDED, 3=COMPLETED, 4=LOCKED)
 * Response: QuestChangeResponse { questId, questStateCollection, reward? }
 */
router.post('/quest/v1/:questId', (req, res) => {
    const questId = req.params.questId;
    const { swid, username } = req.player;
    
    // Parse status from body - client sends as plain text number
    let newStatus;
    if (typeof req.body === 'string') {
        newStatus = parseInt(req.body, 10);
    } else if (typeof req.body === 'object' && req.body.status !== undefined) {
        newStatus = req.body.status;
    } else if (typeof req.body === 'number') {
        newStatus = req.body;
    } else {
        newStatus = QuestStatus.ACTIVE;
    }
    
    console.log(`[QUEST] ${username} updating ${questId} to status ${newStatus} (raw body: ${logSafe(req.body)})`);
    
    const quest = db.getOrCreateQuest(username, questId);
    console.log(`[QUEST] Current quest state: status=${quest.status}, timesCompleted=${quest.timesCompleted}`);
    
    let reward = null;
    
    // Handle ACTIVE status - suspend other quests first
    if (newStatus === QuestStatus.ACTIVE && quest.status !== QuestStatus.ACTIVE) {
        db.suspendOtherQuests(username, questId);
        
        // If restarting a completed quest, clear objectives
        if (quest.status === QuestStatus.COMPLETED) {
            db.clearQuestObjectives(username, questId);
        }
        
        db.updateQuestStatus(username, questId, QuestStatus.ACTIVE);
    }
    
    // Handle COMPLETED status
    if (newStatus === QuestStatus.COMPLETED) {
        const wasFirstCompletion = quest.timesCompleted === 0;
        const newTimesCompleted = (quest.timesCompleted || 0) + 1;
        const completedTime = new Date().toISOString();
        
        db.updateQuestStatus(username, questId, QuestStatus.COMPLETED, newTimesCompleted, completedTime);
        
        if (wasFirstCompletion) {
            const questDef = config.questDefinitions[questId];
            
            if (questDef && questDef.completeReward) {
                const granted = grantRewards(username, questDef.completeReward);
                reward = granted; // Return the reward structure with actual IDs
                console.log(`[QUEST] ${username} COMPLETED ${questId}! Granted rewards from config.`);
            } else {
                // Fallback defaults
                const mascotName = getMascotFromQuestId(questId);
                const { questCompletionXP, questCompletionCoins } = config.rewards;
                
                const currentXp = db.getMascotXP(username)[mascotName] || 0;
                const newXp = addXpToInternal(mascotName, questCompletionXP, currentXp);
                db.setMascotXP(username, mascotName, newXp);
                db.addPlayerCoins(username, questCompletionCoins);
                
                reward = {
                    mascotXP: { [mascotName]: questCompletionXP },
                    coins: questCompletionCoins
                };
                
                console.log(`[QUEST] ${username} COMPLETED ${questId}! Granted default ${questCompletionXP} raw XP (${newXp} internal), ${questCompletionCoins} coins`);
            }
        }
    }
    
    // Handle SUSPENDED status
    if (newStatus === QuestStatus.SUSPENDED) {
        db.updateQuestStatus(username, questId, QuestStatus.SUSPENDED);
    }
    
    const response = {
        questId: questId,
        questStateCollection: signedResponse(buildQuestStateCollection(db.getQuests(username)), swid)
    };
    
    if (reward) response.reward = reward;
    res.json(response);
});

/**
 * Grant the reward for one quest objective. quest.c_obj carries only the
 * objective name (e.g. "Obj0", reused across quests), so the quest is
 * found by which in-progress quest defines that objective. Idempotent: an
 * objective that's already recorded grants nothing. Returns the granted
 * reward, or null if there's nothing to grant.
 */
function grantQuestObjectiveReward(username, objectiveId) {
    const quests = db.getQuests(username);

    // The client flips quests between ACTIVE and SUSPENDED constantly
    // mid-quest (SUSPENDED only means "not the tracked quest"), so both
    // count. Prefer ACTIVE if both match.
    const candidates = quests
        .filter(q => (q.status === QuestStatus.ACTIVE || q.status === QuestStatus.SUSPENDED) && !q.completedObjectives.includes(objectiveId))
        .filter(q => config.questDefinitions[q.questId]?.objectives?.[objectiveId])
        .sort((a, b) => (a.status === QuestStatus.ACTIVE ? -1 : 0) - (b.status === QuestStatus.ACTIVE ? -1 : 0));

    const quest = candidates[0];
    if (!quest) return null;

    db.addQuestObjective(username, quest.questId, objectiveId);

    const objDef = config.questDefinitions[quest.questId].objectives[objectiveId];
    if (!objDef.reward) return null;

    return grantRewards(username, objDef.reward);
}

export default router;
export { grantQuestObjectiveReward };
