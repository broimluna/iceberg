/**
 * SmartFox Notification Module
 *
 * Sends real-time notifications to the SmartFox server when player data changes.
 * This enables immediate UI updates without requiring room changes or polling.
 */

import { internalSecret } from './utils/internalSecret.ts';

const SMARTFOX_HOST = '127.0.0.1';
const SMARTFOX_PORT = Number(process.env.SFS_NOTIFY_PORT) || 9339;
const NOTIFICATION_TIMEOUT_MS = 5000;

/**
 * Send a notification to SmartFox server
 * @returns True if successful, false otherwise
 */
async function sendNotification(payload: Record<string, unknown>): Promise<boolean> {
    try {
        const res = await fetch(`http://${SMARTFOX_HOST}:${SMARTFOX_PORT}/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': internalSecret() },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS)
        });

        if (res.ok) {
            console.log(`[SmartFox-Notifier] ✓ Notification sent: ${payload.type} for ${payload.username}`);
            return true;
        }

        console.warn(`[SmartFox-Notifier] ✗ Failed with status ${res.status}: ${await res.text()}`);
        return false;
    } catch (err) {
        // Don't log errors for offline SmartFox - it's expected during development
        if (!(err instanceof Error) || !err.message.includes('ECONNREFUSED')) {
            console.warn(`[SmartFox-Notifier] Connection error:`, err);
        }
        return false;
    }
}

/**
 * Notify SmartFox that a daily task was updated
 */
export async function notifyDailyTaskUpdate(username: string, taskId: string, counter: number) {
    return sendNotification({ type: 'DAILY_TASK_UPDATE', username, taskId, counter });
}

/**
 * Notify SmartFox that player coins were updated
 */
export async function notifyCoinsUpdate(username: string, coins: number) {
    return sendNotification({ type: 'COINS_UPDATE', username, coins });
}

/**
 * Notify SmartFox that an asset was added to player inventory
 */
export async function notifyAssetAdded(username: string, assetType: string, assetId: number) {
    return sendNotification({ type: 'ASSET_ADDED', username, assetType, assetId });
}

/**
 * Check if SmartFox notification service is available
 */
export async function isAvailable(): Promise<boolean> {
    try {
        await fetch(`http://${SMARTFOX_HOST}:${SMARTFOX_PORT}`, {
            method: 'HEAD',
            signal: AbortSignal.timeout(2000)
        });
        return true;
    } catch {
        return false;
    }
}
