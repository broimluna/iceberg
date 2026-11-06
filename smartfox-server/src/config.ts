// The client uses whatever the server sends in the handshake. The threshold
// is set high enough that the client never compresses, since inbound
// decompression isn't implemented.
export const PORT = Number(process.env.SFS_TCP_PORT ?? 9933);
export const COMPRESSION_THRESHOLD = 999_999_999;
export const MAX_MESSAGE_SIZE = 10_000_000;
export const JOIN_DELAY_MS = Number(process.env.SFS_JOIN_DELAY_MS ?? 0);

// Internal bridge to web-api. Both directions are localhost-only; the
// shared secret is an optional extra check.
export const WEBAPI_INTERNAL_URL = process.env.WEBAPI_INTERNAL_URL ?? "http://127.0.0.1:3000";
export const NOTIFY_PORT = Number(process.env.SFS_NOTIFY_PORT ?? 9339);
export const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET ?? "";
