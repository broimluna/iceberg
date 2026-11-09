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
import { PORT, MAX_MESSAGE_SIZE, MAX_PACKETS_PER_SEC, MAX_CONNECTIONS_PER_IP, LOGIN_TIMEOUT_MS, IDLE_TIMEOUT_MS, MAX_CONNECTIONS, MAX_CONNECTS_PER_IP_PER_MIN, MAX_PENDING_LOGINS, BIND_HOST, TRUST_PROXY } from "./config.ts";
import { addressKey, forwardedClient } from "./net-address.ts";
import { PendingPool } from "./pending-pool.ts";
import { register, unregister } from "./session-registry.ts";
import { resolveIdentity } from "./account.ts";
import { startNotifyListener } from "./notify-listener.ts";
import { reportSessionEnded } from "./webapi-client.ts";
import { broadcastUserLeftRoom } from "./handlers/proximity.ts";
import { onPlayerLeft } from "./daily-tasks.ts";
import { onPartyGamePlayerLeft } from "./party-games/manager.ts";
import { forgetInvitation } from "./handlers/consumables.ts";
import { releaseRoomIfEmpty } from "./world-objects.ts";
import { forgetIslandTargetThrower, releaseRoomPlaygroundsIfEmpty } from "./island-targets/playground.ts";
import { onLobbyPlayerLeft, releaseRoomLobbiesIfEmpty } from "./party-games/lobby.ts";
import { logSafe } from "./log-safe.ts";

// Open connections per remote address, for MAX_CONNECTIONS_PER_IP.
const connectionsByIp = new Map<string, number>();
// Logged-in players, for MAX_CONNECTIONS, and connections still logging in,
// oldest first, for MAX_PENDING_LOGINS.
let loggedInCount = 0;
const pendingLogins = new PendingPool<net.Socket>(MAX_PENDING_LOGINS);
// New connections per address in the current minute, for
// MAX_CONNECTS_PER_IP_PER_MIN. Cleared every minute, so it stays small.
let connectsThisMinute = new Map<string, number>();
setInterval(() => { connectsThisMinute = new Map(); }, 60_000).unref();

// Per connection: detect the transport (raw BitSwarm or WebSocket) and the
// protocol (SFS2X or SFS3), frame packets, and dispatch them to system
// handlers (controller 0) or to extension commands (controller 1, action 13).
//
// Input limits (reported with WPE Pro): a packet may not exceed
// MAX_MESSAGE_SIZE, unparsed input may not grow past it, a connection may
// send at most MAX_PACKETS_PER_SEC packets per second, and one address may
// hold at most MAX_CONNECTIONS_PER_IP connections. Breaking a limit closes
// the connection. Before this, a client could make the receive buffer grow
// without bound until the process ran out of memory.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const connectionHandler = (socket: net.Socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  // Counts the connection against an address and applies the per-address
  // limits; false if it was closed. Behind a trusted proxy the address is
  // only known once the WebSocket upgrade arrives, so admission waits for
  // it (the login timeout still runs meanwhile).
  let ip: string | undefined;
  const admit = (key: string): boolean => {
    ip = key;
    const openFromIp = (connectionsByIp.get(key) ?? 0) + 1;
    connectionsByIp.set(key, openFromIp);
    const connectsFromIp = (connectsThisMinute.get(key) ?? 0) + 1;
    connectsThisMinute.set(key, connectsFromIp);
    if (MAX_CONNECTS_PER_IP_PER_MIN > 0 && connectsFromIp > MAX_CONNECTS_PER_IP_PER_MIN) {
      if (connectsFromIp === MAX_CONNECTS_PER_IP_PER_MIN + 1) {
        console.log(`[${new Date().toISOString()}] ${peer} - over ${MAX_CONNECTS_PER_IP_PER_MIN} new connections a minute from ${key}, closing (further ones this minute aren't logged)`);
      }
      socket.destroy();
      return false;
    }
    if (MAX_CONNECTIONS_PER_IP > 0 && openFromIp > MAX_CONNECTIONS_PER_IP) {
      console.log(`[${new Date().toISOString()}] ${peer} - over ${MAX_CONNECTIONS_PER_IP} connections from ${key}, closing`);
      socket.destroy();
      return false;
    }
    const evicted = pendingLogins.add(socket, key);
    if (evicted) {
      console.log(`[${new Date().toISOString()}] ${evicted.remoteAddress}:${evicted.remotePort} - over ${MAX_PENDING_LOGINS} connections waiting to log in, closing the oldest from the busiest address`);
      evicted.destroy();
    }
    return !socket.destroyed;
  };
  socket.once("close", () => {
    pendingLogins.remove(socket);
    if (ip === undefined) return;
    const n = (connectionsByIp.get(ip) ?? 1) - 1;
    if (n <= 0) connectionsByIp.delete(ip);
    else connectionsByIp.set(ip, n);
  });
  const viaProxy = TRUST_PROXY > 0 && LOOPBACK.has(socket.remoteAddress ?? "");
  if (!viaProxy && !admit(addressKey(socket.remoteAddress))) return;
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
  // One login per connection, like SFS2X; a repeat is ignored.
  let loggedIn = false;
  // Packets in the current one-second window.
  let windowStart = Date.now();
  let packetsInWindow = 0;
  let closing = false;
  // Login deadline, then the idle check (see LOGIN_TIMEOUT_MS in config.ts).
  let lastInbound = Date.now();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const watch = (ms: number, why: string, stillDue: () => number) => {
    if (!(ms > 0)) return;
    watchdog = setTimeout(function fire() {
      const left = stillDue();
      if (left > 0) { watchdog = setTimeout(fire, left); return; }
      console.log(`[${new Date().toISOString()}] ${peer} - ${why}, closing`);
      socket.destroy();
    }, ms);
  };
  watch(LOGIN_TIMEOUT_MS, `no login within ${LOGIN_TIMEOUT_MS} ms`, () => 0);
  socket.once("close", () => clearTimeout(watchdog));

  function dropConnection(reason: string) {
    if (closing) return;
    closing = true;
    console.log(`[${new Date().toISOString()}] ${peer} - ${reason}, closing`);
    buffered = Buffer.alloc(0);
    wsBuffered = Buffer.alloc(0);
    socket.destroy();
  }

  // A packet that can't be encoded for this recipient (e.g. an echoed
  // SFSObject key too long for SFS3) is skipped for them, not thrown into
  // the sender's handler.
  function send(packet: OutgoingPacket) {
    let data: Buffer;
    try {
      data = packet.encode(session.protocol);
    } catch (err) {
      console.log(
        `[${new Date().toISOString()}] ${peer} - couldn't encode c=${packet.controllerId} a=${packet.actionId}, not sent: ${(err as Error).message}`
      );
      return;
    }
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
      if (closing) return;
      const header = tryReadHeader(buffered, session.protocol);
      if (header && header.bodyLength > MAX_MESSAGE_SIZE) {
        dropConnection(`packet claims ${header.bodyLength} bytes (max ${MAX_MESSAGE_SIZE})`);
        return;
      }
      if (!header || buffered.length < header.totalLength) break;
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        packetsInWindow = 0;
      }
      if (++packetsInWindow > MAX_PACKETS_PER_SEC && MAX_PACKETS_PER_SEC > 0) {
        dropConnection(`more than ${MAX_PACKETS_PER_SEC} packets in one second`);
        return;
      }
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
        // At most the first 256 bytes: a junk packet may be megabytes.
        console.log(body.subarray(0, 256).toString("hex").match(/../g)?.join(" ") ?? "");
        continue;
      }

      console.log(
        `[${new Date().toISOString()}] ${peer} -> c=${controllerId} a=${actionId} p=${logSafe(
          Object.fromEntries(Object.entries(params).map(([k, v]) => [k, describeValue(v)])), 600
        )}`
      );

      // One bad packet must not take the whole server down.
      try {
        dispatch(controllerId, actionId, params);
      } catch (err) {
        console.log(
          `[${new Date().toISOString()}] ${peer} - handler for c=${controllerId} a=${actionId} threw: ${(err as Error).stack ?? err}`
        );
      }
    }
  }

  function dispatch(controllerId: number | undefined, actionId: number | undefined, params: SFSObjectData) {
    if (controllerId === 0 && actionId === 0) {
      handleHandshake(ctx);
    } else if (controllerId === 0 && actionId === 1) {
      if (loggedIn) {
        console.log(`[${new Date().toISOString()}] ${peer} - already logged in, ignoring another login`);
        return;
      }
      if (MAX_CONNECTIONS > 0 && loggedInCount >= MAX_CONNECTIONS) {
        console.log(`[${new Date().toISOString()}] ${peer} - ${MAX_CONNECTIONS} players already online, closing`);
        socket.destroy();
        return;
      }
      if (!handleLogin(params, ctx, socket)) return;
      loggedIn = true;
      pendingLogins.remove(socket);
      loggedInCount++;
      socket.once("close", () => loggedInCount--);
      clearTimeout(watchdog);
      watch(IDLE_TIMEOUT_MS, `nothing received for ${IDLE_TIMEOUT_MS} ms`, () => lastInbound + IDLE_TIMEOUT_MS - Date.now());
      // Registered after login, once name, swid and room are known.
      register({ session, peer, send, close: () => socket.destroy() });
      resolveIdentity(session, peer);
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
        console.log(`[${new Date().toISOString()}] ${peer} - no handler for extension cmd ${logSafe(cmd)}, not responding`);
      }
    } else {
      console.log(`[${new Date().toISOString()}] ${peer} - no handler for c=${controllerId} a=${actionId}, not responding`);
    }
  }

  // Unparsed input never needs more room than one maximal packet plus its
  // header (raw: 5 bytes, WebSocket: 14).
  const overLimit = (buf: Buffer, header: number) => buf.length > MAX_MESSAGE_SIZE + header;

  function handleWebSocketBytes(chunk: Buffer) {
    if (closing) return;
    wsBuffered = Buffer.concat([wsBuffered, chunk]);
    if (overLimit(wsBuffered, 14)) {
      dropConnection(`over ${MAX_MESSAGE_SIZE} bytes of unparsed WebSocket input`);
      return;
    }
    for (;;) {
      const frame = tryReadWebSocketFrame(wsBuffered);
      if (!frame) break;
      wsBuffered = wsBuffered.subarray(frame.consumed);
      buffered = Buffer.concat([buffered, frame.payload]);
      if (overLimit(buffered, 5)) {
        dropConnection(`over ${MAX_MESSAGE_SIZE} bytes of unparsed input`);
        return;
      }
    }
    parseBufferedPackets();
  }

  socket.on("data", (chunk: Buffer) => {
    if (closing) return;
    lastInbound = Date.now();
    if (transportMode === "unknown") {
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      if (!looksLikeHttpRequest(handshakeBuffer)) {
        transportMode = "raw";
        if (viaProxy && !admit(addressKey(socket.remoteAddress))) return;
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
      if (viaProxy && !admit(addressKey(forwardedClient(handshakeResult.headerText, TRUST_PROXY) ?? socket.remoteAddress))) return;
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
      if (overLimit(buffered, 5)) {
        dropConnection(`over ${MAX_MESSAGE_SIZE} bytes of unparsed input`);
        return;
      }
      parseBufferedPackets();
    }
  });

  socket.on("close", (hadError) => {
    unregister(session);
    onLobbyPlayerLeft(session);
    onPartyGamePlayerLeft(session);
    forgetInvitation(session);
    onPlayerLeft(session);
    if (session.playerSessionId) void reportSessionEnded(session.playerSessionId);
    // Remove the avatar for everyone else in the room.
    broadcastUserLeftRoom(session.roomName, session);
    // Last one out stops the room's geyser/light timers.
    releaseRoomIfEmpty(session.roomName);
    releaseRoomLobbiesIfEmpty(session.roomName);
    forgetIslandTargetThrower(session);
    releaseRoomPlaygroundsIfEmpty(session.roomName);
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
    server.listen(port, BIND_HOST, () => {
      console.log(`SFS server (SFS2X + SFS3) listening on ${BIND_HOST ?? "*"}:${port}`);
    });
  }
  startNotifyListener();
}
