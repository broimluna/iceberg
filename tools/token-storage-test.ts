// Stored login tokens: the database holds a hash of each token, never the
// token, and tokens stored in plain text by an older version are hashed on
// the next start without ending the session.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker, issueApiKey, pw } from "./lib/harness.ts";

const { check, finish } = makeChecker();
const api = await startWebApi();
const gc = `${api.base}/jgc/v5/client/T`;
const rows = () => {
  const db = new Database(api.dbPath, { readonly: true });
  try { return db.query("SELECT token, token_type, swid FROM guest_controller_tokens").all() as { token: string; token_type: string; swid: string }[]; }
  finally { db.close(); }
};
const cpi = (token: string) => fetch(`${api.base}/player/v1/`, { headers: { Authorization: "Basic " + btoa(`${token}:x`) } }).then((r) => r.status);

try {
  const reg = await fetch(`${gc}/guest/register?langPref=en`, {
    method: "POST", headers: { Authorization: `APIKEY ${await issueApiKey(api.base)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ password: pw("main"), profile: { username: "StoreUser" } }),
  });
  const body: any = await reg.json();
  const swid = body.data.profile.swid as string;
  const access = body.data.token.access_token as string;
  const refresh = body.data.token.refresh_token as string;

  let r = rows();
  check(r.length === 2, `an access and a refresh token are stored (${r.length})`);
  check(r.every((x) => x.token.startsWith("sha256:") && x.token.length === 71), "both are stored as sha256 hashes");
  check(!r.some((x) => x.token.includes(access) || x.token.includes(refresh)), "neither token appears in the database");
  check(await cpi(access) === 200, "the access token still works");
  check(await cpi(refresh) === 401, "the refresh token is still not an access token");
  check(await cpi("sha256:" + "0".repeat(64)) === 401, "a stored hash is not a token");
  check(r.some((x) => x.token === r.find((y) => y.token_type === "access")!.token && x.token_type === "access"), "types are kept");

  // A refresh swaps the pair; the old refresh token stops working.
  const again: any = await fetch(`${gc}/guest/refresh-auth/${refresh}`, { method: "POST" }).then((x) => x.json());
  const access2 = again?.data?.token?.access_token as string;
  check(!!access2 && await cpi(access2) === 200, "a refreshed access token works");
  check(await cpi(access) === 401, "the old access token no longer works");
  check(rows().every((x) => x.token.startsWith("sha256:")), "refreshed tokens are stored hashed too");

  // A token written by an older version (plain text) is hashed at start-up and keeps working.
  await api.stop();
  const legacy = "legacy" + "a".repeat(58);
  { const db = new Database(api.dbPath); db.run("INSERT INTO guest_controller_tokens (token, token_type, swid, expires_at) VALUES (?, 'access', ?, ?)", [legacy, swid, new Date(Date.now() + 3_600_000).toISOString()]); db.close(); }
  await api.restart();
  r = rows();
  check(r.every((x) => x.token.startsWith("sha256:")), "after a restart no token is stored in plain text");
  check(!r.some((x) => x.token.includes(legacy)), "the old plain-text token is gone from the database");
  check(await cpi(legacy) === 200, "and its session still works");
  check(/Hashed 1 stored login tokens/.test(api.logs()), "the migration is logged without the token");
  check(!api.logs().includes(legacy), "the log doesn't contain the token");
} finally {
  await api.stop();
}
finish(api.logs());
