// A game server spawned against a test web API, and fake SFS2X clients
// that log in with the web API's signed joinRoomData and spend
// consumables through it, as the real client does.
import net from "node:net";
import { Database } from "bun:sqlite";
import { createPlayer } from "./mix-client.ts";
import { decodeVars } from "./party-fakes.ts";
import type { WebApi } from "./harness.ts";
import {
  SFSObjectWriter, SFSArrayWriter, encodePacket, tryReadHeader, decodeSFSObject, SFSDataType,
  type SFSObjectData, type SFSValue,
} from "../../smartfox-server/src/sfs-wire.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface GameServer {
  port: number;
  logs: () => string;
  stop: () => void;
}

/** Spawns smartfox-server on a random port and waits until it accepts connections. */
export async function startGameServer(api: WebApi, key: string, env: Record<string, string> = {}): Promise<GameServer> {
  const port = 19700 + Math.floor(Math.random() * 80);
  const proc = Bun.spawn(["bun", "run", "src/handshake-server.ts"], {
    cwd: `${import.meta.dir}/../../smartfox-server`,
    env: {
      ...process.env, SFS_TCP_PORT: String(port), SFS_NOTIFY_PORT: String(port + 100), WEBAPI_INTERNAL_URL: api.base,
      JOIN_SIGNING_KEY: key, PARTY_GAME_SCHEDULE: "off", ...env,
    },
    stdout: "pipe", stderr: "pipe",
  });
  let out = "";
  (async () => { for await (const c of proc.stdout as any) out += new TextDecoder().decode(c); })();
  for (let i = 0; i < 100; i++) {
    try {
      await new Promise<void>((res, rej) => { const s = net.connect(port, "127.0.0.1", () => { s.destroy(); res(); }); s.on("error", rej); });
      break;
    } catch { await sleep(50); }
  }
  return { port, logs: () => out, stop: () => proc.kill() };
}

export class GameClient {
  sock!: net.Socket;
  buf = Buffer.alloc(0);
  myId = -1;
  sid = "";
  username = "";
  closed = false;
  ext: { cmd: string; p: SFSObjectData }[] = [];
  updates: { u: number; vars: Record<string, unknown>; at: number }[] = [];
  /** Sent as X-CP-Client-Version on web API calls when set, as the real client does. */
  clientVersion?: string;
  constructor(public api: WebApi, public port: number, public swid: string, public name: string, public room = "Town") {}

  auth(): Record<string, string> {
    const h: Record<string, string> = { Authorization: "Basic " + btoa(`${this.swid}:x`), "Content-Type": "application/json" };
    if (this.clientVersion) h["X-CP-Client-Version"] = this.clientVersion;
    return h;
  }

  async connect() {
    await createPlayer(this.api.base, this.api.dbPath, this.swid, this.name);
    const db = new Database(this.api.dbPath);
    this.username = (db.query("SELECT username FROM player_identity WHERE swid = ?").get(this.swid) as any).username;
    db.close();
    const jr = await fetch(`${this.api.base}/game/v1/worlds/Alpine/language/en/rooms/${this.room}/players`, {
      method: "POST", headers: this.auth(), body: "{}",
    });
    const joinText = await jr.text();
    this.sid = joinText.match(/"sessionId"\s*:\s*(\d+)/)![1]!;
    this.sock = net.connect(this.port, "127.0.0.1");
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
  /** DELETE /consumable/v1/{type}, buying one first if the player has none. Returns the response text. */
  async spend(type: string): Promise<string> {
    let r = await fetch(`${this.api.base}/consumable/v1/${type}`, { method: "DELETE", headers: this.auth() });
    if (r.status === 400) {
      await fetch(`${this.api.base}/consumable/v1/${type}/1`, { method: "PUT", headers: this.auth() });
      r = await fetch(`${this.api.base}/consumable/v1/${type}`, { method: "DELETE", headers: this.auth() });
    }
    return r.text();
  }
  /** con.use with a SignedResponse<UsedConsumable> as JSON text. */
  sendUse(signedJson: string, prop = "{}") {
    this.ext13("con.use", new SFSObjectWriter().putUtfString("type", signedJson).putUtfString("prop", prop));
  }
  /** Spends through the web API and sends con.use with its response. Returns the response text. */
  async use(type: string, prop = "{}"): Promise<string> {
    const signed = await this.spend(type);
    this.sendUse(signed, prop);
    return signed;
  }
  interactWith(sid: string) {
    this.ext13("l.a", new SFSObjectWriter().putFloatArray("p", [0, 0, 0]).putByte("a", 2)
      .putUtfString("o", `{"type":2,"id":"${sid}","tag":"Player"}`));
  }
  /** An `l.a` with a bare action byte (a button press). */
  action(byte: number) {
    this.ext13("l.a", new SFSObjectWriter().putFloatArray("p", [0, 0, 0]).putByte("a", byte));
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
      if (c === 0 && a === 12) this.updates.push({ u: p.u!.value as number, vars: decodeVars(p.vl!.value as SFSValue[]), at: Date.now() });
    }
  }
}
