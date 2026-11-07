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
} finally {
  api.stop();
}
finish(api.logs());
