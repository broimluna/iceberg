// Our own operational choices, not values extracted from the real client
// (nothing in the decompiled code sets a client-side default - see
// HandleHandShake in SmartFox2X.decompiled.cs, it only ever reads what
// the server sends). A huge compression threshold means the client will
// never bother compressing outgoing packets, which matters because this
// codec doesn't implement decompression yet.
export const PORT = Number(process.env.SFS_TCP_PORT ?? 9933);
export const COMPRESSION_THRESHOLD = 999_999_999;
export const MAX_MESSAGE_SIZE = 10_000_000;
export const JOIN_DELAY_MS = Number(process.env.SFS_JOIN_DELAY_MS ?? 0);

// Server-to-server wiring between this SFS2X server and the WebAPI
// (web-api/, default port 3000 per its own config.ts). Both directions are
// localhost-only by design (see webapi-client.ts/notify-listener.ts's own
// comments) - INTERNAL_API_SECRET is an optional extra check, not a
// requirement, since neither side is meant to be reachable off localhost
// at all.
export const WEBAPI_INTERNAL_URL = process.env.WEBAPI_INTERNAL_URL ?? "http://127.0.0.1:3000";
export const NOTIFY_PORT = Number(process.env.SFS_NOTIFY_PORT ?? 9339);
export const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET ?? "";
