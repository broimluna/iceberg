// Moderation CLI for operators. Works while the server runs: the server
// notices committed rule changes through PRAGMA data_version
// (web-api/src/services/moderation.ts).
//
//   bun tools/mod.ts rules list
//   bun tools/mod.ts rules add <pattern> [--regex] [--block]
//   bun tools/mod.ts rules remove <id>
//   bun tools/mod.ts reports [--open]
//   bun tools/mod.ts report <id> dismiss|actioned
//
// --db <file> picks the database (default web-api/src/cpi_data.db).
// This opens the DB directly instead of importing database.ts, which
// opens its fixed path and runs migrations as a side effect.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

const USAGE = `usage: bun tools/mod.ts rules list
       bun tools/mod.ts rules add <pattern> [--regex] [--block]
       bun tools/mod.ts rules remove <id>
       bun tools/mod.ts reports [--open]
       bun tools/mod.ts report <id> dismiss|actioned
options: --db <file>   database (default web-api/src/cpi_data.db)`;

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
const [group, cmd, arg] = args;
if (!["rules", "reports", "report"].includes(group) || (group !== "reports" && !cmd)) fail(USAGE);

if (!existsSync(dbPath)) fail(`no database at ${dbPath} (start the web API once to create it)`);
const db = new Database(dbPath);
db.exec("PRAGMA busy_timeout = 5000");
const table = group === "rules" ? "mix_moderation_rules" : "mix_reports";
const hasTable = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
if (!hasTable) fail(`${dbPath} has no ${table} table (start the web API once to create it)`);

if (group === "reports") {
  const rows = db.query(`SELECT r.*, a.display_name AS reporter_name, b.display_name AS reported_name
      FROM mix_reports r
      LEFT JOIN player_identity a ON a.swid = r.reporter_swid
      LEFT JOIN player_identity b ON b.swid = r.reported_swid
      ${onlyOpen ? "WHERE r.status = 'open'" : ""} ORDER BY r.id`).all() as any[];
  if (rows.length === 0) console.log(onlyOpen ? "(no open reports)" : "(no reports)");
  for (const r of rows) {
    const who = (name: string | null, swid: string) => (name ? `${name} ${swid}` : swid);
    console.log(`${String(r.id).padStart(4)}  ${r.status.padEnd(9)}  ${r.source.padEnd(3)}  ${r.created_at}  ${who(r.reporter_name, r.reporter_swid)} -> ${who(r.reported_name, r.reported_swid)}: ${r.reason}`);
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
  for (const r of rows) console.log(`${String(r.id).padStart(4)}  ${r.kind.padEnd(5)}  ${r.action.padEnd(5)}  ${r.pattern}`);
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
