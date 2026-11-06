import crypto from "node:crypto";
import { SFSDataType, type SFSObjectData } from "./sfs-wire.ts";
import type { Session } from "./session.ts";

export function getUtfString(obj: SFSObjectData, key: string): string | undefined {
  const v = obj[key];
  return v?.type === SFSDataType.UTF_STRING ? v.value : undefined;
}

// Mirrors the client's own SmartFoxEncryptor.DecryptParameters
// (ClubPenguinClient.decompiled.cs:13906-13917) for a UTF_STRING field -
// real, decompiled-confirmed shape, not guessed: once a key's established
// via encryption.get (handlers/encryption.ts, session.aesKey),
// EncryptParameter (:13887-13904) replaces the target field's own value
// with base64(16-byte random IV + AES-256-CBC/PKCS7 ciphertext of the
// UTF-8 original) and adds a *sibling* field "ep" whose value names which
// key got encrypted (e.g. "ep":"msg") - so decryption means checking "ep"
// first, not assuming a fixed field is always encrypted. Only kicks in
// once session.aesKey exists; before that (or if "ep" doesn't name this
// key), falls back to a plain, unencrypted read - matches the client only
// encrypting once `mt.SmartFoxEncryptor != null` (set after encryption.get
// succeeds, ClubPenguinClient.decompiled.cs:1380/:2274).
export function getPossiblyEncryptedUtfString(obj: SFSObjectData, key: string, session: Session): string | undefined {
  const encryptedField = getUtfString(obj, "ep");
  if (encryptedField !== key || !session.aesKey) return getUtfString(obj, key);
  const raw = getUtfString(obj, key);
  if (!raw) return undefined;
  try {
    const combined = Buffer.from(raw, "base64");
    const iv = combined.subarray(0, 16);
    const ciphertext = combined.subarray(16);
    const decipher = crypto.createDecipheriv("aes-256-cbc", session.aesKey, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (err) {
    console.log(`[wire-helpers] failed to decrypt "${key}": ${(err as Error).message}`);
    return undefined;
  }
}

export function getSFSObject(obj: SFSObjectData, key: string): SFSObjectData {
  const v = obj[key];
  return v?.type === SFSDataType.SFS_OBJECT ? v.value : {};
}

export function getInt(obj: SFSObjectData, key: string): number | undefined {
  const v = obj[key];
  return v?.type === SFSDataType.INT ? v.value : undefined;
}

export function getByte(obj: SFSObjectData, key: string): number | undefined {
  const v = obj[key];
  return v?.type === SFSDataType.BYTE ? v.value : undefined;
}

export function getFloatArray(obj: SFSObjectData, key: string): number[] | undefined {
  const v = obj[key];
  return v?.type === SFSDataType.FLOAT_ARRAY ? v.value : undefined;
}

// For diagnostic logging only (the `-> c=... a=... p=...` line in
// server.ts) - NOT used for any actual protocol/decoding logic, so it's
// safe to lossily stringify anything JSON.stringify can't handle natively.
// `JSON.stringify` throws on a raw `bigint` (LONG-typed values decode to
// JS `bigint`, sfs-wire.ts:116) - since that throw happened while still
// building the log line's *argument*, `console.log` itself never even
// ran, and the exception unwound out of the whole `for(;;)` packet loop
// in server.ts silently (nothing crashes, but the packet that triggered
// it - and only that one - never reaches its handler). Every incoming
// packet gets run through this before dispatch, so any client request
// containing a LONG field (e.g. "time.get"'s "ct") was being silently
// dropped, with no log line and no visible error anywhere - found via a
// byte-level proxy capture confirming the bytes reached the socket fine,
// then step-by-step debug logging pinpointing exactly this line.
export function describeValue(v: SFSObjectData[string]): unknown {
  if (v.type === SFSDataType.SFS_OBJECT) {
    const out: Record<string, unknown> = {};
    for (const [k, nested] of Object.entries(v.value)) out[k] = describeValue(nested);
    return out;
  }
  if (v.type === SFSDataType.SFS_ARRAY) {
    return v.value.map((nested) => describeValue(nested));
  }
  if (typeof v.value === "bigint") {
    return v.value.toString();
  }
  return v.value;
}

// Extracts the raw, unparsed JSON substring for a top-level-ish `"key":`
// occurrence in `text`, matching brace/bracket depth rather than going
// through JSON.parse/stringify - needed for joinRoomData.data.playerRoomData
// .outfit specifically, because PlayerOutfitDetails.sessionId
// (ClubPenguinClient.decompiled.cs:10884) nests the same 64-bit sessionId
// precision hazard already worked around everywhere else in this file
// (JSON.parse would silently round it via IEEE754 double). Re-serializing
// the parsed object with JSON.stringify would reintroduce exactly that bug;
// extracting the original text verbatim avoids it. Not a general-purpose
// JSON extractor (doesn't handle brace characters inside string values) -
// fine for this project's own well-formed, always-known joinRoomData shape,
// not attacker-adversarial input.
export function extractRawJsonValue(text: string, key: string): string | undefined {
  const marker = `"${key}"`;
  const idx = text.indexOf(marker);
  if (idx === -1) return undefined;
  let pos = idx + marker.length;
  while (pos < text.length && (text[pos] === " " || text[pos] === ":")) pos++;
  const first = text[pos];
  if (first !== "{" && first !== "[") {
    let end = pos;
    while (end < text.length && !",}]".includes(text[end]!)) end++;
    return text.slice(pos, end).trim();
  }
  const close = first === "{" ? "}" : "]";
  let depth = 0;
  let end = pos;
  for (; end < text.length; end++) {
    if (text[end] === first) depth++;
    else if (text[end] === close) {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  return text.slice(pos, end);
}
