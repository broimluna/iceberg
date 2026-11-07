/**
 * Task Routes
 * 
 * Handles daily task (daily challenges) progress and reward claiming.
 * 
 * Endpoints:
 * - POST /task/v1         - Client-relayed progress, ignored (the game server
 *                            counts it via /api/internal/task-increment)
 * - POST /task/v1/reward  - Claim daily task reward (ClaimTaskRewardOperation)
 */

import express from "express";
const router = express.Router();
import * as db from "../database.ts";
import * as smartfox from "../smartfoxNotifier.ts";
import config from "../config.ts";
import { addXpToInternal } from "../utils/xp.ts";
import { signedResponse } from "../utils/response.ts";
import dailyTaskData from "../../../smartfox-server/data/daily-tasks.json" with { type: "json" };

// Task definitions shared with the game server (generated from the game's
// task assets): threshold, comparison and reward per task id.
const DAILY_TASKS = dailyTaskData.tasks;

// TaskDefinition.TaskComparison: 0 LessThan, 1 Equals, 2 GreaterThan.
function isTaskComplete(def, counter) {
    if (def.comparison === 0) return counter < def.threshold;
    if (def.comparison === 2) return counter > def.threshold;
    return counter === def.threshold;
}

// TaskDefinition.TaskGroup 2: one counter shared by every player.
const GROUP_COMMUNITY = 2;

function currentCounter(username, taskId, def) {
    if (def.group === GROUP_COMMUNITY) return db.getCommunityTaskCounter(taskId);
    return db.getTodaysDailyTask(username, taskId)?.counter ?? 0;
}

/**
 * Applies `times` counted events to a task (Task.Increment: +1 each, never
 * past CounterMax unless it's 0), for today. Called by the game server,
 * which decides what counts. Returns the new counter, whether it changed,
 * and whether this made the task complete; null for an unknown task.
 */
export function incrementTask(username, taskId, times) {
    const def = DAILY_TASKS[taskId];
    if (!def) return null;
    const day = db.currentTaskDay();
    const before = currentCounter(username, taskId, def);
    let counter = before;
    for (let i = 0; i < times; i++) {
        if (def.counterMax === 0 || counter < def.counterMax) counter++;
    }
    if (counter !== before) {
        if (def.group === GROUP_COMMUNITY) db.setCommunityTaskCounter(taskId, counter, day);
        else db.setDailyTaskCounter(username, taskId, counter, day);
    }
    return {
        counter,
        changed: counter !== before,
        completed: !isTaskComplete(def, before) && isTaskComplete(def, counter)
    };
}

/**
 * POST /task/v1
 * Set task progress
 * 
 * Request: SignedResponse<TaskProgress> { taskId, counter, day, claimed }
 * Response: Empty object (acknowledgement)
 */
router.post('/task/v1', (req, res) => {
    // The client relays task progress here, but the game server counts and
    // saves it (/api/internal/task-increment), so a client can't set its own.
    const { username } = req.player;
    console.log(`[TASK] ${username} sent task progress, ignored (server-counted): ${JSON.stringify(req.body)}`);
    res.json({});
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
    
    // Pays the task's own reward, once, and only if the game server counted
    // it complete today.
    const def = DAILY_TASKS[taskId];
    const counter = def ? currentCounter(username, taskId, def) : 0;
    if (!def || !isTaskComplete(def, counter)) {
        console.log(`[TASK] ${username} claim for ${taskId} refused: ${!def ? 'unknown task' : 'not complete today'} (counter=${counter})`);
        return res.json({ reward: {} });
    }
    if (!db.claimTodaysDailyTask(username, taskId)) {
        console.log(`[TASK] ${username} claim for ${taskId} refused: already claimed`);
        return res.json({ reward: {} });
    }
    
    const reward = def.reward;
    if (reward.coins) db.addPlayerCoins(username, reward.coins);
    for (const [mascot, rawXp] of Object.entries(reward.mascotXP)) {
        const currentXp = db.getMascotXP(username)[mascot] || 0;
        db.setMascotXP(username, mascot, addXpToInternal(mascot, rawXp, currentXp));
    }
    
    console.log(`[TASK] ${username} claimed task ${taskId}: ${JSON.stringify(reward)}`);
    
    // Response format: ClaimTaskRewardResponse
    res.json({ reward });
});

export default router;
