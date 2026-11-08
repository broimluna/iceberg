// Web API + game server pair and a fake client for the staff command
// tests. Clients log in the way the real one does: create the account, POST
// the room join to the web API, and hand its signed joinRoomData to the
// game server.
import net from "node:net";
import { Database } from "bun:sqlite";
import { startWebApi, type WebApi } from "./harness.ts";
import { createPlayer } from "./mix-client.ts";
import {
  SFSObjectWriter, encodePacket, tryReadHeader, decodeSFSObject, SFSDataType, type SFSObjectData,
} from "../../smartfox-server/src/sfs-wire.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SYSTEM = "​", SYSTEM_ERROR = "​‌";

export interface Servers {
  api: WebApi;
  sfsPort: number;
  key: string;
  sfsLog: () => string;
  /** Restarts the web API with STAFF_ADMINS set (usernames are only known once accounts exist). */
  setStaffAdmins: (names: string[]) => Promise<void>;
  stopSfs: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function startServers(opts: { sfsEntry?: string; sfsEnv?: Record<string, string> } = {}): Promise<Servers> {
  const key = "test-join-key-" + Math.random().toString(36).slice(2);
  const apiEnv = { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: key };
  const api = await startWebApi({ env: apiEnv });
  const sfsPort = 19800 + Math.floor(Math.random() * 150);
  let log = "";
  const sfs = Bun.spawn(["bun", "run", opts.sfsEntry ?? "src/handshake-server.ts"], {
    cwd: `${import.meta.dir}/../../smartfox-server`,
    env: {
      ...process.env, SFS_TCP_PORT: String(sfsPort), SFS_NOTIFY_PORT: String(sfsPort + 200),
      WEBAPI_INTERNAL_URL: api.base, JOIN_SIGNING_KEY: key, ...opts.sfsEnv,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const pump = async (s: ReadableStream<Uint8Array>) => { for await (const c of s) log += new TextDecoder().decode(c); };
  pump(sfs.stdout as ReadableStream<Uint8Array>);
  pump(sfs.stderr as ReadableStream<Uint8Array>);
  for (let i = 0; i < 100; i++) {
    const up = await new Promise<boolean>((r) => {
      const s = net.connect(sfsPort, "127.0.0.1");
      s.once("connect", () => { s.destroy(); r(true); });
      s.once("error", () => r(false));
    });
    if (up) break;
    await sleep(100);
  }
  const stopSfs = async () => { sfs.kill(); await sfs.exited; };
  return {
    api, sfsPort, key, sfsLog: () => log,
    setStaffAdmins: (names) => api.restart({ ...apiEnv, STAFF_ADMINS: names.join(",") }),
    stopSfs,
    stop: async () => { await stopSfs(); await api.stop(); },
  };
}

export class Client {
  sock!: net.Socket;
  buf = Buffer.alloc(0);
  myId = -1;
  sid = "";
  username = "";
  closed = false;
  kickReason: number | undefined;
  /** System bubbles addressed to this client (text without the prefix). */
  bubbles: string[] = [];
  errors: string[] = [];
  /** Ordinary chat from other players, as the client would show it. */
  roomChats: string[] = [];
  ext: { cmd: string; p: SFSObjectData }[] = [];

  constructor(public servers: Servers, public swid: string, public name: string, public room = "Town") {}

  /** Creates the web API account (once) and returns its username. */
  async account(): Promise<string> {
    if (this.username) return this.username;
    await createPlayer(this.servers.api.base, this.servers.api.dbPath, this.swid, this.name);
    const db = new Database(this.servers.api.dbPath, { readonly: true });
    this.username = (db.query("SELECT username FROM player_identity WHERE swid = ?").get(this.swid) as any).username;
    db.close();
    return this.username;
  }

  /** Logs in with the web API's signed joinRoomData. `loginName` overrides "un". */
  async connect(opts: { loginName?: string; waitIdentity?: boolean; unsigned?: boolean } = {}) {
    await this.account();
    this.closed = false; this.myId = -1; this.kickReason = undefined; this.buf = Buffer.alloc(0);
    const jr = await fetch(`${this.servers.api.base}/game/v1/worlds/Alpine/language/en/rooms/${this.room}/players`, {
      method: "POST", headers: { Authorization: "Basic " + btoa(`${this.swid}:x`), "Content-Type": "application/json" }, body: "{}",
    });
    let joinText = await jr.text();
    if (opts.unsigned) joinText = joinText.replace(/"signature"\s*:\s*"[^"]*"/, '"signature":"forged"');
    this.sid = joinText.match(/"sessionId"\s*:\s*(\d+)/)![1]!;
    this.sock = net.connect(this.servers.sfsPort, "127.0.0.1");
    await new Promise<void>((r) => this.sock.once("connect", () => r()));
    this.sock.on("close", () => (this.closed = true));
    this.sock.on("error", () => {});
    this.sock.on("data", (d) => this.onData(d));
    this.send(0, 0, new SFSObjectWriter().putUtfString("api", "1.7.6").putUtfString("cl", "test"));
    await sleep(50);
    this.send(0, 1, new SFSObjectWriter().putUtfString("zn", "ClubPenguin").putUtfString("un", opts.loginName ?? this.username).putUtfString("pw", "")
      .putSFSObject("p", new SFSObjectWriter().putUtfString("joinRoomData", joinText)));
    for (let i = 0; i < 100 && this.myId < 0 && !this.closed; i++) await sleep(20);
    if (opts.waitIdentity !== false) await sleep(250);
  }

  send(c: number, a: number, p: SFSObjectWriter) { this.sock.write(encodePacket(c, a, p).encode("sfs2x")); }
  ext13(cmd: string, p: SFSObjectWriter) { this.send(1, 13, new SFSObjectWriter().putUtfString("c", cmd).putSFSObject("p", p)); }
  /** Chats the way the client does: the web API checks and signs the message, then it goes to the game server. */
  async chat(message: string) {
    const signed = await this.signChat(message);
    if (signed) this.sendChatJson(signed);
  }
  /** The web API's signed chat.msg JSON for message, or null if it refused. */
  async signChat(message: string): Promise<string | null> {
    const r = await fetch(`${this.servers.api.base}/chat/v1/message/verify`, {
      method: "POST", headers: { Authorization: "Basic " + btoa(`${this.swid}:x`), "Content-Type": "application/json" },
      body: JSON.stringify({ senderSessionId: Number(this.sid), message, emotion: 0, moderated: false, questId: "", objective: "" }),
    });
    this.lastVerify = r.status;
    return r.ok ? await r.text() : null;
  }
  lastVerify = 0;
  /** Sends a chat.msg as-is (for unsigned, altered or replayed messages). */
  sendChatJson(json: string) {
    this.ext13("chat.msg", new SFSObjectWriter().putUtfString("msg", json));
  }
  questSet() {
    this.ext13("quest.set", new SFSObjectWriter().putUtfString("data", JSON.stringify({ data: [] })));
  }

  onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const h = tryReadHeader(this.buf, "sfs2x");
      if (!h || this.buf.length < h.totalLength) return;
      const env = decodeSFSObject(this.buf.subarray(h.headerLength, h.totalLength), 0, "sfs2x").value;
      this.buf = this.buf.subarray(h.totalLength);
      const c = env.c?.value, a = env.a?.value;
      const p = (env.p?.type === SFSDataType.SFS_OBJECT ? env.p.value : {}) as SFSObjectData;
      if (c === 0 && a === 1 && typeof p.id?.value === "number") this.myId = p.id.value as number;
      if (c === 0 && a === 1005) this.kickReason = p.dr?.value as number;
      if (c !== 1 || a !== 13) continue;
      const cmd = p.c?.value as string;
      const inner = (p.p?.type === SFSDataType.SFS_OBJECT ? p.p.value : {}) as SFSObjectData;
      this.ext.push({ cmd, p: inner });
      if (cmd !== "chat.msg") continue;
      const msg = JSON.parse(inner.msg!.value as string).message as string;
      const fromSelf = inner.senderId?.value === this.myId;
      if (fromSelf && msg.startsWith(SYSTEM_ERROR)) this.errors.push(msg.slice(2));
      else if (fromSelf && msg.startsWith(SYSTEM)) this.bubbles.push(msg.slice(1));
      else if (!fromSelf) this.roomChats.push(msg);
    }
  }

  /** Clears what has been received so far. */
  reset() { this.bubbles = []; this.errors = []; this.roomChats = []; this.ext = []; }
  disconnect() { this.sock.end(); }
}

export function owns(dbPath: string, table: string, column: string, username: string, id: number): boolean {
  const db = new Database(dbPath, { readonly: true });
  const row = db.query(`SELECT 1 FROM ${table} WHERE username = ? AND ${column} = ?`).get(username, id);
  db.close();
  return !!row;
}

export function coins(dbPath: string, username: string): number | undefined {
  const db = new Database(dbPath, { readonly: true });
  const row = db.query("SELECT coins FROM player_assets WHERE username = ?").get(username) as { coins: number } | null;
  db.close();
  return row?.coins;
}
