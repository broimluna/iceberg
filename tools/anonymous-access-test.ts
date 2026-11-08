// Requests without a login: the CPI game API refuses them (401 {code: 3},
// which makes the client refresh its token) instead of acting as a shared
// fallback account. Only the calls the client itself makes without
// credentials stay open: other-player lookups, the encryption key and
// diagnostics.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { createPlayer } from "./lib/mix-client.ts";

const { check, finish } = makeChecker();
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1" } });
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${api.base}${path}`, {
    method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
};

try {
  await createPlayer(api.base, api.dbPath, "{anon-real}", "RealPlayer");

  // ---- the game API needs a login ----
  for (const [method, path, body] of [
    ["GET", "/player/v1/"],
    ["POST", "/reward/v1", { coins: 1000 }],
    ["POST", "/reward/v1/claimQuickNotification", {}],
    ["POST", "/quest/v1/AAA001", { status: 3 }],
    ["POST", "/event/v1/cfc/-5", {}],
    ["POST", "/minigame/v1/fishing/catch", {}],
    ["POST", "/inventory/v1/equipment", { definitionId: 1 }],
    ["POST", "/igloo/v1/decorations/0/1", {}],
    ["POST", "/consumable/v1/HotChocolateGroup/1", {}],
    ["POST", "/game/v1/worlds/Alpine/language/en/rooms/Town/players", {}],
    ["POST", "/player/v1/id/online", ["{anon-real}"]],
    ["POST", "/REWARD/v1", { coins: 1000 }],
    ["GET", "/player/v1"],
  ] as [string, string, unknown?][]) {
    const r = await call(method, path, body);
    check(r.status === 401 && r.json?.code === 3, `no login: ${method} ${path} is refused with 401 {code: 3} (${r.status})`);
  }
  const db = new Database(api.dbPath, { readonly: true });
  const debug = db.query("SELECT (SELECT COUNT(*) FROM players WHERE lower(username) = 'debugpenguin') + (SELECT COUNT(*) FROM player_identity WHERE lower(username) = 'debugpenguin') AS n").get() as { n: number };
  db.close();
  check(debug.n === 0, `no shared fallback account was created (${debug.n})`);

  // ---- what the client calls without credentials still works ----
  for (const [method, path, body] of [
    ["GET", "/player/v1/name/RealPlayer"],
    ["POST", "/player/v1/names", ["RealPlayer"]],
    ["GET", "/player/v1/id/{anon-real}"],
    ["POST", "/player/v1/id", ["{anon-real}"]],
    ["GET", "/player/v1/session/123"],
    ["POST", "/encryption-trusted/v1/encryptionKey", {}],
    ["POST", "/diagnostics/v1/log", []],
  ] as [string, string, unknown?][]) {
    const r = await call(method, path, body);
    check(r.status !== 401 && r.status < 500, `no login: ${method} ${path} still answers (${r.status})`);
  }

  // ---- with a login, as before ----
  const r = await call("GET", "/player/v1/", undefined, { Authorization: "Basic " + btoa("{anon-real}:x") });
  check(r.status === 200, `with a login: GET /player/v1/ works (${r.status})`);
} finally {
  await api.stop();
}
finish();
