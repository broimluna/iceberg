// Moderation CLI for operators. Works while the server runs: the server
// notices committed rule changes through PRAGMA data_version
// (web-api/src/services/moderation.ts).
//
//   bun tools/mod.ts rules list
//   bun tools/mod.ts rules add <pattern> [--regex] [--block]
//   bun tools/mod.ts rules remove <id>
//
// --db <file> picks the database (default web-api/src/cpi_data.db).
// This opens the DB directly instead of importing database.ts, which
// opens its fixed path and runs migrations as a side effect.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

const USAGE = `usage: bun tools/mod.ts rules list
       bun tools/mod.ts rules add <pattern> [--regex] [--block]
       bun tools/mod.ts rules remove <id>
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
const [group, cmd, arg] = args;
if (group !== "rules" || !cmd) fail(USAGE);

if (!existsSync(dbPath)) fail(`no database at ${dbPath} (start the web API once to create it)`);
const db = new Database(dbPath);
db.exec("PRAGMA busy_timeout = 5000");
const hasTable = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mix_moderation_rules'").get();
if (!hasTable) fail(`${dbPath} has no mix_moderation_rules table (start the web API once to create it)`);

if (cmd === "list") {
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
