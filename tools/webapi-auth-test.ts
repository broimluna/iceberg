// WebAPI access-token auth against a throwaway copy, with the default
// settings (no ALLOW_SWID_AUTH): valid tokens work; unknown, expired, or raw
// SWID values get 401 {code: 3} (the client refreshes its token) and never
// create an account.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";

const { check, finish } = makeChecker();
const basic = (v: string) => ({ Authorization: "Basic " + btoa(`${v}:x`) });
const players = () => (new Database(DB, { readonly: true }).query("SELECT COUNT(*) AS n FROM player_identity").get() as any).n;

// Phase 1: create a player (SWID auth allowed only here).
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1" } });
const DB = api.dbPath;
const BASE = api.base;
await fetch(`${BASE}/player/v1`, { headers: basic("{AUTH-TEST-1}") });
await api.stop();

// Tokens, stored the way the guest controller stores them (JS ISO strings).
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
{
  const db = new Database(DB);
  db.run("INSERT INTO guest_controller_tokens (token, token_type, swid, expires_at) VALUES (?, 'access', '{AUTH-TEST-1}', ?)", ["good-token", iso(3_600_000)]);
  db.run("INSERT INTO guest_controller_tokens (token, token_type, swid, expires_at) VALUES (?, 'access', '{AUTH-TEST-1}', ?)", ["expired-token", iso(-60_000)]);
  db.close();
}

// Phase 2: default settings.
await api.restart({});
try {
  const before = players();
  const ok = await fetch(`${BASE}/player/v1`, { headers: basic("good-token") });
  check(ok.status === 200, `valid token -> ${ok.status}`);
  for (const [label, value] of [["expired token (1 min ago, same day)", "expired-token"], ["unknown token", "9f".repeat(32)], ["raw SWID", "{AUTH-TEST-1}"]]) {
    const r = await fetch(`${BASE}/player/v1`, { headers: basic(value!) });
    const body = await r.json().catch(() => null);
    check(r.status === 401 && body?.code === 3, `${label} -> ${r.status} ${JSON.stringify(body)}`);
  }
  check(players() === before, `no account auto-created (${players()} players)`);
} finally {
  api.stop();
}
finish(api.logs());
