// SetUserVariables relays only the variables the client sets
// (SocketUserVars), with the type the client reads them as and a bounded
// size. Others (sess, con_prop, on_quest are the server's) are dropped,
// so a modified client can't rewrite what other players see about it.
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";
import { SFSObjectWriter, SFSArrayWriter } from "../smartfox-server/src/sfs-wire.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const sfs = await startGameServer(api, KEY);

const str = (name: string, value: string) => new SFSArrayWriter().putUtfString(name).putVariableType("string").putUtfString(value).putBool(false);
const int = (name: string, value: number) => new SFSArrayWriter().putUtfString(name).putVariableType("int").putInt(value).putBool(false);
const setVars = (c: GameClient, ...entries: SFSArrayWriter[]) => {
  const vl = new SFSArrayWriter();
  for (const e of entries) vl.putSFSArray(e);
  c.send(0, 12, new SFSObjectWriter().putSFSArray("vl", vl));
};

try {
  const a = new GameClient(api, sfs.port, "{uv-a}", "VarsAlpha"), b = new GameClient(api, sfs.port, "{uv-b}", "VarsBravo");
  await a.connect(); await b.connect(); await sleep(300);

  b.clear();
  setVars(a, str("sess", "123"), str("on_quest", "x"), str("con_prop", "{}"), str("madeup", "hi"), int("awayfromkeyboard", 1));
  await sleep(300);
  const seen = Object.assign({}, ...b.varsOf(a.myId));
  check(seen.awayfromkeyboard === 1, `a client variable is relayed (${JSON.stringify(seen)})`);
  check(!("sess" in seen) && !("on_quest" in seen) && !("con_prop" in seen), "server-owned variables from the client are dropped");
  check(!("madeup" in seen), "unknown variables are dropped");

  b.clear();
  setVars(a, str("loc", "not a number"), int("proto", 5));
  await sleep(300);
  check(b.varsOf(a.myId).every((v) => !("loc" in v) && !("proto" in v)), `variables of the wrong type are dropped (${JSON.stringify(b.varsOf(a.myId))})`);

  b.clear();
  setVars(a, str("proto", "x".repeat(60_000)), int("tempheadstatus", 2));
  await sleep(500);
  const big = Object.assign({}, ...b.varsOf(a.myId));
  check(!("proto" in big) && big.tempheadstatus === 2, "an oversized value is dropped, the rest still go out");

  b.clear();
  const outfit = JSON.stringify({ data: { parts: [], sessionId: Number(a.sid) }, swid: "{uv-a}", goodUntil: 1, signature: "s" });
  setVars(a, str("outfit", outfit));
  a.setCon(null);
  await sleep(300);
  const ok = Object.assign({}, ...b.varsOf(a.myId));
  check(typeof ok.outfit === "string" && ok.outfit.startsWith("{") && "con" in ok, `outfit and con still work (${JSON.stringify(ok).slice(0, 120)})`);
} finally {
  sfs.stop();
  await api.stop();
}
finish(sfs.logs());
