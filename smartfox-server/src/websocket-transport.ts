// Minimal WebSocket (RFC 6455) layer for the BitSwarm WebSocket-Binary mode.
// The OpenCPI client always connects over WebSocket: SFS2X builds use
// ws://host:port/BlueBox/websocket and SFS3 builds /WebServices/websocket.
// The path isn't checked. Raw TCP is accepted on the same ports. Each frame carries the same BitSwarm packets,
// so this only wraps and unwraps. Implemented: the upgrade handshake,
// single-frame masked binary frames in and unmasked binary frames out. Not
// implemented: ping/pong, close frames, fragmentation.

import crypto from "node:crypto";

const WEBSOCKET_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// A WebSocket upgrade starts with "GET". A raw SFS2X packet starts with a
// byte >= 0x80 (the binary flag), and a raw SFS3 handshake with 0x00, so
// "G" (0x47) tells them apart.
export function looksLikeHttpRequest(buf: Buffer): boolean {
  return buf.length > 0 && buf[0] === 0x47;
}

// Returns null if the header block (terminated by \r\n\r\n) hasn't fully
// arrived yet - caller should keep buffering and retry.
export function tryHandleWebSocketHandshake(buf: Buffer): { response: string; consumed: number; headerText: string } | null {
  const headerEnd = buf.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;
  const headerText = buf.subarray(0, headerEnd).toString("utf8");
  const keyMatch = headerText.match(/Sec-WebSocket-Key:\s*(\S+)/i);
  if (!keyMatch) {
    throw new Error("HTTP upgrade request missing Sec-WebSocket-Key header");
  }
  const accept = crypto
    .createHash("sha1")
    .update(keyMatch[1]! + WEBSOCKET_MAGIC)
    .digest("base64");
  const response =
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`;
  return { response, consumed: headerEnd + 4, headerText };
}

// Returns null until the whole frame has arrived.
export function tryReadWebSocketFrame(buf: Buffer): { payload: Buffer; consumed: number } | null {
  if (buf.length < 2) return null;
  const masked = (buf[1]! & 0x80) !== 0;
  let payloadLen = buf[1]! & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < offset + 2) return null;
    payloadLen = buf.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLen === 127) {
    if (buf.length < offset + 8) return null;
    payloadLen = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  let maskKey: Buffer | undefined;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + payloadLen) return null;
  let payload = buf.subarray(offset, offset + payloadLen);
  if (maskKey) {
    const unmasked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i]! ^ maskKey[i % 4]!;
    payload = unmasked;
  }
  return { payload, consumed: offset + payloadLen };
}

// Server-to-client frames are never masked.
export function encodeWebSocketFrame(payload: Buffer): Buffer {
  const opcodeByte = 0x82; // FIN=1, opcode=2 (binary)
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([opcodeByte, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = opcodeByte;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = opcodeByte;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}
