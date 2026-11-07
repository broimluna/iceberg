// Checks the WebAPI fixes against a throwaway copy (scratchpad/webapi-copy):
// X-HTTP-Method-Override routing, the invitations migration, and session
// online/offline handling.
import { Database } from "bun:sqlite";

import { startWebApi, makeChecker } from "./lib/harness.ts";

const { check, finish } = makeChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Old schema + a half-written invite (inviter row only) + a complete-looking pair is impossible in the old schema.
const api = await startWebApi({
  env: { ALLOW_SWID_AUTH: "1" },
  beforeStart: (DB) => {  const db = new Database(DB, { create: true });
  db.exec(`CREATE TABLE mix_friendship_invitations (
    invitation_id INTEGER PRIMARY KEY, swid TEXT NOT NULL, friend_display_name TEXT NOT NULL,
    is_inviter INTEGER DEFAULT 0, is_trusted INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  db.run("INSERT INTO mix_friendship_invitations (invitation_id, swid, friend_display_name, is_inviter) VALUES (569143012, '{A}', 'tboskk1', 1)");
  db.close();
  },
});
const DB = api.dbPath;
const BASE = api.base;

const server = { kill: api.stop };
const out = { includes: (t: string) => api.logs().includes(t) };

try {
  const auth = { Authorization: "Basic " + btoa("{TESTSWID-1}:x") };
  // Create the player through any authenticated request.
  await fetch(`${BASE}/player/v1`, { headers: auth });
  const coins = () => new Database(DB, { readonly: true }).query("SELECT coins FROM player_assets a JOIN player_identity i ON i.username = a.username WHERE i.swid = '{TESTSWID-1}'").get() as { coins: number } | null;
  let before: number | undefined;
  try { before = coins()?.coins; } catch (e) { console.log("coins query:", (e as Error).message); }

  // ---- PUT via X-HTTP-Method-Override ----
  const body = JSON.stringify({ goodUntil: 0, signature: "", swid: "", data: { source: 1, sourceId: "7", rewards: { "123": { coins: 25 } } } });
  const r = await fetch(`${BASE}/reward/v1`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", "X-HTTP-Method-Override": "PUT" }, body });
  check(r.ok, `POST + override PUT /reward/v1 -> ${r.status}`);
  await sleep(100);
  check(out.includes("echoed a reward.add, not applied"), "reached the PUT /reward/v1 handler (not the POST claim handler)");
  check(!out.includes("claiming generic reward"), "POST claim handler not hit");
  let after: number | undefined;
  try { after = coins()?.coins; } catch {}
  console.log(`coins before=${before} after=${after}`);
  if (before !== undefined && after !== undefined) check(after === before, "client reward echo grants nothing (rewards are server-granted)");

  // ---- invitations migration ----
  const db = new Database(DB);
  const pk = db.query("SELECT name FROM pragma_table_info('mix_friendship_invitations') WHERE pk > 0 ORDER BY pk").all().map((x: any) => x.name);
  check(JSON.stringify(pk) === '["invitation_id","swid"]', `invitations primary key is now ${JSON.stringify(pk)}`);
  check((db.query("SELECT COUNT(*) AS n FROM mix_friendship_invitations").get() as any).n === 0, "half-written invite removed");
  db.run("INSERT INTO mix_friendship_invitations (invitation_id, swid, friend_display_name, is_inviter) VALUES (1, '{A}', 'b', 1)");
  db.run("INSERT INTO mix_friendship_invitations (invitation_id, swid, friend_display_name, is_inviter) VALUES (1, '{B}', 'a', 0)");
  check((db.query("SELECT COUNT(*) AS n FROM mix_friendship_invitations WHERE invitation_id = 1").get() as any).n === 2, "both sides of one invitation insert");

  // ---- online / offline ----
  db.run("INSERT INTO player_sessions (session_id, swid, username, room_name) VALUES (2112464646, '{TESTSWID-1}', (SELECT username FROM player_identity WHERE swid = '{TESTSWID-1}'), 'Town')");
  db.close();
  const online = async () => (await (await fetch(`${BASE}/player/v1/id/online`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(["{TESTSWID-1}", "{NOPE}"]) })).json());
  check(JSON.stringify(await online()) === '["{TESTSWID-1}"]', "fresh session counts as online");
  // Card onlineLocation must carry the room list's contentIdentifier.
  {
    const dbw = new Database(DB);
    dbw.run("UPDATE player_sessions SET world = 'Alpine' WHERE session_id = 2112464646");
    dbw.close();
    const card = await (await fetch(`${BASE}/player/v1/id/${encodeURIComponent("{TESTSWID-1}")}`, { headers: auth })).json() as any;
    const rooms = await (await fetch(`${BASE}/game/v1/rooms?language=en_US&rooms=Town&limit=1`, { headers: auth })).json() as any;
    const roomCi = Array.isArray(rooms) ? rooms[0]?.contentIdentifier : undefined;
    const loc = card.onlineLocation ?? card.data?.onlineLocation;
    check(loc?.contentIdentifier === roomCi && !!roomCi, `card contentIdentifier ${loc?.contentIdentifier} == room list ${roomCi}`);
    check(loc?.world === "Alpine" && loc?.zoneId?.name === "Town", `card world/room ${loc?.world}/${loc?.zoneId?.name}`);
  }
  const ended = await fetch(`${BASE}/api/internal/session-ended`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: 2112464646 }) });
  check(ended.ok, `session-ended -> ${ended.status}`);
  check(JSON.stringify(await online()) === "[]", "offline after session-ended");
  const bad = await fetch(`${BASE}/api/internal/session-ended`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check(bad.status === 400, "session-ended without sessionId -> 400");
} finally {
  server.kill();
}
finish(api.logs());
