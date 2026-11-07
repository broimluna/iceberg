// BitSwarm wire codec for both SmartFoxServer 2X and SmartFoxServer 3
// clients: packet header, packet body, and the SFSObject/SFSArray binary
// format. The SFS2X side matches the retail client's PacketHeader,
// SFSProtocolCodec and DefaultSFSDataSerializer and was checked against
// captured traffic. The SFS3 side matches the SmartFox3 client API.
//
// What differs between the two:
// - Header flags. SFS2X: 0x80 binary (always set), 0x40 encrypted,
//   0x20 compressed, 0x10 blueBoxed, 0x08 bigSized. SFS3: 0x80 compressed,
//   0x40 encrypted, 0x20 bigSized, 0x10 raw, and no binary flag.
// - Body. SFS2X wraps everything in an SFSObject {c: byte, a: short,
//   p: params}. SFS3 sends controllerId(1) + actionId(2, BE) + params.
// - SFSObject keys have a 2-byte length in SFS2X and a 1-byte one in SFS3.
// - SFS3 adds SHORT_STRING (19, 1-byte length; 19 is CLASS in SFS2X) and
//   VECTOR2/VECTOR3.
// - User/room/MMOItem variable type ids are numbered differently (see
//   VariableKind below).
// Everything else (type ids 0-18 and 20, value layouts, request ids) is
// the same.
//
// Packets are built once and encoded per recipient (OutgoingPacket), so one
// broadcast can reach players on either protocol.
//
// Decoded types: NULL, BOOL, BYTE, SHORT, INT, LONG, FLOAT, DOUBLE,
// UTF_STRING, TEXT, SHORT_STRING, SFS_OBJECT, SFS_ARRAY, FLOAT_ARRAY,
// INT_ARRAY, VECTOR2, VECTOR3. Add others as needed.

export type Protocol = "sfs2x" | "sfs3";

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
  SHORT_STRING = 19, // SFS3 only
  TEXT = 20,
  VECTOR2 = 22, // SFS3 only
  VECTOR3 = 23, // SFS3 only
  // Not a wire type: a variable's type byte, kept protocol-neutral and
  // written as a BYTE with the recipient's numbering.
  VARIABLE_TYPE = 256,
}

// A user/room/MMOItem variable's type. SFS2X and SFS3 number these
// differently.
export type VariableKind =
  | "null"
  | "bool"
  | "byte"
  | "short"
  | "int"
  | "long"
  | "float"
  | "double"
  | "string"
  | "object"
  | "array"
  | "vector2"
  | "vector3";

// SFS2X VariableType: NULL, BOOL, INT, DOUBLE, STRING, OBJECT, ARRAY. Kinds
// that only SFS3 has are sent as the nearest SFS2X kind.
const SFS2X_VARIABLE_TYPES: Record<VariableKind, number> = {
  null: 0,
  bool: 1,
  byte: 2,
  short: 2,
  int: 2,
  long: 2,
  float: 3,
  double: 3,
  string: 4,
  object: 5,
  array: 6,
  vector2: 6,
  vector3: 6,
};

// SFS3 VariableType.
const SFS3_VARIABLE_TYPES: Record<VariableKind, number> = {
  null: 0,
  bool: 1,
  byte: 2,
  short: 3,
  int: 4,
  long: 5,
  float: 6,
  double: 7,
  string: 8,
  object: 9,
  array: 10,
  vector2: 11,
  vector3: 12,
};

export function variableTypeId(kind: VariableKind, protocol: Protocol): number {
  return (protocol === "sfs3" ? SFS3_VARIABLE_TYPES : SFS2X_VARIABLE_TYPES)[kind];
}

// The kind a client meant by its variable type byte. Unknown ids map to
// undefined.
export function variableKindFromId(id: number, protocol: Protocol): VariableKind | undefined {
  if (protocol === "sfs3") {
    return (Object.keys(SFS3_VARIABLE_TYPES) as VariableKind[]).find((k) => SFS3_VARIABLE_TYPES[k] === id);
  }
  // First match, so 2 is "int" and 3 is "double".
  const sfs2x: VariableKind[] = ["null", "bool", "int", "double", "string", "object", "array"];
  return sfs2x[id];
}

export type SFSValue =
  | { type: SFSDataType.NULL; value: null }
  | { type: SFSDataType.BOOL; value: boolean }
  | { type: SFSDataType.BYTE; value: number }
  | { type: SFSDataType.SHORT; value: number }
  | { type: SFSDataType.INT; value: number }
  | { type: SFSDataType.LONG; value: bigint }
  | { type: SFSDataType.FLOAT; value: number }
  | { type: SFSDataType.DOUBLE; value: number }
  | { type: SFSDataType.UTF_STRING; value: string }
  | { type: SFSDataType.INT_ARRAY; value: number[] }
  | { type: SFSDataType.FLOAT_ARRAY; value: number[] }
  | { type: SFSDataType.SFS_ARRAY; value: SFSValue[] }
  | { type: SFSDataType.SFS_OBJECT; value: SFSObjectData }
  | { type: SFSDataType.VARIABLE_TYPE; value: VariableKind };

export type SFSObjectData = Record<string, SFSValue>;

export interface DecodedPacket {
  header: { encrypted: boolean; compressed: boolean; bigSized: boolean };
  headerLength: number; // bytes consumed by flag byte + length field
  bodyLength: number; // ExpectedLength - the body byte count
  totalLength: number; // headerLength + bodyLength
}

// Which protocol a connection speaks, from its first byte. Every SFS2X
// packet has the 0x80 binary flag; an SFS3 packet only has 0x80 when it's
// compressed, and the handshake never is.
export function detectProtocol(firstByte: number): Protocol {
  return (firstByte & 0x80) > 0 ? "sfs2x" : "sfs3";
}

export function tryReadHeader(buf: Buffer, protocol: Protocol): DecodedPacket | null {
  if (buf.length < 1) return null;
  const flagByte = buf[0]!;
  const header =
    protocol === "sfs3"
      ? {
          compressed: (flagByte & 0x80) > 0,
          encrypted: (flagByte & 0x40) > 0,
          bigSized: (flagByte & 0x20) > 0,
        }
      : {
          encrypted: (flagByte & 0x40) > 0,
          compressed: (flagByte & 0x20) > 0,
          bigSized: (flagByte & 0x08) > 0,
        };
  const lenFieldSize = header.bigSized ? 4 : 2;
  if (buf.length < 1 + lenFieldSize) return null;
  const bodyLength = header.bigSized ? buf.readUInt32BE(1) : buf.readUInt16BE(1);
  return {
    header,
    headerLength: 1 + lenFieldSize,
    bodyLength,
    totalLength: 1 + lenFieldSize + bodyLength,
  };
}

// Splits a packet body into controller id, action id and params.
export function decodePacketBody(
  body: Buffer,
  protocol: Protocol
): { controllerId: number | undefined; actionId: number | undefined; params: SFSObjectData } {
  if (protocol === "sfs3") {
    if (body.length < 3) throw new Error(`packet body too short (${body.length} bytes)`);
    return { controllerId: body[0]!, actionId: body.readInt16BE(1), params: decodeSFSObject(body, 3, protocol).value };
  }
  const envelope = decodeSFSObject(body, 0, protocol).value;
  const c = envelope["c"]?.value;
  const a = envelope["a"]?.value;
  return {
    controllerId: typeof c === "number" ? c : undefined,
    actionId: typeof a === "number" ? a : undefined,
    params: envelope["p"]?.type === SFSDataType.SFS_OBJECT ? envelope["p"].value : {},
  };
}

// SFSObject binary layout: type(1) + count(2, BE) + count * [keyLen + key(utf8)
// + type(1) + value]. keyLen is 2 bytes (BE) in SFS2X and 1 byte in SFS3.
export function decodeSFSObject(buf: Buffer, offset: number, protocol: Protocol): { value: SFSObjectData; next: number } {
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
    let keyLen: number;
    if (protocol === "sfs3") {
      keyLen = buf[pos]!;
      pos += 1;
    } else {
      keyLen = buf.readUInt16BE(pos);
      pos += 2;
    }
    const key = buf.toString("utf8", pos, pos + keyLen);
    pos += keyLen;
    const decoded = decodeValue(buf, pos, protocol);
    result[key] = decoded.value;
    pos = decoded.next;
  }
  return { value: result, next: pos };
}

function readFloats(buf: Buffer, pos: number, count: number): number[] {
  const values: number[] = [];
  for (let i = 0; i < count; i++) values.push(buf.readFloatBE(pos + i * 4));
  return values;
}

function decodeValue(buf: Buffer, offset: number, protocol: Protocol): { value: SFSValue; next: number } {
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
    case SFSDataType.FLOAT:
      return { value: { type, value: buf.readFloatBE(pos) }, next: pos + 4 };
    case SFSDataType.DOUBLE:
      return { value: { type, value: buf.readDoubleBE(pos) }, next: pos + 8 };
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
      const nested = decodeSFSObject(buf, pos - 1, protocol);
      return { value: { type, value: nested.value }, next: nested.next };
    }
    // FLOAT_ARRAY: count(2,BE) + count * float(4,BE), no per-element type tags.
    case SFSDataType.FLOAT_ARRAY: {
      const count = buf.readUInt16BE(pos);
      pos += 2;
      return { value: { type, value: readFloats(buf, pos, count) }, next: pos + count * 4 };
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
        const decoded = decodeValue(buf, pos, protocol);
        items.push(decoded.value);
        pos = decoded.next;
      }
      return { value: { type, value: items }, next: pos };
    }
    default:
      if (protocol === "sfs3") {
        // SHORT_STRING: like UTF_STRING with a 1-byte length, so decoded
        // as a plain string.
        if (type === SFSDataType.SHORT_STRING) {
          const len = buf[pos]!;
          pos += 1;
          const s = buf.toString("utf8", pos, pos + len);
          return { value: { type: SFSDataType.UTF_STRING, value: s }, next: pos + len };
        }
        // VECTOR2/VECTOR3: 2 or 3 floats, decoded as a FLOAT_ARRAY.
        if (type === SFSDataType.VECTOR2 || type === SFSDataType.VECTOR3) {
          const count = type === SFSDataType.VECTOR2 ? 2 : 3;
          return { value: { type: SFSDataType.FLOAT_ARRAY, value: readFloats(buf, pos, count) }, next: pos + count * 4 };
        }
      }
      throw new Error(`decodeValue: unimplemented SFS data type ${type} at offset ${offset}`);
  }
}

// --- Encoding (server -> client) ---

function encodeKey(key: string, protocol: Protocol): Buffer {
  const keyBuf = Buffer.from(key, "utf8");
  if (protocol === "sfs3") {
    if (keyBuf.length > 255) throw new Error(`SFSObject key too long for SFS3: "${key}"`);
    return Buffer.concat([Buffer.from([keyBuf.length]), keyBuf]);
  }
  const keyLenBuf = Buffer.alloc(2);
  keyLenBuf.writeUInt16BE(keyBuf.length, 0);
  return Buffer.concat([keyLenBuf, keyBuf]);
}

function encodeUtfString(value: string): Buffer {
  const strBuf = Buffer.from(value, "utf8");
  const b = Buffer.alloc(3 + strBuf.length);
  b[0] = SFSDataType.UTF_STRING;
  b.writeUInt16BE(strBuf.length, 1);
  strBuf.copy(b, 3);
  return b;
}

// Layout: type(1) + count(2,BE) + count * 4 bytes.
function encodeFloatArray(values: number[]): Buffer {
  const b = Buffer.alloc(3 + values.length * 4);
  b[0] = SFSDataType.FLOAT_ARRAY;
  b.writeUInt16BE(values.length, 1);
  values.forEach((v, i) => b.writeFloatBE(v, 3 + i * 4));
  return b;
}

function encodeIntArray(values: number[]): Buffer {
  const b = Buffer.alloc(3 + values.length * 4);
  b[0] = SFSDataType.INT_ARRAY;
  b.writeUInt16BE(values.length, 1);
  values.forEach((v, i) => b.writeInt32BE(v, 3 + i * 4));
  return b;
}

function encodeContainerHeader(type: SFSDataType.SFS_ARRAY | SFSDataType.SFS_OBJECT, count: number): Buffer {
  const b = Buffer.alloc(3);
  b[0] = type;
  b.writeUInt16BE(count, 1);
  return b;
}

// Re-encodes a decoded value unchanged, e.g. to echo a client's
// SetUserVariables list, whose values can be any type.
export function encodeSFSValue(v: SFSValue, protocol: Protocol): Buffer {
  switch (v.type) {
    case SFSDataType.NULL:
      return Buffer.from([SFSDataType.NULL]);
    case SFSDataType.BOOL:
      return Buffer.from([SFSDataType.BOOL, v.value ? 1 : 0]);
    case SFSDataType.BYTE:
      return Buffer.from([SFSDataType.BYTE, v.value & 0xff]);
    case SFSDataType.VARIABLE_TYPE:
      return Buffer.from([SFSDataType.BYTE, variableTypeId(v.value, protocol)]);
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
    case SFSDataType.FLOAT: {
      const b = Buffer.alloc(5);
      b[0] = SFSDataType.FLOAT;
      b.writeFloatBE(v.value, 1);
      return b;
    }
    case SFSDataType.DOUBLE: {
      const b = Buffer.alloc(9);
      b[0] = SFSDataType.DOUBLE;
      b.writeDoubleBE(v.value, 1);
      return b;
    }
    case SFSDataType.UTF_STRING:
      return encodeUtfString(v.value);
    case SFSDataType.FLOAT_ARRAY:
      return encodeFloatArray(v.value);
    case SFSDataType.INT_ARRAY:
      return encodeIntArray(v.value);
    case SFSDataType.SFS_ARRAY: {
      const parts = v.value.map((item) => encodeSFSValue(item, protocol));
      return Buffer.concat([encodeContainerHeader(SFSDataType.SFS_ARRAY, v.value.length), ...parts]);
    }
    case SFSDataType.SFS_OBJECT: {
      const entries = Object.entries(v.value);
      const parts: Buffer[] = [];
      for (const [key, val] of entries) parts.push(encodeKey(key, protocol), encodeSFSValue(val, protocol));
      return Buffer.concat([encodeContainerHeader(SFSDataType.SFS_OBJECT, entries.length), ...parts]);
    }
  }
}

type Encoder = (protocol: Protocol) => Buffer;

// Builds an SFSObject. Values are encoded when the packet is encoded for a
// recipient, so the same writer serves both protocols.
export class SFSObjectWriter {
  private entries: { key: string; encode: Encoder; only?: Protocol }[] = [];

  private put(key: string, encode: Encoder): this {
    this.entries.push({ key, encode });
    return this;
  }

  putBool(key: string, value: boolean): this {
    return this.putRaw(key, { type: SFSDataType.BOOL, value });
  }

  putByte(key: string, value: number): this {
    return this.putRaw(key, { type: SFSDataType.BYTE, value });
  }

  putShort(key: string, value: number): this {
    return this.putRaw(key, { type: SFSDataType.SHORT, value });
  }

  putInt(key: string, value: number): this {
    return this.putRaw(key, { type: SFSDataType.INT, value });
  }

  putUtfString(key: string, value: string): this {
    return this.put(key, () => encodeUtfString(value));
  }

  putLong(key: string, value: bigint): this {
    return this.putRaw(key, { type: SFSDataType.LONG, value });
  }

  putFloatArray(key: string, values: number[]): this {
    return this.put(key, () => encodeFloatArray(values));
  }

  putIntArray(key: string, values: number[]): this {
    return this.put(key, () => encodeIntArray(values));
  }

  putSFSObject(key: string, nested: SFSObjectWriter): this {
    return this.put(key, (p) => nested.encodeBody(p));
  }

  putSFSArray(key: string, nested: SFSArrayWriter): this {
    return this.put(key, (p) => nested.encodeBody(p));
  }

  // Embeds an already-decoded value verbatim - see encodeSFSValue above.
  putRaw(key: string, value: SFSValue): this {
    return this.put(key, (p) => encodeSFSValue(value, p));
  }

  // Entries added inside `build` are only sent to clients on `protocol`.
  onlyFor(protocol: Protocol, build: (w: SFSObjectWriter) => void): this {
    const tmp = new SFSObjectWriter();
    build(tmp);
    for (const e of tmp.entries) this.entries.push({ ...e, only: protocol });
    return this;
  }

  // Encoded with its leading type(1) + count(2) header.
  encodeBody(protocol: Protocol): Buffer {
    const parts: Buffer[] = [];
    let count = 0;
    for (const { key, encode, only } of this.entries) {
      if (only && only !== protocol) continue;
      parts.push(encodeKey(key, protocol), encode(protocol));
      count++;
    }
    return Buffer.concat([encodeContainerHeader(SFSDataType.SFS_OBJECT, count), ...parts]);
  }
}

// Like SFSObjectWriter, but elements have no keys.
export class SFSArrayWriter {
  private elements: { encode: Encoder; only?: Protocol }[] = [];

  private push(encode: Encoder): this {
    this.elements.push({ encode });
    return this;
  }

  putInt(value: number): this {
    return this.putRaw({ type: SFSDataType.INT, value });
  }

  putShort(value: number): this {
    return this.putRaw({ type: SFSDataType.SHORT, value });
  }

  putBool(value: boolean): this {
    return this.putRaw({ type: SFSDataType.BOOL, value });
  }

  putByte(value: number): this {
    return this.putRaw({ type: SFSDataType.BYTE, value });
  }

  // A variable's type byte, numbered for the recipient's protocol.
  putVariableType(kind: VariableKind): this {
    return this.putRaw({ type: SFSDataType.VARIABLE_TYPE, value: kind });
  }

  putDouble(value: number): this {
    return this.putRaw({ type: SFSDataType.DOUBLE, value });
  }

  putNull(): this {
    return this.putRaw({ type: SFSDataType.NULL, value: null });
  }

  putUtfString(value: string): this {
    return this.push(() => encodeUtfString(value));
  }

  putSFSArray(nested: SFSArrayWriter): this {
    return this.push((p) => nested.encodeBody(p));
  }

  putSFSObject(nested: SFSObjectWriter): this {
    return this.push((p) => nested.encodeBody(p));
  }

  // Embeds an already-decoded value verbatim - see encodeSFSValue above.
  putRaw(value: SFSValue): this {
    return this.push((p) => encodeSFSValue(value, p));
  }

  putFloatArray(values: number[]): this {
    return this.push(() => encodeFloatArray(values));
  }

  putIntArray(values: number[]): this {
    return this.push(() => encodeIntArray(values));
  }

  // Elements added inside `build` are only sent to clients on `protocol`.
  onlyFor(protocol: Protocol, build: (w: SFSArrayWriter) => void): this {
    const tmp = new SFSArrayWriter();
    build(tmp);
    for (const e of tmp.elements) this.elements.push({ ...e, only: protocol });
    return this;
  }

  encodeBody(protocol: Protocol): Buffer {
    const parts = this.elements.filter((e) => !e.only || e.only === protocol).map((e) => e.encode(protocol));
    return Buffer.concat([encodeContainerHeader(SFSDataType.SFS_ARRAY, parts.length), ...parts]);
  }
}

// One server -> client message. Encoded lazily per protocol and cached, so
// a broadcast encodes at most twice.
export class OutgoingPacket {
  private readonly cache = new Map<Protocol, Buffer>();

  constructor(
    readonly controllerId: number,
    readonly actionId: number,
    private readonly params: SFSObjectWriter
  ) {}

  encode(protocol: Protocol): Buffer {
    let bytes = this.cache.get(protocol);
    if (!bytes) {
      bytes = protocol === "sfs3" ? this.encodeSfs3() : this.encodeSfs2x();
      this.cache.set(protocol, bytes);
    }
    return bytes;
  }

  // {c, a, p} envelope; flags: binary, plus bigSized past 64 KB.
  private encodeSfs2x(): Buffer {
    const envelope = new SFSObjectWriter()
      .putByte("c", this.controllerId)
      .putShort("a", this.actionId)
      .putSFSObject("p", this.params);
    return frame(envelope.encodeBody("sfs2x"), 0x80, 0x08);
  }

  // controllerId(1) + actionId(2) + params; flags: bigSized past 64 KB.
  private encodeSfs3(): Buffer {
    const prefix = Buffer.alloc(3);
    prefix[0] = this.controllerId;
    prefix.writeInt16BE(this.actionId, 1);
    return frame(Buffer.concat([prefix, this.params.encodeBody("sfs3")]), 0x00, 0x20);
  }
}

// Adds the header: flag byte + 2-byte length, or a 4-byte length with the
// bigSized flag when the body doesn't fit in 2 bytes. Never compressed or
// encrypted.
function frame(body: Buffer, baseFlags: number, bigSizedFlag: number): Buffer {
  if (body.length <= 0xffff) {
    const header = Buffer.alloc(3);
    header[0] = baseFlags;
    header.writeUInt16BE(body.length, 1);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(5);
  header[0] = baseFlags | bigSizedFlag;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

export function encodePacket(controllerId: number, actionId: number, params: SFSObjectWriter): OutgoingPacket {
  return new OutgoingPacket(controllerId, actionId, params);
}
