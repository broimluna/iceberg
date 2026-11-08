import express from "express";
import { clientAddress } from "../utils/rateLimit.ts";
import { logSafe } from "../utils/logSafe.ts";
const router = express.Router();

// At most this many ERROR/CRITICAL entries are logged per request.
const MAX_LOGGED_ENTRIES = 20;

/**
 * POST /diagnostics/v1/log
 * Receive diagnostic logs from the client. Anyone can call it, so what is
 * logged is escaped and capped (utils/logSafe.ts).
 */
router.post('/diagnostics/v1/log', (req, res) => {
    const entries = Array.isArray(req.body) ? req.body : [];
    console.log(`[DIAGNOSTICS] Received ${entries.length} log entr${entries.length === 1 ? "y" : "ies"} from ${clientAddress(req)}`);

    let logged = 0;
    for (const entry of entries) {
        if (entry?.severity !== 'ERROR' && entry?.severity !== 'CRITICAL') continue;
        if (logged++ >= MAX_LOGGED_ENTRIES) {
            console.error(`[DIAGNOSTICS] further entries in this request not logged`);
            break;
        }
        console.error(`[CLIENT LOG] [${entry.severity}] ${logSafe(entry.message)}`);
    }

    res.json({});
});

export default router;
