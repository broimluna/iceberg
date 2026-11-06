// SFS2X BitSwarm wire codec: packet header, the c/a/p envelope, and the
// SFSObject/SFSArray binary format. Matches the client's PacketHeader,
// SFSProtocolCodec and DefaultSFSDataSerializer, and was checked against
// captured traffic.
//
// Supported types: NULL, BOOL, BYTE, SHORT, INT, LONG, UTF_STRING, TEXT,
// SFS_OBJECT, SFS_ARRAY, FLOAT_ARRAY, INT_ARRAY. Add others as needed.

export const enum SFSDataType {
  NULL = 0,
  BOOL = 1,
  BYTE = 2,
  SHORT = 3,
  INT = 4,
  LONG = 5,
  FLOAT = 6,
  DOUBLE = 7,
  UTF_STRING = 8,
  INT_ARRAY = 12,
  FLOAT_ARRAY = 14,
  SFS_ARRAY = 17,
  SFS_OBJECT = 18,
  TEXT = 20,
}

export type SFSValue =
  | { type: SFSDataType.NULL; value: null }
  | { type: SFSDataType.BOOL; value: boolean }
  | { type: SFSDataType.BYTE; value: number }
  | { type: SFSDataType.SHORT; value: number }
  | { type: SFSDataType.INT; value: number }
  | { type: SFSDataType.LONG; value: bigint }
  | { type: SFSDataType.UTF_STRING; value: string }
  | { type: SFSDataType.INT_ARRAY; value: number[] }
  | { type: SFSDataType.FLOAT_ARRAY; value: number[] }
  | { type: SFSDataType.SFS_ARRAY; value: SFSValue[] }
  | { type: SFSDataType.SFS_OBJECT; value: SFSObjectData };

export type SFSObjectData = Record<string, SFSValue>;

export interface DecodedPacket {
  header: { encrypted: boolean; compressed: boolean; blueBoxed: boolean; bigSized: boolean };
  headerLength: number; // bytes consumed by flag byte + length field
  bodyLength: number; // ExpectedLength - the body byte count
  totalLength: number; // headerLength + bodyLength
}

// Header flag bits: 0x80 binary (always set), 0x40 encrypted, 0x20 compressed,
// 0x10 blueBoxed, 0x08 bigSized (4-byte length instead of 2).
export function tryReadHeader(buf: Buffer): DecodedPacket | null {
  if (buf.length < 1) return null;
  const flagByte = buf[0]!;
  const bigSized = (flagByte & 0x08) > 0;
  const lenFieldSize = bigSized ? 4 : 2;
  if (buf.length < 1 + lenFieldSize) return null;
  const bodyLength = bigSized ? buf.readUInt32BE(1) : buf.readUInt16BE(1);
  return {
    header: {
      encrypted: (flagByte & 0x40) > 0,
      compressed: (flagByte & 0x20) > 0,
      blueBoxed: (flagByte & 0x10) > 0,
      bigSized,
    },
    headerLength: 1 + lenFieldSize,
    bodyLength,
    totalLength: 1 + lenFieldSize + bodyLength,
  };
}

// SFSObject binary layout: type(1) + count(2, BE) + count * [keyLen(2,BE)
// + key(utf8) + type(1) + value].
export function decodeSFSObject(buf: Buffer, offset: number): { value: SFSObjectData; next: number } {
  let pos = offset;
  const type = buf[pos]!;
  pos += 1;
  if (type !== SFSDataType.SFS_OBJECT) {
    throw new Error(`expected SFS_OBJECT (18) at offset ${offset}, got ${type}`);
  }
  const count = buf.readUInt16BE(pos);
  pos += 2;
  const result: SFSObjectData = {};
  for (let i = 0; i < count; i++) {
    const keyLen = buf.readUInt16BE(pos);
    pos += 2;
    const key = buf.toString("utf8", pos, pos + keyLen);
    pos += keyLen;
    const decoded = decodeValue(buf, pos);
    result[key] = decoded.value;
    pos = decoded.next;
  }
  return { value: result, next: pos };
}

function decodeValue(buf: Buffer, offset: number): { value: SFSValue; next: number } {
  let pos = offset;
  const type = buf[pos]! as SFSDataType;
  pos += 1;
  switch (type) {
    case SFSDataType.NULL:
      return { value: { type, value: null }, next: pos };
    case SFSDataType.BOOL:
      return { value: { type, value: buf[pos]! !== 0 }, next: pos + 1 };
    case SFSDataType.BYTE:
      return { value: { type, value: buf[pos]! }, next: pos + 1 };
    case SFSDataType.SHORT:
      return { value: { type, value: buf.readInt16BE(pos) }, next: pos + 2 };
    case SFSDataType.INT:
      return { value: { type, value: buf.readInt32BE(pos) }, next: pos + 4 };
    case SFSDataType.LONG:
      return { value: { type, value: buf.readBigInt64BE(pos) }, next: pos + 8 };
    case SFSDataType.UTF_STRING: {
      const len = buf.readUInt16BE(pos);
      pos += 2;
      const s = buf.toString("utf8", pos, pos + len);
      return { value: { type, value: s }, next: pos + len };
    }
    // TEXT: like UTF_STRING with a 4-byte length; decoded as a plain string,
    // the same as the client does.
    case SFSDataType.TEXT: {
      const len = buf.readUInt32BE(pos);
      pos += 4;
      const s = buf.toString("utf8", pos, pos + len);
      return { value: { type: SFSDataType.UTF_STRING, value: s }, next: pos + len };
    }
    case SFSDataType.SFS_OBJECT: {
      const nested = decodeSFSObject(buf, pos - 1);
      return { value: { type, value: nested.value }, next: nested.next };
    }
    // FLOAT_ARRAY: count(2,BE) + count * float(4,BE), no per-element type tags.
    case SFSDataType.FLOAT_ARRAY: {
      const count = buf.readUInt16BE(pos);
      pos += 2;
      const values: number[] = [];
      for (let i = 0; i < count; i++) {
        values.push(buf.readFloatBE(pos));
        pos += 4;
      }
      return { value: { type, value: values }, next: pos };
    }
    // INT_ARRAY: count(2,BE) + count * int(4,BE), same layout as FLOAT_ARRAY.
    case SFSDataType.INT_ARRAY: {
      const count = buf.readUInt16BE(pos);
      pos += 2;
      const values: number[] = [];
      for (let i = 0; i < count; i++) {
        values.push(buf.readInt32BE(pos));
        pos += 4;
      }
      return { value: { type, value: values }, next: pos };
    }
    // SFS_ARRAY: count(2,BE) + count * [type(1) + value], no keys.
    case SFSDataType.SFS_ARRAY: {
      const count = buf.readUInt16BE(pos);
      pos += 2;
      const items: SFSValue[] = [];
      for (let i = 0; i < count; i++) {
        const decoded = decodeValue(buf, pos);
        items.push(decoded.value);
        pos = decoded.next;
      }
      return { value: { type, value: items }, next: pos };
    }
    default:
      throw new Error(`decodeValue: unimplemented SFS data type ${type} at offset ${offset}`);
  }
}

// --- Encoding (server -> client) ---

// Re-encodes a decoded value unchanged, e.g. to echo a client's
// SetUserVariables list, whose values can be any type.
export function encodeSFSValue(v: SFSValue): Buffer {
  switch (v.type) {
    case SFSDataType.NULL:
      return Buffer.from([SFSDataType.NULL]);
    case SFSDataType.BOOL:
      return Buffer.from([SFSDataType.BOOL, v.value ? 1 : 0]);
    case SFSDataType.BYTE:
      return Buffer.from([SFSDataType.BYTE, v.value & 0xff]);
    case SFSDataType.SHORT: {
      const b = Buffer.alloc(3);
      b[0] = SFSDataType.SHORT;
      b.writeInt16BE(v.value, 1);
      return b;
    }
    case SFSDataType.INT: {
      const b = Buffer.alloc(5);
      b[0] = SFSDataType.INT;
      b.writeInt32BE(v.value, 1);
      return b;
    }
    case SFSDataType.LONG: {
      const b = Buffer.alloc(9);
      b[0] = SFSDataType.LONG;
      b.writeBigInt64BE(v.value, 1);
      return b;
    }
    case SFSDataType.UTF_STRING: {
      const strBuf = Buffer.from(v.value, "utf8");
      const b = Buffer.alloc(3 + strBuf.length);
      b[0] = SFSDataType.UTF_STRING;
      b.writeUInt16BE(strBuf.length, 1);
      strBuf.copy(b, 3);
      return b;
    }
    case SFSDataType.FLOAT_ARRAY: {
      const b = Buffer.alloc(3 + v.value.length * 4);
      b[0] = SFSDataType.FLOAT_ARRAY;
      b.writeUInt16BE(v.value.length, 1);
      v.value.forEach((f, i) => b.writeFloatBE(f, 3 + i * 4));
      return b;
    }
    case SFSDataType.INT_ARRAY: {
      const b = Buffer.alloc(3 + v.value.length * 4);
      b[0] = SFSDataType.INT_ARRAY;
      b.writeUInt16BE(v.value.length, 1);
      v.value.forEach((n, i) => b.writeInt32BE(n, 3 + i * 4));
      return b;
    }
    case SFSDataType.SFS_ARRAY: {
      const parts = v.value.map(encodeSFSValue);
      const countBuf = Buffer.alloc(3);
      countBuf[0] = SFSDataType.SFS_ARRAY;
      countBuf.writeUInt16BE(v.value.length, 1);
      return Buffer.concat([countBuf, ...parts]);
    }
    case SFSDataType.SFS_OBJECT: {
      const entries = Object.entries(v.value);
      const parts: Buffer[] = [];
      for (const [key, val] of entries) {
        const keyBuf = Buffer.from(key, "utf8");
        const keyLenBuf = Buffer.alloc(2);
        keyLenBuf.writeUInt16BE(keyBuf.length, 0);
        parts.push(keyLenBuf, keyBuf, encodeSFSValue(val));
      }
      const countBuf = Buffer.alloc(3);
      countBuf[0] = SFSDataType.SFS_OBJECT;
      countBuf.writeUInt16BE(entries.length, 1);
      return Buffer.concat([countBuf, ...parts]);
    }
  }
}

export class SFSObjectWriter {
  private entries: { key: string; encode: () => Buffer }[] = [];

  putByte(key: string, value: number): this {
    this.entries.push({ key, encode: () => Buffer.from([SFSDataType.BYTE, value & 0xff]) });
    return this;
  }

  putShort(key: string, value: number): this {
    this.entries.push({
      key,
      encode: () => {
        const b = Buffer.alloc(3);
        b[0] = SFSDataType.SHORT;
        b.writeInt16BE(value, 1);
        return b;
      },
    });
    return this;
  }

  putInt(key: string, value: number): this {
    this.entries.push({
      key,
      encode: () => {
        const b = Buffer.alloc(5);
        b[0] = SFSDataType.INT;
        b.writeInt32BE(value, 1);
        return b;
      },
    });
    return this;
  }

  putUtfString(key: string, value: string): this {
    this.entries.push({
      key,
      encode: () => {
        const strBuf = Buffer.from(value, "utf8");
        const b = Buffer.alloc(3 + strBuf.length);
        b[0] = SFSDataType.UTF_STRING;
        b.writeUInt16BE(strBuf.length, 1);
        strBuf.copy(b, 3);
        return b;
      },
    });
    return this;
  }

  putLong(key: string, value: bigint): this {
    this.entries.push({
      key,
      encode: () => {
        const b = Buffer.alloc(9);
        b[0] = SFSDataType.LONG;
        b.writeBigInt64BE(value, 1);
        return b;
      },
    });
    return this;
  }

  putFloatArray(key: string, values: number[]): this {
    this.entries.push({
      key,
      encode: () => {
        const b = Buffer.alloc(3 + values.length * 4);
        b[0] = SFSDataType.FLOAT_ARRAY;
        b.writeUInt16BE(values.length, 1);
        values.forEach((v, i) => b.writeFloatBE(v, 3 + i * 4));
        return b;
      },
    });
    return this;
  }

  putIntArray(key: string, values: number[]): this {
    this.entries.push({
      key,
      encode: () => {
        const b = Buffer.alloc(3 + values.length * 4);
        b[0] = SFSDataType.INT_ARRAY;
        b.writeUInt16BE(values.length, 1);
        values.forEach((v, i) => b.writeInt32BE(v, 3 + i * 4));
        return b;
      },
    });
    return this;
  }

  putSFSObject(key: string, nested: SFSObjectWriter): this {
    this.entries.push({
      key,
      encode: () => nested.encodeBody(),
    });
    return this;
  }

  putSFSArray(key: string, nested: SFSArrayWriter): this {
    this.entries.push({
      key,
      encode: () => nested.encodeBody(),
    });
    return this;
  }

  // Embeds an already-decoded value verbatim - see encodeSFSValue above.
  putRaw(key: string, value: SFSValue): this {
    this.entries.push({ key, encode: () => encodeSFSValue(value) });
    return this;
  }

  // Encoded with its leading type(1) + count(2) header.
  encodeBody(): Buffer {
    const parts: Buffer[] = [];
    for (const { key, encode } of this.entries) {
      const keyBuf = Buffer.from(key, "utf8");
      const keyLenBuf = Buffer.alloc(2);
      keyLenBuf.writeUInt16BE(keyBuf.length, 0);
      parts.push(keyLenBuf, keyBuf, encode());
    }
    const countBuf = Buffer.alloc(3);
    countBuf[0] = SFSDataType.SFS_OBJECT;
    countBuf.writeUInt16BE(this.entries.length, 1);
    return Buffer.concat([countBuf, ...parts]);
  }
}

// Like SFSObjectWriter, but elements have no keys.
export class SFSArrayWriter {
  private elements: (() => Buffer)[] = [];

  putInt(value: number): this {
    this.elements.push(() => {
      const b = Buffer.alloc(5);
      b[0] = SFSDataType.INT;
      b.writeInt32BE(value, 1);
      return b;
    });
    return this;
  }

  putShort(value: number): this {
    this.elements.push(() => {
      const b = Buffer.alloc(3);
      b[0] = SFSDataType.SHORT;
      b.writeInt16BE(value, 1);
      return b;
    });
    return this;
  }

  putBool(value: boolean): this {
    this.elements.push(() => Buffer.from([SFSDataType.BOOL, value ? 1 : 0]));
    return this;
  }

  putByte(value: number): this {
    this.elements.push(() => Buffer.from([SFSDataType.BYTE, value & 0xff]));
    return this;
  }

  putUtfString(value: string): this {
    this.elements.push(() => {
      const strBuf = Buffer.from(value, "utf8");
      const b = Buffer.alloc(3 + strBuf.length);
      b[0] = SFSDataType.UTF_STRING;
      b.writeUInt16BE(strBuf.length, 1);
      strBuf.copy(b, 3);
      return b;
    });
    return this;
  }

  putSFSArray(nested: SFSArrayWriter): this {
    this.elements.push(() => nested.encodeBody());
    return this;
  }

  putSFSObject(nested: SFSObjectWriter): this {
    this.elements.push(() => nested.encodeBody());
    return this;
  }

  // Embeds an already-decoded value verbatim - see encodeSFSValue above.
  putRaw(value: SFSValue): this {
    this.elements.push(() => encodeSFSValue(value));
    return this;
  }

  // Layout: type(1) + count(2,BE) + count * float(4,BE).
  putFloatArray(values: number[]): this {
    this.elements.push(() => {
      const b = Buffer.alloc(3 + values.length * 4);
      b[0] = SFSDataType.FLOAT_ARRAY;
      b.writeUInt16BE(values.length, 1);
      values.forEach((v, i) => b.writeFloatBE(v, 3 + i * 4));
      return b;
    });
    return this;
  }

  // Same layout as putFloatArray, with 4-byte ints.
  putIntArray(values: number[]): this {
    this.elements.push(() => {
      const b = Buffer.alloc(3 + values.length * 4);
      b[0] = SFSDataType.INT_ARRAY;
      b.writeUInt16BE(values.length, 1);
      values.forEach((v, i) => b.writeInt32BE(v, 3 + i * 4));
      return b;
    });
    return this;
  }

  encodeBody(): Buffer {
    const parts = this.elements.map((encode) => encode());
    const countBuf = Buffer.alloc(3);
    countBuf[0] = SFSDataType.SFS_ARRAY;
    countBuf.writeUInt16BE(this.elements.length, 1);
    return Buffer.concat([countBuf, ...parts]);
  }
}

// Wraps params in the {c, a, p} envelope and adds the packet header (binary
// flag only: uncompressed, unencrypted, 2-byte length).
export function encodePacket(controllerId: number, actionId: number, params: SFSObjectWriter): Buffer {
  const envelope = new SFSObjectWriter()
    .putByte("c", controllerId)
    .putShort("a", actionId)
    .putSFSObject("p", params);
  const body = envelope.encodeBody();
  const header = Buffer.alloc(3);
  header[0] = 0x80; // binary flag only
  header.writeUInt16BE(body.length, 1);
  return Buffer.concat([header, body]);
}
