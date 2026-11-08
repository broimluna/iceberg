// Staff roles in the web API: the players.role column, STAFF_ADMINS and
// the internal identity / set-role endpoints the game server uses.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { createPlayer } from "./lib/mix-client.ts";

const { check, finish } = makeChecker();
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1" } });

const usernameOf = (swid: string) => {
  const db = new Database(api.dbPath, { readonly: true });
  const row = db.query("SELECT username FROM player_identity WHERE swid = ?").get(swid) as { username: string } | null;
  db.close();
  return row!.username;
};
const post = async (path: string, body: unknown) => {
  const res = await fetch(`${api.base}/api/internal/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
};

try {
  await createPlayer(api.base, api.dbPath, "{root}", "Root");
  await createPlayer(api.base, api.dbPath, "{bob}", "Bob");
  await createPlayer(api.base, api.dbPath, "{ROOT}", "Mallory");
  const root = usernameOf("{root}"), bob = usernameOf("{bob}"), lookalike = usernameOf("{ROOT}");
  check(lookalike !== root && lookalike.toLowerCase() === root.toLowerCase(), `test setup: a second account differing only in case (${root} / ${lookalike})`);
  // STAFF_ADMINS matches exactly: usernames that differ only in case are
  // different accounts.
  await api.restart({ ALLOW_SWID_AUTH: "1", STAFF_ADMINS: ` ${root} , someone-else` });

  let r = await post("identity", { swid: "{root}" });
  check(r.status === 200 && r.json?.username === root && r.json?.role === "admin", `config admin's identity is admin (${JSON.stringify(r.json)})`);
  r = await post("identity", { swid: "{ROOT}" });
  check(r.json?.role === "player", `an account whose name differs only in case is not a config admin (${JSON.stringify(r.json)})`);
  r = await post("identity", { swid: "{bob}" });
  check(r.status === 200 && r.json?.username === bob && r.json?.role === "player", `new account is a player (${JSON.stringify(r.json)})`);
  r = await post("identity", { swid: "{nobody}" });
  check(r.status === 404, `unknown swid is 404 (${r.status})`);
  r = await post("identity", { swid: 42 });
  check(r.status === 400, `non-string swid is 400 (${r.status})`);

  r = await post("set-role", { username: bob, role: "moderator" });
  check(r.status === 200 && r.json?.role === "moderator", `set-role moderator (${r.status} ${JSON.stringify(r.json)})`);
  r = await post("identity", { swid: "{bob}" });
  check(r.json?.role === "moderator", `identity reflects the new role (${r.json?.role})`);
  r = await post("set-role", { username: bob.toUpperCase(), role: "moderator" });
  check(r.status === 200 && r.json?.username === bob, `set-role matches usernames in any case (${JSON.stringify(r.json)})`);
  r = await post("set-role", { username: bob, role: "superuser" });
  check(r.status === 400, `unknown role is 400 (${r.status})`);
  r = await post("set-role", { username: root.toLowerCase() === root ? root.toUpperCase() : root.toLowerCase(), role: "moderator" });
  check(r.status === 404, `an any-case name that matches two accounts is refused (${r.status} ${JSON.stringify(r.json)})`);
  r = await post("set-role", { username: lookalike, role: "moderator" });
  check(r.status === 200 && r.json?.username === lookalike, `the exact name picks that account (${JSON.stringify(r.json)})`);
  r = await post("set-role", { username: "ghost", role: "admin" });
  check(r.status === 404, `unknown username is 404 (${r.status})`);
  r = await post("set-role", { username: root, role: "player" });
  check(r.status === 409, `a STAFF_ADMINS account can't be changed (${r.status})`);
  r = await post("identity", { swid: "{root}" });
  check(r.json?.role === "admin", "config admin is still admin");

  // Registering with an existing username must not take that account over
  // (it used to repoint the username at the new swid, roles and all).
  for (const name of [root, root.toUpperCase(), bob]) {
    const reg = await fetch(`${api.base}/jgc/v5/client/TEST/guest/register?langPref=en`, {
      method: "POST", headers: { Authorization: "APIKEY test", "Content-Type": "application/json" },
      body: JSON.stringify({ password: "hunter22", profile: { username: name } }),
    });
    const regBody: any = await reg.json().catch(() => null);
    check(reg.status === 400 && regBody?.error?.errors?.[0]?.code === "INUSE_VALUE", `register with taken username ${name} is refused (${reg.status})`);
  }
  r = await post("identity", { swid: "{root}" });
  check(r.json?.username === root && r.json?.role === "admin", `the admin's account still belongs to them (${JSON.stringify(r.json)})`);
  r = await post("identity", { swid: "{bob}" });
  check(r.json?.username === bob, `and bob's to bob (${JSON.stringify(r.json)})`);
  // Generated names use the swid's first 8 letters and digits, so {r-o-o-t}
  // would also be Penguinroot: it gets a suffix instead of taking root's account.
  await createPlayer(api.base, api.dbPath, "{r-o-o-t}", "Collider");
  const collide = usernameOf("{r-o-o-t}");
  check(collide !== root, `a colliding generated name gets a different username (${collide})`);
  r = await post("identity", { swid: "{root}" });
  check(r.json?.username === root, `a colliding generated name doesn't replace the account (${collide}, root ${JSON.stringify(r.json)})`);

  await api.restart({ ALLOW_SWID_AUTH: "1" });
  r = await post("identity", { swid: "{bob}" });
  check(r.json?.role === "moderator", `role survives a restart (${r.json?.role})`);
  r = await post("identity", { swid: "{root}" });
  check(r.json?.role === "player", `without STAFF_ADMINS the old config admin is a player (${r.json?.role})`);
} finally {
  await api.stop();
}
finish(api.logs());
