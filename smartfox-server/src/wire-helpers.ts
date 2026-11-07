import crypto from "node:crypto";
import { SFSDataType, type SFSObjectData } from "./sfs-wire.ts";
import type { Session } from "./session.ts";

export function getUtfString(obj: SFSObjectData, key: string): string | undefined {
  const v = obj[key];
  return v?.type === SFSDataType.UTF_STRING ? v.value : undefined;
}

// Reads a string field that may be encrypted (mirrors the client's
// SmartFoxEncryptor). Once encryption.get has set a key, the client replaces
// the field's value with base64(16-byte IV + AES-256-CBC ciphertext) and
// adds a sibling "ep" naming the encrypted field. Otherwise this is a plain
// read.
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

// Makes a decoded value safe to log or print. LONG fields decode to bigint,
// which JSON.stringify throws on, so they're converted to strings.
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

// Like ISFSObject.toJson() in the Java server API: a decoded SFSObject as
// plain JSON, without the {type, value} wrappers. LONGs become strings.
export function toJson(obj: SFSObjectData): string {
  return JSON.stringify(describeValue({ type: SFSDataType.SFS_OBJECT, value: obj }));
}

// Returns the raw JSON text of `key`'s value without parsing it. Used for the
// outfit in joinRoomData, which contains a 64-bit sessionId that JSON.parse
// would round. Not a general JSON parser: it doesn't handle braces inside
// strings, which is fine for the known joinRoomData shape.
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
