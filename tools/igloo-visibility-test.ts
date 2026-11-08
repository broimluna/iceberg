// Igloo visibility is enforced on join: a private igloo admits only its
// owner, a friends-only one also the owner's friends. Refusals carry
// ErrorResponse code 1010 (CP_IGLOO_UNAVAILABLE), which the client shows
// as a private igloo and goes back to the previous room.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { createPlayer } from "./lib/mix-client.ts";

const { check, finish } = makeChecker();
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1" } });
const sql = (q: string, ...p: any[]) => { const d = new Database(api.dbPath); try { return d.query(q).all(...p) as any[]; } finally { d.close(); } };

let n = 0;
async function player() {
  const swid = `{igv-${n++}}`;
  await createPlayer(api.base, api.dbPath, swid, `Igloo${n}vis`);
  const username = sql("SELECT username FROM player_identity WHERE swid = ?", swid)[0].username as string;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${api.base}${path}`, {
      method, headers: { Authorization: "Basic " + btoa(`${swid}:x`), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, json };
  };
  await call("GET", "/player/v1/");
  return { swid, username, call };
}
const join = (visitor: Awaited<ReturnType<typeof player>>, owner: { swid: string }, name = "DefaultIgloo") =>
  visitor.call("POST", "/game/v1/igloos/language/en/players", { name, instanceId: owner.swid });
const refused = (r: { status: number; json: any }) => r.status !== 200 && r.json?.code === 1010;

try {
  const owner = await player(), friend = await player(), stranger = await player();
  sql("INSERT INTO mix_friendships (swid, friend_user_id, is_trusted) VALUES (?, ?, 0), (?, ?, 0)", owner.swid, friend.swid, friend.swid, owner.swid);
  const setVisibility = (v: number) => owner.call("PUT", "/igloo/v1", { visibility: v });

  await setVisibility(2);
  check((await join(stranger, owner)).status === 200, "anyone can visit a public igloo");

  await setVisibility(1);
  check((await join(friend, owner)).status === 200, "a friend can visit a friends-only igloo");
  const r1 = await join(stranger, owner);
  check(refused(r1), `a stranger can't (${r1.status}, ${JSON.stringify(r1.json)})`);

  await setVisibility(0);
  check(refused(await join(friend, owner)), "nobody else can visit a private igloo");
  check((await join(owner, owner)).status === 200, "the owner always can");

  check((await setVisibility(7)).status === 400, "an unknown visibility is refused");
  await setVisibility(2);
  check(refused(await join(stranger, owner, "../../NotALot")), "an igloo zone that isn't a lot is refused");

  const r2 = await owner.call("PUT", "/igloo/v1", { activeLayoutId: 424242 });
  check(r2.status === 404, `the active layout must be one of your own (${r2.status})`);
} finally {
  await api.stop();
}
finish(api.logs());
