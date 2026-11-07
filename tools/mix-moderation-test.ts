// The shared text filter (services/moderation.ts): Mix's PUT
// /moderation/text and CPI's POST /chat/v1/message/verify both run it, and
// tools/mod.ts edits its rules while the server runs.
import { Database } from "bun:sqlite";
import { $ } from "bun";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { MixClient, createPlayer } from "./lib/mix-client.ts";

const api = await startWebApi({
  env: { ALLOW_SWID_AUTH: "1" },
  beforeStart: (dbPath) => {
    // Creating the table here means the server's starter list is not
    // seeded, so the test knows exactly which rules exist.
    const d = new Database(dbPath);
    d.exec(`CREATE TABLE IF NOT EXISTS mix_moderation_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT NOT NULL, kind TEXT NOT NULL,
      action TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    const ins = d.prepare("INSERT INTO mix_moderation_rules (pattern, kind, action) VALUES (?, ?, ?)");
    ins.run("darn", "word", "mask");
    ins.run("heck", "word", "block");
    ins.run("\\bf+o+o+\\b", "regex", "mask");
    d.close();
  },
});
const { check, finish } = makeChecker();

try {
  await createPlayer(api.base, api.dbPath, "{MOD-1}", "molly");
  const M = new MixClient(api.base);
  await M.login("molly", "pw-molly");
  await M.startSession();
  const mod = async (text: string) => (await M.call("PUT", "/moderation/text", { Text: text, Language: "en" })).body;

  let r = await mod("Darn it");
  check(r?.Status === "OK" && r?.Text === "**** it" && r?.Moderated === true, `"Darn it" -> ${JSON.stringify(r)}`);
  r = await mod("what the heck");
  check(r?.Moderated === true && !/heck/i.test(r?.Text ?? "heck"), `blocked "what the heck" -> ${JSON.stringify(r)}`);
  r = await mod("fooooo");
  check(r?.Text === "******" && r?.Moderated === true, `regex "fooooo" -> ${JSON.stringify(r)}`);
  r = await mod("darned");
  check(r?.Text === "darned" && r?.Moderated === false, `whole word "darned" -> ${JSON.stringify(r)}`);
  r = await mod("héllo 👋 café");
  check(r?.Text === "héllo 👋 café" && r?.Moderated === false, `unicode untouched -> ${JSON.stringify(r)}`);

  const v = await fetch(`${api.base}/chat/v1/message/verify`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa("{MOD-1}:x"), "Content-Type": "application/json" },
    body: JSON.stringify({ senderSessionId: 1, message: "darn", emotion: 0, moderated: false }),
  });
  const vb: any = await v.json().catch(() => null);
  check(v.status === 200 && vb?.data?.moderated === true && vb?.data?.message === "****", `CPI verify "darn" -> ${v.status} ${JSON.stringify(vb?.data)}`);

  // A rule added by the CLI reaches the running server (PRAGMA data_version).
  r = await mod("gosh");
  check(r?.Text === "gosh", `"gosh" before the CLI add -> ${JSON.stringify(r)}`);
  const out = await $`bun ${import.meta.dir}/mod.ts rules add gosh --db ${api.dbPath}`.nothrow().quiet();
  check(out.exitCode === 0, `mod.ts rules add -> exit ${out.exitCode} ${out.stderr.toString()}`);
  r = await mod("gosh");
  check(r?.Text === "****" && r?.Moderated === true, `"gosh" after the CLI add -> ${JSON.stringify(r)}`);
  const list = await $`bun ${import.meta.dir}/mod.ts rules list --db ${api.dbPath}`.nothrow().quiet();
  check(list.exitCode === 0 && /gosh/.test(list.stdout.toString()), `mod.ts rules list shows gosh`);

  // Reports from both apps land in mix_reports.
  await createPlayer(api.base, api.dbPath, "{MOD-A}", "alice");
  await createPlayer(api.base, api.dbPath, "{MOD-B}", "bob");
  const A = new MixClient(api.base);
  await A.login("alice", "pw-alice");
  await A.startSession();
  const mr = await A.call("PUT", "/moderation/reportPlayer", { ReportedUserId: "{MOD-B}", Reason: "ChatSwearing" });
  check(mr.http === 200 && mr.body?.Status === "OK", `Mix reportPlayer -> ${mr.http} ${JSON.stringify(mr.body)}`);
  const cpiReport = (name: string, reason: string) => fetch(`${api.base}/moderation/v1/report/name/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa("{MOD-A}:x"), "Content-Type": "application/json" },
    body: JSON.stringify(reason),
  });
  const cr = await cpiReport("bob", "Harassment");
  check(cr.status === 200, `CPI report bob -> ${cr.status}`);
  const ghost = await cpiReport("nobody-here", "Other");
  check(ghost.status === 200, `CPI report of an unknown name is still 200 -> ${ghost.status}`);

  const d = new Database(api.dbPath, { readonly: true });
  const rows = d.query("SELECT reporter_swid, reported_swid, reason, source, status FROM mix_reports WHERE reported_swid = '{MOD-B}' ORDER BY id").all() as any[];
  const unknown = d.query("SELECT reported_swid, source FROM mix_reports WHERE reported_swid LIKE 'name:%'").all() as any[];
  d.close();
  check(rows.length === 2 && rows.every((r) => r.status === "open" && r.reporter_swid === "{MOD-A}"), `2 open reports of bob by alice (${JSON.stringify(rows)})`);
  check(rows[0]?.source === "mix" && rows[0]?.reason === "ChatSwearing", `Mix report row ${JSON.stringify(rows[0])}`);
  check(rows[1]?.source === "cpi" && rows[1]?.reason === "Harassment", `CPI report row ${JSON.stringify(rows[1])}`);
  check(unknown.length === 1 && unknown[0].reported_swid === "name:nobody-here" && unknown[0].source === "cpi", `unknown name stored as name: (${JSON.stringify(unknown)})`);

  // Operators triage reports with the CLI.
  const open = await $`bun ${import.meta.dir}/mod.ts reports --open --db ${api.dbPath}`.nothrow().quiet();
  const openText = open.stdout.toString();
  check(open.exitCode === 0 && /ChatSwearing/.test(openText) && /Harassment/.test(openText), `mod.ts reports --open lists both`);
  const firstId = openText.match(/^\s*(\d+)/m)?.[1];
  const dis = await $`bun ${import.meta.dir}/mod.ts report ${firstId ?? "0"} dismiss --db ${api.dbPath}`.nothrow().quiet();
  check(dis.exitCode === 0, `mod.ts report ${firstId} dismiss -> ${dis.exitCode} ${dis.stderr.toString()}`);
  const after = (await $`bun ${import.meta.dir}/mod.ts reports --open --db ${api.dbPath}`.nothrow().quiet()).stdout.toString();
  check(!new RegExp(`^\\s*${firstId}\\s`, "m").test(after) && /Harassment/.test(after), `dismissed report leaves the open list`);
  const all = (await $`bun ${import.meta.dir}/mod.ts reports --db ${api.dbPath}`.nothrow().quiet()).stdout.toString();
  check(new RegExp(`^\\s*${firstId}\\s.*dismissed`, "m").test(all), `mod.ts reports shows it as dismissed`);

  // Player-supplied text reaches an operator's terminal: control
  // characters (ANSI escapes, CR) are printed escaped, and reasons are capped.
  await A.call("PUT", "/moderation/reportPlayer", { ReportedUserId: "{MOD-B}", Reason: "\x1b[2J\x1b[31mspoof\r" + "x".repeat(5000) });
  const esc = (await $`bun ${import.meta.dir}/mod.ts reports --db ${api.dbPath}`.nothrow().quiet()).stdout.toString();
  check(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(esc) && esc.includes("\\x1b[2J"), `reports output escapes control characters`);
  const d2 = new Database(api.dbPath, { readonly: true });
  const longest = (d2.query("SELECT MAX(LENGTH(reason)) AS n FROM mix_reports").get() as any).n;
  d2.close();
  check(longest <= 500, `stored reason capped (${longest})`);
  // Bidi overrides, zero-width and line-separator characters can reorder or
  // hide text without any control character.
  await A.call("PUT", "/moderation/reportPlayer", { ReportedUserId: "{MOD-B}", Reason: "ok\u202Edesrever\u200B\u2028x" });
  const bidi = (await $`bun ${import.meta.dir}/mod.ts reports --db ${api.dbPath}`.nothrow().quiet()).stdout.toString();
  check(!/[\u202E\u200B\u2028]/.test(bidi) && bidi.includes("\\u{202e}") && bidi.includes("\\u{2028}"), `reports output escapes bidi/format/separator characters`);

  // ---- Sanctions: Disney's ladder (MIX_API.md section 9) ----
  const B = new MixClient(api.base);
  await B.login("bob", "pw-bob");
  await B.startSession();
  await B.state();
  const cli = (...a: string[]) => $`bun ${import.meta.dir}/mod.ts ${a} --db ${api.dbPath}`.nothrow().quiet();
  const gcLogin = async (name: string, pw: string) => {
    const gc = `${api.base}/jgc/v5/client/CPI-TEST`;
    const k = await fetch(`${gc}/api-key`, { method: "POST" });
    const r = await fetch(`${gc}/guest/login?expand=profile,displayName,marketing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `APIKEY ${k.headers.get("api-key")}` },
      body: JSON.stringify({ loginValue: name, password: pw }),
    });
    const body: any = await r.json().catch(() => null);
    return { status: r.status, code: body?.error?.errors?.[0]?.code ?? null, ok: !!body?.data?.token?.access_token };
  };

  // Warning only: an alert, no ban.
  let sres = await cli("sanction", "bob", "TROLL", "1");
  check(sres.exitCode === 0, `mod.ts sanction bob TROLL 1 -> ${sres.exitCode} ${sres.stderr.toString()}`);
  const got = await B.drain();
  const alert = got.find((g) => g.type === "AddAlert")?.n?.Alert;
  check(alert?.Text === "TROLL" && alert?.Level === "1" && typeof alert?.AlertId === "number", `bob gets AddAlert TROLL/1 (${JSON.stringify(alert)})`);
  check((await B.call("POST", "/state")).http === 200, "a warning doesn't block bob");

  // Next TROLL is suggested at level 2: a 12 h ban.
  sres = await cli("sanction", "bob", "TROLL");
  const sOut = sres.stdout.toString();
  check(sres.exitCode === 0 && /level 2/.test(sOut) && /12 h|12h/.test(sOut), `suggested level 2 = 12 h ban (${sOut.trim()})`);
  const banned = await B.call("POST", "/state");
  check(banned.http === 401 && banned.body?.Status === "UNAUTHORIZED_BANNED", `banned bob's call -> ${banned.http} ${JSON.stringify(banned.body)}`);
  let li = await gcLogin("bob", "pw-bob");
  check(li.status === 400 && li.code === "PROFILE_USER_BANNED", `temp-banned login -> ${li.status} ${li.code}`);
  const wrongPw = await gcLogin("bob", "nope");
  check(wrongPw.code === "INVALID_CREDENTIALS", `wrong password still says INVALID_CREDENTIALS, not banned (${wrongPw.code})`);

  // Expiry.
  { const d3 = new Database(api.dbPath); d3.run("UPDATE mix_bans SET until = ? WHERE swid = '{MOD-B}'", [new Date(Date.now() - 60_000).toISOString()]); d3.close(); }
  li = await gcLogin("bob", "pw-bob");
  check(li.ok, `login works after the ban expires (${li.status} ${li.code})`);

  // VULNERABLE_PERSON starts at level 3: a lock.
  sres = await cli("sanction", "bob", "VULNERABLE_PERSON", "1");
  check(sres.exitCode === 0 && /level 3/.test(sres.stdout.toString()), `VULNERABLE_PERSON 1 clamps to 3 (${sres.stdout.toString().trim()})`);
  li = await gcLogin("bob", "pw-bob");
  check(li.status === 400 && li.code === "PROFILE_DISABLED", `locked login -> ${li.status} ${li.code}`);

  // Unban.
  const ub = await cli("unban", "bob");
  check(ub.exitCode === 0, `mod.ts unban bob -> ${ub.exitCode} ${ub.stderr.toString()}`);
  li = await gcLogin("bob", "pw-bob");
  check(li.ok, `login works after unban (${li.status} ${li.code})`);
  const d4 = new Database(api.dbPath, { readonly: true });
  const sanctions = d4.query("SELECT type, level FROM mix_sanctions WHERE swid = '{MOD-B}' ORDER BY id").all();
  d4.close();
  check(JSON.stringify(sanctions) === JSON.stringify([{ type: "TROLL", level: 1 }, { type: "TROLL", level: 2 }, { type: "VULNERABLE_PERSON", level: 3 }]), `sanction history ${JSON.stringify(sanctions)}`);
} finally {
  api.stop();
}
finish(api.logs());
