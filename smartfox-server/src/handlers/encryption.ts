import crypto from "node:crypto";
import { SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import { getUtfString } from "../wire-helpers.ts";
import type { HandlerContext } from "./context.ts";

const MAX_MODULUS_BYTES = 512; // 4096 bits
const MAX_EXPONENT_BYTES = 4;

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// "encryption.get" - sent right after time.get on room join. The client sends
// its RSA public key as raw big-endian modulus/exponent bytes (base64
// "pkm"/"pke", not PEM). We generate an AES-256 key, encrypt it with
// RSA PKCS#1 v1.5 padding (not OAEP; the .NET client needs v1.5) and return
// it as "ek". The key is kept on the session so chat.ts can decrypt
// encrypted chat messages.
export function handleEncryptionGet(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const pkm = getUtfString(innerParams, "pkm");
  const pke = getUtfString(innerParams, "pke");
  if (!pkm || !pke) {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - encryption.get: missing pkm/pke, not responding`);
    return;
  }
  try {
    // JWK "n" must not have a leading zero byte; Node rejects it.
    let modulus = Buffer.from(pkm, "base64");
    if (modulus.length > 0 && modulus[0] === 0x00) modulus = modulus.subarray(1);
    const exponent = Buffer.from(pke, "base64");
    // The client's key is 1024-bit with exponent 65537. Bigger keys cost a
    // long modular power each, so they're refused.
    if (modulus.length > MAX_MODULUS_BYTES || exponent.length > MAX_EXPONENT_BYTES) {
      throw new Error(`unsupported ${modulus.length * 8}-bit key with a ${exponent.length}-byte exponent`);
    }
    const publicKey = crypto.createPublicKey({
      key: { kty: "RSA", n: toBase64Url(modulus), e: toBase64Url(exponent) },
      format: "jwk",
    });

    const aesKey = crypto.randomBytes(32); // AES-256
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
