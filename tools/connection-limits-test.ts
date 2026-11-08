// Game server connection limits: connections that never log in, logged-in
// connections that go silent, a cap on all connections and on how fast
// one address may open them. Timeouts are shortened for the test.
import net from "node:net";
import { makeChecker } from "./lib/harness.ts";
import { SFSObjectWriter, encodePacket } from "../smartfox-server/src/sfs-wire.ts";
import { addressKey } from "../smartfox-server/src/net-address.ts";
import { PendingPool } from "../smartfox-server/src/pending-pool.ts";

const { check, finish } = makeChecker();
let lastLog = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startSfs(env: Record<string, string>) {
  const port = 20100 + Math.floor(Math.random() * 300);
  let log = "";
  const proc = Bun.spawn(["bun", "run", "src/handshake-server.ts"], {
    cwd: `${import.meta.dir}/../smartfox-server`,
    env: { ...process.env, SFS_TCP_PORT: String(port), SFS_NOTIFY_PORT: String(port + 400), WEBAPI_INTERNAL_URL: "http://127.0.0.1:1", SFS_ALLOW_UNSIGNED_LOGIN: "1", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  (async () => { for await (const c of proc.stdout as any) log += new TextDecoder().decode(c); })();
  for (let i = 0; i < 100; i++) {
    if (await new Promise<boolean>((r) => { const s = net.connect(port, "127.0.0.1"); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); })) break;
    await sleep(100);
  }
  await sleep(200);
  return { port, log: () => log, stop: async () => { lastLog += log; proc.kill(); await proc.exited; } };
}

class Conn {
  sock: net.Socket;
  closed = false;
  constructor(port: number) {
    this.sock = net.connect(port, "127.0.0.1");
    this.sock.on("close", () => (this.closed = true));
    this.sock.on("error", () => {});
    this.sock.on("data", () => {});
  }
  ready() { return new Promise<void>((r) => this.sock.once("connect", () => r())); }
  send(c: number, a: number, p: SFSObjectWriter) { this.sock.write(encodePacket(c, a, p).encode("sfs2x")); }
  handshake() { this.send(0, 0, new SFSObjectWriter().putUtfString("api", "1.7.6").putUtfString("cl", "test")); }
  login(n: number) {
    const jrd = `{"swid":"{conn-${n}}","data":{"room":"Town","sessionId":${1000 + n},"playerRoomData":{"profile":{"colour":3},"outfit":{"parts":[]}}}}`;
    this.send(0, 1, new SFSObjectWriter().putUtfString("zn", "ClubPenguin").putUtfString("un", `conn${n}`).putUtfString("pw", "")
      .putSFSObject("p", new SFSObjectWriter().putUtfString("joinRoomData", jrd)));
  }
  ping() { this.send(0, 29, new SFSObjectWriter()); }
  close() { this.sock.destroy(); }
}

{
  const sfs = await startSfs({ SFS_LOGIN_TIMEOUT_MS: "600", SFS_IDLE_TIMEOUT_MS: "800", SFS_MAX_CONNECTS_PER_IP_PER_MIN: "0" });
  try {
    const silent = new Conn(sfs.port); await silent.ready();
    const handshakeOnly = new Conn(sfs.port); await handshakeOnly.ready(); handshakeOnly.handshake();
    const player = new Conn(sfs.port); await player.ready(); player.handshake(); await sleep(50); player.login(1);
    for (let i = 0; i < 5; i++) { await sleep(200); player.ping(); }
    check(silent.closed, "a connection that sends nothing is closed after the login timeout");
    check(handshakeOnly.closed, "a connection that only handshakes is closed after the login timeout");
    check(!player.closed, "a logged-in connection isn't");
    // Pings (the client's lag monitor sends one every 4 seconds) keep a
    // logged-in connection alive however idle the player is.
    for (let i = 0; i < 8; i++) { player.ping(); await sleep(250); }
    check(!player.closed, "a pinging connection stays open past the idle timeout");
    await sleep(1200);
    check(player.closed, "a logged-in connection that goes silent is closed after the idle timeout");
  } finally {
    await sfs.stop();
  }
}

{
  // The overall cap counts players who logged in; connections still logging
  // in have a pool of their own, where the oldest gives way to new ones.
  const sfs = await startSfs({ SFS_MAX_CONNECTIONS: "2", SFS_MAX_PENDING_LOGINS: "3", SFS_MAX_CONNECTIONS_PER_IP: "0", SFS_MAX_CONNECTS_PER_IP_PER_MIN: "0" });
  try {
    const p1 = new Conn(sfs.port); await p1.ready(); p1.handshake(); await sleep(30); p1.login(11);
    const p2 = new Conn(sfs.port); await p2.ready(); p2.handshake(); await sleep(30); p2.login(12);
    await sleep(200);
    const pending = [];
    for (let i = 0; i < 4; i++) { const c = new Conn(sfs.port); await c.ready(); pending.push(c); await sleep(30); }
    await sleep(200);
    check(!p1.closed && !p2.closed, "logged-in players aren't affected by connections still logging in");
    check(pending[0]!.closed && !pending[1]!.closed && !pending[3]!.closed, `the oldest pending connection gives way when the pool is full (${pending.map((c) => c.closed)})`);
    const p3 = new Conn(sfs.port); await p3.ready(); p3.handshake(); await sleep(30); p3.login(13);
    await sleep(300);
    check(p3.closed, "a login over SFS_MAX_CONNECTIONS players is refused");
    p1.close(); await sleep(200);
    const p4 = new Conn(sfs.port); await p4.ready(); p4.handshake(); await sleep(30); p4.login(14);
    await sleep(300);
    check(!p4.closed, "a slot frees up when a player leaves");
    for (const c of [p2, p4, ...pending]) c.close();
  } finally {
    await sfs.stop();
  }
}

{
  const sfs = await startSfs({ SFS_MAX_CONNECTS_PER_IP_PER_MIN: "5" });
  try {
    const conns = [];
    for (let i = 0; i < 6; i++) { const c = new Conn(sfs.port); await c.ready(); conns.push(c); c.close(); await sleep(30); }
    const sixth = new Conn(sfs.port); await sixth.ready(); await sleep(200);
    check(sixth.closed, "opening connections faster than SFS_MAX_CONNECTS_PER_IP_PER_MIN is refused");
  } finally {
    await sfs.stop();
  }
}
// Behind a reverse proxy on this machine (SFS_TRUST_PROXY=1), WebSocket
// clients count against the address the proxy puts in X-Forwarded-For,
// the last entry (anything further left was written by the client).
{
  const sfs = await startSfs({ SFS_TRUST_PROXY: "1", SFS_MAX_CONNECTIONS_PER_IP: "2", SFS_MAX_CONNECTS_PER_IP_PER_MIN: "0" });
  const wsVia = async (xff: string | null) => {
    const c = new Conn(sfs.port); await c.ready();
    c.sock.write(`GET /websocket HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${xff === null ? "" : `X-Forwarded-For: ${xff}\r\n`}\r\n`);
    await sleep(80);
    return c;
  };
  try {
    const a = [await wsVia("198.51.100.1"), await wsVia("198.51.100.1"), await wsVia("198.51.100.1")];
    await sleep(150);
    check(!a[0]!.closed && !a[1]!.closed && a[2]!.closed, `a 3rd connection from one forwarded address is refused (${a.map((c) => c.closed)})`);
    const b = [await wsVia("198.51.100.2"), await wsVia("198.51.100.3")];
    await sleep(150);
    check(b.every((c) => !c.closed), "other forwarded addresses are counted on their own, though all arrive from 127.0.0.1");
    const spoof = await wsVia("203.0.113.50, 198.51.100.1");
    await sleep(150);
    check(spoof.closed, "a client-written entry left of the proxy's doesn't dodge the limit");
    for (const c of [...a, ...b, spoof]) c.close();
  } finally {
    await sfs.stop();
  }
}
// Per-address limits: IPv4-mapped IPv6 is the IPv4 address, IPv6 counts per /64.
check(addressKey("::ffff:192.0.2.7") === "192.0.2.7", "IPv4-mapped IPv6 is keyed as IPv4");
check(addressKey("2001:db8:1:2::1") === addressKey("2001:db8:1:2:ffff::9"), "one IPv6 /64 is one key");
check(addressKey("2001:db8:1:2::1") !== addressKey("2001:db8:1:3::1"), "another /64 is another key");
check(addressKey("10.0.0.1") === "10.0.0.1", "IPv4 unchanged");
// A full pending pool evicts from the address holding the most pending
// connections, so a flood from a few addresses can't push out a real
// player who is partway through logging in.
{
  const pool = new PendingPool<string>(4);
  const evicted: string[] = [];
  const add = (id: string, ip: string) => { const out = pool.add(id, ip); if (out) evicted.push(out); };
  add("player", "198.51.100.5");
  for (let i = 0; i < 6; i++) add(`flood${i}`, "203.0.113.9");
  check(!evicted.includes("player") && evicted.length === 3, `the flooding address gives way, not the player (${evicted})`);
  check(evicted[0] === "flood0", "oldest from that address first");
  pool.remove("player");
  check(pool.size === 3, `remove() frees a slot (${pool.size})`);
}
if (process.env.DEBUG_LOGS) console.log(lastLog);
finish();
