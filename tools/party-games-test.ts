// Find Four end to end: a real web API and game server, three fake clients
// (owner, guest, spectator) in Town. The owner holds out the FindFourGroup
// invitation, the guest accepts by interacting with them, they play, and
// the web API's coins change by the placement rewards.
import net from "node:net";
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { createPlayer } from "./lib/mix-client.ts";
import { decodeVars } from "./lib/party-fakes.ts";
import {
  SFSObjectWriter, SFSArrayWriter, encodePacket, tryReadHeader, decodeSFSObject, SFSDataType,
  type SFSObjectData, type SFSValue,
} from "../smartfox-server/src/sfs-wire.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
const PORT = 19700 + Math.floor(Math.random() * 80);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const sfs = Bun.spawn(["bun", "run", "src/handshake-server.ts"], {
  cwd: `${import.meta.dir}/../smartfox-server`,
  env: {
    ...process.env, SFS_TCP_PORT: String(PORT), SFS_NOTIFY_PORT: String(PORT + 100), WEBAPI_INTERNAL_URL: api.base,
    JOIN_SIGNING_KEY: KEY, PARTY_GAME_TIME_SCALE: "0.01",
  },
  stdout: "pipe", stderr: "pipe",
});
let sfsLog = "";
(async () => { for await (const c of sfs.stdout as any) sfsLog += new TextDecoder().decode(c); })();

class Client {
  sock!: net.Socket;
  buf = Buffer.alloc(0);
  myId = -1;
  sid = "";
  username = "";
  closed = false;
  ext: { cmd: string; p: SFSObjectData }[] = [];
  updates: { u: number; vars: Record<string, unknown> }[] = [];
  constructor(public swid: string, public name: string) {}

  async connect() {
    await createPlayer(api.base, api.dbPath, this.swid, this.name);
    const db = new Database(api.dbPath);
    this.username = (db.query("SELECT username FROM player_identity WHERE swid = ?").get(this.swid) as any).username;
    db.close();
    const jr = await fetch(`${api.base}/game/v1/worlds/Alpine/language/en/rooms/Town/players`, {
      method: "POST", headers: { Authorization: "Basic " + btoa(`${this.swid}:x`), "Content-Type": "application/json" }, body: "{}",
    });
    const joinText = await jr.text();
    this.sid = joinText.match(/"sessionId"\s*:\s*(\d+)/)![1]!;
    this.sock = net.connect(PORT, "127.0.0.1");
    await new Promise<void>((r) => this.sock.once("connect", () => r()));
    this.sock.on("close", () => (this.closed = true));
    this.sock.on("data", (d) => this.onData(d));
    this.send(0, 0, new SFSObjectWriter().putUtfString("api", "1.7.6").putUtfString("cl", "test"));
    await sleep(50);
    this.send(0, 1, new SFSObjectWriter().putUtfString("zn", "ClubPenguin").putUtfString("un", this.username).putUtfString("pw", "")
      .putSFSObject("p", new SFSObjectWriter().putUtfString("joinRoomData", joinText)));
    for (let i = 0; i < 100 && this.myId < 0; i++) await sleep(20);
  }
  send(c: number, a: number, p: SFSObjectWriter) { this.sock.write(encodePacket(c, a, p).encode("sfs2x")); }
  ext13(cmd: string, p: SFSObjectWriter) { this.send(1, 13, new SFSObjectWriter().putUtfString("c", cmd).putSFSObject("p", p)); }
  setCon(name: string | null) {
    const entry = new SFSArrayWriter().putUtfString("con");
    if (name) entry.putVariableType("object").putSFSObject(new SFSObjectWriter().putUtfString("type", "consum").putUtfString("name", name)).putBool(false);
    else entry.putVariableType("null").putNull().putBool(false);
    this.send(0, 12, new SFSObjectWriter().putSFSArray("vl", new SFSArrayWriter().putSFSArray(entry)));
  }
  use(type: string) {
    this.ext13("con.use", new SFSObjectWriter()
      .putUtfString("type", JSON.stringify({ goodUntil: 0, signature: "", swid: "", data: { type, partialCount: 0 } }))
      .putUtfString("prop", "{}"));
  }
  interactWith(sid: string) {
    this.ext13("l.a", new SFSObjectWriter().putFloatArray("p", [0, 0, 0]).putByte("a", 2)
      .putUtfString("o", `{"type":2,"id":"${sid}","tag":"Player"}`));
  }
  move(id: number, column: number) {
    this.ext13("pgame.message", new SFSObjectWriter().putInt("id", id).putInt("type", 5)
      .putUtfString("message", `{"PlayerId":${this.sid},"ScoreDelta":${column}}`));
  }
  clear() { this.ext = []; this.updates = []; }
  extOf(cmd: string) { return this.ext.filter((e) => e.cmd === cmd).map((e) => e.p); }
  varsOf(u: number) { return this.updates.filter((x) => x.u === u).map((x) => x.vars); }
  onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const h = tryReadHeader(this.buf, "sfs2x");
      if (!h || this.buf.length < h.totalLength) return;
      const env = decodeSFSObject(this.buf.subarray(h.headerLength, h.totalLength), 0, "sfs2x").value;
      this.buf = this.buf.subarray(h.totalLength);
      const c = env.c?.value as number, a = env.a?.value as number;
      const p = (env.p?.type === SFSDataType.SFS_OBJECT ? env.p.value : {}) as SFSObjectData;
      if (c === 0 && a === 1 && p.id) this.myId = p.id.value as number;
      if (c === 1 && a === 13) this.ext.push({ cmd: p.c?.value as string, p: (p.p?.value ?? {}) as SFSObjectData });
      if (c === 0 && a === 12) this.updates.push({ u: p.u!.value as number, vars: decodeVars(p.vl!.value as SFSValue[]) });
    }
  }
}

function coins(username: string): number {
  const db = new Database(api.dbPath);
  const row = db.query("SELECT coins FROM player_assets WHERE username = ?").get(username) as any;
  db.close();
  return row?.coins ?? -1;
}
const until = async (cond: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(20); return cond(); };

try {
  for (let i = 0; i < 100; i++) { try { await new Promise<void>((res, rej) => { const s = net.connect(PORT, "127.0.0.1", () => { s.destroy(); res(); }); s.on("error", rej); }); break; } catch { await sleep(50); } }
  const O = new Client("{PG-OWNER}", "owner"), G = new Client("{PG-GUEST}", "guest"), S = new Client("{PG-SPEC}", "spectator");
  const all = [O, G, S];
  for (const c of all) await c.connect();
  check(all.every((c) => c.myId > 0), `all three logged in (${all.map((c) => c.myId)})`);
  await sleep(150);

  // ---- invitation held ----
  O.setCon("FindFourGroup");
  await sleep(100);
  for (const c of all) c.clear();
  O.use("FindFourGroup");
  await sleep(200);
  for (const c of all) {
    const up = c.varsOf(O.myId);
    check(up.length === 1 && up[0]!.con === "consum:FindFourGroup" && up[0]!.con_prop === '{"actionCount":1}',
      `${c.name} sees the held invitation ${JSON.stringify(up)}`);
  }

  // ---- self-interact does nothing ----
  for (const c of all) c.clear();
  O.interactWith(O.sid);
  await sleep(200);
  // l.a itself is relayed to the room as usual.
  check(all.every((c) => c.updates.length === 0 && c.ext.every((e) => e.cmd === "l.a")), "owner interacting with themselves changes nothing");

  // ---- busy guest refused ----
  G.setCon("PizzaGroup");
  await sleep(100);
  G.use("PizzaGroup");
  await sleep(150);
  for (const c of all) c.clear();
  G.interactWith(O.sid);
  await sleep(200);
  check(all.every((c) => c.extOf("pgame.start.v2").length === 0) && O.varsOf(O.myId).length === 0, "a guest with full hands can't join");
  G.setCon(null);
  await sleep(200);

  // ---- join starts the match ----
  for (const c of all) c.clear();
  G.interactWith(O.sid);
  await until(() => O.extOf("pgame.start.v2").length > 0);
  await sleep(100);
  const start = O.extOf("pgame.start.v2")[0];
  const id = start?.id?.value as number;
  check(!!start && G.extOf("pgame.start.v2").length === 1 && S.extOf("pgame.start.v2").length === 0, "both players get pgame.start.v2, spectator none");
  check(start?.players?.value === `{"Players":[{"TeamId":0,"UserSessionId":${O.sid},"RoleId":0},{"TeamId":0,"UserSessionId":${G.sid},"RoleId":0}]}`,
    `owner listed first: ${start?.players?.value}`);
  for (const c of all) {
    const ov = c.varsOf(O.myId);
    const cleared = ov.findIndex((v) => v.con === null && v.con_prop === null);
    const equipped = ov.findIndex((v) => v.con === "pgame:FindFourGameServerAdded");
    check(cleared >= 0 && equipped > cleared, `${c.name}: owner's invitation removed, then game prop (${JSON.stringify(ov)})`);
    check(c.varsOf(G.myId).some((v) => v.con === "pgame:FindFourGameServerAdded"), `${c.name}: guest holds the game prop`);
  }

  // ---- full match ----
  const oBefore = coins(O.username), gBefore = coins(G.username);
  await sleep(100); // intro
  for (const [i, col] of [0, 6, 1, 6, 2, 6, 3].entries()) {
    (i % 2 === 0 ? O : G).move(id, col);
    await sleep(60);
  }
  check(await until(() => O.extOf("pgame.end").length === 1 && G.extOf("pgame.end").length === 1), "both players get pgame.end");
  check(O.extOf("pgame.end")[0]?.results?.value === `[{"PlayerSessionId":${O.sid},"Placement":0},{"PlayerSessionId":${G.sid},"Placement":1}]`,
    `owner won: ${O.extOf("pgame.end")[0]?.results?.value}`);
  check(O.extOf("reward.add_delayed").length === 1 && G.extOf("reward.add_delayed").length === 1 && S.ext.every((e) => !e.cmd.startsWith("pgame.") && e.cmd !== "reward.add_delayed"),
    "each player gets reward.add_delayed; spectator nothing");
  await until(() => coins(O.username) === oBefore + 20, 2000);
  check(coins(O.username) === oBefore + 20 && coins(G.username) === gBefore + 10, `coins +20 / +10 (${oBefore}->${coins(O.username)}, ${gBefore}->${coins(G.username)})`);
  check(all.every((c) => c.varsOf(O.myId).at(-1)?.con === null && c.varsOf(G.myId).at(-1)?.con === null), "game props cleared for the room");

  // ---- forfeit by disconnect ----
  O.setCon("FindFourGroup"); await sleep(100); O.use("FindFourGroup"); await sleep(150);
  for (const c of all) c.clear();
  G.interactWith(O.sid);
  await until(() => O.extOf("pgame.start.v2").length > 0);
  const id2 = O.extOf("pgame.start.v2")[0]?.id?.value as number;
  check(id2 === id + 1, `second match started (${id2})`);
  const before2 = coins(O.username);
  G.sock.destroy();
  check(await until(() => O.extOf("pgame.end").length === 1), "owner's match ends when the guest disconnects");
  check(O.extOf("pgame.end")[0]?.results?.value === `[{"PlayerSessionId":${O.sid},"Placement":0}]`, `forfeit results: ${O.extOf("pgame.end")[0]?.results?.value}`);
  await until(() => coins(O.username) === before2 + 20, 2000);
  check(coins(O.username) === before2 + 20, `forfeit winner paid (${before2}->${coins(O.username)})`);

  // ---- server alive ----
  S.clear();
  S.ext13("time.get", new SFSObjectWriter());
  check(await until(() => S.ext.length > 0), "server still answers");
} catch (err) {
  check(false, `threw: ${(err as Error).stack}`);
} finally {
  sfs.kill();
  await api.stop();
}
finish(sfsLog + api.logs());
