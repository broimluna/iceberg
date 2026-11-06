/**
 * Task Routes
 * 
 * Handles daily task (daily challenges) progress and reward claiming.
 * 
 * Endpoints:
 * - POST /task/v1         - Update daily task progress (SetTaskProgressOperation)
 * - POST /task/v1/reward  - Claim daily task reward (ClaimTaskRewardOperation)
 */

import express from "express";
const router = express.Router();
import * as db from "../database.ts";
import * as smartfox from "../smartfoxNotifier.ts";
import config from "../config.ts";
import { addXpToInternal } from "../utils/xp.ts";
import { signedResponse } from "../utils/response.ts";

/**
 * POST /task/v1
 * Set task progress
 * 
 * Request: SignedResponse<TaskProgress> { taskId, counter, day, claimed }
 * Response: Empty object (acknowledgement)
 */
router.post('/task/v1', (req, res) => {
    const { swid, username } = req.player;
    console.log(`[TASK] ${username} setting task progress`);
    
    // Extract TaskProgress from SignedResponse
    const taskProgress = req.body.data || req.body.Data || 
        (req.body.taskId !== undefined ? req.body : null);
    
    if (taskProgress?.taskId) {
        db.updateDailyTask(
            username,
            taskProgress.taskId,
            taskProgress.counter,
            taskProgress.day,
            taskProgress.claimed
        );
        console.log(`[TASK] Updated task ${taskProgress.taskId}: counter=${taskProgress.counter}, claimed=${taskProgress.claimed}`);
    }
    
    res.json({});
});

/**update
 * Internal endpoint for SmartFox server to update task progress
 * 
 * Request: { username, taskId, counter }
 * Response: { success: boolean }
 */
router.post('/task/update', (req, res) => {
    const { username, taskId, counter } = req.body;
    
    if (!username || !taskId || counter === undefined) {
        return res.status(400).json({ 
            success: false, 
            error: 'Missing required fields: username, taskId, counter' 
        });
    }
    
    console.log(`[TASK-UPDATE] SmartFox updating ${username}: ${taskId} = ${counter}`);
    
    try {
        // Update the task in database
        db.updateDailyTask(username, taskId, counter, Date.now(), false);
        
        console.log(`[TASK-UPDATE] Successfully updated database for ${username}: ${taskId} = ${counter}`);
        
        res.json({ success: true });
    } catch (error) {
        console.error(`[TASK-UPDATE] Error updating task:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /task/
 * POST /task/v1/reward
 * Claim reward for a completed task
 * 
 * Request: taskId as plain text
 * Response: ClaimTaskRewardResponse { reward: RewardJsonReader }
 */
router.post('/task/v1/reward', (req, res) => {
    const { swid, username } = req.player;
    
    // Parse taskId from body - client sends as plain text
    let taskId = req.body;
    if (typeof taskId === 'string') {
        taskId = taskId.trim();
    } else if (typeof taskId === 'object' && taskId !== null) {
        taskId = Object.keys(taskId)[0] || '';
    }
    
    console.log(`[TASK] ${username} claiming reward for task: ${taskId}`);
    
    // Mark task as claimed
    db.updateDailyTask(username, taskId, null, null, true);
    
    // Default task reward
    const defaultReward = {
        coins: 50,
        mascotXP: { Rockhopper: 25 }
    };
    
    // Apply rewards
    db.addPlayerCoins(username, defaultReward.coins);
    
    for (const [mascot, rawXp] of Object.entries(defaultReward.mascotXP)) {
        const currentXp = db.getMascotXP(username)[mascot] || 0;
        const newXp = addXpToInternal(mascot, rawXp, currentXp);
        db.setMascotXP(username, mascot, newXp);
    }
    
    console.log(`[TASK] ${username} claimed task ${taskId}, granted ${defaultReward.coins} coins`);
    
    // Response format: ClaimTaskRewardResponse
    res.json({ 
        reward: defaultReward 
    });
});

export default router;
