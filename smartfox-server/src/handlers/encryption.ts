import crypto from "node:crypto";
import { SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import { getUtfString } from "../wire-helpers.ts";
import type { HandlerContext } from "./context.ts";

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// SmartfoxCommand.GET_ROOM_ENCRYPTION_KEY ("encryption.get") - the second
// of the two bootstrap calls a real client makes immediately after
// JoinRoom, right after time.get (see handlers/time.ts's comment for how
// that pair was found to be the actual room-join-hang root cause).
// Protocol: the client uploads
// its own RSA public key as raw big-endian modulus/exponent bytes
// (base64, "pkm"/"pke" - NOT a PEM/X.509 blob), the server generates a
// random AES-256 key, RSA-encrypts it against that public key with
// PKCS1 padding (`RSA/ECB/PKCS1Padding` - explicitly not OAEP, per that
// file's own "for compatibility with .NET client" comment), and returns
// the encrypted blob as "ek" (base64). The plaintext AES key is stashed
// on Session (session.aesKey) so handlers/chat.ts can decrypt later
// encrypted chat.msg traffic (if the key were thrown away, every chat.msg
// sent after a client establishes a key would silently decode as an
// empty message).
export function handleEncryptionGet(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const pkm = getUtfString(innerParams, "pkm");
  const pke = getUtfString(innerParams, "pke");
  if (!pkm || !pke) {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - encryption.get: missing pkm/pke, not responding`);
    return;
  }
  try {
    // JWK's "n" must be the minimal-length unsigned big-endian modulus
    // (no leading zero sign byte) - Java's `new BigInteger(1, bytes)`
    // accepts a leading zero fine, but Node's JWK import is stricter.
    let modulus = Buffer.from(pkm, "base64");
    if (modulus.length > 0 && modulus[0] === 0x00) modulus = modulus.subarray(1);
    const exponent = Buffer.from(pke, "base64");
    const publicKey = crypto.createPublicKey({
      key: { kty: "RSA", n: toBase64Url(modulus), e: toBase64Url(exponent) },
      format: "jwk",
    });

    const aesKey = crypto.randomBytes(32); // AES-256, matches KeyGenerator.getInstance("AES").init(256)
    const encrypted = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, aesKey);
    ctx.session.aesKey = aesKey;

    const responseP = new SFSObjectWriter().putUtfString("ek", encrypted.toString("base64"));
    ctx.send(encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "encryption.get").putSFSObject("p", responseP)));
    console.log(`[${new Date().toISOString()}] ${ctx.peer} <- encryption.get response (ek=${encrypted.length} bytes encrypted)`);
  } catch (err) {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - encryption.get failed: ${(err as Error).message}`);
    ctx.send(encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "encryption.error").putSFSObject("p", new SFSObjectWriter())));
  }
}
