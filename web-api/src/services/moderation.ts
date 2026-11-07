// The text filter shared by Mix (PUT /moderation/text) and CPI chat
// (POST /chat/v1/message/verify). Rules live in mix_moderation_rules:
// - word: the pattern as a whole word, case-insensitive. Word edges are
//   Unicode letters and digits (\p{L}\p{N}), so "darn" doesn't hit "darned"
//   or "darné".
// - regex: the pattern as given, with flags giu.
// - mask: each match becomes one * per code point. block: the whole
//   message is masked and reported as moderated.
//
// tools/mod.ts edits the rules from another process. SQLite bumps
// PRAGMA data_version when another connection commits, so each call
// checks it and reloads the rules when it moved.
import * as database from "../database.ts";
import { notify } from "./mixNotify.ts";

export type Rule = { id: number; pattern: string; kind: "word" | "regex"; action: "mask" | "block"; created_at: string };
type Compiled = { re: RegExp; action: Rule["action"] };

const sql = database.db;
let cache: Compiled[] | null = null;
let seenVersion = -1;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compile(rule: Rule): RegExp | null {
    try {
        if (rule.kind === "word") return new RegExp(`(?<![\\p{L}\\p{N}])${escape(rule.pattern)}(?![\\p{L}\\p{N}])`, "giu");
        return new RegExp(rule.pattern, "giu");
    } catch (e) {
        console.log(`[MODERATION] Skipping rule ${rule.id} (${rule.pattern}): ${(e as Error).message}`);
        return null;
    }
}

function rules(): Compiled[] {
    const version = (sql.query("PRAGMA data_version").get() as { data_version: number }).data_version;
    if (cache && version === seenVersion) return cache;
    seenVersion = version;
    cache = listRules().flatMap((r) => {
        const re = compile(r);
        return re ? [{ re, action: r.action }] : [];
    });
    return cache;
}

const stars = (s: string) => "*".repeat([...s].length);

export function filterText(text: string): { text: string; moderated: boolean; blocked: boolean } {
    let out = text ?? "";
    let moderated = false;
    let blocked = false;
    for (const { re, action } of rules()) {
        re.lastIndex = 0;
        if (action === "block") {
            if (re.test(text ?? "")) blocked = true;
            continue;
        }
        out = out.replace(re, (m) => {
            if (m.length > 0) moderated = true;
            return stars(m);
        });
    }
    if (blocked) out = stars(text ?? "");
    return { text: out, moderated, blocked };
}

export function listRules(): Rule[] {
    return sql.query("SELECT id, pattern, kind, action, created_at FROM mix_moderation_rules ORDER BY id").all() as Rule[];
}

export function addRule(pattern: string, kind: Rule["kind"], action: Rule["action"]): number {
    const r = sql.query("INSERT INTO mix_moderation_rules (pattern, kind, action) VALUES (?, ?, ?)").run(pattern, kind, action);
    cache = null;
    return Number(r.lastInsertRowid);
}

export function removeRule(id: number): boolean {
    const r = sql.query("DELETE FROM mix_moderation_rules WHERE id = ?").run(id);
    cache = null;
    return r.changes > 0;
}

// ---------------------------------------------------------------------------
// Reports (mix_reports). Mix sends the reported user's swid; CPI sends a
// display name, which the route resolves (unknown names are stored as
// "name:<displayName>" so nothing reveals whether an account exists).

export type ReportRow = {
    id: number; reporter_swid: string; reported_swid: string; reason: string;
    thread_id: number | null; message_id: number | null;
    source: "mix" | "cpi"; status: "open" | "actioned" | "dismissed"; created_at: string;
};

// Both clients send short reason codes ("ChatSwearing"); cap anything
// longer so a report can't flood the table or an operator's terminal.
const MAX_REPORT_FIELD = 500;
const cap = (s: string) => [...String(s ?? "")].slice(0, MAX_REPORT_FIELD).join("");

export function report(r: { reporter: string; reported: string; reason: string; source: "mix" | "cpi"; threadId?: number; messageId?: number }): number {
    const res = sql.query(`INSERT INTO mix_reports (reporter_swid, reported_swid, reason, thread_id, message_id, source)
        VALUES (?, ?, ?, ?, ?, ?)`).run(r.reporter, cap(r.reported), cap(r.reason), r.threadId ?? null, r.messageId ?? null, r.source);
    return Number(res.lastInsertRowid);
}

export function listReports(status?: ReportRow["status"]): ReportRow[] {
    return (status
        ? sql.query("SELECT * FROM mix_reports WHERE status = ? ORDER BY id").all(status)
        : sql.query("SELECT * FROM mix_reports ORDER BY id").all()) as ReportRow[];
}

export function setReportStatus(id: number, status: "actioned" | "dismissed"): boolean {
    return sql.query("UPDATE mix_reports SET status = ? WHERE id = ?").run(status, id).changes > 0;
}

// ---------------------------------------------------------------------------
// Sanctions: Disney's escalation ladder (docs/MIX_API.md section 9).
//
// A sanction is an alert plus, on some rungs, a ban. The alert's Text is
// the category and Level the severity; the app shows Disney's own
// localized string customtokens.alerts.<type>_<level>. Those strings name
// the durations ("banned for 72 hours"), but the client never enforces
// them, so the durations below transcribe the strings and the server
// applies them.

export type AlertTypeName =
    | "CYBERCRIMINAL" | "CYBERBULLY" | "DATING_TEENS" | "OFFENSIVE_USER" | "OVERSHARING_CHILD"
    | "POTENTIAL_PAEDOPHILE" | "SEX_PEST" | "SPAMMER" | "TERRORIST" | "TROLL" | "VULNERABLE_PERSON";

/** null = warning only; hours null = until lifted ("permanent", "ban", "contact support"). */
export type Rung = null | { kind: "ban" | "lock"; hours: number | null };
type Rungs = [Rung, Rung, Rung, Rung, Rung];

const W: Rung = null;
const h = (hours: number): Rung => ({ kind: "ban", hours });
const BAN: Rung = { kind: "ban", hours: null };
const LOCK: Rung = { kind: "lock", hours: null };

// Rungs below min have no string in the client; they're never used.
export const LADDER: Record<AlertTypeName, { min: 1 | 3; rungs: Rungs }> = {
    CYBERCRIMINAL:        { min: 1, rungs: [W, h(72), BAN, BAN, BAN] },
    CYBERBULLY:           { min: 1, rungs: [W, W, h(12), h(24), BAN] },
    DATING_TEENS:         { min: 1, rungs: [W, W, h(12), h(24), BAN] }, // level 2 says "may be banned": still a warning
    OFFENSIVE_USER:       { min: 1, rungs: [W, h(12), h(24), h(72), BAN] },
    OVERSHARING_CHILD:    { min: 1, rungs: [W, W, W, W, BAN] },
    POTENTIAL_PAEDOPHILE: { min: 3, rungs: [W, W, BAN, BAN, BAN] },
    SEX_PEST:             { min: 1, rungs: [W, h(12), h(24), BAN, BAN] },
    SPAMMER:              { min: 1, rungs: [W, h(24), h(72), BAN, BAN] },
    TERRORIST:            { min: 3, rungs: [W, W, BAN, BAN, BAN] },
    TROLL:                { min: 1, rungs: [W, h(12), h(24), h(72), BAN] },
    VULNERABLE_PERSON:    { min: 3, rungs: [W, W, LOCK, LOCK, LOCK] }, // protects the user: a lock, not a ban
};

export const isAlertType = (t: string): t is AlertTypeName => Object.hasOwn(LADDER, t);

export type BanRow = {
    rowid: number; swid: string; kind: "ban" | "lock"; until: string | null;
    sanction_id: number | null; created_at: string; lifted_at: string | null;
};

const clampLevel = (type: AlertTypeName, level: number) =>
    Math.min(5, Math.max(LADDER[type].min, Math.trunc(Number.isFinite(level) ? level : LADDER[type].min)));

/** The last level used for this type, plus 1, within the ladder. Only a suggestion. */
export function suggestLevel(swid: string, type: AlertTypeName): number {
    const last = sql.query("SELECT level FROM mix_sanctions WHERE swid = ? AND type = ? ORDER BY id DESC LIMIT 1").get(swid, type) as { level: number } | null;
    return clampLevel(type, last ? last.level + 1 : LADDER[type].min);
}

export function sanction(swid: string, type: AlertTypeName, level: number, moderator: string): { alertId: number; level: number; ban: BanRow | null } {
    const lvl = clampLevel(type, level);
    const rung = LADDER[type].rungs[lvl - 1];
    return database.inTransaction(() => {
        const now = Date.now();
        const alertId = Number(database.addMixAlert(swid, String(lvl), type, now));
        notify(swid, "AddAlert", { Alert: { AlertId: alertId, Level: String(lvl), Text: type, Timestamp: now } });
        const sanctionId = Number(sql.query("INSERT INTO mix_sanctions (swid, type, level, alert_id, moderator) VALUES (?, ?, ?, ?, ?)")
            .run(swid, type, lvl, alertId, moderator).lastInsertRowid);
        let ban: BanRow | null = null;
        if (rung) {
            const until = rung.hours === null ? null : new Date(now + rung.hours * 3_600_000).toISOString();
            const rowid = sql.query("INSERT INTO mix_bans (swid, kind, until, sanction_id) VALUES (?, ?, ?, ?)")
                .run(swid, rung.kind, until, sanctionId).lastInsertRowid;
            ban = sql.query("SELECT rowid, * FROM mix_bans WHERE rowid = ?").get(rowid) as BanRow;
        }
        return { alertId, level: lvl, ban };
    });
}

/**
 * The active ban or lock, or null. `until` is an ISO-8601 UTC string, so
 * it compares correctly as text. When several are active, an open-ended
 * one wins over a timed one, then the one that ends last.
 */
export function isBanned(swid: string): BanRow | null {
    return (sql.query(`SELECT rowid, * FROM mix_bans
        WHERE swid = ? AND lifted_at IS NULL AND (until IS NULL OR until > ?)
        ORDER BY (until IS NULL) DESC, until DESC LIMIT 1`).get(swid, new Date().toISOString()) as BanRow | null) ?? null;
}

/** Lifts every active ban and lock. */
export function liftBan(swid: string): boolean {
    return sql.query("UPDATE mix_bans SET lifted_at = ? WHERE swid = ? AND lifted_at IS NULL AND (until IS NULL OR until > ?)")
        .run(new Date().toISOString(), swid, new Date().toISOString()).changes > 0;
}
