// Web API login/registration hardening: issued API keys only, password
// rules and hashing, no claiming password-less accounts, rate limits.
import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker, issueApiKey } from "./lib/harness.ts";
import { createPlayer } from "./lib/mix-client.ts";

const { check, finish } = makeChecker();
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", LEGACY_PASSWORD_CLAIM: "0" } });
const gc = `${api.base}/jgc/v5/client/T`;
const sql = (q: string, ...p: any[]) => { const d = new Database(api.dbPath); try { return d.query(q).all(...p) as any[]; } finally { d.close(); } };
let n = 0;
const register = async (password: string, key?: string) => fetch(`${gc}/guest/register?langPref=en`, {
  method: "POST", headers: { Authorization: `APIKEY ${key ?? (await issueApiKey(api.base))}`, "Content-Type": "application/json" },
  body: JSON.stringify({ password, profile: { username: `Hard${n++}user` } }),
});
const login = async (loginValue: string, password: string) => fetch(`${gc}/guest/login`, {
  method: "POST", headers: { Authorization: `APIKEY ${await issueApiKey(api.base)}`, "Content-Type": "application/json" },
  body: JSON.stringify({ loginValue, password }),
});

try {
  // ---- API keys ----
  let r = await register("hunter22", "made-up-key");
  check(r.status === 401, `a key the server never issued is refused (${r.status})`);
  r = await register("hunter22");
  check(r.status === 200, `an issued key works (${r.status})`);

  // ---- password rules and hashing ----
  r = await register("x");
  check(r.status === 400 && ((await r.json()) as any)?.error?.errors?.[0]?.code === "PASSWORD_TOO_SHORT", "a 1-character password is refused");
  r = await register("p".repeat(129));
  check(r.status === 400, `a 129-character password is refused (${r.status})`);
  r = await register("hunter22");
  const body: any = await r.json();
  const swid = body.data.profile.swid, username = body.data.profile.username;
  const stored = sql("SELECT password_hash FROM player_identity WHERE swid = ?", swid)[0].password_hash as string;
  check(stored.startsWith("pbkdf2-sha512$210000$"), `new passwords use 210,000 rounds (${stored.slice(0, 24)})`);
  check((await login(username, "hunter22")).status === 200, "login with the right password");
  check((await login(username, "hunter23")).status === 400, "login with the wrong password fails");

  // An old 1,000-round hash still logs in, and is upgraded on the way.
  const salt = crypto.randomBytes(16).toString("hex");
  const legacy = `${salt}:${crypto.pbkdf2Sync("oldpass1", salt, 1000, 64, "sha512").toString("hex")}`;
  sql("UPDATE player_identity SET password_hash = ? WHERE swid = ?", legacy, swid);
  check((await login(username, "wrongpass")).status === 400, "a legacy hash rejects the wrong password");
  check(sql("SELECT password_hash FROM player_identity WHERE swid = ?", swid)[0].password_hash === legacy, "and isn't upgraded by a failed login");
  check((await login(username, "oldpass1")).status === 200, "a legacy hash still logs in");
  check((sql("SELECT password_hash FROM player_identity WHERE swid = ?", swid)[0].password_hash as string).startsWith("pbkdf2-sha512$210000$"), "and is upgraded");
  check((await login(username, "oldpass1")).status === 200, "the upgraded hash logs in");

  // ---- an account with no password can't be claimed by whoever logs in first ----
  await createPlayer(api.base, api.dbPath, "{no-pass}", "NoPassword");
  check((await login("NoPassword", "mine-now")).status === 400, "a password-less account can't be claimed");
  check(!sql("SELECT password_hash FROM player_identity WHERE swid = '{no-pass}'")[0].password_hash, "and keeps no password");
  await api.restart({ ALLOW_SWID_AUTH: "1", LEGACY_PASSWORD_CLAIM: "1" });
  check((await login("NoPassword", "mine-now")).status === 200, "LEGACY_PASSWORD_CLAIM=1 allows the old claim");

  // ---- rate limits (per IP) ----
  await api.restart({ ALLOW_SWID_AUTH: "1", LEGACY_PASSWORD_CLAIM: "0", AUTH_LOGIN_PER_MIN: "5", AUTH_REGISTER_PER_HOUR: "3", AUTH_APIKEY_PER_MIN: "30" });
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await login(username, "nope")).status);
  check(statuses.slice(0, 5).every((s) => s === 400) && statuses[5] === 429, `6th login in a minute is limited (${statuses})`);
  const regs: number[] = [];
  for (let i = 0; i < 4; i++) regs.push((await register("hunter22")).status);
  check(regs.slice(0, 3).every((s) => s === 200) && regs[3] === 429, `4th registration in an hour is limited (${regs})`);
  const keys: number[] = [];
  for (let i = 0; i < 31; i++) keys.push((await fetch(`${gc}/api-key`, { method: "POST" })).status);
  check(keys.filter((s) => s === 429).length >= 1, `API-key creation is limited (${keys.filter((s) => s === 429).length} limited)`);
} finally {
  await api.stop();
}
finish(api.logs());
