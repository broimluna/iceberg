// Minimal RFC 6455 WebSocket transport - just enough to let SFS2X's own
// WebSocket-Binary mode (Sfs2X.Util.UseWebSocket.WS_BIN/WSS_BIN) work over
// the same TCP port this server already speaks raw BitSwarm framing on.
//
// Why this exists: OpenCPI's client build (decompiled
// SmartFoxGameServerClientShared.cs:516) unconditionally constructs
// `new SmartFox(UseWebSocket.WS_BIN, ...)` - no raw-TCP fallback on any
// platform - and connects to `ws://<host>:<port>/BlueBox/websocket`
// (Sfs2X.Core.Sockets.WebSocketLayer.cs:118), the exact same host/port as
// the raw `tcpPort` field. Confirmed live: our raw `net.createServer`
// listener never even completes a TCP-level handshake with it because
// the client is speaking HTTP (the WS upgrade request) at a socket that
// only understands BitSwarm's own binary framing.
//
// The payload carried inside each WS binary frame is the *same* BitSwarm/
// SFSObject packet bytes this server already builds and parses - WS_BIN
// only changes the outer transport, not the protocol - so this module is
// deliberately just a thin wrap/unwrap layer, not a second protocol
// implementation. Only what SFS2X's own client-side WebSocketHelper
// actually needs is implemented: a single HTTP upgrade handshake, then
// single (non-fragmented) masked binary data frames from the client and
// unmasked binary data frames back - no ping/pong, no close frames, no
// fragmentation. Extend if a live capture ever shows the client using any
// of those.

import crypto from "node:crypto";

const WEBSOCKET_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Raw BitSwarm packets always start with the binary flag (PacketHeader's
// 0x80 bit, sfs-wire.ts's own encodePacket sets it unconditionally) - a
// byte value >= 0x80 can never be the first byte of a printable-ASCII HTTP
// request line ("GET ", "POST ", etc., all < 0x80). Cheap and reliable
// enough to distinguish the two on the same port without needing to peek
// further.
export function looksLikeHttpRequest(buf: Buffer): boolean {
  return buf.length > 0 && buf[0]! < 0x80;
}

// Returns null if the header block (terminated by \r\n\r\n) hasn't fully
// arrived yet - caller should keep buffering and retry.
export function tryHandleWebSocketHandshake(buf: Buffer): { response: string; consumed: number } | null {
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
  return { response, consumed: headerEnd + 4 };
}

// RFC 6455 frame decode - single-frame binary messages only (see module
// note above). Returns null if the frame hasn't fully arrived yet.
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

// RFC 6455 frame encode - a single unfragmented binary frame, unmasked
// (server-to-client frames must never be masked, per spec).
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
