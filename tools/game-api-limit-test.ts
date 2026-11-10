// Game API call limits: one account (and one address) can only make so many
// calls a minute; the limits are per account, so another player is not
// affected, and routes outside the game API are not counted.
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { createPlayer } from "./lib/mix-client.ts";

const { check, finish } = makeChecker();

const asA = { Authorization: "Basic " + btoa("{limit-a}:x") };
const asB = { Authorization: "Basic " + btoa("{limit-b}:x") };
const get = (base: string, path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers }).then((r) => r.status);

// ---- per account ----
{
  const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", GAME_API_PER_ACCOUNT_PER_MIN: "5", GAME_API_PER_IP_PER_MIN: "0" } });
  try {
    await createPlayer(api.base, api.dbPath, "{limit-a}", "LimitA");
    await createPlayer(api.base, api.dbPath, "{limit-b}", "LimitB");
    // createPlayer made the account's first call, so 4 of the 5 are left.
    const a: number[] = [];
    for (let i = 0; i < 8; i++) a.push(await get(api.base, "/player/v1/", asA));
    check(a.slice(0, 4).every((s) => s === 200), `account: the calls up to the limit of 5 are answered (${a.slice(0, 4)})`);
    check(a.slice(4).every((s) => s === 429), `account: the rest of the minute is refused with 429 (${a.slice(4)})`);
    check(await get(api.base, "/player/v1/", asB) === 200, "another account is not affected");
    check(await get(api.base, "/player/v1/name/LimitB") === 200, "lookups without a login are not counted against the account");
    const outside: number[] = [];
    for (let i = 0; i < 12; i++) outside.push(await get(api.base, "/"));
    check(outside.every((s) => s !== 429), "routes outside the game API are not limited");
    check(/\[RATE-LIMIT\] game-api\/account/.test(api.logs()), "the refusal is logged");
  } finally { await api.stop(); }
}

// ---- per address, with and without a login ----
{
  const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", GAME_API_PER_ACCOUNT_PER_MIN: "0", GAME_API_PER_IP_PER_MIN: "6" } });
  try {
    await createPlayer(api.base, api.dbPath, "{limit-a}", "LimitA");
    const s: number[] = [];
    for (let i = 0; i < 4; i++) s.push(await get(api.base, "/player/v1/name/LimitA"));
    for (let i = 0; i < 4; i++) s.push(await get(api.base, "/player/v1/", { Authorization: "Basic " + btoa(`bad-${i}:x`) }));
    // createPlayer made the address's first call, so 5 of the 6 are left.
    check(s.slice(0, 5).every((x) => x !== 429), `address: the calls up to the limit of 6 are not refused (${s.slice(0, 5)})`);
    check(s.slice(5).every((x) => x === 429), `address: later calls, with bad tokens too, are refused with 429 (${s.slice(5)})`);
    check(await get(api.base, "/") !== 429, "routes outside the game API are not limited");
  } finally { await api.stop(); }
}

// ---- a normal session is nowhere near the defaults ----
{
  const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1" } });
  try {
    await createPlayer(api.base, api.dbPath, "{limit-a}", "LimitA");
    const s: number[] = [];
    for (let i = 0; i < 60; i++) s.push(await get(api.base, "/player/v1/", asA));
    check(s.every((x) => x === 200), "default limits: 60 calls in a row are all answered");
  } finally { await api.stop(); }
}
finish();
