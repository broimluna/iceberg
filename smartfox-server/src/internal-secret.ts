// The shared secret for the internal bridge with web-api (POST /notify
// here, /api/internal/* there). Always required: INTERNAL_API_SECRET if
// set, otherwise one derived from the join signing key, which both servers
// already share. web-api/src/utils/internalSecret.ts is the same code.
import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { signingKey } from "./join-signature.ts";

let secret: string | null = null;
export function internalSecret(): string {
  return (secret ??= process.env.INTERNAL_API_SECRET
    || crypto.createHmac("sha256", signingKey()).update("iceberg internal api v1").digest("hex"));
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Loopback, not relayed by a reverse proxy, and carrying the secret. */
export function internalRequestStatus(req: IncomingMessage): 200 | 401 | 403 {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return 403;
  if (req.headers["x-forwarded-for"] !== undefined || req.headers["forwarded"] !== undefined || req.headers["x-real-ip"] !== undefined) return 403;
  const given = req.headers["x-internal-secret"];
  if (typeof given !== "string") return 401;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(internalSecret()).digest();
  return crypto.timingSafeEqual(a, b) ? 200 : 401;
}

/** Headers for calls to web-api's internal endpoints. */
export function internalHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "X-Internal-Secret": internalSecret() };
}
