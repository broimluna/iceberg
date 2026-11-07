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
