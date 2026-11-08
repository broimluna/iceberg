// Fixes found on the first deployed test server:
// - joinRoomData.tcpPort is a number even when GAME_SERVER_PORT is set
//   (the client's JoinRoomData.tcpPort is an int; a string stops its JSON
//   mapper and the room is never read).
// - Guest Controller error codes are ones GuestControllerErrorParser maps,
//   so a wrong password, a lockout or a bad refresh token reach the right
//   message instead of a generic popup.
// - Display-name validate doesn't report the caller's own name as taken
//   (the client validates the name it just registered; the call carries
//   only the API key, which the server ties to the account it logged in).
// - A forged quest.set (its SignedResponse isn't verified) pays nothing.
// - No X-Powered-By header.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker, issueApiKey } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";
import { createPlayer } from "./lib/mix-client.ts";
import { SFSObjectWriter } from "../smartfox-server/src/sfs-wire.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
const baseEnv = { ALLOW_SWID_AUTH: "1", LEGACY_PASSWORD_CLAIM: "0", JOIN_SIGNING_KEY: KEY, GAME_SERVER_PORT: "9933" };
const api = await startWebApi({ env: baseEnv });
const gc = `${api.base}/jgc/v5/client/T`;
const sql = (q: string, ...p: any[]) => { const d = new Database(api.dbPath); try { return d.query(q).all(...p) as any[]; } finally { d.close(); } };
const codesOf = async (r: Response) => ((await r.json()) as any)?.error?.errors?.map((e: any) => e.code) ?? [];
const post = (path: string, body: unknown, key: string) => fetch(`${gc}${path}`, {
  method: "POST", headers: { Authorization: `APIKEY ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const register = async (username: string, displayName: string, key: string) =>
  post("/guest/register?langPref=en", { password: "hunter22", profile: { username }, displayName: { proposedDisplayName: displayName } }, key);
const login = async (loginValue: string, password: string, key?: string) =>
  post("/guest/login", { loginValue, password }, key ?? (await issueApiKey(api.base)));

// Codes the client's GuestControllerErrorParser knows, per list.
const LOGIN_CODES = ["MISSING_VALUE", "PPU_MARKETING", "PPU_LEGAL", "PPU_SECURITY", "AUTHORIZATION_MASE_ERROR", "AUTHORIZATION_PARENTAL_CONSENT_REQUIRED",
  "PROFILE_USER_BANNED", "PROFILE_DISABLED", "AUTHORIZATION_ACCOUNT_LOCKED_OUT", "AUTHORIZATION_CREDENTIALS", "MALFORMED_INPUT", "RATE_LIMITED", "GUEST_GATED_LOCATION"];
const VALIDATION_CODES = ["INVALID_VALUE_PASSWORD_MISSING_EXPECTED_CHARS", "INVALID_VALUE_PASSWORD_SIZE", "INVALID_VALUE_PASSWORD_TOO_COMMON",
  "INVALID_VALUE_PASSWORD_LIKE_PHONE_NUMBER", "ACCOUNT_FOUND", "INUSE_VALUE", "AUTHORIZATION_MASE_ERROR", "DISALLOWED_VALUE", "INVALID_VALUE",
  "INVALID_VALUE_FILTHY", "INVALID_VALUE_USERNAME_SIZE", "NRT_ACCOUNT", "INVALID_OR_MALFORMED_REQUEST", "RATE_LIMITED"];

let sfs: { stop: () => void } | null = null;
try {
  // ---- 1. tcpPort is a number ----
  await createPlayer(api.base, api.dbPath, "{PD-PORT}", "PortCheck");
  const jr = await fetch(`${api.base}/game/v1/worlds/Alpine/language/en/rooms/Town/players`, {
    method: "POST", headers: { Authorization: "Basic " + btoa("{PD-PORT}:x"), "Content-Type": "application/json" }, body: "{}",
  });
  const join = (await jr.json()) as any;
  const jrd = join.data ?? join;
  check(jrd.tcpPort === 9933, `tcpPort with GAME_SERVER_PORT set is the number 9933 (${JSON.stringify(jrd.tcpPort)})`);
  check(typeof jrd.httpsPort === "number", `httpsPort is a number (${JSON.stringify(jrd.httpsPort)})`);

  // ---- 7. no X-Powered-By ----
  check(jr.headers.get("x-powered-by") === null, `no X-Powered-By header (${jr.headers.get("x-powered-by")})`);

  // ---- 2. login error codes ----
  const key0 = await issueApiKey(api.base);
  check((await register("PdUser1", "Pd Penguin", key0)).status === 200, "registered PdUser1");
  let r = await login("PdUser1", "wrongpass");
  let codes = await codesOf(r);
  check(r.status === 400 && codes.join() === "AUTHORIZATION_CREDENTIALS", `wrong password -> 400 AUTHORIZATION_CREDENTIALS (${r.status} ${codes})`);
  r = await login("NoSuchPenguin", "whatever1");
  codes = await codesOf(r);
  check(r.status === 400 && codes.join() === "AUTHORIZATION_CREDENTIALS", `unknown account -> 400 AUTHORIZATION_CREDENTIALS (${r.status} ${codes})`);
  r = await post("/guest/login", { loginValue: "PdUser1" }, key0);
  codes = await codesOf(r);
  check(r.status === 400 && codes.every((c: string) => LOGIN_CODES.includes(c)) && !codes.includes("MISSING_VALUE"),
    `missing password -> a login code the client maps, not MISSING_VALUE (${r.status} ${codes})`);
  await createPlayer(api.base, api.dbPath, "{PD-NOPASS}", "NoPassPd");
  r = await login("NoPassPd", "claimit1");
  codes = await codesOf(r);
  check(r.status === 400 && codes.join() === "AUTHORIZATION_CREDENTIALS", `password-less account -> AUTHORIZATION_CREDENTIALS (${r.status} ${codes})`);

  // ---- 2. refresh with an unknown token ----
  r = await fetch(`${gc}/guest/refresh-auth/not-a-real-token`, { method: "POST" });
  codes = await codesOf(r);
  check(r.status === 400 && codes.join() === "AUTHORIZATION_INVALID_REFRESH_TOKEN", `unknown refresh token -> 400 AUTHORIZATION_INVALID_REFRESH_TOKEN (${r.status} ${codes})`);

  // ---- 2. validate codes are ones the client maps ----
  r = await post("/validate", { username: "ab", password: "hunter22" }, key0);
  codes = await codesOf(r);
  check(codes.includes("INVALID_VALUE_USERNAME_SIZE") && codes.every((c: string) => VALIDATION_CODES.includes(c)), `short username -> INVALID_VALUE_USERNAME_SIZE (${codes})`);
  r = await post("/validate", { username: "GoodName1", password: "abc" }, key0);
  codes = await codesOf(r);
  check(codes.includes("INVALID_VALUE_PASSWORD_SIZE") && codes.every((c: string) => VALIDATION_CODES.includes(c)), `short password -> INVALID_VALUE_PASSWORD_SIZE (${codes})`);
  r = await post("/validate", { username: "GoodName1", password: "x".repeat(129) }, key0);
  codes = await codesOf(r);
  check(codes.includes("INVALID_VALUE_PASSWORD_SIZE"), `password over 128 -> INVALID_VALUE_PASSWORD_SIZE, as register refuses it (${codes})`);
  r = await post("/validate", { username: "PdUser1", password: "hunter22" }, key0);
  codes = await codesOf(r);
  check(codes.join() === "INUSE_VALUE", `taken username -> INUSE_VALUE (${codes})`);

  // ---- 3. display-name validate and the caller's own name ----
  // Each client gets its own key (the key is what ties validate to an account).
  const k1 = await issueApiKey(api.base), k2 = await issueApiKey(api.base);
  check(k1 !== k2 && k1.length === 120 && /^[A-Za-z0-9+/]+==$/.test(k1), `issued API keys are random, 120 base64 characters (${k1.slice(0, 8)}... vs ${k2.slice(0, 8)}...)`);
  r = await post("/validate", { displayName: "Pd Penguin" }, key0);
  check(r.status === 200 && ((await r.json()) as any).error === null, `the name just registered with this key validates for its owner (${r.status})`);
  const otherKey = await issueApiKey(api.base);
  r = await post("/validate", { displayName: "Pd Penguin" }, otherKey);
  check(r.status === 400 && (await codesOf(r)).includes("INUSE_VALUE"), `the same name from another client is taken (${r.status})`);
  r = await post("/validate", { displayName: "PdUser1" }, otherKey);
  check(r.status === 400 && (await codesOf(r)).includes("INUSE_VALUE"), `someone's username is taken as a display name (${r.status})`);
  check((await register("PdUser2", "Other Pd", otherKey)).status === 200, "registered PdUser2");
  r = await post("/validate", { displayName: "Pd Penguin" }, otherKey);
  check(r.status === 400 && (await codesOf(r)).includes("INUSE_VALUE"), `PdUser2's client still can't take PdUser1's name (${r.status})`);
  const loginKey = await issueApiKey(api.base);
  check((await login("PdUser1", "hunter22", loginKey)).status === 200, "PdUser1 logs in with a new key");
  r = await post("/validate", { displayName: "pd penguin" }, loginKey);
  check(r.status === 200, `after login, the owner's own name (any case) validates (${r.status})`);

  // ---- 6. a forged quest.set pays nothing ----
  sfs = await startGameServer(api, KEY, { SFS_MAX_PACKETS_PER_SEC: "0" });
  const c = new GameClient(api, (sfs as any).port, "{PD-QUEST}", "QuestForger");
  await c.connect();
  const quest = "AAC001Q001LeakyShip";
  const auth = { Authorization: "Basic " + btoa("{PD-QUEST}:x"), "Content-Type": "application/json" };
  await fetch(`${api.base}/quest/v1/${quest}`, { method: "POST", headers: auth, body: JSON.stringify({ status: 1 }) });
  const defs = JSON.parse(await Bun.file(`${import.meta.dir}/../web-api/data/quests.json`).text());
  const allObjectives = Object.keys(defs[quest].objectives);
  const forged = { goodUntil: Date.now() + 100000, swid: "{PD-QUEST}", signature: "mock_signature", data: [{ questId: quest, status: 1, completedObjectives: allObjectives }] };
  c.ext13("quest.set", new SFSObjectWriter().putUtfString("data", JSON.stringify(forged)));
  await sleep(300);
  const coinsBefore = sql("SELECT a.coins FROM player_assets a JOIN player_identity i ON i.username = a.username WHERE i.swid = '{PD-QUEST}'")[0]?.coins;
  const done = (await (await fetch(`${api.base}/quest/v1/${quest}`, { method: "POST", headers: auth, body: JSON.stringify({ status: 3 }) })).json()) as any;
  const coinsAfter = sql("SELECT a.coins FROM player_assets a JOIN player_identity i ON i.username = a.username WHERE i.swid = '{PD-QUEST}'")[0]?.coins;
  check(!done.reward && coinsAfter === coinsBefore, `completing after a forged quest.set pays nothing (reward ${JSON.stringify(done.reward)}, coins ${coinsBefore} -> ${coinsAfter})`);
  // Control: the same quest with its objectives recorded by the web API pays.
  await createPlayer(api.base, api.dbPath, "{PD-HONEST}", "HonestQuester");
  const auth2 = { Authorization: "Basic " + btoa("{PD-HONEST}:x"), "Content-Type": "application/json" };
  await fetch(`${api.base}/quest/v1/${quest}`, { method: "POST", headers: auth2, body: JSON.stringify({ status: 1 }) });
  await fetch(`${api.base}/quest/v1/progress`, { method: "POST", headers: auth2, body: JSON.stringify({ goodUntil: 0, swid: "", signature: "", data: allObjectives }) });
  const honest = (await (await fetch(`${api.base}/quest/v1/${quest}`, { method: "POST", headers: auth2, body: JSON.stringify({ status: 3 }) })).json()) as any;
  check(!!honest.reward, `control: with objectives recorded by the web API the same completion pays (${JSON.stringify(honest.reward)?.slice(0, 80)})`);

  // ---- 2. lockouts reach the client as a lockout ----
  await api.restart({ ...baseEnv, AUTH_ACCOUNT_FAILS_PER_15MIN: "2" });
  for (let i = 0; i < 2; i++) await login("PdUser1", "guess" + i);
  r = await login("PdUser1", "guess9");
  codes = await codesOf(r);
  check(r.status === 400 && codes.join() === "AUTHORIZATION_ACCOUNT_LOCKED_OUT", `locked account -> 400 AUTHORIZATION_ACCOUNT_LOCKED_OUT (${r.status} ${codes})`);
  await api.restart({ ...baseEnv, AUTH_LOGIN_PER_MIN: "1" });
  await login("PdUser1", "x1x1x1");
  r = await login("PdUser1", "x2x2x2");
  codes = await codesOf(r);
  check(r.status === 400 && codes.join() === "AUTHORIZATION_ACCOUNT_LOCKED_OUT", `per-address login limit -> 400 AUTHORIZATION_ACCOUNT_LOCKED_OUT, not RATE_LIMITED (the SDK swallows that one) (${r.status} ${codes})`);
} finally {
  sfs?.stop();
  await api.stop();
}
finish(api.logs());
