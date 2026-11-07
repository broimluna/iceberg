// smartfox-server input hardening (reported with WPE Pro by Shinon):
// - a packet may not claim more than MAX_MESSAGE_SIZE, and unparsed input
//   can't grow past it (the receive buffer used to grow without limit)
// - SFS login needs joinRoomData signed by the web API (it used to trust
//   the client's swid; the signature was a constant)
// - one login per connection, a per-connection packet rate limit and a
//   per-IP connection cap
// Every check sends a small, bounded number of packets.
import net from "node:net";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { createPlayer } from "./lib/mix-client.ts";
import { SFSObjectWriter, encodePacket, tryReadHeader, decodePacketBody } from "../smartfox-server/src/sfs-wire.ts";
import { getUtfString } from "../smartfox-server/src/wire-helpers.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
const PORT = 19900 + Math.floor(Math.random() * 80);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sfs = Bun.spawn(["bun", "run", "src/handshake-server.ts"], {
  cwd: `${import.meta.dir}/../smartfox-server`,
  env: {
    ...process.env, SFS_TCP_PORT: String(PORT), SFS_NOTIFY_PORT: String(PORT + 100), WEBAPI_INTERNAL_URL: "http://127.0.0.1:1",
    JOIN_SIGNING_KEY: KEY, SFS_MAX_PACKETS_PER_SEC: "50", SFS_MAX_CONNECTIONS_PER_IP: "6",
  },
  stdout: "pipe", stderr: "pipe",
});
let sfsLog = "";
(async () => { for await (const c of sfs.stdout as any) sfsLog += new TextDecoder().decode(c); })();
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });

class Conn {
  sock!: net.Socket;
  buf = Buffer.alloc(0);
  got: { c: number; a: number; p: any }[] = [];
  closed = false;
  static async open(): Promise<Conn> {
    const c = new Conn();
    await new Promise<void>((res, rej) => {
      c.sock = net.connect(PORT, "127.0.0.1", () => res());
      c.sock.on("error", (e) => (c.closed ? null : rej(e)));
    });
    c.sock.on("close", () => (c.closed = true));
    c.sock.on("data", (d) => {
      c.buf = Buffer.concat([c.buf, d]);
      for (;;) {
        const h = tryReadHeader(c.buf, "sfs2x");
        if (!h || c.buf.length < h.totalLength) break;
        const body = c.buf.subarray(h.headerLength, h.totalLength);
        c.buf = c.buf.subarray(h.totalLength);
        try { const d2 = decodePacketBody(body, "sfs2x"); c.got.push({ c: d2.controllerId!, a: d2.actionId!, p: d2.params }); } catch {}
      }
    });
    return c;
  }
  send(c: number, a: number, p: SFSObjectWriter) { this.sock.write(encodePacket(c, a, p).encode("sfs2x")); }
  handshake() { this.send(0, 0, new SFSObjectWriter().putUtfString("api", "1.7.6").putUtfString("cl", "test")); }
  login(joinRoomData: string) {
    this.send(0, 1, new SFSObjectWriter().putUtfString("zn", "ClubPenguin").putUtfString("un", "tester").putUtfString("pw", "")
      .putSFSObject("p", new SFSObjectWriter().putUtfString("joinRoomData", joinRoomData)));
  }
  logins() { return this.got.filter((g) => g.c === 0 && g.a === 1).length; }
  async until(cond: () => boolean, ms = 2000) { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(20); return cond(); }
}

try {
  // Wait for smartfox to listen.
  for (let i = 0; i < 100; i++) { try { (await Conn.open()).sock.destroy(); break; } catch { await sleep(50); } }

  // A real joinRoomData from the web API's join route.
  await createPlayer(api.base, api.dbPath, "{SFS-1}", "sally");
  const jr = await fetch(`${api.base}/game/v1/worlds/Alpine/language/en/rooms/Town/players`, {
    method: "POST", headers: { Authorization: "Basic " + btoa("{SFS-1}:x"), "Content-Type": "application/json" }, body: "{}",
  });
  const joinText = await jr.text();
  const joinObj = JSON.parse(joinText);
  check(jr.status === 200 && typeof joinObj.signature === "string" && joinObj.signature !== "server_signature" && joinObj.signature.length > 20,
    `web API signs joinRoomData (${jr.status}, signature ${String(joinObj.signature).slice(0, 12)}...)`);

  // Signed login is accepted.
  const ok = await Conn.open();
  ok.handshake(); ok.login(joinText);
  check(await ok.until(() => ok.logins() === 1), "signed login from the web API is accepted");

  // A second login on the same connection is ignored.
  ok.login(joinText);
  await sleep(300);
  check(ok.logins() === 1 && !ok.closed, `second login on one connection is ignored (${ok.logins()} login replies)`);

  // Unsigned (Shinon's capture had "signature":null) and tampered logins are refused.
  const unsigned = await Conn.open();
  unsigned.handshake(); unsigned.login(JSON.stringify({ ...joinObj, signature: null }));
  check(await unsigned.until(() => unsigned.closed) && unsigned.logins() === 0, "login with signature null is refused and closed");
  const tampered = await Conn.open();
  tampered.handshake(); tampered.login(joinText.replace("{SFS-1}", "{SFS-2}"));
  check(await tampered.until(() => tampered.closed) && tampered.logins() === 0, "login with an edited swid is refused and closed");
  const expired = await Conn.open();
  expired.handshake(); expired.login(JSON.stringify({ ...joinObj, goodUntil: Date.now() - 48 * 3_600_000 }));
  check(await expired.until(() => expired.closed) && expired.logins() === 0, "login with an edited goodUntil is refused and closed");

  // A header claiming more than MAX_MESSAGE_SIZE (10 MB) closes the connection at once.
  const big = await Conn.open();
  const hdr = Buffer.alloc(5); hdr[0] = 0x80 | 0x08; hdr.writeUInt32BE(50_000_000, 1);
  big.sock.write(hdr);
  check(await big.until(() => big.closed), "a packet header claiming 50 MB closes the connection");

  // Packet rate: 50/s allowed here; 120 pings at once trips it.
  const fast = await Conn.open();
  fast.handshake();
  for (let i = 0; i < 120; i++) fast.send(0, 29, new SFSObjectWriter());
  check(await fast.until(() => fast.closed), "120 packets in one burst trips the 50/s limit");
  const steady = await Conn.open();
  steady.handshake();
  for (let i = 0; i < 20; i++) { steady.send(0, 29, new SFSObjectWriter()); await sleep(25); }
  check(!steady.closed, "a normal 40/s pace stays connected");
  steady.sock.destroy();

  // Per-IP connection cap: 6 here, and ok is still open, so 5 more fit.
  await sleep(200);
  const extra: Conn[] = [];
  for (let i = 0; i < 6; i++) extra.push(await Conn.open());
  check(await extra[5]!.until(() => extra[5]!.closed) && extra.slice(0, 5).every((c) => !c.closed), "the 7th connection from one IP is closed, the first 6 stay");
  extra.forEach((c) => c.sock.destroy()); ok.sock.destroy();

  check(sfs.exitCode === null, "smartfox is still running");
} finally {
  sfs.kill();
  api.stop();
}
finish(sfsLog);
