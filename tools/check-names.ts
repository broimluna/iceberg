// Lists usernames and display names in a database that break the name rule
// (web-api/src/utils/names.ts), and names that clash ignoring case. Names
// saved before the rule existed aren't changed by it; use this to find them.
// Read-only.
//
//   bun tools/check-names.ts [--db <file>]   (default web-api/src/cpi_data.db)
//
// Exit code 1 when anything is listed.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkName } from "../web-api/src/utils/names.ts";

const dbArg = process.argv.indexOf("--db");
const dbPath = dbArg >= 0 ? resolve(process.argv[dbArg + 1] ?? "") : resolve(import.meta.dir, "../web-api/src/cpi_data.db");
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}`);
  process.exit(2);
}
const db = new Database(dbPath, { readonly: true });
const rows = db.query("SELECT swid, username, display_name FROM player_identity ORDER BY username").all() as
  { swid: string; username: string; display_name: string | null }[];
db.close();

let found = 0;
for (const r of rows) {
  for (const [field, value] of [["username", r.username], ["display name", r.display_name]] as const) {
    if (value == null || value === "") continue;
    const c = checkName(value);
    if (!c.ok) {
      console.log(`${r.swid}  ${field} ${JSON.stringify(value)}: ${c.reason}`);
      found++;
    } else if (c.name !== value) {
      console.log(`${r.swid}  ${field} ${JSON.stringify(value)}: would be stored as ${JSON.stringify(c.name)}`);
      found++;
    }
  }
}

// Usernames and display names share one namespace for lookups.
const byFolded = new Map<string, Set<string>>();
for (const r of rows) {
  for (const value of [r.username, r.display_name]) {
    if (!value) continue;
    const key = value.normalize("NFKC").trim().toLowerCase();
    if (!byFolded.has(key)) byFolded.set(key, new Set());
    byFolded.get(key)!.add(`${r.swid}:${value}`);
  }
}
for (const entries of byFolded.values()) {
  const swids = new Set([...entries].map((e) => e.split(":")[0]));
  if (swids.size > 1) {
    console.log(`clash: ${[...entries].map((e) => { const i = e.indexOf(":"); return `${JSON.stringify(e.slice(i + 1))} (${e.slice(0, i)})`; }).join(", ")}`);
    found++;
  }
}

console.log(found === 0 ? `${rows.length} accounts checked, nothing found` : `${found} problem(s) in ${rows.length} accounts`);
process.exit(found === 0 ? 0 : 1);
