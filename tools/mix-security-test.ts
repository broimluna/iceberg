// Security regressions found by review after the Mix merge (2026-11-07):
// 1. PUT /friendship: only the invitee can accept, trust comes from the
//    stored invitation, and the other player is found by SWID, not name.
// 2. PUT /displayname: length, filter and uniqueness rules.
// 3. CPI web-api requests from a banned player get 401 {code: 3}.
import { Database } from "bun:sqlite";
import { $ } from "bun";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { MixClient, createPlayer } from "./lib/mix-client.ts";

const api = await startWebApi({
  env: { ALLOW_SWID_AUTH: "1" },
  beforeStart: (dbPath) => {
    // A known filter rule set (see mix-moderation-test.ts).
    const d = new Database(dbPath);
    d.exec(`CREATE TABLE IF NOT EXISTS mix_moderation_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT NOT NULL, kind TEXT NOT NULL,
      action TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    d.prepare("INSERT INTO mix_moderation_rules (pattern, kind, action) VALUES (?, ?, ?)").run("heck", "word", "block");
    d.close();
  },
});
const { check, finish } = makeChecker();
const sql = (q: string, ...p: any[]) => { const d = new Database(api.dbPath); try { return d.query(q).all(...p); } finally { d.close(); } };
const friendRows = (a: string, b: string) => sql(
  "SELECT swid, friend_user_id, is_trusted FROM mix_friendships WHERE (swid = ? AND friend_user_id = ?) OR (swid = ? AND friend_user_id = ?)", a, b, b, a) as any[];

try {
  for (const [swid, name] of [["{SEC-A}", "alice"], ["{SEC-B}", "bob"], ["{SEC-M}", "mallory"], ["{SEC-C}", "carol"]]) {
    await createPlayer(api.base, api.dbPath, swid, name);
  }
  const login = async (name: string) => { const c = new MixClient(api.base); await c.login(name, `pw-${name}`); await c.startSession(); return c; };
  const A = await login("alice"), B = await login("bob"), M = await login("mallory");

  // --- 1a. The inviter can't accept their own invitation.
  const inv = (await A.call("PUT", "/friendship/invitation", { InviteeDisplayName: "bob", IsTrusted: false })).body;
  const invId = inv?.Notification?.Invitation?.FriendshipInvitationId;
  check(inv?.Status === "OK" && typeof invId === "number", `alice invites bob -> ${inv?.Status}`);
  const self = (await A.call("PUT", "/friendship", { InvitationId: invId, IsTrusted: true })).body;
  check(self?.Status === "INVITATION_DOES_NOT_EXIST", `alice accepting her own invitation -> ${self?.Status}`);
  check(friendRows("{SEC-A}", "{SEC-B}").length === 0, "no friendship created by the inviter");

  // --- 1b. Trust comes from the invitation, not the accepter's body.
  const acc = (await B.call("PUT", "/friendship", { InvitationId: invId, IsTrusted: true })).body;
  check(acc?.Status === "OK", `bob accepts -> ${acc?.Status}`);
  const rows = friendRows("{SEC-A}", "{SEC-B}");
  check(rows.length === 2 && rows.every((r) => r.is_trusted === 0), `untrusted invitation stays untrusted (${JSON.stringify(rows)})`);
  check(acc?.Notification?.IsTrusted === false, `accept notification IsTrusted = ${acc?.Notification?.IsTrusted}`);

  // --- 1c. A rename can't redirect a pending invitation. Mallory invites
  // carol; then mallory renames and alice is forced onto the old name
  // (directly in the DB, since 2 now blocks taking a used name).
  const inv2 = (await M.call("PUT", "/friendship/invitation", { InviteeDisplayName: "carol", IsTrusted: false })).body;
  const inv2Id = inv2?.Notification?.Invitation?.FriendshipInvitationId;
  sql("UPDATE player_identity SET display_name = 'mallory2' WHERE swid = '{SEC-M}'");
  sql("UPDATE player_identity SET display_name = 'mallory' WHERE swid = '{SEC-A}'");
  const C = await login("carol");
  const acc2 = (await C.call("PUT", "/friendship", { InvitationId: inv2Id, IsTrusted: false })).body;
  check(acc2?.Status === "OK" && acc2?.Notification?.Friend?.UserId === "{SEC-M}", `carol's accept befriends the inviter by SWID -> ${acc2?.Status} ${acc2?.Notification?.Friend?.UserId}`);
  check(friendRows("{SEC-C}", "{SEC-A}").length === 0, "the player now named 'mallory' got no friendship");
  sql("UPDATE player_identity SET display_name = 'alice' WHERE swid = '{SEC-A}'");
  sql("UPDATE player_identity SET display_name = 'mallory' WHERE swid = '{SEC-M}'");

  // --- 2. Display names.
  const setName = async (c: MixClient, n: any) => (await c.call("PUT", "/displayname", { DisplayName: n, Language: "en" })).body;
  const nameOf = (swid: string) => (sql("SELECT display_name FROM player_identity WHERE swid = ?", swid)[0] as any)?.display_name;
  for (const [label, n, status] of [
    ["another player's display name", "bob", "DISPLAYNAME_ASSIGNMENT_FAILED"],
    ["another player's display name, other case", "BoB", "DISPLAYNAME_ASSIGNMENT_FAILED"],
    ["another player's username", (sql("SELECT username FROM player_identity WHERE swid = '{SEC-C}'")[0] as any).username, "DISPLAYNAME_ASSIGNMENT_FAILED"],
    ["too short", "ab", "DISPLAYNAME_ASSIGNMENT_FAILED"],
    ["too long", "x".repeat(21), "DISPLAYNAME_ASSIGNMENT_FAILED"],
    ["blank", "   ", "DISPLAYNAME_ASSIGNMENT_FAILED"],
    ["not a string", 42, "DISPLAYNAME_ASSIGNMENT_FAILED"],
    ["blocked by the filter", "heck yes", "DISPLAYNAME_MODERATION_FAILED"],
    // Rules apply to the stored (NFKC-folded) name: U+FDFA expands to 18
    // characters, fullwidth letters fold to plain ones.
    ["over 20 characters once folded", "a\uFDFA\uFDFA", "DISPLAYNAME_ASSIGNMENT_FAILED"],
    ["a fullwidth filtered word", "\uFF48\uFF45\uFF43\uFF4B yes", "DISPLAYNAME_MODERATION_FAILED"],
  ] as const) {
    const r = await setName(M, n);
    check(r?.Status === status, `${label} (${JSON.stringify(n)}) -> ${r?.Status}`);
  }
  check(nameOf("{SEC-M}") === "mallory", `rejected names left mallory's name alone (${nameOf("{SEC-M}")})`);
  let ok = await setName(M, "  Mal  ");
  check(ok?.Status === "OK" && ok?.DisplayName === "Mal" && nameOf("{SEC-M}") === "Mal", `valid name is trimmed and stored -> ${JSON.stringify(ok)} / ${nameOf("{SEC-M}")}`);
  ok = await setName(M, "MAL");
  check(ok?.Status === "OK", `re-setting your own name in another case -> ${ok?.Status}`);
  ok = await setName(M, "\uFF2Dal2");
  check(ok?.DisplayName === "Mal2" && nameOf("{SEC-M}") === "Mal2", `the reply echoes the stored, folded name -> ${JSON.stringify(ok)} / ${nameOf("{SEC-M}")}`);

  // --- 3. A ban blocks CPI web-api calls made with an existing token.
  const cpi = (token: string) => fetch(`${api.base}/player/v1`, { headers: { Authorization: "Basic " + btoa(`${token}:x`) } });
  check((await cpi(B.accessToken)).status === 200, "bob's CPI call works before the ban");
  const s = await $`bun ${import.meta.dir}/mod.ts sanction bob TROLL 2 --db ${api.dbPath}`.nothrow().quiet();
  check(s.exitCode === 0, `ban bob -> exit ${s.exitCode} ${s.stderr.toString()}`);
  const r = await cpi(B.accessToken);
  const body = await r.json().catch(() => null);
  check(r.status === 401 && body?.code === 3, `banned bob's CPI call -> ${r.status} ${JSON.stringify(body)}`);
  check((await cpi(A.accessToken)).status === 200, "alice is unaffected");
} finally {
  api.stop();
}
finish(api.logs());
