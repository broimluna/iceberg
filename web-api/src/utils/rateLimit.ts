// Per-address rate limits for unauthenticated endpoints (login,
// registration, API-key creation). A fixed window per address, in memory.
// Limits come from the environment; 0 turns one off.
//
// Behind reverse proxies set TRUST_PROXY to how many there are. Each proxy
// appends the address it received from to X-Forwarded-For, so the client's
// real address is that many entries from the right; anything further left
// was written by the client and is ignored.
import type { Request, Response, NextFunction } from "express";

const MAX_TRACKED = 50_000;

/** The address a request counts against: IPv4, or an IPv6 /64 (one host's usual allocation). */
export function clientAddress(req: Request): string {
    let address = req.socket.remoteAddress ?? "?";
    const hops = Number(process.env.TRUST_PROXY ?? 0);
    if (Number.isInteger(hops) && hops > 0) {
        const header = req.headers["x-forwarded-for"];
        const entries = (Array.isArray(header) ? header.join(",") : header ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (entries.length >= hops) address = entries[entries.length - hops]!;
    }
    if (address.startsWith("::ffff:") && address.includes(".")) return address.slice(7);
    if (address.includes(":")) return ipv6Prefix64(address);
    return address;
}

function ipv6Prefix64(address: string): string {
    const [head = "", tail = ""] = address.split("::");
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const groups = address.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
    return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

export function rateLimit(opts: { name: string; envVar: string; defaultLimit: number; windowMs: number; onLimited: (res: Response) => void }) {
    const fromEnv = process.env[opts.envVar];
    const limit = fromEnv === undefined || fromEnv === "" ? opts.defaultLimit : Number(fromEnv);
    // Insertion-ordered, so the first key is the oldest window.
    const hits = new Map<string, { count: number; resetAt: number }>();
    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }, Math.min(opts.windowMs, 60_000));
    sweep.unref?.();

    const middleware = (req: Request, res: Response, next: NextFunction) => {
        if (!(limit > 0)) return next();
        const now = Date.now();
        const key = clientAddress(req);
        let entry = hits.get(key);
        if (!entry || entry.resetAt <= now) {
            hits.delete(key);
            // Full: drop the oldest window rather than grow without bound.
            if (hits.size >= MAX_TRACKED) hits.delete(hits.keys().next().value!);
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
    return Object.assign(middleware, { size: () => hits.size });
}

/**
 * Failed logins per account, whatever address they come from, so many
 * addresses can't share one account's guesses. AUTH_ACCOUNT_FAILS_PER_15MIN
 * (default 10, 0 = off) failures lock the account's logins until the
 * window ends.
 */
export function accountFailureLimit() {
    const fromEnv = process.env.AUTH_ACCOUNT_FAILS_PER_15MIN;
    const limit = fromEnv === undefined || fromEnv === "" ? 10 : Number(fromEnv);
    const windowMs = 15 * 60_000;
    const fails = new Map<string, { count: number; resetAt: number }>();
    const live = (key: string) => {
        const e = fails.get(key);
        if (e && e.resetAt <= Date.now()) { fails.delete(key); return undefined; }
        return e;
    };
    return {
        locked: (key: string) => limit > 0 && (live(key)?.count ?? 0) >= limit,
        fail: (key: string) => {
            if (!(limit > 0)) return;
            const e = live(key);
            if (e) e.count++;
            else {
                if (fails.size >= MAX_TRACKED) fails.delete(fails.keys().next().value!);
                fails.set(key, { count: 1, resetAt: Date.now() + windowMs });
            }
        },
    };
}

