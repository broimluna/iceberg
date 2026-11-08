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
 * addresses can't share one account's guesses. After
 * AUTH_ACCOUNT_FAILS_PER_15MIN failures (default 10, 0 = off) the account's
 * logins are refused until the 15-minute window ends, except from addresses
 * that have logged into it before, so a lock can't keep the owner out.
 *
 * begin() reserves an attempt before the (slow) password check, so guesses
 * sent all at once can't get past the limit; done() records the result.
 * Locked accounts are never dropped from the table; if it fills with them,
 * new attempts are refused rather than a lock forgotten.
 */
export function accountFailureLimit() {
    const fromEnv = process.env.AUTH_ACCOUNT_FAILS_PER_15MIN;
    const limit = fromEnv === undefined || fromEnv === "" ? 10 : Number(fromEnv);
    const windowMs = 15 * 60_000;
    const entries = new Map<string, { fails: number; inFlight: number; resetAt: number }>();
    const knownAddresses = new Map<string, Set<string>>();
    const KNOWN_PER_ACCOUNT = 5;

    const live = (key: string) => {
        const e = entries.get(key);
        if (e && e.resetAt <= Date.now() && e.inFlight === 0) { entries.delete(key); return undefined; }
        return e;
    };
    // Room for one more account: drop an expired or unlocked entry, oldest first.
    const makeRoom = (): boolean => {
        if (entries.size < MAX_TRACKED) return true;
        let scanned = 0;
        for (const [k, e] of entries) {
            if (++scanned > 1000) break;
            if ((e.resetAt <= Date.now() || e.fails < limit) && e.inFlight === 0) { entries.delete(k); return true; }
        }
        return false;
    };

    return {
        /** null when the account is locked for this address; otherwise call done(ok) after checking the password. */
        begin(key: string, address: string): { done: (ok: boolean) => void } | null {
            if (!(limit > 0)) return { done: () => {} };
            const known = knownAddresses.get(key)?.has(address) ?? false;
            let e = live(key);
            if (!e) {
                if (!makeRoom()) return known ? { done: () => {} } : null;
                e = { fails: 0, inFlight: 0, resetAt: Date.now() + windowMs };
                entries.set(key, e);
            }
            if (!known && e.fails + e.inFlight >= limit) return null;
            const entry = e;
            entry.inFlight++;
            return {
                done(ok: boolean) {
                    entry.inFlight--;
                    if (!ok) { entry.fails++; return; }
                    let set = knownAddresses.get(key);
                    if (!set) {
                        if (knownAddresses.size >= MAX_TRACKED) knownAddresses.delete(knownAddresses.keys().next().value!);
                        knownAddresses.set(key, (set = new Set()));
                    }
                    set.add(address);
                    if (set.size > KNOWN_PER_ACCOUNT) set.delete(set.values().next().value!);
                },
            };
        },
    };
}
