// The shared secret for the internal bridge with smartfox-server
// (/api/internal/* here, POST /notify there). Always required:
// INTERNAL_API_SECRET if set, otherwise one derived from the join signing
// key, which both servers already share. smartfox-server/src/internal-secret.ts
// is the same code.
import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { signingKey } from "./joinSignature.ts";

let secret: string | null = null;
export function internalSecret(): string {
    return (secret ??= process.env.INTERNAL_API_SECRET
        || crypto.createHmac("sha256", signingKey()).update("iceberg internal api v1").digest("hex"));
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * A call from the other server: from loopback, not relayed by a reverse
 * proxy (a proxy on the same machine also connects from loopback), and
 * carrying the secret.
 */
export function isInternalRequest(req: IncomingMessage): boolean {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return false;
    if (req.headers["x-forwarded-for"] !== undefined || req.headers["forwarded"] !== undefined || req.headers["x-real-ip"] !== undefined) return false;
    const given = req.headers["x-internal-secret"];
    if (typeof given !== "string") return false;
    const a = crypto.createHash("sha256").update(given).digest();
    const b = crypto.createHash("sha256").update(internalSecret()).digest();
    return crypto.timingSafeEqual(a, b);
}
