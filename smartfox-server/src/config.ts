// The client uses whatever the server sends in the handshake. The threshold
// is set high enough that the client never compresses, since inbound
// decompression isn't implemented.
export const PORT = Number(process.env.SFS_TCP_PORT ?? 9933);
export const COMPRESSION_THRESHOLD = 999_999_999;
// Largest packet a client may send (and the "ms" the handshake
// advertises). Real logins are far smaller; raise SFS_MAX_MESSAGE_SIZE
// only if a large player's login is refused for size.
export const MAX_MESSAGE_SIZE = Number(process.env.SFS_MAX_MESSAGE_SIZE ?? 1_000_000);
export const JOIN_DELAY_MS = Number(process.env.SFS_JOIN_DELAY_MS ?? 0);

// Internal bridge to web-api: localhost only, with the shared secret from
// internal-secret.ts.
export const WEBAPI_INTERNAL_URL = process.env.WEBAPI_INTERNAL_URL ?? "http://127.0.0.1:3000";
export const NOTIFY_PORT = Number(process.env.SFS_NOTIFY_PORT ?? 9339);
// Address the game ports listen on (all interfaces by default).
// 127.0.0.1 when clients only arrive through a reverse proxy on this machine.
export const BIND_HOST = process.env.SFS_BIND_HOST || undefined;

// Input limits (see server.ts). A client that exceeds one is disconnected.
// A packet (raw frame or WebSocket frame) may not exceed MAX_MESSAGE_SIZE,
// the same limit the handshake advertises. 0 turns the packet-rate or
// per-IP limit off: set SFS_MAX_CONNECTIONS_PER_IP=0 when clients reach
// this server through a proxy, since they'd all share its address.
export const MAX_PACKETS_PER_SEC = Number(process.env.SFS_MAX_PACKETS_PER_SEC ?? 100);
export const MAX_CONNECTIONS_PER_IP = Number(process.env.SFS_MAX_CONNECTIONS_PER_IP ?? 16);
// Connections that don't log in within SFS_LOGIN_TIMEOUT_MS, and logged-in
// ones that send nothing for SFS_IDLE_TIMEOUT_MS, are closed. Clients ping
// every 4 seconds once logged in (the lag monitor), so an idle player is
// never affected, only a client that has gone away. SFS_MAX_CONNECTIONS
// caps logged-in players; SFS_MAX_CONNECTS_PER_IP_PER_MIN caps how fast one
// address may open connections. 0 turns any of these off. Behind a proxy
// every client shares the proxy's address: turn the per-address limits off.
export const LOGIN_TIMEOUT_MS = Number(process.env.SFS_LOGIN_TIMEOUT_MS ?? 10_000);
export const IDLE_TIMEOUT_MS = Number(process.env.SFS_IDLE_TIMEOUT_MS ?? 120_000);
export const MAX_CONNECTIONS = Number(process.env.SFS_MAX_CONNECTIONS ?? 2000);
// Connections still logging in are kept apart from the cap above, in a pool
// of their own; when it's full the busiest address's oldest gives way, so a flood of
// connections that never log in can't keep real players out.
export const MAX_PENDING_LOGINS = Number(process.env.SFS_MAX_PENDING_LOGINS ?? 200);
export const MAX_CONNECTS_PER_IP_PER_MIN = Number(process.env.SFS_MAX_CONNECTS_PER_IP_PER_MIN ?? 60);
// Reverse proxies in front of the WebSocket ports (e.g. 1 for Caddy or
// nginx). For WebSocket connections from loopback, the per-address limits
// then use the client address from X-Forwarded-For. 0 (default): off.
export const TRUST_PROXY = Number(process.env.SFS_TRUST_PROXY ?? 0);
// Development only: accept joinRoomData without a valid web API signature.
export const ALLOW_UNSIGNED_LOGIN = process.env.SFS_ALLOW_UNSIGNED_LOGIN === "1";

// Exit code that asks the supervisor (supervisor.ts) to start the server
// again after an admin's :admin-swre-restart. Without a supervisor the server stops.
export const RESTART_EXIT_CODE = 75;
