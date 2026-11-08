// Game server connection limits: connections that never log in, logged-in
// connections that go silent, a cap on all connections and on how fast
// one address may open them. Timeouts are shortened for the test.
import net from "node:net";
import { makeChecker } from "./lib/harness.ts";
import { SFSObjectWriter, encodePacket } from "../smartfox-server/src/sfs-wire.ts";

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
  const sfs = await startSfs({ SFS_MAX_CONNECTIONS: "3", SFS_MAX_CONNECTIONS_PER_IP: "0", SFS_MAX_CONNECTS_PER_IP_PER_MIN: "0" });
  try {
    const conns = [];
    for (let i = 0; i < 4; i++) { const c = new Conn(sfs.port); await c.ready(); conns.push(c); await sleep(50); }
    await sleep(200);
    check(!conns[0]!.closed && !conns[2]!.closed && conns[3]!.closed, `over SFS_MAX_CONNECTIONS is refused (${conns.map((c) => c.closed)})`);
    conns[0]!.close(); await sleep(200);
    const again = new Conn(sfs.port); await again.ready(); await sleep(200);
    check(!again.closed, "a slot frees up when a connection closes");
    for (const c of [...conns, again]) c.close();
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
if (process.env.DEBUG_LOGS) console.log(lastLog);
finish();
