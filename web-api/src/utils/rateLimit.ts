// Per-address rate limits for unauthenticated endpoints (login,
// registration, API-key creation). A fixed window per address, in memory.
// Limits come from the environment; 0 turns one off. Behind a reverse proxy
// set TRUST_PROXY=1 so the client's address is read from X-Forwarded-For
// (otherwise every request would share the proxy's).
import type { Request, Response, NextFunction } from "express";

export function clientAddress(req: Request): string {
    if (process.env.TRUST_PROXY === "1") {
        const forwarded = req.headers["x-forwarded-for"];
        const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
        if (first) return first;
    }
    return req.socket.remoteAddress ?? "?";
}

export function rateLimit(opts: { name: string; envVar: string; defaultLimit: number; windowMs: number; onLimited: (res: Response) => void }) {
    const fromEnv = process.env[opts.envVar];
    const limit = fromEnv === undefined || fromEnv === "" ? opts.defaultLimit : Number(fromEnv);
    const hits = new Map<string, { count: number; resetAt: number }>();
    return (req: Request, res: Response, next: NextFunction) => {
        if (!(limit > 0)) return next();
        const now = Date.now();
        const key = clientAddress(req);
        let entry = hits.get(key);
        if (!entry || entry.resetAt <= now) {
            // Forget finished windows now and then so the map stays small.
            if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
            entry = { count: 0, resetAt: now + opts.windowMs };
            hits.set(key, entry);
        }
        if (++entry.count > limit) {
            console.log(`[RATE-LIMIT] ${opts.name}: ${key} over ${limit} per ${opts.windowMs / 1000}s`);
            res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
            return opts.onLimited(res);
        }
        next();
    };
}
