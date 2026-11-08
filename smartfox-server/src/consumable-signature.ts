// Signatures on the SignedResponse<UsedConsumable> payloads the client
// relays between the web API and this server (the same code is in
// web-api/src/utils/consumableSignature.ts):
// - "use": the web API's DELETE /consumable/v1/{type} response, which the
//   client sends back here as con.use's "type". Proves the item was spent.
// - "partial": this server's con.partial, which the client POSTs to
//   /consumable/v1/partial. Proves the partial count came from a tray here.
//
// HMAC-SHA256 over "purpose|swid|type|partialCount|goodUntil|nonce" with
// the join signing key. The signature field is "nonce.hmac"; the client
// passes it through untouched. The random nonce makes every signature
// unique, so each one can be accepted once (claimConsumable).
//
// Payloads are good for five minutes; the client relays them straight
// away. Accepted signatures are remembered in memory until they expire,
// so a restart forgets them: a payload from the last five minutes before
// a restart could be accepted once more.
import crypto from "node:crypto";
import { signingKey } from "./join-signature.ts";

const VALID_MS = 5 * 60_000;

export type ConsumablePurpose = "use" | "partial";
export type ConsumableClaims = { swid: unknown; type: unknown; partialCount: unknown; goodUntil: unknown; signature: unknown };

function mac(purpose: ConsumablePurpose, swid: string, type: string, partialCount: number, goodUntil: number, nonce: string): Buffer {
  return crypto.createHmac("sha256", signingKey()).update(`${purpose}|${swid}|${type}|${partialCount}|${goodUntil}|${nonce}`).digest();
}

export function signConsumable(purpose: ConsumablePurpose, swid: string, type: string, partialCount: number, now = Date.now()): { goodUntil: number; signature: string } {
  const goodUntil = now + VALID_MS;
  const nonce = crypto.randomBytes(16).toString("base64url");
  return { goodUntil, signature: `${nonce}.${mac(purpose, swid, type, partialCount, goodUntil, nonce).toString("base64url")}` };
}

const field = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !v.includes("|");

/** Returns null when the claims are signed for `purpose` and current, else the reason. Doesn't claim them. */
export function checkConsumable(purpose: ConsumablePurpose, c: ConsumableClaims, now = Date.now()): string | null {
  if (typeof c.signature !== "string" || c.signature.length === 0) return "no signature";
  const dot = c.signature.indexOf(".");
  if (dot <= 0 || !field(c.swid) || !field(c.type)) return "bad signature";
  if (!Number.isSafeInteger(c.partialCount) || (c.partialCount as number) < 0 || !Number.isSafeInteger(c.goodUntil)) return "bad signature";
  const expected = mac(purpose, c.swid, c.type, c.partialCount as number, c.goodUntil as number, c.signature.slice(0, dot));
  const given = Buffer.from(c.signature.slice(dot + 1), "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return "bad signature";
  if ((c.goodUntil as number) < now) return "expired";
  return null;
}

const accepted = new Map<string, number>();

/** Records a checked signature. False if it was already accepted. */
export function claimConsumable(signature: string, goodUntil: number, now = Date.now()): boolean {
  for (const [s, until] of accepted) if (until < now) accepted.delete(s);
  if (accepted.has(signature)) return false;
  accepted.set(signature, goodUntil);
  return true;
}

export function replaySize(): number {
  return accepted.size;
}

/** The claims in a parsed SignedResponse<UsedConsumable>. */
export function claimsFrom(signed: unknown): ConsumableClaims {
  const s = (signed && typeof signed === "object" ? signed : {}) as Record<string, any>;
  const data = s.data && typeof s.data === "object" ? s.data : {};
  return { swid: s.swid, type: data.type, partialCount: data.partialCount, goodUntil: s.goodUntil, signature: s.signature };
}
