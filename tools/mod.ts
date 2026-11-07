// Moderation CLI for operators. Works while the server runs: the server
// notices committed rule changes through PRAGMA data_version
// (web-api/src/services/moderation.ts).
//
//   bun tools/mod.ts rules list
//   bun tools/mod.ts rules add <pattern> [--regex] [--block]
//   bun tools/mod.ts rules remove <id>
//   bun tools/mod.ts reports [--open]
//   bun tools/mod.ts report <id> dismiss|actioned
//   bun tools/mod.ts sanction <swid|displayName> <TYPE> [level]
//   bun tools/mod.ts unban <swid|displayName>
//
// --db <file> picks the database (default web-api/src/cpi_data.db).
// rules/reports open the DB directly. sanction/unban go through
// web-api/src/services/moderation.ts (pointed at --db via ICEBERG_DB_PATH),
// so the alert, its AddAlert notification sequence and the ban are written
// exactly as the server would.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const USAGE = `usage: bun tools/mod.ts rules list
       bun tools/mod.ts rules add <pattern> [--regex] [--block]
       bun tools/mod.ts rules remove <id>
       bun tools/mod.ts reports [--open]
       bun tools/mod.ts report <id> dismiss|actioned
       bun tools/mod.ts sanction <swid|displayName> <TYPE> [level]
       bun tools/mod.ts unban <swid|displayName>
options: --db <file>   database (default web-api/src/cpi_data.db)`;

// Reasons and names come from players. Print control characters (ANSI
// escapes, CR, C1) as \xNN, and Unicode format and separator characters
// (bidi overrides, zero-width, line/paragraph separators) as \u{NNNN}, so
// they can't rewrite, reorder or hide the operator's terminal output.
const safe = (v: unknown) => String(v ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => {
  const n = c.codePointAt(0)!;
  return n < 0x100 ? `\\x${n.toString(16).padStart(2, "0")}` : `\\u{${n.toString(16)}}`;
});

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
let dbPath = `${import.meta.dir}/../web-api/src/cpi_data.db`;
const di = args.indexOf("--db");
if (di >= 0) {
  if (!args[di + 1]) fail(USAGE);
  dbPath = args[di + 1];
  args.splice(di, 2);
}
const isRegex = flag("--regex");
const isBlock = flag("--block");
const onlyOpen = flag("--open");
const [group, cmd, arg, extra] = args;
if (!["rules", "reports", "report", "sanction", "unban"].includes(group) || (group !== "reports" && !cmd)) fail(USAGE);

if (!existsSync(dbPath)) fail(`no database at ${dbPath} (start the web API once to create it)`);
const db = new Database(dbPath);
db.exec("PRAGMA busy_timeout = 5000");
const table = group === "rules" ? "mix_moderation_rules" : group.startsWith("report") ? "mix_reports" : "mix_bans";
const hasTable = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
if (!hasTable) fail(`${dbPath} has no ${table} table (start the web API once to create it)`);

// A swid, or a display name / username (case-insensitive).
function resolveSwid(who: string): { swid: string; name: string | null } {
  const row = db.query(`SELECT swid, display_name FROM player_identity
      WHERE swid = ?1 OR display_name = ?1 COLLATE NOCASE OR username = ?1 COLLATE NOCASE
      ORDER BY (swid = ?1) DESC LIMIT 1`).get(who) as { swid: string; display_name: string | null } | null;
  if (!row) fail(`no player ${safe(who)}`);
  return { swid: row.swid, name: row.display_name };
}

async function service() {
  process.env.ICEBERG_DB_PATH = resolvePath(dbPath);
  const origLog = console.log;
  console.log = () => {}; // database.ts logs its startup
  try {
    return await import("../web-api/src/services/moderation.ts");
  } finally {
    console.log = origLog;
  }
}

if (group === "sanction") {
  const target = resolveSwid(cmd);
  const m = await service();
  const type = String(arg ?? "").toUpperCase();
  if (!m.isAlertType(type)) fail(`unknown type ${safe(arg)}; one of: ${Object.keys(m.LADDER).join(", ")}`);
  if (extra !== undefined && !/^\d+$/.test(extra)) fail(USAGE);
  const level = extra !== undefined ? Number(extra) : m.suggestLevel(target.swid, type);
  const r = m.sanction(target.swid, type, level, process.env.USER || "mod.ts");
  const who = safe(target.name ? `${target.name} ${target.swid}` : target.swid);
  const what = !r.ban ? "warning only" : r.ban.kind === "lock" ? "account locked until lifted"
    : r.ban.until ? `${m.LADDER[type].rungs[r.level - 1]?.hours} h ban (until ${r.ban.until})` : "ban until lifted";
  console.log(`${who}: alert ${r.alertId} ${type} level ${r.level}: ${what}`);
} else if (group === "unban") {
  const target = resolveSwid(cmd);
  const m = await service();
  if (!m.liftBan(target.swid)) fail(`${safe(cmd)} has no active ban`);
  console.log(`lifted bans for ${safe(target.name ?? target.swid)}`);
} else if (group === "reports") {
  const rows = db.query(`SELECT r.*, a.display_name AS reporter_name, b.display_name AS reported_name
      FROM mix_reports r
      LEFT JOIN player_identity a ON a.swid = r.reporter_swid
      LEFT JOIN player_identity b ON b.swid = r.reported_swid
      ${onlyOpen ? "WHERE r.status = 'open'" : ""} ORDER BY r.id`).all() as any[];
  if (rows.length === 0) console.log(onlyOpen ? "(no open reports)" : "(no reports)");
  for (const r of rows) {
    const who = (name: string | null, swid: string) => safe(name ? `${name} ${swid}` : swid);
    console.log(`${String(r.id).padStart(4)}  ${safe(r.status).padEnd(9)}  ${safe(r.source).padEnd(3)}  ${safe(r.created_at)}  ${who(r.reporter_name, r.reporter_swid)} -> ${who(r.reported_name, r.reported_swid)}: ${safe(r.reason)}`);
  }
} else if (group === "report") {
  const id = Number(cmd);
  const status = arg === "dismiss" ? "dismissed" : arg === "actioned" ? "actioned" : null;
  if (!Number.isInteger(id) || !status) fail(USAGE);
  const r = db.query("UPDATE mix_reports SET status = ? WHERE id = ?").run(status, id);
  if (r.changes === 0) fail(`no report ${id}`);
  console.log(`report ${id} ${status}`);
} else if (cmd === "list") {
  const rows = db.query("SELECT id, pattern, kind, action, created_at FROM mix_moderation_rules ORDER BY id").all() as any[];
  if (rows.length === 0) console.log("(no rules)");
  for (const r of rows) console.log(`${String(r.id).padStart(4)}  ${safe(r.kind).padEnd(5)}  ${safe(r.action).padEnd(5)}  ${safe(r.pattern)}`);
} else if (cmd === "add") {
  if (!arg) fail(USAGE);
  if (isRegex) {
    try { new RegExp(arg, "giu"); } catch (e) { fail(`invalid regex: ${(e as Error).message}`); }
  }
  const r = db.query("INSERT INTO mix_moderation_rules (pattern, kind, action) VALUES (?, ?, ?)")
    .run(arg, isRegex ? "regex" : "word", isBlock ? "block" : "mask");
  console.log(`added rule ${r.lastInsertRowid}`);
} else if (cmd === "remove") {
  const id = Number(arg);
  if (!Number.isInteger(id)) fail(USAGE);
  const r = db.query("DELETE FROM mix_moderation_rules WHERE id = ?").run(id);
  if (r.changes === 0) fail(`no rule ${id}`);
  console.log(`removed rule ${id}`);
} else {
  fail(USAGE);
}
db.close();
