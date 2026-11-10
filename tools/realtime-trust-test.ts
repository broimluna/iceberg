// What the game server takes on trust from a connection (security audit):
// - nothing but handshake, login and ping is handled before login
// - a deeply nested SFS packet is refused by the decoder and the
//   connection carries on (it used to end in a stack overflow outside
//   the handlers' try/catch)
// - the name other players see comes from the signed joinRoomData, not
//   from the login's unsigned "un"
// - outfit, colour and tube values a client sets are not relayed as they
//   came (the web API's saved values are; see appearance-trust-test.ts)
// - a banned account can't log in with joinRoomData issued before the
//   ban, and is disconnected if it is already online
// Every check sends a handful of small packets to a throwaway server.
import net from "node:net";
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";
import { SFSObjectWriter, SFSArrayWriter, encodePacket, tryReadHeader, decodePacketBody } from "../smartfox-server/src/sfs-wire.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const gs = await startGameServer(api, KEY, { SFS_BAN_RECHECK_MS: "300" });

class Raw {
  sock!: net.Socket;
  buf = Buffer.alloc(0);
  got: { c: number; a: number; p: any }[] = [];
  closed = false;
  static async open(): Promise<Raw> {
    const r = new Raw();
    await new Promise<void>((res, rej) => { r.sock = net.connect(gs.port, "127.0.0.1", () => res()); r.sock.on("error", (e) => (r.closed ? null : rej(e))); });
    r.sock.on("close", () => (r.closed = true));
    r.sock.on("data", (d) => {
      r.buf = Buffer.concat([r.buf, d]);
      for (;;) {
        const h = tryReadHeader(r.buf, "sfs2x");
        if (!h || r.buf.length < h.totalLength) break;
        const body = r.buf.subarray(h.headerLength, h.totalLength);
        r.buf = r.buf.subarray(h.totalLength);
        try { const d2 = decodePacketBody(body, "sfs2x"); r.got.push({ c: d2.controllerId!, a: d2.actionId!, p: d2.params }); } catch {}
      }
    });
    return r;
  }
  send(c: number, a: number, p: SFSObjectWriter) { this.sock.write(encodePacket(c, a, p).encode("sfs2x")); }
  handshake() { this.send(0, 0, new SFSObjectWriter().putUtfString("api", "1.7.6").putUtfString("cl", "test")); }
}

// A packet whose params hold `depth` SFS arrays, one inside the other.
function nested(depth: number): Buffer {
  const key = (k: string) => Buffer.from([0, k.length, ...Buffer.from(k)]);
  const arr = Buffer.alloc(depth * 3);
  for (let i = 0; i < depth; i++) { arr[i * 3] = 17; arr[i * 3 + 2] = i === depth - 1 ? 0 : 1; }
  const body = Buffer.concat([Buffer.from([18, 0, 3]), key("c"), Buffer.from([2, 0]), key("a"), Buffer.from([3, 0, 99]),
    key("p"), Buffer.from([18, 0, 1]), key("x"), arr]);
  const head = Buffer.alloc(5); head[0] = 0x88; head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

const stringVar = (name: string, value: string) => new SFSObjectWriter().putSFSArray("vl", new SFSArrayWriter().putSFSArray(
  new SFSArrayWriter().putUtfString(name).putVariableType("string").putUtfString(value).putBool(false)));

// --- 1. Before login ---
{
  const r = await Raw.open();
  r.handshake();
  await sleep(100);
  const afterHandshake = r.got.length;
  check(afterHandshake === 1, `handshake answered before login (${afterHandshake} packet)`);
  for (const cmd of ["quest.set", "time.get", "encryption.get", "validate.state", "zone.logout"])
    r.send(1, 13, new SFSObjectWriter().putUtfString("c", cmd).putSFSObject("p", new SFSObjectWriter()));
  r.send(0, 12, stringVar("outfit", "{}"));
  await sleep(300);
  check(r.got.length === afterHandshake, `extension commands and SetUserVariables before login get no answer (${r.got.length - afterHandshake} packets)`);
  check(/before login/.test(gs.logs()), "the server logs that it ignored them");
  check(!/extension ack \(c=quest\.set\)/.test(gs.logs()), "quest.set wasn't handled");
  r.sock.destroy();
}

// --- 2. Deep nesting ---
for (const depth of [40, 5_000, 30_000, 100_000, 300_000]) {
  const r = await Raw.open();
  const before = gs.logs().length;
  r.sock.write(nested(depth));
  await sleep(250);
  r.handshake();
  await sleep(250);
  const log = gs.logs().slice(before);
  check(!r.closed && r.got.some((g) => g.c === 0 && g.a === 0), `depth ${depth}: the connection still answers a handshake afterwards`);
  check(/failed to decode packet: .*nested/.test(log), `depth ${depth}: refused by the decoder`);
  check(!/socket error/.test(log), `depth ${depth}: no error escaped the packet loop`);
  r.sock.destroy();
}
{
  // The deepest packet the real client sends is far below the limit.
  const r = await Raw.open();
  const before = gs.logs().length;
  r.sock.write(nested(8));
  await sleep(200);
  check(!/failed to decode/.test(gs.logs().slice(before)), "depth 8 still decodes");
  r.sock.destroy();
}

// --- 3. Display name ---
class Forger extends GameClient {
  forged?: string;
  loginName = "";
  raw = Buffer.alloc(0);
  override send(c: number, a: number, p: SFSObjectWriter) {
    if (c === 0 && a === 1 && this.forged) {
      const sock = this.sock;
      const joinText = this.joinText;
      sock.write(encodePacket(0, 1, new SFSObjectWriter().putUtfString("zn", "ClubPenguin").putUtfString("un", this.forged).putUtfString("pw", "")
        .putSFSObject("p", new SFSObjectWriter().putUtfString("joinRoomData", joinText))).encode("sfs2x"));
      return;
    }
    super.send(c, a, p);
  }
  joinText = "";
  override onData(d: Buffer) {
    this.raw = Buffer.concat([this.raw, d]);
    let buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const h = tryReadHeader(buf, "sfs2x");
      if (!h || buf.length < h.totalLength) break;
      try {
        const p = decodePacketBody(buf.subarray(h.headerLength, h.totalLength), "sfs2x");
        if (p.controllerId === 0 && p.actionId === 1 && p.params.un) this.loginName = p.params.un.value as string;
      } catch {}
      buf = buf.subarray(h.totalLength);
    }
    super.onData(d);
  }
}
async function joinTextFor(c: GameClient): Promise<string> {
  const jr = await fetch(`${api.base}/game/v1/worlds/Alpine/language/en/rooms/Town/players`, { method: "POST", headers: c.auth(), body: "{}" });
  return jr.text();
}

const watcher = new Forger(api, gs.port, "{TRUST-WATCHER}", "Watcher");
await watcher.connect();
check(watcher.myId > 0, "a normal login still works");
check(watcher.loginName === "Watcher", `the login answers with the account's display name (${watcher.loginName})`);

const forger = new Forger(api, gs.port, "{TRUST-FORGER}", "Honest");
// connect() fetches joinRoomData itself; the forged login reuses a copy.
await (await import("./lib/mix-client.ts")).createPlayer(api.base, api.dbPath, forger.swid, forger.name);
forger.joinText = await joinTextFor(forger);
forger.forged = "Moderator";
await forger.connect();
await sleep(300);
check(forger.myId > 0, "a login with a different \"un\" is still let in");
check(forger.loginName === "Honest", `its name is the signed one, not the "un" it sent (${forger.loginName})`);
check(watcher.raw.includes("Honest") && !watcher.raw.includes("Moderator"), "the room is told the signed name");

{
  // Editing userName inside joinRoomData breaks the signature.
  const r = await Raw.open();
  r.handshake();
  await sleep(50);
  const edited = forger.joinText.replace('"userName":"Honest"', '"userName":"Moderator"');
  check(edited !== forger.joinText, "(the test edited userName in joinRoomData)");
  r.send(0, 1, new SFSObjectWriter().putUtfString("zn", "ClubPenguin").putUtfString("un", "Moderator").putUtfString("pw", "")
    .putSFSObject("p", new SFSObjectWriter().putUtfString("joinRoomData", edited)));
  await sleep(300);
  check(r.closed && !r.got.some((g) => g.c === 0 && g.a === 1), "joinRoomData with an edited userName is refused");
}

// --- 4. Variables that aren't the web API's JSON ---
{
  watcher.clear();
  forger.send(0, 12, stringVar("outfit", "not json {"));
  forger.send(0, 12, stringVar("colour", "red"));
  forger.send(0, 12, stringVar("tube", "{\"data\":{\"tubeId\":\"x\"}}"));
  forger.send(0, 12, stringVar("outfit", "{\"data\":{\"parts\":[\"}\"]}}")); // brace inside a string
  await sleep(300);
  const seen = watcher.varsOf(forger.myId);
  check(seen.length === 0, `malformed outfit, colour and tube values aren't relayed (${JSON.stringify(seen)})`);
  watcher.clear();
  forger.send(0, 12, stringVar("colour", JSON.stringify({ goodUntil: 1, swid: forger.swid, data: { colour: 255 }, signature: "x" })));
  forger.send(0, 12, stringVar("outfit", JSON.stringify({ goodUntil: 1, swid: forger.swid, data: { parts: [], sessionId: 5 }, signature: "x" })));
  await sleep(300);
  const ok = watcher.varsOf(forger.myId);
  // The web API has no such colour or outfit saved for this account, so neither is shown
  // (tools/appearance-trust-test.ts covers what is shown instead).
  check(!ok.some((v) => v.colour === 255), `a well-formed colour the web API doesn't have is not relayed (${JSON.stringify(ok)})`);
  check(!ok.some((v) => typeof v.outfit === "string" && v.outfit.includes('"sessionId":5')), "a well-formed outfit the web API doesn't have is not relayed");
}

// --- 5. Bans ---
{
  const ban = (swid: string) => { const db = new Database(api.dbPath); db.run("INSERT INTO mix_bans (swid, kind, until) VALUES (?, 'ban', NULL)", [swid]); db.close(); };
  ban(forger.swid);
  for (let i = 0; i < 40 && !forger.closed; i++) await sleep(100);
  check(forger.closed, "a player banned while online is disconnected");
  check(!watcher.closed, "other players stay connected");

  const r = await Raw.open();
  r.handshake();
  await sleep(50);
  r.send(0, 1, new SFSObjectWriter().putUtfString("zn", "ClubPenguin").putUtfString("un", "Honest").putUtfString("pw", "")
    .putSFSObject("p", new SFSObjectWriter().putUtfString("joinRoomData", forger.joinText)));
  for (let i = 0; i < 30 && !r.closed; i++) await sleep(100);
  check(r.closed, "joinRoomData issued before the ban no longer keeps a connection");
  check(/banned/.test(gs.logs()), "the server logs the reason");
}

gs.stop();
await api.stop();
finish(gs.logs());
