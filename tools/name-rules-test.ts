// The shared name rule (web-api/src/utils/names.ts) and every path that
// sets a username or display name.
import { startWebApi, makeChecker, issueApiKey, pw } from "./lib/harness.ts";
import { MixClient, createPlayer } from "./lib/mix-client.ts";
import { checkName } from "../web-api/src/utils/names.ts";

const { check, finish } = makeChecker();

// ---- the rule itself ----
const ok: [string, string, string][] = [
  ["plain", "Bob", "Bob"], ["digits and _-.", "Cool_Guy-2.0", "Cool_Guy-2.0"], ["single spaces", "Big Bob", "Big Bob"],
  ["accented Latin", "José Müller", "José Müller"], ["all Cyrillic", "Иван", "Иван"], ["all Greek", "Νίκος", "Νίκος"],
  ["padding is trimmed", "  Bob ", "Bob"], ["fullwidth folds to plain", "Ｂob", "Bob"], ["math bold folds", "\u{1D401}\u{1D428}\u{1D41B}", "Bob"],
  ["exactly 20", "x".repeat(20), "x".repeat(20)], ["NBSP padding folds and trims", "\u00A0Bob\u00A0", "Bob"], ["digits only", "123", "123"],
];
for (const [label, input, stored] of ok) {
  const r = checkName(input);
  check(r.ok && r.name === stored, `${label}: ${JSON.stringify(input)} -> ${JSON.stringify(r)}`);
}
const bad: [string, string, string][] = [
  ["emoji", "Cool😎Guy", "chars"], ["only emoji", "😎😎😎", "chars"], ["ZWJ emoji", "a👨‍👩‍👧b", "chars"],
  ["zalgo", "Z̷̢̛a̸l̵g̶o̴", "chars"], ["RTL override", "abc‮gnp", "chars"], ["zero-width inside", "Bo​b", "chars"],
  ["control char", "Bob\u0007x", "chars"], ["newline", "Bob\nAdmin", "chars"], ["tab", "Bo\tb", "chars"], ["NUL", "Bob\u0000x", "chars"],
  ["Cyrillic in a Latin name", "бob", "mixed"], ["Cyrillic a in admin", "аdmin", "mixed"], ["Greek omicron in Bob", "Bοb", "mixed"],
  ["Unity rich text", "<b>Mod</b>", "chars"], ["size tag", "<size=200>X", "chars"], ["SQL-ish", "bob'; DROP--", "chars"],
  ["too long", "x".repeat(21), "length"], ["way too long", "x".repeat(5000), "length"], ["too short", "ab", "length"], ["empty", "", "length"],
  ["double space", "a  b", "spacing"], ["ideographic spaces", "　　　", "length"],
  ["Hangul filler", "ㅤㅤㅤ", "chars"], ["Braille blank", "⠀⠀⠀", "chars"], ["lone surrogate", "ab\uD800c", "chars"],
  ["no letter or digit", "._-", "chars"], ["folds past 20", "aﷺﷺ", "length"], ["not a string", 42 as any, "length"],
];
for (const [label, input, reason] of bad) {
  const r = checkName(input);
  check(!r.ok && r.reason === reason, `${label}: ${JSON.stringify(input).slice(0, 40)} -> ${JSON.stringify(r)}`);
}

// ---- every path uses it ----
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1" } });
try {
  const register = async (body: unknown) => fetch(`${api.base}/jgc/v5/client/T/guest/register?langPref=en`, {
    method: "POST", headers: { Authorization: `APIKEY ${await issueApiKey(api.base)}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  for (const n of ["Cool😎Guy", "<color=red>Mod</color>", "аdmin", "x".repeat(5000), "ㅤㅤㅤ"]) {
    let r = await register({ password: pw("main"), profile: { username: n } });
    check(r.status === 400, `register refuses username ${JSON.stringify(n).slice(0, 30)} (${r.status})`);
    r = await register({ password: pw("main"), profile: {}, displayName: { proposedDisplayName: n } });
    check(r.status === 400, `register refuses display name ${JSON.stringify(n).slice(0, 30)} (${r.status})`);
  }
  const good = await register({ password: pw("main"), profile: { username: "  José_99 " }, displayName: { proposedDisplayName: "Jose Fan" } });
  const body: any = await good.json();
  check(good.status === 200 && body?.data?.profile?.username === "José_99", `a valid name registers, trimmed (${good.status} ${body?.data?.profile?.username})`);

  await createPlayer(api.base, api.dbPath, "{nr-a}", "Renamer");
  const rename = (n: string) => fetch(`${api.base}/player/v1/displayName`, {
    method: "POST", headers: { Authorization: "Basic " + btoa("{nr-a}:x"), "Content-Type": "application/json" }, body: JSON.stringify({ displayName: n }),
  });
  for (const n of ["😎😎😎", "<size=200>X", "Bοb"]) check((await rename(n)).status === 400, `in-game rename refuses ${JSON.stringify(n)}`);
  check((await rename("Renamed Ok")).status === 200, "in-game rename accepts a valid name");

  const mix = new MixClient(api.base);
  await mix.login("José_99", pw("main"));
  await mix.startSession();
  for (const n of ["Cool😎Guy", "аdmin", "a  b"]) {
    const r = (await mix.call("PUT", "/displayname", { DisplayName: n, Language: "en" })).body;
    check(r?.Status === "DISPLAYNAME_ASSIGNMENT_FAILED", `Mix rename refuses ${JSON.stringify(n)} (${r?.Status})`);
  }

  // tools/check-names.ts reports names in an existing database that break the rule.
  const { Database } = await import("bun:sqlite");
  await createPlayer(api.base, api.dbPath, "{nr-bad}", "Cool😎Guy");
  await createPlayer(api.base, api.dbPath, "{nr-dup1}", "Twin");
  await createPlayer(api.base, api.dbPath, "{nr-dup2}", "TWIN");
  const db = new Database(api.dbPath); db.run("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  const out = await Bun.$`bun ${import.meta.dir}/check-names.ts --db ${api.dbPath}`.nothrow().quiet();
  const text = out.stdout.toString();
  check(text.includes("Cool😎Guy") && text.includes("chars"), `the report lists a display name with emoji (${JSON.stringify(text.slice(0, 200))})`);
  check(/Twin/.test(text) && /TWIN/.test(text) && /clash/i.test(text), "and names that clash ignoring case");
  check(!text.includes("Renamed Ok"), "valid names aren't listed");
  check(out.exitCode === 1, `exit code 1 when something is found (${out.exitCode})`);
} finally {
  await api.stop();
}
finish(api.logs());
