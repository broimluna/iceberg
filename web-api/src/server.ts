/**
 * Club Penguin Island - Web API Server
 *
 * Main entry point for the game's HTTP API.
 * Routes are organized into separate modules for maintainability.
 */

import express from "express";
import * as db from "./database.ts";
import config from "./config.ts";
import { logger, errorHandler, notFoundHandler, authenticate } from "./middleware/index.ts";
import * as routes from "./routes/index.ts";
import { encryptionMiddleware } from "./routes/encryption.ts";
import { incrementTask as incrementDailyTask } from "./routes/task.ts";

// Initialize Express app
const app = express();

// =============================================================================
// Middleware
// =============================================================================

// The client's HTTP layer (Unity WWW) can only send GET and POST, so PUT
// and DELETE arrive as POST with an X-HTTP-Method-Override header. Restore
// the real verb before routing.
app.use((req, res, next) => {
    const override = req.headers['x-http-method-override'];
    if (req.method === 'POST' && typeof override === 'string' && ['PUT', 'DELETE', 'PATCH'].includes(override.toUpperCase())) {
        req.method = override.toUpperCase();
        console.log(`[HTTP] ${req.url}: POST -> ${req.method} (X-HTTP-Method-Override), content-type=${req.headers['content-type'] ?? '(none)'}, length=${req.headers['content-length'] ?? '?'}`);
    }
    next();
});

// Capture raw body for encrypted requests (before JSON parsing)
app.use((req, res, next) => {
    if (req.headers['x-encryption-key-id']) {
        let chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            (req as any).rawBody = Buffer.concat(chunks);
            next();
        });
    } else {
        next();
    }
});

// Body parsing - skip for application/mix (encrypted Mix API requests) and encrypted CP requests
// CPI's report call sends the reason as a bare JSON string ("ChatSwearing"),
// which the strict parser below rejects with a 400 before the route runs.
app.use('/moderation/v1/report', express.json({ strict: false }));
app.use(express.json({
    type: (req) => {
        const contentType = req.headers['content-type'] || '';
        // Skip JSON parsing for encrypted Mix API requests
        if (contentType.includes('application/mix')) {
            return false;
        }
        // Skip JSON parsing for encrypted CP API requests (we handle it in middleware)
        if (req.headers['x-encryption-key-id']) {
            return false;
        }
        return contentType.includes('json');
    }
}));
app.use(express.text({ type: 'text/plain' })); // For quest status updates which send just a number
// Allow raw binary bodies for encrypted Mix API requests
app.use(express.raw({ type: 'application/mix', limit: '10mb' }));

// Request logging
app.use(logger);

// Authentication - extracts player identity from Basic Auth headers
app.use(authenticate);

// Encryption middleware - handles encrypted CP API requests
app.use(encryptionMiddleware);

// =============================================================================
// Routes
// =============================================================================

// Internal endpoints, called only by the game server. Restricted to
// localhost, plus the shared secret if one is configured.
function isInternalCaller(req: express.Request): boolean {
    const remote = req.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false;
    if (config.internalApiSecret && req.headers['x-internal-secret'] !== config.internalApiSecret) return false;
    return true;
}

app.post('/api/internal/add-coins', express.json(), (req, res) => {
    if (!isInternalCaller(req)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const { username, coins } = req.body;
        if (!username || coins === undefined) {
            return res.status(400).json({ error: 'Missing username or coins' });
        }
        db.addPlayerCoins(username, coins);
        console.log(`[INTERNAL-API] Added ${coins} coins to ${username}`);
        res.json({ success: true });
    } catch (error) {
        console.error('[INTERNAL-API] Error adding coins:', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

/**
 * POST /api/internal/grant-reward
 * Called by the game server when its own logic decides a reward is earned,
 * so grants don't depend on the client relaying them. Same reward shape as
 * PUT /reward/v1.
 */
app.post('/api/internal/grant-reward', express.json(), (req, res) => {
    if (!isInternalCaller(req)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const { username, reward } = req.body;
        if (!username || !reward) {
            return res.status(400).json({ error: 'Missing username or reward' });
        }
        routes.applyRewards(username, reward);
        console.log(`[INTERNAL-API] Granted reward to ${username} from game server:`, reward);
        res.json({ success: true, assets: db.getPlayerAssets(username) });
    } catch (error) {
        console.error('[INTERNAL-API] Error granting reward:', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

/**
 * POST /api/internal/quest-objective
 * Called by the game server on quest.c_obj. Records the objective and
 * grants its reward from quests.json.
 */
app.post('/api/internal/quest-objective', express.json(), (req, res) => {
    if (!isInternalCaller(req)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const { username, objective } = req.body;
        if (!username || !objective) {
            return res.status(400).json({ error: 'Missing username or objective' });
        }
        const reward = routes.grantQuestObjectiveReward(username, objective);
        console.log(`[INTERNAL-API] Objective ${objective} for ${username}: ${reward ? `granted ${JSON.stringify(reward)}` : 'no reward / already granted'}`);
        res.json({ success: true, reward });
    } catch (error) {
        console.error('[INTERNAL-API] Error granting quest objective reward:', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

/**
 * POST /api/internal/session-ended
 * The game server reports a closed connection, so the player stops showing
 * as online. Body: { sessionId } (the joinRoomData sessionId).
 */
app.post('/api/internal/session-ended', express.json(), (req, res) => {
    if (!isInternalCaller(req)) return res.status(403).json({ error: 'Forbidden' });
    const sessionId = Number(req.body?.sessionId);
    if (!Number.isSafeInteger(sessionId)) return res.status(400).json({ error: 'Missing or invalid sessionId' });
    db.deleteSession(sessionId);
    console.log(`[INTERNAL-API] Session ${sessionId} ended`);
    res.json({ success: true });
});

/**
 * POST /api/internal/task-increment
 * The game server reports a counted daily-challenge event.
 * Body: { username, taskId, times }. Returns { counter, changed, completed }.
 */
app.post('/api/internal/task-increment', express.json(), (req, res) => {
    if (!isInternalCaller(req)) return res.status(403).json({ error: 'Forbidden' });
    const { username, taskId, times } = req.body ?? {};
    if (typeof username !== 'string' || typeof taskId !== 'string' || !Number.isInteger(times) || times < 1) {
        return res.status(400).json({ error: 'Missing or invalid username, taskId or times' });
    }
    const result = incrementDailyTask(username, taskId, times);
    if (!result) return res.status(404).json({ error: 'Unknown task' });
    res.json(result);
});

// Mount all route modules
app.use(routes.sessionRoutes);
app.use(routes.gameRoutes);
app.use(routes.playerRoutes);
app.use(routes.questRoutes);
app.use(routes.rewardRoutes);
app.use(routes.inventoryRoutes);
app.use(routes.catalogRoutes);
app.use(routes.taskRoutes);
app.use(routes.consumableRoutes);
app.use(routes.tutorialRoutes);
app.use(routes.breadcrumbRoutes);
app.use(routes.iglooRoutes);
app.use(routes.captchaRoutes);
app.use(routes.chatRoutes);
app.use(routes.minigameRoutes);
app.use(routes.moderationRoutes);
app.use(routes.disneystoreRoutes);
app.use(routes.tubeRoutes);
app.use(routes.eventRoutes);
app.use(routes.encryptionRoutes);
app.use(routes.membershipRoutes);
app.use(routes.guestcontrollerRoutes);
// Disney Mix content CDN (manifest + files); before the Mix routes.
app.use(routes.cpipeRoutes);
// Mix routes at /mix (tools/mix-config.ts's mix_platform_services_url) and at
// the root (CPI and the prebuilt Mix build). Two separate mounts: an array
// mount is one layer whose '/' alternative always wins, so /mix/... 404'd.
app.use('/mix', routes.mixRoutes);
app.use(routes.mixRoutes);
app.use(routes.diagnosticsRoutes);

// =============================================================================
// Error Handling
// =============================================================================

// 404 handler
app.use(notFoundHandler);

// Global error handler
app.use(errorHandler);

// =============================================================================
// Graceful Shutdown
// =============================================================================

function shutdown() {
    console.log('\n[SERVER] Shutting down...');
    db.closeDatabase();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// =============================================================================
// Start Server
// =============================================================================

app.listen(config.server.port, () => {
    console.log(`CPI Web API listening at http://localhost:${config.server.port}`);
    console.log('[DATABASE] Using SQLite for persistent storage (bun:sqlite)');
    console.log('[CONFIG] Game server:', config.gameServer.ip + ':' + config.gameServer.tcpPort);
});
