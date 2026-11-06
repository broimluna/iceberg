import net from "node:net";
import {
  tryReadHeader,
  decodeSFSObject,
  SFSDataType,
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
import { extensionHandlers } from "./handlers/registry.ts";
import { PORT } from "./config.ts";
import { register, unregister } from "./session-registry.ts";
import { startNotifyListener } from "./notify-listener.ts";
import { broadcastUserLeftRoom } from "./handlers/proximity.ts";

// Per-connection setup: transport detection (raw BitSwarm vs WebSocket),
// packet framing/buffering, and dispatch into the c=0 system handlers or
// the c=1/a=13 extension command registry. Behavior here is unchanged
// from this project's original single-file version - only the per-command
// bodies moved out to handlers/.
const connectionHandler = (socket: net.Socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[${new Date().toISOString()}] connection from ${peer}`);
  const session = new Session();
  let buffered = Buffer.alloc(0);
  // Dual transport support - see websocket-transport.ts's module comment
  // for why: the retail client speaks raw BitSwarm TCP
  // directly, OpenCPI's client unconditionally speaks WebSocket-Binary
  // instead (same host/port, different outer framing). `transportMode`
  // starts undetermined and gets pinned to whichever one the first bytes
  // of the connection look like.
  let transportMode: "unknown" | "raw" | "websocket" = "unknown";
  let handshakeBuffer = Buffer.alloc(0);
  let wsBuffered = Buffer.alloc(0);

  function send(data: Buffer) {
    socket.write(transportMode === "websocket" ? encodeWebSocketFrame(data) : data);
  }
  const ctx: HandlerContext = { session, peer, send };

  function parseBufferedPackets() {
    for (;;) {
      const header = tryReadHeader(buffered);
      if (!header || buffered.length < header.totalLength) break;
      const body = buffered.subarray(header.headerLength, header.totalLength);
      buffered = buffered.subarray(header.totalLength);

      let envelope: SFSObjectData;
      try {
        envelope = decodeSFSObject(body, 0).value;
      } catch (err) {
        console.log(`[${new Date().toISOString()}] ${peer} - failed to decode packet: ${(err as Error).message}`);
        console.log(body.toString("hex").match(/../g)?.join(" ") ?? "");
        continue;
      }

      const controllerId = envelope["c"]?.value;
      const actionId = envelope["a"]?.value;
      const params = envelope["p"]?.type === SFSDataType.SFS_OBJECT ? envelope["p"].value : {};
      console.log(
        `[${new Date().toISOString()}] ${peer} -> c=${controllerId} a=${actionId} p=${JSON.stringify(
          Object.fromEntries(Object.entries(params).map(([k, v]) => [k, describeValue(v)]))
        )}`
      );

      if (controllerId === 0 && actionId === 0) {
        handleHandshake(ctx);
      } else if (controllerId === 0 && actionId === 1) {
        handleLogin(params, ctx, socket);
        // Session registry (room registry + reward integrity pass,
        // 2026-09-17 plan) - registered right after Login populates
        // session.userName/swid/roomName, not at connection-open, since
        // those fields don't exist yet before this point.
        register({ session, peer, send });
      } else if (controllerId === 0 && actionId === 29) {
        handlePingPong(ctx);
      } else if (controllerId === 0 && actionId === 12) {
        handleSetUserVariables(params, ctx);
      } else if (controllerId === 1 && actionId === 13) {
        const cmd = params["c"]?.type === SFSDataType.UTF_STRING ? params["c"].value : undefined;
        const handler = cmd ? extensionHandlers[cmd] : undefined;
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
      // Undetermined until the first bytes arrive - see websocket-transport.ts's
      // module comment for why both are real, live-confirmed possibilities on
      // this exact port (retail raw BitSwarm vs OpenCPI's WebSocket-Binary).
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
    // Companion to handlers/proximity.ts's join notifications - without
    // this, once join/movement visibility works, a disconnected player
    // leaves a permanent ghost avatar for everyone else in the room
    // (nothing else ever sends action-30's "m" field). No-op for a session
    // that never joined a room or was alone in it.
    broadcastUserLeftRoom(session.roomName, session);
    console.log(`[${new Date().toISOString()}] ${peer} closed (error=${hadError})`);
  });

  socket.on("error", (err) => {
    console.log(`[${new Date().toISOString()}] ${peer} socket error: ${err.message}`);
  });
};

// Listens on two ports with the identical connection handler (transport
// detection already happens per-connection, so nothing else here needs to
// know which port a given socket arrived on). PORT (9933) is the real,
// decompiled-and-confirmed tcpPort value every client so far actually
// sends in its own JoinRoomData (retail, OpenCPI). 8080 is added
// specifically to work around a confirmed bug in OpenCPI's own compiled
// client: `SmartFoxGameServerClientShared.cs:649` unconditionally
// overwrites the correct `serverTcpPort` with `configData.HttpPort`
// (default 8080, never otherwise set) whenever the target host is
// recognized as local (`UseEncryption` false) - so OpenCPI's client will
// always try to connect to *that* port instead of the real one for any
// unencrypted local server. Not something fixable from our side short of
// also listening where its bug sends it.
export function startServer(): void {
  for (const port of [PORT, 8080]) {
    const server = net.createServer(connectionHandler);
    server.on("error", (err) => {
      // Only PORT (9933, the real protocol port) failing to bind is fatal -
      // 8080 is just the OpenCPI-bug workaround (see comment above); if
      // something else already holds it (e.g. a real SFS2X install's own
      // Tomcat/AdminTool service, encountered live 2026-09-17 while
      // diagnosing a login hang), that shouldn't take down the whole
      // server, just mean OpenCPI clients specifically can't connect.
      console.error(`listener error on port ${port}: ${err.message}`);
      if (port === PORT) process.exit(1);
    });
    server.listen(port, () => {
      console.log(`SFS2X server listening on tcp:${port}`);
    });
  }
  startNotifyListener();
}
