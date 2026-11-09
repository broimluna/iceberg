// Rooms are split by client version: the web API puts the caller's
// X-CP-Client-Version into the content identifier of the signed room name,
// and the game server keys rooms by that full name, so clients of different
// versions never share a room. A missing or malformed version falls back to
// the configured default.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";
import { createPlayer } from "./lib/mix-client.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
process.env.JOIN_SIGNING_KEY = KEY;
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const sfs = await startGameServer(api, KEY);
const BASE = api.base;
const DEFAULT = "1.13.0";

const headers = (swid: string, version?: string): Record<string, string> => ({
  Authorization: "Basic " + btoa(`${swid}:x`), "Content-Type": "application/json",
  ...(version !== undefined ? { "X-CP-Client-Version": version } : {}),
});
const versionOf = (contentIdentifier: string | undefined) => contentIdentifier?.split(";")[0];
const roomVersion = (room: string | undefined) => versionOf(room?.split(":")[4]);
const joinRoom = async (swid: string, version?: string, room = "Town") => {
  const r = await fetch(`${BASE}/game/v1/worlds/Alpine/language/en/rooms/${room}/players`, { method: "POST", headers: headers(swid, version), body: "{}" });
  return ((await r.json()) as any).data;
};

try {
  const A = "{A1A1A1A1-0000-0000-0000-000000000001}";
  const B = "{B2B2B2B2-0000-0000-0000-000000000002}";
  const C = "{C3C3C3C3-0000-0000-0000-000000000003}";
  await createPlayer(BASE, api.dbPath, A, "VerA");
  await createPlayer(BASE, api.dbPath, B, "VerB");
  await createPlayer(BASE, api.dbPath, C, "VerC");

  // ---- signed room name ----
  check(roomVersion((await joinRoom(A, "1.16.1.1"))?.room) === "1.16.1.1", "join with 1.16.1.1 -> room carries 1.16.1.1");
  check(roomVersion((await joinRoom(A))?.room) === DEFAULT, `join without a version -> ${DEFAULT}`);
  for (const bad of ["1.16;evil", "1.16:x", "abc", "1.2.3.4.5", "1".repeat(40), ""]) {
    check(roomVersion((await joinRoom(A, bad))?.room) === DEFAULT, `malformed version ${JSON.stringify(bad.slice(0, 12))} -> default`);
  }
  const fullRoom = (await joinRoom(A, "1.16.1.1"))?.room as string;
  check(fullRoom.split(":").length === 5 && fullRoom.startsWith("Alpine:en:Town::"), `room name keeps its shape (${fullRoom})`);

  // Igloos too.
  const igloo = await fetch(`${BASE}/game/v1/igloos/language/en/players`, {
    method: "POST", headers: headers(A, "1.16.1.1"), body: JSON.stringify({ name: Object.keys(await import("../web-api/data/lots.json")).find((k) => k !== "default")!, instanceId: A }),
  });
  const iglooRoom = ((await igloo.json()) as any)?.data?.room as string | undefined;
  check(igloo.ok && roomVersion(iglooRoom) === "1.16.1.1", `igloo join carries the version (${igloo.status} ${iglooRoom})`);

  // ---- room list ----
  const list = async (version?: string) => (await (await fetch(`${BASE}/game/v1/rooms?language=en&rooms=Town&limit=1`, { headers: headers(A, version) })).json()) as any[];
  check(versionOf((await list("1.16.1.1"))[0]?.contentIdentifier) === "1.16.1.1", "room list uses the caller's version");
  check(versionOf((await list())[0]?.contentIdentifier) === DEFAULT, "room list without a version uses the default");

  // ---- populations per version ----
  // Fresh sessions: B (default version) alone in Beach.
  const db = new Database(api.dbPath);
  db.run("DELETE FROM player_sessions");
  db.close();
  await joinRoom(B, undefined, "Beach");
  const population = async (version?: string) => {
    const r = (await (await fetch(`${BASE}/game/v1/roomPopulation/Alpine?language=en`, { headers: headers(C, version) })).json()) as any;
    return r.roomPopulations.find((p: any) => p.identifier.zoneId.name === "Beach");
  };
  const same = await population();
  const other = await population("1.16.1.1");
  check(same?.populationScaled !== undefined && same.populationScaled !== "ZERO", `same-version viewer sees Beach occupied (${same?.populationScaled})`);
  check(other?.populationScaled === "ZERO", `other-version viewer sees Beach empty (${other?.populationScaled})`);
  check(versionOf(other?.identifier?.contentIdentifier) === "1.16.1.1", "population identifiers use the caller's version");

  // ---- player card shows the player's own version ----
  const card = (await (await fetch(`${BASE}/player/v1/id/${encodeURIComponent(B)}`, { headers: headers(C, "1.16.1.1") })).json()) as any;
  const loc = card.onlineLocation ?? card.data?.onlineLocation;
  check(versionOf(loc?.contentIdentifier) === DEFAULT, `card of a ${DEFAULT} player viewed by 1.16 says ${DEFAULT} (${loc?.contentIdentifier})`);

  // ---- game server: different versions never share a room ----
  const a = new GameClient(api, sfs.port, A, "VerA"); a.clientVersion = "1.16.1.1";
  const b = new GameClient(api, sfs.port, B, "VerB");
  const c = new GameClient(api, sfs.port, C, "VerC"); c.clientVersion = "1.16.1.1";
  await a.connect(); await sleep(150);
  await b.connect(); await sleep(150);
  await c.connect(); await sleep(300);
  const pushes = sfs.logs().split("\n").filter((l) => l.includes("join room push"));
  const pushFor = (v: string) => pushes.filter((l) => l.includes(`;`) && l.includes(`Town::${v};`));
  check(pushFor("1.16.1.1").length === 2 && pushFor(DEFAULT).length === 1, `two 1.16 joins and one ${DEFAULT} join (${pushes.length} pushes)`);
  check(/ul=0\)/.test(pushFor(DEFAULT)[0] ?? ""), `the ${DEFAULT} player joins an empty Town (${pushFor(DEFAULT)[0]?.slice(-60)})`);
  check(/ul=1\)/.test(pushFor("1.16.1.1")[1] ?? ""), `the second 1.16 player finds only the first (${pushFor("1.16.1.1")[1]?.slice(-60)})`);
  const cardA = (await (await fetch(`${BASE}/player/v1/id/${encodeURIComponent(A)}`, { headers: headers(B) })).json()) as any;
  const locA = cardA.onlineLocation ?? cardA.data?.onlineLocation;
  check(versionOf(locA?.contentIdentifier) === "1.16.1.1", `card of a 1.16 player says 1.16.1.1 (${locA?.contentIdentifier})`);
  a.sock.destroy(); b.sock.destroy(); c.sock.destroy();
} finally {
  sfs.stop();
  api.stop();
}
finish();
