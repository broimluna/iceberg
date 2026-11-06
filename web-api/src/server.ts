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

// Initialize Express app
const app = express();

// =============================================================================
// Middleware
// =============================================================================

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

// Internal API endpoints - server-to-server only (the SFS2X game server
// calling this WebAPI directly, never the game client). Not part of the
// normal Basic-Auth `authenticate` middleware chain above (these run
// before it, same as before) - restricted instead to localhost callers,
// plus an optional shared-secret header if config.internalApiSecret is
// set. add-coins previously had neither check at all ("no authentication
// required" was true in the most literal sense).
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
 * Server-to-server reward grant - called by the SFS2X game server when
 * its own game logic (quest completion, target hits, etc.) decides a
 * reward is earned, instead of relying on the client to relay a
 * reward.add push into PUT /reward/v1 (routes/reward.ts) faithfully.
 * Reuses that same route's applyRewards(username, reward) - identical
 * reward shape, not reinvented here.
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
 * Server-to-server quest objective grant - called by the SFS2X game
 * server when it receives quest.c_obj (SmartfoxCommand.COMPLETE_OBJECTIVE),
 * so the reward attached to that objective in quests.json (e.g. an
 * equipmentInstances entry) actually gets persisted, instead of the
 * quest.s_obj ack alone (which just acknowledges the objective to the
 * client's own FSM and grants nothing). Resolves questId from the
 * player's current active quest, since quest.c_obj's wire payload only
 * ever carries the bare objective name.
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
// Mount mix routes at both root and /mix to handle different client behaviors
app.use(['/', '/mix'], routes.mixRoutes);
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
