// Both key exchanges (the web API's POST /encryption-trusted/v1/encryptionKey
// and the game server's encryption.get) encrypt a key with the client's
// RSA public key. The client's key is 1024-bit with exponent 65537; keys
// over 4096 bits or with an exponent over 4 bytes are refused, since one
// such key costs the (single-threaded) server a long modular power.
import crypto from "node:crypto";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";
import { SFSObjectWriter } from "../smartfox-server/src/sfs-wire.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const sfs = await startGameServer(api, KEY);

const jwk = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "jwk" }) as any;
const b64 = (s: string) => Buffer.from(s, "base64url").toString("base64");
const real = { modulus: b64(jwk.n), exponent: b64(jwk.e) };
const hugeModulus = crypto.randomBytes(1024).toString("base64"); // 8192 bits
const hugeExponent = crypto.randomBytes(64).toString("base64");

try {
  const webKey = (modulus: string, exponent: string) => fetch(`${api.base}/encryption-trusted/v1/encryptionKey`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modulus, exponent }),
  }).then((r) => r.status);
  check(await webKey(real.modulus, real.exponent) === 200, "web API: the client's kind of key works");
  check(await webKey(hugeModulus, real.exponent) === 400, "web API: an 8192-bit modulus is refused");
  check(await webKey(real.modulus, hugeExponent) === 400, "web API: a 64-byte exponent is refused");

  const c = new GameClient(api, sfs.port, "{key-x}", "KeyExchanger");
  await c.connect();
  const get = async (pkm: string, pke: string) => {
    c.clear();
    c.ext13("encryption.get", new SFSObjectWriter().putUtfString("pkm", pkm).putUtfString("pke", pke));
    await sleep(300);
    return c.extOf("encryption.get").length === 1 ? "key" : c.extOf("encryption.error").length === 1 ? "error" : "nothing";
  };
  check(await get(real.modulus, real.exponent) === "key", "game server: the client's kind of key works");
  check(await get(hugeModulus, real.exponent) === "error", "game server: an 8192-bit modulus is refused");
  check(await get(real.modulus, hugeExponent) === "error", "game server: a 64-byte exponent is refused");
} finally {
  sfs.stop();
  await api.stop();
}
finish(sfs.logs());
