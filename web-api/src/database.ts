/**
 * SQLite Database Module for CPI Web API
 * 
 * This module provides persistent storage for player data using SQLite.
 * It replaces the previous JSON file-based storage with a proper relational database.
 */

import { Database } from "bun:sqlite";
import path from "path";

// Database file path. ICEBERG_DB_PATH lets tools (tools/mod.ts --db) open
// another database through this module.
const DB_PATH = process.env.ICEBERG_DB_PATH || path.join(import.meta.dir, "cpi_data.db");

// Initialize database connection
const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.exec("PRAGMA journal_mode = WAL");
// The server and tools/mod.ts can write at the same time; wait instead of
// failing with "database is locked".
db.exec("PRAGMA busy_timeout = 5000");

// Runs fn in one SQLite transaction. Re-entrant: inside another
// inTransaction it just calls fn, so the outer transaction covers it.
let transactionDepth = 0;
function inTransaction<T>(fn: () => T): T {
    if (transactionDepth > 0) return fn();
    transactionDepth++;
    try {
        return db.transaction(fn)();
    } finally {
        transactionDepth--;
    }
}

/**
 * Initialize all database tables
 */
function initializeDatabase() {
    console.log('[DATABASE] Initializing database...');

    // Players table - core player information
    db.exec(`
        CREATE TABLE IF NOT EXISTS players (
            username TEXT PRIMARY KEY,
            profile_colour INTEGER DEFAULT 3235500,
            profile_days_old INTEGER DEFAULT 1,
            claimed_welcome_kit INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Player assets - coins and various owned items
    db.exec(`
        CREATE TABLE IF NOT EXISTS player_assets (
            username TEXT PRIMARY KEY,
            coins INTEGER DEFAULT 1000,
            saved_outfit_slots INTEGER DEFAULT 0,
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Mascot XP - stored per mascot
    db.exec(`
        CREATE TABLE IF NOT EXISTS mascot_xp (
            username TEXT NOT NULL,
            mascot_name TEXT NOT NULL,
            xp_amount INTEGER DEFAULT 0,
            PRIMARY KEY (username, mascot_name),
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Equipment templates owned by player
    db.exec(`
        CREATE TABLE IF NOT EXISTS owned_equipment_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            template_id INTEGER NOT NULL,
            UNIQUE(username, template_id),
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Durables (items like jackhammer)
    db.exec(`
        CREATE TABLE IF NOT EXISTS owned_durables (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            durable_id INTEGER NOT NULL,
            UNIQUE(username, durable_id),
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Emote packs owned
    db.exec(`
        CREATE TABLE IF NOT EXISTS owned_emote_packs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            emote_pack_id TEXT NOT NULL,
            UNIQUE(username, emote_pack_id),
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Colour packs owned
    db.exec(`
        CREATE TABLE IF NOT EXISTS owned_colour_packs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            colour_pack_id INTEGER NOT NULL,
            UNIQUE(username, colour_pack_id),
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Decals owned
    db.exec(`
        CREATE TABLE IF NOT EXISTS owned_decals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            decal_id INTEGER NOT NULL,
            UNIQUE(username, decal_id),
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Fabrics owned
    db.exec(`
        CREATE TABLE IF NOT EXISTS owned_fabrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            fabric_id INTEGER NOT NULL,
            UNIQUE(username, fabric_id),
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Sizzle clips owned
    db.exec(`
        CREATE TABLE IF NOT EXISTS owned_sizzle_clips (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            sizzle_clip_id INTEGER NOT NULL,
            UNIQUE(username, sizzle_clip_id),
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Tubes owned
    db.exec(`
        CREATE TABLE IF NOT EXISTS owned_tubes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            tube_id INTEGER NOT NULL,
            UNIQUE(username, tube_id),
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Collectible currencies
    db.exec(`
        CREATE TABLE IF NOT EXISTS collectible_currencies (
            username TEXT NOT NULL,
            currency_type TEXT NOT NULL,
            amount INTEGER DEFAULT 0,
            PRIMARY KEY (username, currency_type),
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Quest progress
    db.exec(`
        CREATE TABLE IF NOT EXISTS quests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            quest_id TEXT NOT NULL,
            status INTEGER DEFAULT 0,
            times_completed INTEGER DEFAULT 0,
            unlock_time TEXT,
            completed_time TEXT,
            UNIQUE(username, quest_id),
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Quest completed objectives (many-to-one with quests)
    db.exec(`
        CREATE TABLE IF NOT EXISTS quest_objectives (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            quest_id TEXT NOT NULL,
            objective_id TEXT NOT NULL,
            UNIQUE(username, quest_id, objective_id),
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Daily task progress
    db.exec(`
        CREATE TABLE IF NOT EXISTS community_tasks (
            task_id TEXT PRIMARY KEY,
            counter INTEGER NOT NULL DEFAULT 0,
            day INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS daily_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            task_id TEXT NOT NULL,
            counter INTEGER DEFAULT 0,
            day INTEGER,
            claimed INTEGER DEFAULT 0,
            UNIQUE(username, task_id),
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Tutorial progress (stored as byte array serialized)
    db.exec(`
        CREATE TABLE IF NOT EXISTS tutorial_progress (
            username TEXT PRIMARY KEY,
            tutorial_data TEXT NOT NULL,
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Breadcrumbs
    db.exec(`
        CREATE TABLE IF NOT EXISTS breadcrumbs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            breadcrumb_id INTEGER NOT NULL,
            UNIQUE(username, breadcrumb_id),
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Outfit (equipped items - just the equipment IDs)
    db.exec(`
        CREATE TABLE IF NOT EXISTS outfit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            equipment_id INTEGER NOT NULL,
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Custom equipment (player-created/customized items)
    db.exec(`
        CREATE TABLE IF NOT EXISTS equipment (
            equipment_id INTEGER PRIMARY KEY,
            username TEXT NOT NULL,
            date_time_created INTEGER NOT NULL,
            definition_id INTEGER NOT NULL,
            parts_json TEXT NOT NULL DEFAULT '[]',
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Claimed reward IDs
    db.exec(`
        CREATE TABLE IF NOT EXISTS claimed_rewards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            reward_id INTEGER NOT NULL,
            UNIQUE(username, reward_id),
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Daily spin data
    db.exec(`
        CREATE TABLE IF NOT EXISTS daily_spin_data (
            username TEXT PRIMARY KEY,
            current_chest_id INTEGER DEFAULT 0,
            num_chests_received INTEGER DEFAULT 0,
            num_punches INTEGER DEFAULT 0,
            time_of_last_spin INTEGER DEFAULT 0,
            num_spins_since_chest INTEGER DEFAULT 0,
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Catalog submissions
    db.exec(`
        CREATE TABLE IF NOT EXISTS catalog_submissions (
            clothing_catalog_item_id INTEGER PRIMARY KEY,
            username TEXT NOT NULL,
            creator_name TEXT NOT NULL,
            cost INTEGER DEFAULT 100,
            number_sold INTEGER DEFAULT 0,
            scheduled_theme_challenge_id INTEGER DEFAULT 0,
            date_submitted INTEGER NOT NULL,
            equipment_json TEXT NOT NULL,
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Consumable inventory
    db.exec(`
        CREATE TABLE IF NOT EXISTS consumable_inventory (
            username TEXT NOT NULL,
            consumable_type TEXT NOT NULL,
            item_count INTEGER DEFAULT 0,
            partial_count INTEGER DEFAULT 0,
            PRIMARY KEY (username, consumable_type),
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Igloo data - player's igloo settings
    db.exec(`
        CREATE TABLE IF NOT EXISTS igloo_data (
            username TEXT PRIMARY KEY,
            visibility INTEGER DEFAULT 1,
            active_layout_id INTEGER,
            max_igloo_layouts INTEGER DEFAULT 3,
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Igloo layouts - saved layouts for a player's igloo
    db.exec(`
        CREATE TABLE IF NOT EXISTS igloo_layouts (
            layout_id INTEGER PRIMARY KEY,
            username TEXT NOT NULL,
            name TEXT DEFAULT 'My Igloo',
            zone_id TEXT DEFAULT 'DefaultIgloo',
            lighting_id INTEGER DEFAULT 0,
            music_id INTEGER DEFAULT 0,
            extra_info_json TEXT DEFAULT '{}',
            decorations_layout_json TEXT DEFAULT '[]',
            created_date INTEGER,
            last_modified_date INTEGER,
            member_only INTEGER DEFAULT 1,
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Decoration inventory - decorations owned by player
    db.exec(`
        CREATE TABLE IF NOT EXISTS decoration_inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            definition_id INTEGER NOT NULL,
            type INTEGER NOT NULL,
            custom_id INTEGER,
            count INTEGER DEFAULT 1,
            UNIQUE(username, definition_id, type, custom_id),
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Player identity mapping - maps SWIDs to usernames
    db.exec(`
        CREATE TABLE IF NOT EXISTS player_identity (
            swid TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            display_name TEXT,
            password_hash TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Check if password_hash column exists in player_identity (for existing databases)
    const columns = db.query("PRAGMA table_info(player_identity)").all() as { name: string }[];
    const hasPasswordHash = columns.some(c => c.name === 'password_hash');
    if (!hasPasswordHash) {
        console.log('[DATABASE] Adding password_hash column to player_identity table');
        db.exec('ALTER TABLE player_identity ADD COLUMN password_hash TEXT');
    }

    // Active sessions - maps session IDs to players
    db.exec(`
        CREATE TABLE IF NOT EXISTS player_sessions (
            session_id INTEGER PRIMARY KEY,
            swid TEXT NOT NULL,
            username TEXT NOT NULL,
            room_name TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            last_activity TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (swid) REFERENCES player_identity(swid) ON DELETE CASCADE
        )
    `);
    // World and instance (igloo owner) of the session's room, for the
    // onlineLocation on player cards. Added to older databases here.
    const sessionCols = db.prepare("SELECT name FROM pragma_table_info('player_sessions')").all().map(c => c.name);
    if (!sessionCols.includes('world')) db.exec("ALTER TABLE player_sessions ADD COLUMN world TEXT");
    if (!sessionCols.includes('instance_id')) db.exec("ALTER TABLE player_sessions ADD COLUMN instance_id TEXT DEFAULT ''");

    // Referrals table - tracks who referred whom and pending rewards
    db.exec(`
        CREATE TABLE IF NOT EXISTS referrals (
            username TEXT PRIMARY KEY,
            referred_by TEXT,
            needs_reward INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (username) REFERENCES players(username) ON DELETE CASCADE
        )
    `);

    // Encryption keys table - stores symmetric keys for encrypted communication
    db.exec(`
        CREATE TABLE IF NOT EXISTS encryption_keys (
            key_id TEXT PRIMARY KEY,
            symmetric_key BLOB NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT
        )
    `);

    // Guest controller tokens - access and refresh tokens
    db.exec(`
        CREATE TABLE IF NOT EXISTS guest_controller_tokens (
            token TEXT PRIMARY KEY,
            token_type TEXT NOT NULL,
            swid TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Guest controller API keys
    db.exec(`
        CREATE TABLE IF NOT EXISTS guest_controller_api_keys (
            api_key TEXT PRIMARY KEY,
            request_count INTEGER DEFAULT 0,
            expires_at TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Mix user sessions - stores session data for Mix API
    db.exec(`
        CREATE TABLE IF NOT EXISTS mix_user_sessions (
            swid TEXT PRIMARY KEY,
            session_id INTEGER NOT NULL,
            hashed_user_id TEXT NOT NULL,
            symmetric_key BLOB NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            last_activity TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Mix friendships - friend relationships
    db.exec(`
        CREATE TABLE IF NOT EXISTS mix_friendships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            swid TEXT NOT NULL,
            friend_user_id TEXT NOT NULL,
            is_trusted INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(swid, friend_user_id)
        )
    `);

    // Mix friendship invitations
    db.exec(`
        CREATE TABLE IF NOT EXISTS mix_friendship_invitations (
            invitation_id INTEGER NOT NULL,
            swid TEXT NOT NULL,
            friend_display_name TEXT NOT NULL,
            is_inviter INTEGER DEFAULT 0,
            is_trusted INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (invitation_id, swid)
        )
    `);
    // Each invitation has one row per side (inviter and invitee) with the
    // same invitation_id. Older databases made invitation_id alone the
    // primary key, so the invitee's row always failed to insert.
    const invitationPk = db.prepare("SELECT name FROM pragma_table_info('mix_friendship_invitations') WHERE pk > 0").all();
    if (invitationPk.length === 1) {
        db.exec(`
            ALTER TABLE mix_friendship_invitations RENAME TO mix_friendship_invitations_old;
            CREATE TABLE mix_friendship_invitations (
                invitation_id INTEGER NOT NULL,
                swid TEXT NOT NULL,
                friend_display_name TEXT NOT NULL,
                is_inviter INTEGER DEFAULT 0,
                is_trusted INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (invitation_id, swid)
            );
            INSERT OR IGNORE INTO mix_friendship_invitations SELECT * FROM mix_friendship_invitations_old;
            DROP TABLE mix_friendship_invitations_old;
            -- Half-written invitations from the old schema (inviter row only).
            DELETE FROM mix_friendship_invitations WHERE invitation_id IN (
                SELECT invitation_id FROM mix_friendship_invitations GROUP BY invitation_id HAVING COUNT(*) < 2
            );
        `);
        console.log('[DATABASE] Migrated mix_friendship_invitations to a per-side primary key');
    }

    // Mix alerts
    db.exec(`
        CREATE TABLE IF NOT EXISTS mix_alerts (
            alert_id INTEGER PRIMARY KEY AUTOINCREMENT,
            swid TEXT NOT NULL,
            level TEXT NOT NULL,
            text TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Mix presence state
    db.exec(`
        CREATE TABLE IF NOT EXISTS mix_presence_state (
            swid TEXT PRIMARY KEY,
            state TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Mix pending notifications - for long polling
    db.exec(`
        CREATE TABLE IF NOT EXISTS mix_pending_notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            swid TEXT NOT NULL,
            type TEXT NOT NULL,
            data TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Mix notification sequence numbers are per user and must never repeat
    // or go backwards: the client applies a notification only if its
    // number is exactly one past the last it saw. Seeded once from any
    // pending notifications already stored.
    db.exec(`
        CREATE TABLE IF NOT EXISTS mix_notification_counters (
            swid TEXT PRIMARY KEY,
            last_sequence INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO mix_notification_counters (swid, last_sequence)
            SELECT swid, MAX(sequence) FROM mix_pending_notifications GROUP BY swid;
    `);

    // Moderation (Mix and CPI). The text filter rules are read by
    // services/moderation.ts and edited live with tools/mod.ts.
    const rulesExisted = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mix_moderation_rules'").get();
    db.exec(`
        CREATE TABLE IF NOT EXISTS mix_moderation_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pattern TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('word', 'regex')),
            action TEXT NOT NULL CHECK (action IN ('mask', 'block')),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    if (!rulesExisted) {
        // Starter list, seeded once when the table is first created: the
        // three most common English swear words, masked. Operators extend
        // it with `bun tools/mod.ts rules add`.
        const seed = db.prepare("INSERT INTO mix_moderation_rules (pattern, kind, action) VALUES (?, 'word', 'mask')");
        for (const word of ["fuck", "shit", "bitch"]) seed.run(word);
    }
    db.exec(`
        CREATE TABLE IF NOT EXISTS mix_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reporter_swid TEXT NOT NULL,
            reported_swid TEXT NOT NULL,
            reason TEXT,
            thread_id INTEGER NULL,
            message_id INTEGER NULL,
            source TEXT NOT NULL CHECK (source IN ('mix', 'cpi')),
            status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS mix_sanctions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            swid TEXT NOT NULL,
            type TEXT NOT NULL,
            level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
            alert_id INTEGER,
            moderator TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS mix_bans (
            swid TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('ban', 'lock')),
            until TEXT NULL,
            sanction_id INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            lifted_at TEXT NULL
        )
    `);

    // Create indexes for performance
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_mix_reports_status ON mix_reports(status);
        CREATE INDEX IF NOT EXISTS idx_mix_sanctions_swid ON mix_sanctions(swid);
        CREATE INDEX IF NOT EXISTS idx_mix_bans_swid ON mix_bans(swid);
        CREATE INDEX IF NOT EXISTS idx_quests_username ON quests(username);
        CREATE INDEX IF NOT EXISTS idx_daily_tasks_username ON daily_tasks(username);
        CREATE INDEX IF NOT EXISTS idx_equipment_username ON equipment(username);
        CREATE INDEX IF NOT EXISTS idx_catalog_username ON catalog_submissions(username);
        CREATE INDEX IF NOT EXISTS idx_player_identity_username ON player_identity(username);
        CREATE INDEX IF NOT EXISTS idx_player_identity_display_name ON player_identity(display_name);
        CREATE INDEX IF NOT EXISTS idx_player_sessions_swid ON player_sessions(swid);
        CREATE INDEX IF NOT EXISTS idx_igloo_layouts_username ON igloo_layouts(username);
        CREATE INDEX IF NOT EXISTS idx_decoration_inventory_username ON decoration_inventory(username);
        CREATE INDEX IF NOT EXISTS idx_referrals_referred_by ON referrals(referred_by);
        CREATE INDEX IF NOT EXISTS idx_encryption_keys_expires_at ON encryption_keys(expires_at);
        CREATE INDEX IF NOT EXISTS idx_guest_controller_tokens_swid ON guest_controller_tokens(swid);
        CREATE INDEX IF NOT EXISTS idx_guest_controller_tokens_expires_at ON guest_controller_tokens(expires_at);
        CREATE INDEX IF NOT EXISTS idx_mix_friendships_swid ON mix_friendships(swid);
        CREATE INDEX IF NOT EXISTS idx_mix_friendship_invitations_swid ON mix_friendship_invitations(swid);
        CREATE INDEX IF NOT EXISTS idx_mix_alerts_swid ON mix_alerts(swid);
        CREATE INDEX IF NOT EXISTS idx_mix_pending_notifications_swid ON mix_pending_notifications(swid);
    `);

    console.log('[DATABASE] Database initialized successfully');
}

// ========== PLAYER OPERATIONS ==========

/**
 * Get or create a player record
 */
function getOrCreatePlayer(username) {
    const existing = db.prepare('SELECT * FROM players WHERE username = ?').get(username);
    if (existing) {
        return existing;
    }

    // Create new player with defaults
    const stmt = db.prepare(`
        INSERT INTO players (username, profile_colour, profile_days_old, claimed_welcome_kit)
        VALUES (?, 3235500, 1, 0)
    `);
    stmt.run(username);

    // Create default assets
    db.prepare('INSERT OR IGNORE INTO player_assets (username, coins, saved_outfit_slots) VALUES (?, 1000, 0)').run(username);

    // Create default durables (15 = some default item)
    db.prepare('INSERT OR IGNORE INTO owned_durables (username, durable_id) VALUES (?, 15)').run(username);

    // Create empty tutorial data
    const emptyTutorialData = JSON.stringify(new Array(16).fill(-1));
    db.prepare('INSERT OR IGNORE INTO tutorial_progress (username, tutorial_data) VALUES (?, ?)').run(username, emptyTutorialData);

    return db.prepare('SELECT * FROM players WHERE username = ?').get(username);
}

/**
 * Update player's profile
 */
function updatePlayerProfile(username, colour, daysOld) {
    getOrCreatePlayer(username);
    db.prepare(`
        UPDATE players SET profile_colour = ?, profile_days_old = ?, updated_at = CURRENT_TIMESTAMP
        WHERE username = ?
    `).run(colour, daysOld, username);
}

/**
 * Set claimed welcome kit flag
 */
function setClaimedWelcomeKit(username, claimed) {
    getOrCreatePlayer(username);
    db.prepare('UPDATE players SET claimed_welcome_kit = ? WHERE username = ?').run(claimed ? 1 : 0, username);
}

/**
 * Get full player profile
 */
function getPlayerProfile(username) {
    const player = getOrCreatePlayer(username);
    return {
        colour: player.profile_colour,
        daysOld: player.profile_days_old
    };
}

// ========== PLAYER IDENTITY OPERATIONS ==========

/**
 * Get player info by SWID
 * @param {string} swid - The player's SWID
 * @returns {object|null} { swid, username, displayName } or null if not found
 */
function getPlayerBySwid(swid) {
    const row = db.prepare('SELECT * FROM player_identity WHERE swid = ?').get(swid);
    if (!row) return null;
    
    // Ensure displayName is never empty - fall back through multiple options
    let displayName = row.display_name;
    if (!displayName || displayName.trim() === '') {
        displayName = row.username;
    }
    if (!displayName || displayName.trim() === '') {
        displayName = `Penguin${(swid || 'Unknown').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}`;
    }
    
    return {
        swid: row.swid,
        username: row.username,
        displayName: displayName
    };
}

/**
 * Get player info by display name
 * @param {string} displayName - The player's display name
 * @returns {object|null} { swid, username, displayName } or null if not found
 */
function getPlayerByDisplayName(displayName) {
    // First try exact match on display_name
    let row = db.prepare('SELECT * FROM player_identity WHERE display_name = ? COLLATE NOCASE').get(displayName);
    if (!row) {
        // Fall back to username match
        row = db.prepare('SELECT * FROM player_identity WHERE username = ? COLLATE NOCASE').get(displayName);
    }
    if (!row) return null;
    
    // Ensure displayName is never empty - fall back through multiple options
    let resolvedDisplayName = row.display_name;
    if (!resolvedDisplayName || resolvedDisplayName.trim() === '') {
        resolvedDisplayName = row.username;
    }
    if (!resolvedDisplayName || resolvedDisplayName.trim() === '') {
        resolvedDisplayName = `Penguin${(row.swid || 'Unknown').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}`;
    }
    
    return {
        swid: row.swid,
        username: row.username,
        displayName: resolvedDisplayName
    };
}

/**
 * Get player info by session ID
 * @param {number} sessionId - The session ID
 * @returns {object|null} { swid, username, displayName } or null if not found
 */
function getPlayerBySessionId(sessionId) {
    const session = db.prepare('SELECT * FROM player_sessions WHERE session_id = ?').get(sessionId);
    if (!session) return null;
    return getPlayerBySwid(session.swid);
}

/**
 * Get multiple players by SWIDs
 * @param {string[]} swids - Array of SWIDs
 * @returns {object[]} Array of player info objects
 */
function getPlayersBySwids(swids) {
    if (!swids || swids.length === 0) return [];
    const placeholders = swids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM player_identity WHERE swid IN (${placeholders})`).all(...swids);
    return rows.map(row => ({
        swid: row.swid,
        username: row.username,
        displayName: row.display_name || row.username
    }));
}

/**
 * Get multiple players by display names
 * @param {string[]} displayNames - Array of display names
 * @returns {object[]} Array of player info objects
 */
function getPlayersByDisplayNames(displayNames) {
    if (!displayNames || displayNames.length === 0) return [];
    const results = [];
    for (const name of displayNames) {
        const player = getPlayerByDisplayName(name);
        if (player) results.push(player);
    }
    return results;
}

/**
 * Create a new player from SWID
 * @param {string} swid - The player's SWID
 * @returns {string} The generated username
 */
function createPlayerFromSwid(swid) {
    // Generate a username from the SWID
    // Use a short hash to make it readable
    const hash = swid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
    const username = `Penguin${hash}`;
    
    // Create the player record
    getOrCreatePlayer(username);
    
    // Create identity mapping
    db.prepare(`
        INSERT OR REPLACE INTO player_identity (swid, username, display_name)
        VALUES (?, ?, ?)
    `).run(swid, username, username);
    
    return username;
}

/**
 * Update player's display name
 * @param {string} swid - The player's SWID
 * @param {string} displayName - The new display name
 */
function setPlayerDisplayName(swid, displayName) {
    // Don't allow empty display names
    if (!displayName || displayName.trim() === '') {
        console.warn(`[DATABASE] Attempted to set empty display name for SWID ${swid}, ignoring`);
        return;
    }
    
    const player = getPlayerBySwid(swid);
    if (player) {
        db.prepare('UPDATE player_identity SET display_name = ? WHERE swid = ?').run(displayName.trim(), swid);
    }
}

/**
 * Set player password hash
 * @param {string} swid - The player's SWID
 * @param {string} passwordHash - The hashed password
 */
function setPlayerPassword(swid, passwordHash) {
    db.prepare('UPDATE player_identity SET password_hash = ? WHERE swid = ?').run(passwordHash, swid);
}

/**
 * Get player password hash
 * @param {string} swid - The player's SWID
 * @returns {string|null} The password hash or null
 */
function getPlayerPassword(swid) {
    const row = db.prepare('SELECT password_hash FROM player_identity WHERE swid = ?').get(swid);
    return row?.password_hash;
}

/**
 * Register or update a player session
 * @param {string} swid - The player's SWID
 * @param {number} sessionId - The session ID
 * @param {string} roomName - The room name
 */
// last_activity is SQLite CURRENT_TIMESTAMP text ("YYYY-MM-DD HH:MM:SS",
// UTC), so it's compared with datetime(), never with a JS ISO string. It's
// only written when a room is joined; the game server deletes the row when
// the connection closes (/api/internal/session-ended), so the window is
// only a backstop for a game server that died without reporting.
const SESSION_ONLINE_WINDOW = '-12 hours';

function registerPlayerSession(swid, sessionId, roomName, world = null, instanceId = '') {
    const player = getPlayerBySwid(swid);
    if (!player) {
        console.log(`[DB] registerPlayerSession: No player found for SWID ${swid}`);
        return;
    }
    
    console.log(`[DB] registerPlayerSession: Registering session ${sessionId} for ${swid} (${player.username}) in room ${roomName}`);
    db.prepare(`
        INSERT OR REPLACE INTO player_sessions (session_id, swid, username, room_name, world, instance_id, last_activity)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(sessionId, swid, player.username, roomName, world, instanceId || '');
    console.log(`[DB] registerPlayerSession: Session registered successfully`);
}

/**
 * Get online player SWIDs from a list
 * @param {string[]} swids - Array of SWIDs to check
 * @returns {string[]} Array of online SWIDs
 */
function getOnlinePlayerSwids(swids) {
    if (!swids || swids.length === 0) return [];
    
    const placeholders = swids.map(() => '?').join(',');
    const rows = db.prepare(`
        SELECT DISTINCT swid FROM player_sessions 
        WHERE swid IN (${placeholders}) AND last_activity > datetime('now', ?)
    `).all(...swids, SESSION_ONLINE_WINDOW);
    
    return rows.map(r => r.swid);
}

/**
 * Remove expired sessions
 */
function cleanupExpiredSessions() {
    db.prepare("DELETE FROM player_sessions WHERE last_activity < datetime('now', ?)").run(SESSION_ONLINE_WINDOW);
}

/**
 * Delete a specific session
 * @param {number} sessionId - The session ID to delete
 */
function deleteSession(sessionId) {
    db.prepare('DELETE FROM player_sessions WHERE session_id = ?').run(sessionId);
}

/**
 * Get session by session ID
 * @param {number} sessionId - The session ID
 * @returns {object|null} Session data or null
 */
function getSession(sessionId) {
    return db.prepare('SELECT * FROM player_sessions WHERE session_id = ?').get(sessionId);
}

/**
 * Get active session by player SWID
 * @param {string} swid - The player's SWID
 * @returns {object|null} Session data or null if player not online
 */
function getActiveSessionBySwid(swid) {
    const result = db.prepare(`
        SELECT * FROM player_sessions 
        WHERE swid = ? AND last_activity > datetime('now', ?)
        ORDER BY last_activity DESC
        LIMIT 1
    `).get(swid, SESSION_ONLINE_WINDOW);
    console.log(`[DB] getActiveSessionBySwid: Result =`, result);
    return result;
}

/**
 * Update session with world and room info
 * @param {number} sessionId - The session ID
 * @param {string} worldName - The world name
 * @param {string} roomName - The room name
 */
function updateSessionLocation(sessionId, worldName, roomName) {
    db.prepare(`
        UPDATE player_sessions 
        SET room_name = ?, last_activity = CURRENT_TIMESTAMP
        WHERE session_id = ?
    `).run(roomName, sessionId);
}

/**
 * Get room population for a world
 * @param {string} worldName - The world name to query
 * @param {string[]} roomNames - List of rooms to check
 * @returns {object[]} Array of room populations
 */
function getRoomPopulationsForWorld(worldName, roomNames) {
    
    // Get counts for each room
    const populations = [];
    for (const roomName of roomNames) {
        const row = db.prepare(`
            SELECT COUNT(*) as count FROM player_sessions 
            WHERE room_name = ? AND last_activity > datetime('now', ?)
        `).get(roomName, SESSION_ONLINE_WINDOW);
        
        populations.push({
            roomName: roomName,
            count: row?.count || 0
        });
    }
    
    return populations;
}

/**
 * Get room population across all worlds for a specific room
 * @param {string} roomName - The room name
 * @param {string[]} worldNames - List of world names
 * @returns {object[]} Array of world populations
 */
function getRoomPopulationAcrossWorlds(roomName, worldNames) {
    
    // Currently we track by room name, not world - for now return zero population for each world
    // In a full implementation, we'd store world info in the session
    const row = db.prepare(`
        SELECT COUNT(*) as count FROM player_sessions 
        WHERE room_name = ? AND last_activity > datetime('now', ?)
    `).get(roomName, SESSION_ONLINE_WINDOW);
    
    const totalCount = row?.count || 0;
    
    // Distribute evenly across worlds (simplified approach)
    return worldNames.map(world => ({
        worldName: world,
        count: Math.floor(totalCount / worldNames.length)
    }));
}

/**
 * Get all active sessions count by room
 * @returns {object} Map of room name to player count
 */
function getActiveSessionsByRoom() {
    
    const rows = db.prepare(`
        SELECT room_name, COUNT(*) as count FROM player_sessions 
        WHERE last_activity > datetime('now', ?)
        GROUP BY room_name
    `).all(SESSION_ONLINE_WINDOW);
    
    const result = {};
    rows.forEach(row => {
        if (row.room_name) {
            result[row.room_name] = row.count;
        }
    });
    return result;
}

/**
 * Check if a player identity exists
 */
function playerIdentityExists(swid) {
    const row = db.prepare('SELECT 1 FROM player_identity WHERE swid = ?').get(swid);
    return !!row;
}

/**
 * Get all registered players (for admin purposes)
 */
function getAllPlayers() {
    return db.prepare('SELECT * FROM player_identity ORDER BY created_at DESC').all();
}

// ========== ASSETS OPERATIONS ==========

/**
 * Get player assets
 */
function getPlayerAssets(username) {
    getOrCreatePlayer(username);
    
    const assetsRow = db.prepare('SELECT * FROM player_assets WHERE username = ?').get(username);
    
    // Get mascot XP
    const mascotXP = {};
    const xpRows = db.prepare('SELECT mascot_name, xp_amount FROM mascot_xp WHERE username = ?').all(username);
    xpRows.forEach(row => { mascotXP[row.mascot_name] = row.xp_amount; });

    // Get collectible currencies
    const collectibleCurrencies = {};
    const currencyRows = db.prepare('SELECT currency_type, amount FROM collectible_currencies WHERE username = ?').all(username);
    currencyRows.forEach(row => { collectibleCurrencies[row.currency_type] = row.amount; });

    // Get owned items
    const colourPacks = db.prepare('SELECT colour_pack_id FROM owned_colour_packs WHERE username = ?').all(username).map(r => r.colour_pack_id);
    const decals = db.prepare('SELECT decal_id FROM owned_decals WHERE username = ?').all(username).map(r => r.decal_id);
    const fabrics = db.prepare('SELECT fabric_id FROM owned_fabrics WHERE username = ?').all(username).map(r => r.fabric_id);
    const emotePacks = db.prepare('SELECT emote_pack_id FROM owned_emote_packs WHERE username = ?').all(username).map(r => r.emote_pack_id);
    const sizzleClips = db.prepare('SELECT sizzle_clip_id FROM owned_sizzle_clips WHERE username = ?').all(username).map(r => r.sizzle_clip_id);
    const equipmentTemplates = db.prepare('SELECT template_id FROM owned_equipment_templates WHERE username = ?').all(username).map(r => r.template_id);
    const durables = db.prepare('SELECT durable_id FROM owned_durables WHERE username = ?').all(username).map(r => r.durable_id);
    const tubes = db.prepare('SELECT tube_id FROM owned_tubes WHERE username = ?').all(username).map(r => r.tube_id);

    return {
        coins: assetsRow?.coins || 1000,
        mascotXP: mascotXP,
        collectibleCurrencies: collectibleCurrencies,
        colourPacks: colourPacks,
        decals: decals,
        fabrics: fabrics,
        emotePacks: emotePacks,
        sizzleClips: sizzleClips,
        equipmentTemplates: equipmentTemplates,
        lots: [],
        decorations: [],
        structures: [],
        musicTracks: [],
        lighting: [],
        durables: durables,
        partySupplies: [],
        tubes: tubes,
        savedOutfitSlots: assetsRow?.saved_outfit_slots || 0
    };
}

/**
 * Update player coins
 */
function updatePlayerCoins(username, coins) {
    getOrCreatePlayer(username);
    db.prepare('UPDATE player_assets SET coins = ? WHERE username = ?').run(coins, username);
}

/**
 * Add coins to player
 */
function addPlayerCoins(username, amount) {
    getOrCreatePlayer(username);
    db.prepare('UPDATE player_assets SET coins = coins + ? WHERE username = ?').run(amount, username);
    return db.prepare('SELECT coins FROM player_assets WHERE username = ?').get(username).coins;
}

/**
 * Get player coins
 */
function getPlayerCoins(username) {
    getOrCreatePlayer(username);
    const row = db.prepare('SELECT coins FROM player_assets WHERE username = ?').get(username);
    return row?.coins || 1000;
}

// ========== MASCOT XP OPERATIONS ==========

/**
 * Get mascot XP for a player
 */
function getMascotXP(username) {
    getOrCreatePlayer(username);
    const mascotXP = {};
    const rows = db.prepare('SELECT mascot_name, xp_amount FROM mascot_xp WHERE username = ?').all(username);
    rows.forEach(row => { mascotXP[row.mascot_name] = row.xp_amount; });
    return mascotXP;
}

/**
 * Set mascot XP for a specific mascot
 */
function setMascotXP(username, mascotName, xpAmount) {
    getOrCreatePlayer(username);
    db.prepare(`
        INSERT INTO mascot_xp (username, mascot_name, xp_amount) VALUES (?, ?, ?)
        ON CONFLICT(username, mascot_name) DO UPDATE SET xp_amount = excluded.xp_amount
    `).run(username, mascotName, xpAmount);
}

/**
 * Add XP to a mascot
 */
function addMascotXP(username, mascotName, xpToAdd) {
    getOrCreatePlayer(username);
    const current = db.prepare('SELECT xp_amount FROM mascot_xp WHERE username = ? AND mascot_name = ?').get(username, mascotName);
    const newAmount = (current?.xp_amount || 0) + xpToAdd;
    setMascotXP(username, mascotName, newAmount);
    return newAmount;
}

// ========== OWNED ITEMS OPERATIONS ==========

function addEquipmentTemplate(username, templateId) {
    getOrCreatePlayer(username);
    db.prepare('INSERT OR IGNORE INTO owned_equipment_templates (username, template_id) VALUES (?, ?)').run(username, templateId);
}

function addDurable(username, durableId) {
    getOrCreatePlayer(username);
    db.prepare('INSERT OR IGNORE INTO owned_durables (username, durable_id) VALUES (?, ?)').run(username, durableId);
}

function addEmotePack(username, emotePackId) {
    getOrCreatePlayer(username);
    db.prepare('INSERT OR IGNORE INTO owned_emote_packs (username, emote_pack_id) VALUES (?, ?)').run(username, String(emotePackId));
}

function addColourPack(username, colourPackId) {
    getOrCreatePlayer(username);
    db.prepare('INSERT OR IGNORE INTO owned_colour_packs (username, colour_pack_id) VALUES (?, ?)').run(username, colourPackId);
}

function addDecal(username, decalId) {
    getOrCreatePlayer(username);
    db.prepare('INSERT OR IGNORE INTO owned_decals (username, decal_id) VALUES (?, ?)').run(username, decalId);
}

function addFabric(username, fabricId) {
    getOrCreatePlayer(username);
    db.prepare('INSERT OR IGNORE INTO owned_fabrics (username, fabric_id) VALUES (?, ?)').run(username, fabricId);
}

function addSizzleClip(username, sizzleClipId) {
    getOrCreatePlayer(username);
    db.prepare('INSERT OR IGNORE INTO owned_sizzle_clips (username, sizzle_clip_id) VALUES (?, ?)').run(username, sizzleClipId);
}

function addTube(username, tubeId) {
    getOrCreatePlayer(username);
    db.prepare('INSERT OR IGNORE INTO owned_tubes (username, tube_id) VALUES (?, ?)').run(username, tubeId);
}

function addCollectibleCurrency(username, currencyType, amount) {
    getOrCreatePlayer(username);
    db.prepare(`
        INSERT INTO collectible_currencies (username, currency_type, amount) VALUES (?, ?, ?)
        ON CONFLICT(username, currency_type) DO UPDATE SET amount = amount + excluded.amount
    `).run(username, currencyType, amount);
}

// ========== QUEST OPERATIONS ==========

/**
 * Get all quests for a player
 */
function getQuests(username) {
    getOrCreatePlayer(username);
    const questRows = db.prepare('SELECT * FROM quests WHERE username = ?').all(username);
    
    return questRows.map(q => {
        // Get completed objectives for this quest
        const objectives = db.prepare('SELECT objective_id FROM quest_objectives WHERE username = ? AND quest_id = ?')
            .all(username, q.quest_id)
            .map(o => o.objective_id);
        
        return {
            questId: q.quest_id,
            status: q.status,
            completedObjectives: objectives,
            timesCompleted: q.times_completed,
            unlockTime: q.unlock_time,
            completedTime: q.completed_time
        };
    });
}

/**
 * Get or create a quest for a player
 */
function getOrCreateQuest(username, questId) {
    getOrCreatePlayer(username);
    const existing = db.prepare('SELECT * FROM quests WHERE username = ? AND quest_id = ?').get(username, questId);
    
    if (existing) {
        const objectives = db.prepare('SELECT objective_id FROM quest_objectives WHERE username = ? AND quest_id = ?')
            .all(username, questId)
            .map(o => o.objective_id);
        return {
            questId: existing.quest_id,
            status: existing.status,
            completedObjectives: objectives,
            timesCompleted: existing.times_completed,
            unlockTime: existing.unlock_time,
            completedTime: existing.completed_time
        };
    }

    db.prepare(`
        INSERT INTO quests (username, quest_id, status, times_completed) VALUES (?, ?, 0, 0)
    `).run(username, questId);

    return {
        questId: questId,
        status: 0,
        completedObjectives: [],
        timesCompleted: 0,
        unlockTime: null,
        completedTime: null
    };
}

/**
 * Update quest status
 */
function updateQuestStatus(username, questId, status, timesCompleted = null, completedTime = null) {
    getOrCreateQuest(username, questId);
    
    if (timesCompleted !== null && completedTime !== null) {
        db.prepare(`
            UPDATE quests SET status = ?, times_completed = ?, completed_time = ? WHERE username = ? AND quest_id = ?
        `).run(status, timesCompleted, completedTime, username, questId);
    } else if (timesCompleted !== null) {
        db.prepare(`
            UPDATE quests SET status = ?, times_completed = ? WHERE username = ? AND quest_id = ?
        `).run(status, timesCompleted, username, questId);
    } else {
        db.prepare('UPDATE quests SET status = ? WHERE username = ? AND quest_id = ?').run(status, username, questId);
    }
}

/**
 * Add completed objective to a quest
 */
function addQuestObjective(username, questId, objectiveId) {
    getOrCreateQuest(username, questId);
    db.prepare('INSERT OR IGNORE INTO quest_objectives (username, quest_id, objective_id) VALUES (?, ?, ?)').run(username, questId, objectiveId);
}

/**
 * Clear quest objectives (for replaying)
 */
function clearQuestObjectives(username, questId) {
    db.prepare('DELETE FROM quest_objectives WHERE username = ? AND quest_id = ?').run(username, questId);
}

/**
 * Suspend all active quests except one
 */
function suspendOtherQuests(username, exceptQuestId) {
    db.prepare('UPDATE quests SET status = 2 WHERE username = ? AND quest_id != ? AND status = 1').run(username, exceptQuestId);
}

// ========== DAILY TASK OPERATIONS ==========

/**
 * Get all daily tasks for a player
 */
// Daily task progress belongs to a day: whole UTC days since the epoch,
// the same value the game server uses (smartfox-server/src/daily-tasks.ts).
// Rows from earlier days are ignored and overwritten.
function currentTaskDay(now = Date.now()) {
    return Math.floor(now / 86400000);
}

function getDailyTasks(username) {
    getOrCreatePlayer(username);
    const day = currentTaskDay();
    const rows = db.prepare('SELECT * FROM daily_tasks WHERE username = ? AND day = ?').all(username, day);
    const progress = new Map(rows.map(t => [t.task_id, {
        taskId: t.task_id,
        counter: t.counter,
        day: t.day,
        claimed: t.claimed === 1
    }]));
    // Community tasks: everyone's shared counter, with this player's own
    // claimed flag.
    for (const c of db.prepare('SELECT * FROM community_tasks WHERE day = ?').all(day)) {
        const own = progress.get(c.task_id);
        progress.set(c.task_id, { taskId: c.task_id, counter: c.counter, day, claimed: own?.claimed ?? false });
    }
    return [...progress.values()];
}

/**
 * Get or create a daily task
 */
function getOrCreateDailyTask(username, taskId) {
    getOrCreatePlayer(username);
    const existing = db.prepare('SELECT * FROM daily_tasks WHERE username = ? AND task_id = ?').get(username, taskId);
    
    if (existing) {
        return {
            taskId: existing.task_id,
            counter: existing.counter,
            day: existing.day,
            claimed: existing.claimed === 1
        };
    }

    db.prepare('INSERT INTO daily_tasks (username, task_id, counter, day, claimed) VALUES (?, ?, 0, ?, 0)')
        .run(username, taskId, Date.now());

    return { taskId, counter: 0, day: Date.now(), claimed: false };
}

/**
 * Update daily task
 */
function updateDailyTask(username, taskId, counter = null, day = null, claimed = null) {
    getOrCreateDailyTask(username, taskId);
    
    const updates = [];
    const params = [];
    
    if (counter !== null) { updates.push('counter = ?'); params.push(counter); }
    if (day !== null) { updates.push('day = ?'); params.push(day); }
    if (claimed !== null) { updates.push('claimed = ?'); params.push(claimed ? 1 : 0); }
    
    if (updates.length > 0) {
        params.push(username, taskId);
        db.prepare(`UPDATE daily_tasks SET ${updates.join(', ')} WHERE username = ? AND task_id = ?`).run(...params);
    }
}

// Sets a task's counter for a day (from the game server). A row left from
// an earlier day starts over, unclaimed.
function setDailyTaskCounter(username, taskId, counter, day) {
    getOrCreatePlayer(username);
    db.prepare(`
        INSERT INTO daily_tasks (username, task_id, counter, day, claimed) VALUES (?, ?, ?, ?, 0)
        ON CONFLICT(username, task_id) DO UPDATE SET
            counter = excluded.counter,
            claimed = CASE WHEN daily_tasks.day = excluded.day THEN daily_tasks.claimed ELSE 0 END,
            day = excluded.day
    `).run(username, taskId, counter, day);
}

function getCommunityTaskCounter(taskId, day = currentTaskDay()) {
    const row = db.prepare('SELECT counter FROM community_tasks WHERE task_id = ? AND day = ?').get(taskId, day);
    return row ? row.counter : 0;
}

function setCommunityTaskCounter(taskId, counter, day) {
    db.prepare(`
        INSERT INTO community_tasks (task_id, counter, day) VALUES (?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET counter = excluded.counter, day = excluded.day
    `).run(taskId, counter, day);
}

// Today's row for one task, or null.
function getTodaysDailyTask(username, taskId) {
    const row = db.prepare('SELECT * FROM daily_tasks WHERE username = ? AND task_id = ? AND day = ?').get(username, taskId, currentTaskDay());
    return row ? { taskId: row.task_id, counter: row.counter, day: row.day, claimed: row.claimed === 1 } : null;
}

// Marks today's row claimed. Returns false if it was already claimed or
// doesn't exist, so a reward is paid once.
function claimTodaysDailyTask(username, taskId) {
    // Community tasks have no counter row for the player until claimed.
    db.prepare('INSERT OR IGNORE INTO daily_tasks (username, task_id, counter, day, claimed) VALUES (?, ?, 0, ?, 0)').run(username, taskId, currentTaskDay());
    db.prepare('UPDATE daily_tasks SET counter = 0, claimed = 0, day = ? WHERE username = ? AND task_id = ? AND day != ?').run(currentTaskDay(), username, taskId, currentTaskDay());
    const info = db.prepare('UPDATE daily_tasks SET claimed = 1 WHERE username = ? AND task_id = ? AND day = ? AND claimed = 0').run(username, taskId, currentTaskDay());
    return info.changes === 1;
}

// ========== TUTORIAL OPERATIONS ==========

/**
 * Get tutorial data for a player
 */
function getTutorialData(username) {
    getOrCreatePlayer(username);
    const row = db.prepare('SELECT tutorial_data FROM tutorial_progress WHERE username = ?').get(username);
    if (row) {
        return JSON.parse(row.tutorial_data);
    }
    return new Array(16).fill(-1);
}

/**
 * Set tutorial data
 */
function setTutorialData(username, tutorialData) {
    getOrCreatePlayer(username);
    db.prepare(`
        INSERT INTO tutorial_progress (username, tutorial_data) VALUES (?, ?)
        ON CONFLICT(username) DO UPDATE SET tutorial_data = excluded.tutorial_data
    `).run(username, JSON.stringify(tutorialData));
}

/**
 * Mark a tutorial as complete
 */
function completeTutorial(username, tutorialId) {
    const data = getTutorialData(username);
    const byteIndex = Math.floor(tutorialId / 8);
    const bitIndex = tutorialId % 8;
    if (byteIndex < data.length) {
        data[byteIndex] |= (1 << bitIndex);
        setTutorialData(username, data);
    }
}

// ========== BREADCRUMB OPERATIONS ==========

/**
 * Get breadcrumbs for a player
 */
function getBreadcrumbs(username) {
    getOrCreatePlayer(username);
    const rows = db.prepare('SELECT breadcrumb_id FROM breadcrumbs WHERE username = ?').all(username);
    return rows.map(r => r.breadcrumb_id);
}

/**
 * Add a breadcrumb
 */
function addBreadcrumb(username, breadcrumbId) {
    getOrCreatePlayer(username);
    db.prepare('INSERT OR IGNORE INTO breadcrumbs (username, breadcrumb_id) VALUES (?, ?)').run(username, breadcrumbId);
}

/**
 * Remove breadcrumbs
 */
function removeBreadcrumbs(username, breadcrumbIds) {
    getOrCreatePlayer(username);
    const placeholders = breadcrumbIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM breadcrumbs WHERE username = ? AND breadcrumb_id IN (${placeholders})`).run(username, ...breadcrumbIds);
}

// ========== OUTFIT OPERATIONS ==========

/**
 * Get equipped outfit (equipment IDs)
 */
function getOutfit(username) {
    getOrCreatePlayer(username);
    const rows = db.prepare('SELECT equipment_id FROM outfit WHERE username = ?').all(username);
    return rows.map(r => r.equipment_id);
}

/**
 * Set outfit (replace all equipped items)
 */
function setOutfit(username, equipmentIds) {
    getOrCreatePlayer(username);
    
    // Clear existing outfit
    db.prepare('DELETE FROM outfit WHERE username = ?').run(username);
    
    // Insert new outfit items
    const insert = db.prepare('INSERT INTO outfit (username, equipment_id) VALUES (?, ?)');
    equipmentIds.forEach(id => insert.run(username, id));
}

// ========== EQUIPMENT OPERATIONS ==========

/**
 * Get all equipment for a player
 */
function getEquipment(username) {
    getOrCreatePlayer(username);
    const rows = db.prepare('SELECT * FROM equipment WHERE username = ?').all(username);
    return rows.map(e => ({
        equipmentId: e.equipment_id,
        dateTimeCreated: e.date_time_created,
        definitionId: e.definition_id,
        parts: JSON.parse(e.parts_json)
    }));
}

/**
 * Get a single equipment item
 */
function getEquipmentById(username, equipmentId) {
    const row = db.prepare('SELECT * FROM equipment WHERE username = ? AND equipment_id = ?').get(username, equipmentId);
    if (!row) return null;
    return {
        equipmentId: row.equipment_id,
        dateTimeCreated: row.date_time_created,
        definitionId: row.definition_id,
        parts: JSON.parse(row.parts_json)
    };
}

/**
 * Create or update equipment
 */
function saveEquipment(username, equipment) {
    getOrCreatePlayer(username);
    return db.prepare(`
        INSERT INTO equipment (equipment_id, username, date_time_created, definition_id, parts_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(equipment_id) DO UPDATE SET
            date_time_created = excluded.date_time_created,
            definition_id = excluded.definition_id,
            parts_json = excluded.parts_json
    `).run(
        equipment.equipmentId,
        username,
        equipment.dateTimeCreated,
        equipment.definitionId,
        JSON.stringify(equipment.parts || [])
    );
}

/**
 * Delete equipment
 */
function deleteEquipment(username, equipmentId) {
    db.prepare('DELETE FROM equipment WHERE username = ? AND equipment_id = ?').run(username, equipmentId);
}

// ========== CLAIMED REWARDS OPERATIONS ==========

/**
 * Get claimed reward IDs
 */
function getClaimedRewards(username) {
    getOrCreatePlayer(username);
    const rows = db.prepare('SELECT reward_id FROM claimed_rewards WHERE username = ?').all(username);
    return rows.map(r => r.reward_id);
}

/**
 * Add claimed reward
 */
function addClaimedReward(username, rewardId) {
    getOrCreatePlayer(username);
    db.prepare('INSERT OR IGNORE INTO claimed_rewards (username, reward_id) VALUES (?, ?)').run(username, rewardId);
}

// ========== DAILY SPIN OPERATIONS ==========

/**
 * Get daily spin data
 */
function getDailySpinData(username) {
    getOrCreatePlayer(username);
    const row = db.prepare('SELECT * FROM daily_spin_data WHERE username = ?').get(username);
    
    if (!row) {
        return {
            currentChestId: 0,
            numChestsReceivedOfCurrentChestId: 0,
            numPunchesOnCurrentChest: 0,
            timeOfLastSpinInMilliseconds: 0,
            numSpinsSinceReceivedChest: 0
        };
    }
    
    return {
        currentChestId: row.current_chest_id,
        numChestsReceivedOfCurrentChestId: row.num_chests_received,
        numPunchesOnCurrentChest: row.num_punches,
        timeOfLastSpinInMilliseconds: row.time_of_last_spin,
        numSpinsSinceReceivedChest: row.num_spins_since_chest
    };
}

/**
 * Save daily spin data
 */
function saveDailySpinData(username, spinData) {
    getOrCreatePlayer(username);
    db.prepare(`
        INSERT INTO daily_spin_data (username, current_chest_id, num_chests_received, num_punches, time_of_last_spin, num_spins_since_chest)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(username) DO UPDATE SET
            current_chest_id = excluded.current_chest_id,
            num_chests_received = excluded.num_chests_received,
            num_punches = excluded.num_punches,
            time_of_last_spin = excluded.time_of_last_spin,
            num_spins_since_chest = excluded.num_spins_since_chest
    `).run(
        username,
        spinData.currentChestId || 0,
        spinData.numChestsReceivedOfCurrentChestId || 0,
        spinData.numPunchesOnCurrentChest || 0,
        spinData.timeOfLastSpinInMilliseconds || 0,
        spinData.numSpinsSinceReceivedChest || 0
    );
}

// ========== CATALOG SUBMISSION OPERATIONS ==========

/**
 * Get all catalog submissions (optionally filtered by theme)
 */
function getCatalogSubmissions(themeId = null) {
    let query = 'SELECT * FROM catalog_submissions';
    let params = [];
    
    if (themeId !== null && themeId !== 0) {
        query += ' WHERE scheduled_theme_challenge_id = ?';
        params.push(themeId);
    }
    
    const rows = db.prepare(query).all(...params);
    return rows.map(s => ({
        clothingCatalogItemId: s.clothing_catalog_item_id,
        creatorName: s.creator_name,
        cost: s.cost,
        numberSold: s.number_sold,
        scheduledThemeChallengeId: s.scheduled_theme_challenge_id,
        dateSubmitted: s.date_submitted,
        equipment: JSON.parse(s.equipment_json)
    }));
}

/**
 * Get catalog submissions for a specific player
 */
function getPlayerCatalogSubmissions(username) {
    const rows = db.prepare('SELECT * FROM catalog_submissions WHERE username = ?').all(username);
    return rows.map(s => ({
        clothingCatalogItemId: s.clothing_catalog_item_id,
        creatorName: s.creator_name,
        cost: s.cost,
        numberSold: s.number_sold,
        scheduledThemeChallengeId: s.scheduled_theme_challenge_id,
        dateSubmitted: s.date_submitted,
        equipment: JSON.parse(s.equipment_json)
    }));
}

/**
 * Add catalog submission
 */
function addCatalogSubmission(username, submission) {
    getOrCreatePlayer(username);
    db.prepare(`
        INSERT INTO catalog_submissions (clothing_catalog_item_id, username, creator_name, cost, number_sold, scheduled_theme_challenge_id, date_submitted, equipment_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        submission.clothingCatalogItemId,
        username,
        submission.creatorName,
        submission.cost || 100,
        submission.numberSold || 0,
        submission.scheduledThemeChallengeId || 0,
        submission.dateSubmitted,
        JSON.stringify(submission.equipment)
    );
}

// ========== CONSUMABLE INVENTORY OPERATIONS ==========

/**
 * Get consumable inventory
 */
function getConsumableInventory(username) {
    getOrCreatePlayer(username);
    const rows = db.prepare('SELECT * FROM consumable_inventory WHERE username = ?').all(username);
    const inventoryMap = {};
    rows.forEach(r => {
        inventoryMap[r.consumable_type] = {
            itemCount: r.item_count,
            partialCount: r.partial_count
        };
    });
    return { inventoryMap };
}

/**
 * Update consumable inventory
 */
function updateConsumable(username, consumableType, itemCount, partialCount = 0) {
    getOrCreatePlayer(username);
    db.prepare(`
        INSERT INTO consumable_inventory (username, consumable_type, item_count, partial_count)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(username, consumable_type) DO UPDATE SET
            item_count = excluded.item_count,
            partial_count = excluded.partial_count
    `).run(username, consumableType, itemCount, partialCount);
}

/**
 * Add consumable to inventory
 */
function addConsumable(username, consumableType, count) {
    getOrCreatePlayer(username);
    db.prepare(`
        INSERT INTO consumable_inventory (username, consumable_type, item_count, partial_count)
        VALUES (?, ?, ?, 0)
        ON CONFLICT(username, consumable_type) DO UPDATE SET item_count = item_count + ?
    `).run(username, consumableType, count, count);
}

// ========== IGLOO OPERATIONS ==========

/**
 * Get igloo data for a player
 */
function getIglooData(username) {
    getOrCreatePlayer(username);
    const row = db.prepare('SELECT * FROM igloo_data WHERE username = ?').get(username);
    
    if (!row) {
        // Return default igloo data
        return {
            visibility: 1,
            activeLayoutId: null,
            activeLayout: null,
            maxIglooLayouts: 3
        };
    }
    
    // Get the active layout if there is one
    let activeLayout = null;
    if (row.active_layout_id) {
        activeLayout = getIglooLayout(username, row.active_layout_id);
    }
    
    return {
        visibility: row.visibility,
        activeLayoutId: row.active_layout_id,
        activeLayout: activeLayout,
        maxIglooLayouts: row.max_igloo_layouts
    };
}

/**
 * Save igloo data for a player
 */
function saveIglooData(username, iglooData) {
    getOrCreatePlayer(username);
    db.prepare(`
        INSERT INTO igloo_data (username, visibility, active_layout_id, max_igloo_layouts)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(username) DO UPDATE SET
            visibility = excluded.visibility,
            active_layout_id = excluded.active_layout_id,
            max_igloo_layouts = excluded.max_igloo_layouts
    `).run(
        username,
        iglooData.visibility !== undefined ? iglooData.visibility : 1,
        iglooData.activeLayoutId || null,
        iglooData.maxIglooLayouts || 3
    );
}

/**
 * Get all igloo layouts for a player
 */
function getIglooLayouts(username) {
    getOrCreatePlayer(username);
    const rows = db.prepare('SELECT * FROM igloo_layouts WHERE username = ?').all(username);
    
    return rows.map(row => ({
        layoutId: row.layout_id,
        name: row.name,
        zoneId: row.zone_id,
        lightingId: row.lighting_id,
        musicId: row.music_id,
        extraInfo: JSON.parse(row.extra_info_json || '{}'),
        decorationsLayout: JSON.parse(row.decorations_layout_json || '[]'),
        createdDate: row.created_date,
        lastModifiedDate: row.last_modified_date,
        memberOnly: row.member_only === 1
    }));
}

/**
 * Get a specific igloo layout
 */
function getIglooLayout(username, layoutId) {
    const row = db.prepare('SELECT * FROM igloo_layouts WHERE username = ? AND layout_id = ?').get(username, layoutId);
    
    if (!row) return null;
    
    return {
        layoutId: row.layout_id,
        name: row.name,
        zoneId: row.zone_id,
        lightingId: row.lighting_id,
        musicId: row.music_id,
        extraInfo: JSON.parse(row.extra_info_json || '{}'),
        decorationsLayout: JSON.parse(row.decorations_layout_json || '[]'),
        createdDate: row.created_date,
        lastModifiedDate: row.last_modified_date,
        memberOnly: row.member_only === 1
    };
}

/**
 * Save an igloo layout
 */
function saveIglooLayout(username, layout) {
    getOrCreatePlayer(username);
    db.prepare(`
        INSERT INTO igloo_layouts (layout_id, username, name, zone_id, lighting_id, music_id, extra_info_json, decorations_layout_json, created_date, last_modified_date, member_only)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(layout_id) DO UPDATE SET
            name = excluded.name,
            zone_id = excluded.zone_id,
            lighting_id = excluded.lighting_id,
            music_id = excluded.music_id,
            extra_info_json = excluded.extra_info_json,
            decorations_layout_json = excluded.decorations_layout_json,
            last_modified_date = excluded.last_modified_date,
            member_only = excluded.member_only
    `).run(
        layout.layoutId,
        username,
        layout.name || 'My Igloo',
        layout.zoneId || 'DefaultIgloo',
        layout.lightingId || 0,
        layout.musicId || 0,
        JSON.stringify(layout.extraInfo || {}),
        JSON.stringify(layout.decorationsLayout || []),
        layout.createdDate || Date.now(),
        layout.lastModifiedDate || Date.now(),
        layout.memberOnly !== false ? 1 : 0
    );
}

/**
 * Delete an igloo layout
 */
function deleteIglooLayout(username, layoutId) {
    db.prepare('DELETE FROM igloo_layouts WHERE username = ? AND layout_id = ?').run(username, layoutId);
    
    // If this was the active layout, clear it
    const iglooData = getIglooData(username);
    if (iglooData.activeLayoutId === layoutId) {
        db.prepare('UPDATE igloo_data SET active_layout_id = NULL WHERE username = ?').run(username);
    }
}

/**
 * Get decoration inventory for a player
 */
function getDecorationInventory(username) {
    getOrCreatePlayer(username);
    const rows = db.prepare('SELECT * FROM decoration_inventory WHERE username = ?').all(username);
    
    return {
        items: rows.map(row => ({
            decorationId: {
                definitionId: row.definition_id,
                type: row.type,
                customId: row.custom_id
            },
            count: row.count
        }))
    };
}

/**
 * Add decoration to inventory
 */
function addDecoration(username, decorationId, count = 1) {
    getOrCreatePlayer(username);
    
    const customId = decorationId.customId !== null && decorationId.customId !== undefined ? decorationId.customId : null;
    
    db.prepare(`
        INSERT INTO decoration_inventory (username, definition_id, type, custom_id, count)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(username, definition_id, type, custom_id) DO UPDATE SET count = count + ?
    `).run(
        username,
        decorationId.definitionId,
        decorationId.type,
        customId,
        count,
        count
    );
}

/**
 * Delete decoration from inventory
 */
function deleteDecoration(username, decorationIdStr) {
    const parts = decorationIdStr.split(':');
    const definitionId = parseInt(parts[0]);
    const type = parseInt(parts[1]);
    const customId = parts.length > 2 ? parseInt(parts[2]) : null;
    
    if (customId !== null) {
        db.prepare('DELETE FROM decoration_inventory WHERE username = ? AND definition_id = ? AND type = ? AND custom_id = ?')
            .run(username, definitionId, type, customId);
    } else {
        db.prepare('DELETE FROM decoration_inventory WHERE username = ? AND definition_id = ? AND type = ? AND custom_id IS NULL')
            .run(username, definitionId, type);
    }
}

/**
 * Get friends' igloos (placeholder - returns empty for now)
 */
function getFriendsIgloos(username, language) {
    // In a full implementation, this would query friends' igloo data
    return [];
}

/**
 * Get popular igloos (placeholder - returns empty for now)
 */
function getPopularIgloos(language) {
    // In a full implementation, this would return popular public igloos
    return [];
}

// ========== REFERRAL OPERATIONS ==========

/**
 * Get referral data for a player
 * @param {string} username - The player's username
 * @returns {object|null} { username, referredBy, needsReward } or null
 */
function getReferralData(username) {
    const row = db.prepare('SELECT * FROM referrals WHERE username = ?').get(username);
    if (!row) return null;
    return {
        username: row.username,
        referredBy: row.referred_by,
        needsReward: row.needs_reward === 1
    };
}

/**
 * Set that a player was referred by another player
 * This also marks the referrer as needing a reward
 * @param {string} newPlayerUsername - The new player who was referred
 * @param {string} referrerUsername - The player who referred them
 */
function setPlayerReferral(newPlayerUsername, referrerUsername) {
    getOrCreatePlayer(newPlayerUsername);
    getOrCreatePlayer(referrerUsername);
    
    // Create referral record for the new player (who was referred by someone)
    db.prepare(`
        INSERT INTO referrals (username, referred_by, needs_reward)
        VALUES (?, ?, 1)
        ON CONFLICT(username) DO UPDATE SET referred_by = ?, needs_reward = 1
    `).run(newPlayerUsername, referrerUsername, referrerUsername);
    
    // Mark the referrer as needing a reward too
    db.prepare(`
        INSERT INTO referrals (username, referred_by, needs_reward)
        VALUES (?, NULL, 1)
        ON CONFLICT(username) DO UPDATE SET needs_reward = 1
    `).run(referrerUsername);
}

/**
 * Clear the pending reward flag for a player
 * @param {string} username - The player's username
 */
function clearReferralReward(username) {
    db.prepare('UPDATE referrals SET needs_reward = 0 WHERE username = ?').run(username);
}

/**
 * Check if a player has a pending referral reward
 * @param {string} username - The player's username
 * @returns {boolean} True if they need a reward
 */
function hasReferralReward(username) {
    const row = db.prepare('SELECT needs_reward FROM referrals WHERE username = ?').get(username);
    return row?.needs_reward === 1;
}

// ========== ENCRYPTION KEY OPERATIONS ==========

/**
 * Store an encryption key
 * @param {string} keyId - The key ID
 * @param {Buffer} symmetricKey - The symmetric key
 * @param {number} ttlSeconds - Time to live in seconds (default 1 hour)
 */
function storeEncryptionKey(keyId, symmetricKey, ttlSeconds = 3600) {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    db.prepare(`
        INSERT INTO encryption_keys (key_id, symmetric_key, expires_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key_id) DO UPDATE SET symmetric_key = ?, expires_at = ?
    `).run(keyId, symmetricKey, expiresAt, symmetricKey, expiresAt);
}

/**
 * Get an encryption key
 * @param {string} keyId - The key ID
 * @returns {Buffer|null} The symmetric key or null if not found/expired
 */
function getEncryptionKey(keyId) {
    const row = db.prepare(`
        SELECT symmetric_key FROM encryption_keys 
        WHERE key_id = ? AND datetime(expires_at) > datetime('now')
    `).get(keyId);
    return row ? row.symmetric_key : null;
}

/**
 * Delete an encryption key
 * @param {string} keyId - The key ID
 */
function deleteEncryptionKey(keyId) {
    db.prepare('DELETE FROM encryption_keys WHERE key_id = ?').run(keyId);
}

/**
 * Clean up expired encryption keys
 */
function cleanupExpiredEncryptionKeys() {
    const result = db.prepare(`DELETE FROM encryption_keys WHERE datetime(expires_at) <= datetime('now')`).run();
    if (result.changes > 0) {
        console.log(`[DATABASE] Cleaned up ${result.changes} expired encryption keys`);
    }
}

// ========== GUEST CONTROLLER TOKEN OPERATIONS ==========

/**
 * Store a guest controller token
 * @param {string} token - The token value
 * @param {string} tokenType - 'access' or 'refresh'
 * @param {string} swid - The player's SWID
 * @param {number} ttlSeconds - Time to live in seconds
 */
function storeGuestToken(token, tokenType, swid, ttlSeconds) {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    db.prepare(`
        INSERT INTO guest_controller_tokens (token, token_type, swid, expires_at)
        VALUES (?, ?, ?, ?)
    `).run(token, tokenType, swid, expiresAt);
}

/**
 * Get a guest controller token
 * @param {string} token - The token value
 * @returns {object|null} { token, tokenType, swid, expiresAt } or null
 */
function getGuestToken(token) {
    const row = db.prepare(`
        SELECT * FROM guest_controller_tokens 
        WHERE token = ? AND datetime(expires_at) > datetime('now')
    `).get(token);
    
    if (!row) return null;
    
    return {
        token: row.token,
        tokenType: row.token_type,
        swid: row.swid,
        expiresAt: row.expires_at
    };
}

/**
 * Delete a guest controller token
 * @param {string} token - The token value
 */
function deleteGuestToken(token) {
    db.prepare('DELETE FROM guest_controller_tokens WHERE token = ?').run(token);
}

/**
 * Delete all tokens for a SWID
 * @param {string} swid - The player's SWID
 */
function deleteGuestTokensBySwid(swid) {
    db.prepare('DELETE FROM guest_controller_tokens WHERE swid = ?').run(swid);
}

/**
 * Clean up expired guest tokens
 */
function cleanupExpiredGuestTokens() {
    const result = db.prepare(`DELETE FROM guest_controller_tokens WHERE datetime(expires_at) <= datetime('now')`).run();
    if (result.changes > 0) {
        console.log(`[DATABASE] Cleaned up ${result.changes} expired guest tokens`);
    }
}

/**
 * Store a guest controller API key
 * @param {string} apiKey - The API key
 * @param {number} ttlSeconds - Time to live in seconds
 */
function storeGuestApiKey(apiKey, ttlSeconds) {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    db.prepare(`
        INSERT INTO guest_controller_api_keys (api_key, expires_at)
        VALUES (?, ?)
        ON CONFLICT(api_key) DO UPDATE SET expires_at = ?, request_count = 0
    `).run(apiKey, expiresAt, expiresAt);
}

/**
 * Get a guest controller API key
 * @param {string} apiKey - The API key
 * @returns {object|null} { apiKey, requestCount, expiresAt } or null
 */
function getGuestApiKey(apiKey) {
    const row = db.prepare(`
        SELECT * FROM guest_controller_api_keys 
        WHERE api_key = ? AND datetime(expires_at) > datetime('now')
    `).get(apiKey);
    
    if (!row) return null;
    
    return {
        apiKey: row.api_key,
        requestCount: row.request_count,
        expiresAt: row.expires_at
    };
}

/**
 * Increment API key request count
 * @param {string} apiKey - The API key
 */
function incrementApiKeyRequestCount(apiKey) {
    db.prepare(`
        UPDATE guest_controller_api_keys 
        SET request_count = request_count + 1 
        WHERE api_key = ?
    `).run(apiKey);
}

/**
 * Clean up expired API keys
 */
function cleanupExpiredApiKeys() {
    const result = db.prepare(`DELETE FROM guest_controller_api_keys WHERE datetime(expires_at) <= datetime('now')`).run();
    if (result.changes > 0) {
        console.log(`[DATABASE] Cleaned up ${result.changes} expired API keys`);
    }
}

// ========== MIX API OPERATIONS ==========

/**
 * Store a Mix user session
 * @param {string} swid - The player's SWID
 * @param {number} sessionId - The session ID
 * @param {string} hashedUserId - The hashed user ID
 * @param {Buffer} symmetricKey - The symmetric key
 */
function storeMixSession(swid, sessionId, hashedUserId, symmetricKey) {
    db.prepare(`
        INSERT INTO mix_user_sessions (swid, session_id, hashed_user_id, symmetric_key)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(swid) DO UPDATE SET 
            session_id = ?,
            hashed_user_id = ?,
            symmetric_key = ?,
            last_activity = CURRENT_TIMESTAMP
    `).run(swid, sessionId, hashedUserId, symmetricKey, sessionId, hashedUserId, symmetricKey);
}

/**
 * Get a Mix user session
 * @param {string} swid - The player's SWID
 * @returns {object|null} { sessionId, hashedUserId, symmetricKey } or null
 */
function getMixSession(swid) {
    const row = db.prepare('SELECT * FROM mix_user_sessions WHERE swid = ?').get(swid);
    if (!row) return null;
    
    return {
        sessionId: row.session_id,
        hashedUserId: row.hashed_user_id,
        symmetricKey: row.symmetric_key
    };
}

/**
 * Get Mix session by session ID
 * @param {number} sessionId - The session ID
 * @returns {object|null} { swid, sessionId, hashedUserId, symmetricKey } or null
 */
function getMixSessionById(sessionId) {
    const row = db.prepare('SELECT * FROM mix_user_sessions WHERE session_id = ?').get(sessionId);
    if (!row) return null;
    
    return {
        swid: row.swid,
        sessionId: row.session_id,
        hashedUserId: row.hashed_user_id,
        symmetricKey: row.symmetric_key
    };
}

/**
 * Delete a Mix user session
 * @param {string} swid - The player's SWID
 */
function deleteMixSession(swid) {
    db.prepare('DELETE FROM mix_user_sessions WHERE swid = ?').run(swid);
}

/**
 * Update Mix session activity timestamp
 * @param {string} swid - The player's SWID
 */
function updateMixSessionActivity(swid) {
    db.prepare('UPDATE mix_user_sessions SET last_activity = CURRENT_TIMESTAMP WHERE swid = ?').run(swid);
}

/**
 * Get all Mix friendships for a user
 * @param {string} swid - The player's SWID
 * @returns {Array} Array of { friendUserId, isTrusted }
 */
function getMixFriendships(swid) {
    const rows = db.prepare('SELECT * FROM mix_friendships WHERE swid = ?').all(swid);
    return rows.map(row => ({
        friendUserId: row.friend_user_id,
        isTrusted: row.is_trusted === 1
    }));
}

/**
 * Add a Mix friendship
 * @param {string} swid - The player's SWID
 * @param {string} friendUserId - The friend's user ID
 * @param {boolean} isTrusted - Whether this is a trusted friendship
 */
function addMixFriendship(swid, friendUserId, isTrusted = false) {
    db.prepare(`
        INSERT INTO mix_friendships (swid, friend_user_id, is_trusted)
        VALUES (?, ?, ?)
        ON CONFLICT(swid, friend_user_id) DO UPDATE SET is_trusted = ?
    `).run(swid, friendUserId, isTrusted ? 1 : 0, isTrusted ? 1 : 0);
}

/**
 * Remove a Mix friendship
 * @param {string} swid - The player's SWID
 * @param {string} friendUserId - The friend's user ID
 */
function removeMixFriendship(swid, friendUserId) {
    db.prepare('DELETE FROM mix_friendships WHERE swid = ? AND friend_user_id = ?').run(swid, friendUserId);
}

/**
 * Get all Mix friendship invitations for a user
 * @param {string} swid - The player's SWID
 * @returns {Array} Array of { invitationId, friendDisplayName, isInviter, isTrusted }
 */
function getMixFriendshipInvitations(swid) {
    const rows = db.prepare('SELECT * FROM mix_friendship_invitations WHERE swid = ?').all(swid);
    return rows.map(row => ({
        invitationId: row.invitation_id,
        friendDisplayName: row.friend_display_name,
        isInviter: row.is_inviter === 1,
        isTrusted: row.is_trusted === 1
    }));
}

/**
 * Add a Mix friendship invitation
 * @param {number} invitationId - The invitation ID
 * @param {string} swid - The player's SWID
 * @param {string} friendDisplayName - The friend's display name
 * @param {boolean} isInviter - Whether this user is the inviter
 * @param {boolean} isTrusted - Whether this is a trusted invitation
 */
function addMixFriendshipInvitation(invitationId, swid, friendDisplayName, isInviter = false, isTrusted = false) {
    db.prepare(`
        INSERT INTO mix_friendship_invitations (invitation_id, swid, friend_display_name, is_inviter, is_trusted)
        VALUES (?, ?, ?, ?, ?)
    `).run(invitationId, swid, friendDisplayName, isInviter ? 1 : 0, isTrusted ? 1 : 0);
}

/**
 * Remove a Mix friendship invitation
 * @param {number} invitationId - The invitation ID
 */
function removeMixFriendshipInvitation(invitationId) {
    db.prepare('DELETE FROM mix_friendship_invitations WHERE invitation_id = ?').run(invitationId);
}

/**
 * Get all Mix alerts for a user
 * @param {string} swid - The player's SWID
 * @returns {Array} Array of { alertId, level, text, timestamp }
 */
function getMixAlerts(swid) {
    const rows = db.prepare('SELECT * FROM mix_alerts WHERE swid = ? ORDER BY timestamp DESC').all(swid);
    return rows.map(row => ({
        alertId: row.alert_id,
        level: row.level,
        text: row.text,
        timestamp: row.timestamp
    }));
}

/**
 * Add a Mix alert
 * @param {string} swid - The player's SWID
 * @param {string} level - The alert level
 * @param {string} text - The alert text
 * @param {number} timestamp - The alert timestamp
 * @returns {number} The alert ID
 */
function addMixAlert(swid, level, text, timestamp) {
    const result = db.prepare(`
        INSERT INTO mix_alerts (swid, level, text, timestamp)
        VALUES (?, ?, ?, ?)
    `).run(swid, level, text, timestamp);
    return result.lastInsertRowid;
}

/**
 * Remove a Mix alert
 * @param {number} alertId - The alert ID
 */
function removeMixAlert(alertId) {
    db.prepare('DELETE FROM mix_alerts WHERE alert_id = ?').run(alertId);
}

/**
 * Clear all Mix alerts for a user
 * @param {string} swid - The player's SWID
 */
function clearMixAlerts(swid) {
    db.prepare('DELETE FROM mix_alerts WHERE swid = ?').run(swid);
}

/**
 * Get Mix presence state
 * @param {string} swid - The player's SWID
 * @returns {string|null} The presence state or null
 */
function getMixPresenceState(swid) {
    const row = db.prepare('SELECT state FROM mix_presence_state WHERE swid = ?').get(swid);
    return row ? row.state : null;
}

/**
 * Set Mix presence state
 * @param {string} swid - The player's SWID
 * @param {string} state - The presence state
 */
function setMixPresenceState(swid, state) {
    db.prepare(`
        INSERT INTO mix_presence_state (swid, state)
        VALUES (?, ?)
        ON CONFLICT(swid) DO UPDATE SET state = ?, updated_at = CURRENT_TIMESTAMP
    `).run(swid, state, state);
}

/**
 * Delete Mix presence state
 * @param {string} swid - The player's SWID
 */
function deleteMixPresenceState(swid) {
    db.prepare('DELETE FROM mix_presence_state WHERE swid = ?').run(swid);
}

/**
 * Get pending Mix notifications for a user
 * @param {string} swid - The player's SWID
 * @param {number} sinceSequence - Get notifications after this sequence number
 * @returns {Array} Array of { id, type, data, sequence }
 */
function getMixPendingNotifications(swid, sinceSequence = 0) {
    const rows = db.prepare(`
        SELECT * FROM mix_pending_notifications 
        WHERE swid = ? AND sequence > ?
        ORDER BY sequence ASC
    `).all(swid, sinceSequence);
    
    return rows.map(row => ({
        id: row.id,
        type: row.type,
        data: JSON.parse(row.data),
        sequence: row.sequence
    }));
}

/**
 * Add a pending Mix notification
 * @param {string} swid - The player's SWID
 * @param {string} type - The notification type
 * @param {object} data - The notification data
 * @returns {number} The notification sequence number
 */
function getMixNotificationSequence(swid) {
    const row = db.prepare('SELECT last_sequence FROM mix_notification_counters WHERE swid = ?').get(swid);
    return row ? row.last_sequence : 0;
}

function nextMixNotificationSequence(swid) {
    const row = db.prepare(`
        INSERT INTO mix_notification_counters (swid, last_sequence) VALUES (?, 1)
        ON CONFLICT(swid) DO UPDATE SET last_sequence = last_sequence + 1
        RETURNING last_sequence
    `).get(swid);
    return row.last_sequence;
}

// Stores a notification for one user with that user's next sequence
// number, which is also written into data.SequenceNumber. Returns it.
function addMixPendingNotification(swid, type, data) {
    const sequence = nextMixNotificationSequence(swid);
    data.SequenceNumber = sequence;
    
    db.prepare(`
        INSERT INTO mix_pending_notifications (swid, type, data, sequence)
        VALUES (?, ?, ?, ?)
    `).run(swid, type, JSON.stringify(data), sequence);
    
    return sequence;
}

/**
 * Clear old Mix notifications for a user
 * @param {string} swid - The player's SWID
 * @param {number} maxAge - Maximum age in seconds (default 1 hour)
 */
function cleanupOldMixNotifications(swid, maxAgeSeconds = 3600) {
    // created_at is SQLite CURRENT_TIMESTAMP text; compare with datetime().
    db.prepare(`
        DELETE FROM mix_pending_notifications 
        WHERE swid = ? AND created_at < datetime('now', ?)
    `).run(swid, `-${Math.floor(maxAgeSeconds)} seconds`);
}

// ========== FULL PLAYER DATA RETRIEVAL ==========

/**
 * Get complete player progress (equivalent to the old JSON structure)
 * This is used for API responses that need the full player data
 */
function getFullPlayerData(username) {
    // Check if username is valid
    if (!username) {
        console.error(`[DATABASE] getFullPlayerData called with invalid username: ${username}`);
        return null;
    }
    
    const player = getOrCreatePlayer(username);
    
    // Extra safety check
    if (!player) {
        console.error(`[DATABASE] Failed to get or create player: ${username}`);
        return null;
    }
    
    return {
        quests: getQuests(username),
        dailyTaskProgress: getDailyTasks(username),
        tutorialData: getTutorialData(username),
        breadcrumbs: getBreadcrumbs(username),
        outfit: { parts: getOutfit(username) },
        profile: {
            colour: player.profile_colour,
            daysOld: player.profile_days_old
        },
        mascotXP: getMascotXP(username),
        assets: getPlayerAssets(username),
        equipment: getEquipment(username),
        claimedWelcomeKit: player.claimed_welcome_kit === 1,
        dailySpinData: getDailySpinData(username),
        catalogSubmissions: getPlayerCatalogSubmissions(username),
        claimedRewardIds: getClaimedRewards(username),
        consumableInventory: getConsumableInventory(username),
        iglooData: getIglooData(username),
        iglooLayouts: getIglooLayouts(username),
        decorationInventory: getDecorationInventory(username)
    };
}

// ========== DATABASE UTILITIES ==========

/**
 * Close database connection
 */
function closeDatabase() {
    db.close();
}

/**
 * Check if a player exists
 */
function playerExists(username) {
    const row = db.prepare('SELECT 1 FROM players WHERE username = ?').get(username);
    return !!row;
}

// Initialize database on module load
initializeDatabase();

// Export all functions
export {
    inTransaction,
    db,
    initializeDatabase,
    closeDatabase,
    
    // Player operations
    getOrCreatePlayer,
    updatePlayerProfile,
    setClaimedWelcomeKit,
    getPlayerProfile,
    playerExists,
    
    // Player identity operations
    getPlayerBySwid,
    getPlayerByDisplayName,
    getPlayerBySessionId,
    getPlayersBySwids,
    getPlayersByDisplayNames,
    createPlayerFromSwid,
    setPlayerDisplayName,
    setPlayerPassword,
    getPlayerPassword,
    registerPlayerSession,
    getOnlinePlayerSwids,
    cleanupExpiredSessions,
    deleteSession,
    getSession,
    getActiveSessionBySwid,
    updateSessionLocation,
    getRoomPopulationsForWorld,
    getRoomPopulationAcrossWorlds,
    getActiveSessionsByRoom,
    playerIdentityExists,
    getAllPlayers,
    
    // Assets operations
    getPlayerAssets,
    updatePlayerCoins,
    addPlayerCoins,
    getPlayerCoins,
    
    // Mascot XP
    getMascotXP,
    setMascotXP,
    addMascotXP,
    
    // Owned items
    addEquipmentTemplate,
    addDurable,
    addEmotePack,
    addColourPack,
    addDecal,
    addFabric,
    addSizzleClip,
    addTube,
    addCollectibleCurrency,
    
    // Quests
    getQuests,
    getOrCreateQuest,
    updateQuestStatus,
    addQuestObjective,
    clearQuestObjectives,
    suspendOtherQuests,
    
    // Daily tasks
    getDailyTasks,
    currentTaskDay,
    setDailyTaskCounter,
    getTodaysDailyTask,
    claimTodaysDailyTask,
    getCommunityTaskCounter,
    setCommunityTaskCounter,
    getOrCreateDailyTask,
    updateDailyTask,
    
    // Tutorial
    getTutorialData,
    setTutorialData,
    completeTutorial,
    
    // Breadcrumbs
    getBreadcrumbs,
    addBreadcrumb,
    removeBreadcrumbs,
    
    // Outfit
    getOutfit,
    setOutfit,
    
    // Equipment
    getEquipment,
    getEquipmentById,
    saveEquipment,
    deleteEquipment,
    
    // Claimed rewards
    getClaimedRewards,
    addClaimedReward,
    
    // Daily spin
    getDailySpinData,
    saveDailySpinData,
    
    // Catalog
    getCatalogSubmissions,
    getPlayerCatalogSubmissions,
    addCatalogSubmission,
    
    // Consumables
    getConsumableInventory,
    updateConsumable,
    addConsumable,
    
    // Igloo
    getIglooData,
    saveIglooData,
    getIglooLayouts,
    getIglooLayout,
    saveIglooLayout,
    deleteIglooLayout,
    getDecorationInventory,
    addDecoration,
    deleteDecoration,
    getFriendsIgloos,
    getPopularIgloos,
    
    // Referrals
    getReferralData,
    setPlayerReferral,
    clearReferralReward,
    hasReferralReward,
    
    // Encryption keys
    storeEncryptionKey,
    getEncryptionKey,
    deleteEncryptionKey,
    cleanupExpiredEncryptionKeys,
    
    // Guest controller tokens
    storeGuestToken,
    getGuestToken,
    deleteGuestToken,
    deleteGuestTokensBySwid,
    cleanupExpiredGuestTokens,
    storeGuestApiKey,
    getGuestApiKey,
    incrementApiKeyRequestCount,
    cleanupExpiredApiKeys,
    
    // Mix API
    storeMixSession,
    getMixSession,
    getMixSessionById,
    deleteMixSession,
    updateMixSessionActivity,
    getMixFriendships,
    addMixFriendship,
    removeMixFriendship,
    getMixFriendshipInvitations,
    addMixFriendshipInvitation,
    removeMixFriendshipInvitation,
    getMixAlerts,
    addMixAlert,
    removeMixAlert,
    clearMixAlerts,
    getMixPresenceState,
    setMixPresenceState,
    deleteMixPresenceState,
    getMixPendingNotifications,
    addMixPendingNotification,
    getMixNotificationSequence,
    cleanupOldMixNotifications,
    
    // Full data
    getFullPlayerData
};
