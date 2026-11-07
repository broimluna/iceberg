// Checks the web API's signature on joinRoomData before the login trusts
// its swid, sessionId and room (web-api/src/utils/joinSignature.ts signs
// it). Without this, editing the swid in a captured login packet let a
// player act as someone else here.
//
// HMAC-SHA256 over "swid|sessionId|room|goodUntil", keyed by
// JOIN_SIGNING_KEY or <repo>/.iceberg-join-key (whichever server starts
// first creates the file).
//
// goodUntil is the web API's one-hour validity. A grace period on top lets
// a client that has sat in one room for a long time reconnect with the
// joinRoomData it already holds. The signature, not the time, is what
// stops impersonation: a replay can only ever be of your own login.
import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const KEY_FILE = path.resolve(import.meta.dir, "../../.iceberg-join-key");
const GRACE_MS = 24 * 3_600_000;

let key: string | null = null;
function signingKey(): string {
  if (key) return key;
  if (process.env.JOIN_SIGNING_KEY) return (key = process.env.JOIN_SIGNING_KEY);
  try {
    writeFileSync(KEY_FILE, crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return (key = readFileSync(KEY_FILE, "utf8").trim());
}

export type JoinClaims = { swid: string; sessionId: string; room: string; goodUntil: number; signature: unknown };

/** Returns null when the claims are signed and current, else the reason. */
export function checkJoinSignature(c: JoinClaims, now = Date.now()): string | null {
  if (typeof c.signature !== "string" || c.signature.length === 0) return "no signature";
  if (!Number.isSafeInteger(c.goodUntil)) return "no goodUntil";
  const expected = crypto.createHmac("sha256", signingKey()).update(`${c.swid}|${c.sessionId}|${c.room}|${c.goodUntil}`).digest();
  const given = Buffer.from(c.signature, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return "bad signature";
  if (c.goodUntil + GRACE_MS < now) return "expired";
  return null;
}
