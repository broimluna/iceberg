import net from "node:net";
import {
  tryReadHeader,
  decodePacketBody,
  detectProtocol,
  SFSDataType,
  type OutgoingPacket,
  type SFSObjectData,
} from "./sfs-wire.ts";
import {
  looksLikeHttpRequest,
  tryHandleWebSocketHandshake,
  tryReadWebSocketFrame,
  encodeWebSocketFrame,
} from "./websocket-transport.ts";
import { getSFSObject, describeValue } from "./wire-helpers.ts";
import { Session } from "./session.ts";
import type { HandlerContext } from "./handlers/context.ts";
import { handleHandshake } from "./handlers/sfs2x/handshake.ts";
import { handleLogin } from "./handlers/sfs2x/login.ts";
import { handlePingPong } from "./handlers/sfs2x/ping.ts";
import { handleSetUserVariables } from "./handlers/sfs2x/set-user-variables.ts";
import { findExtensionHandler } from "./handlers/registry.ts";
import { PORT } from "./config.ts";
import { register, unregister } from "./session-registry.ts";
import { startNotifyListener } from "./notify-listener.ts";
import { reportSessionEnded } from "./webapi-client.ts";
import { broadcastUserLeftRoom } from "./handlers/proximity.ts";
import { onPlayerLeft } from "./daily-tasks.ts";

// Per connection: detect the transport (raw BitSwarm or WebSocket) and the
// protocol (SFS2X or SFS3), frame packets, and dispatch them to system
// handlers (controller 0) or to extension commands (controller 1, action 13).
const connectionHandler = (socket: net.Socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[${new Date().toISOString()}] connection from ${peer}`);
  const session = new Session();
  let buffered = Buffer.alloc(0);
  // The retail client speaks raw BitSwarm TCP; the OpenCPI client speaks
  // WebSocket on the same port. The first bytes decide which.
  let transportMode: "unknown" | "raw" | "websocket" = "unknown";
  let handshakeBuffer = Buffer.alloc(0);
  let wsBuffered = Buffer.alloc(0);
  // Retail and older OpenCPI clients speak SFS2X; newer OpenCPI builds
  // speak SFS3. The first packet decides.
  let protocolDetected = false;

  function send(packet: OutgoingPacket) {
    const data = packet.encode(session.protocol);
    socket.write(transportMode === "websocket" ? encodeWebSocketFrame(data) : data);
  }
  const ctx: HandlerContext = { session, peer, send };

  function parseBufferedPackets() {
    if (!protocolDetected && buffered.length > 0) {
      session.protocol = detectProtocol(buffered[0]!);
      protocolDetected = true;
      console.log(`[${new Date().toISOString()}] ${peer} - speaks ${session.protocol === "sfs3" ? "SFS3" : "SFS2X"}`);
    }
    for (;;) {
      const header = tryReadHeader(buffered, session.protocol);
      if (!header || buffered.length < header.totalLength) break;
      const body = buffered.subarray(header.headerLength, header.totalLength);
      buffered = buffered.subarray(header.totalLength);

      // The handshake's compression threshold keeps clients from
      // compressing, and packet encryption is never negotiated.
      if (header.header.compressed || header.header.encrypted) {
        console.log(
          `[${new Date().toISOString()}] ${peer} - dropped a ${header.header.compressed ? "compressed" : "encrypted"} packet (not supported)`
        );
        continue;
      }

      let controllerId: number | undefined;
      let actionId: number | undefined;
      let params: SFSObjectData;
      try {
        ({ controllerId, actionId, params } = decodePacketBody(body, session.protocol));
      } catch (err) {
        console.log(`[${new Date().toISOString()}] ${peer} - failed to decode packet: ${(err as Error).message}`);
        console.log(body.toString("hex").match(/../g)?.join(" ") ?? "");
        continue;
      }

      console.log(
        `[${new Date().toISOString()}] ${peer} -> c=${controllerId} a=${actionId} p=${JSON.stringify(
          Object.fromEntries(Object.entries(params).map(([k, v]) => [k, describeValue(v)]))
        )}`
      );

      if (controllerId === 0 && actionId === 0) {
        handleHandshake(ctx);
      } else if (controllerId === 0 && actionId === 1) {
        handleLogin(params, ctx, socket);
        // Registered after login, once name, swid and room are known.
        register({ session, peer, send });
      } else if (controllerId === 0 && actionId === 29) {
        handlePingPong(ctx);
      } else if (controllerId === 0 && actionId === 12) {
        handleSetUserVariables(params, ctx);
      } else if (controllerId === 1 && actionId === 13) {
        const cmd = params["c"]?.type === SFSDataType.UTF_STRING ? params["c"].value : undefined;
        const handler = cmd ? findExtensionHandler(cmd) : undefined;
        if (handler) {
          handler(getSFSObject(params, "p"), ctx);
        } else {
          console.log(`[${new Date().toISOString()}] ${peer} - no handler for extension cmd "${cmd}", not responding`);
        }
      } else {
        console.log(`[${new Date().toISOString()}] ${peer} - no handler for c=${controllerId} a=${actionId}, not responding`);
      }
    }
  }

  function handleWebSocketBytes(chunk: Buffer) {
    wsBuffered = Buffer.concat([wsBuffered, chunk]);
    for (;;) {
      const frame = tryReadWebSocketFrame(wsBuffered);
      if (!frame) break;
      wsBuffered = wsBuffered.subarray(frame.consumed);
      buffered = Buffer.concat([buffered, frame.payload]);
    }
    parseBufferedPackets();
  }

  socket.on("data", (chunk: Buffer) => {
    if (transportMode === "unknown") {
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      if (!looksLikeHttpRequest(handshakeBuffer)) {
        transportMode = "raw";
        buffered = Buffer.concat([buffered, handshakeBuffer]);
        handshakeBuffer = Buffer.alloc(0);
        parseBufferedPackets();
        return;
      }
      let handshakeResult: ReturnType<typeof tryHandleWebSocketHandshake>;
      try {
        handshakeResult = tryHandleWebSocketHandshake(handshakeBuffer);
      } catch (err) {
        console.log(`[${new Date().toISOString()}] ${peer} - WebSocket handshake failed: ${(err as Error).message}`);
        socket.destroy();
        return;
      }
      if (!handshakeResult) {
        if (handshakeBuffer.length > 8192) {
          console.log(`[${new Date().toISOString()}] ${peer} - WebSocket handshake headers too large, closing`);
          socket.destroy();
        }
        return; // wait for the rest of the HTTP request headers to arrive
      }
      socket.write(handshakeResult.response);
      transportMode = "websocket";
      console.log(`[${new Date().toISOString()}] ${peer} - upgraded to WebSocket transport (OpenCPI-style client)`);
      const remainder = handshakeBuffer.subarray(handshakeResult.consumed);
      handshakeBuffer = Buffer.alloc(0);
      if (remainder.length > 0) handleWebSocketBytes(remainder);
      return;
    }
    if (transportMode === "websocket") {
      handleWebSocketBytes(chunk);
    } else {
      buffered = Buffer.concat([buffered, chunk]);
      parseBufferedPackets();
    }
  });

  socket.on("close", (hadError) => {
    unregister(session);
    onPlayerLeft(session);
    if (session.playerSessionId) void reportSessionEnded(session.playerSessionId);
    // Remove the avatar for everyone else in the room.
    broadcastUserLeftRoom(session.roomName, session);
    console.log(`[${new Date().toISOString()}] ${peer} closed (error=${hadError})`);
  });

  socket.on("error", (err) => {
    console.log(`[${new Date().toISOString()}] ${peer} socket error: ${err.message}`);
  });
};

// Listens on PORT (9933, the port clients are told to use), 8080 and 8088.
// For local, unencrypted servers the OpenCPI client connects to its
// HttpPort setting instead of the real port: that defaults to 8080 in the
// SFS2X client API and 8088 in the SFS3 one.
export function startServer(): void {
  for (const port of [PORT, 8080, 8088]) {
    const server = net.createServer(connectionHandler);
    server.on("error", (err) => {
      // Only PORT failing is fatal; something else (e.g. a real SFS2X or
      // SFS3 install) may already hold 8080 or 8088.
      console.error(`listener error on port ${port}: ${err.message}`);
      if (port === PORT) process.exit(1);
    });
    server.listen(port, () => {
      console.log(`SFS server (SFS2X + SFS3) listening on tcp:${port}`);
    });
  }
  startNotifyListener();
}
