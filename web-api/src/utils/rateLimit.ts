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
 * AUTH_ACCOUNT_FAILS_PER_15MIN failures (default 10, 0 = off) the account is
 * locked until the 15-minute window ends, except for addresses that have
 * logged into it before, so a lock can't keep the owner out. A known
 * address that then fails as often as the limit loses that standing (a
 * shared address, like a school's, isn't a free pass).
 *
 * begin() reserves an attempt before the (slow) password check, so guesses
 * sent all at once can't get past the limit; done() records the result and
 * must always be called. Locked accounts live in their own table and are
 * only removed when they expire; the table of unlocked counts drops its
 * oldest entry when full.
 */
export function accountFailureLimit() {
    const fromEnv = process.env.AUTH_ACCOUNT_FAILS_PER_15MIN;
    const limit = fromEnv === undefined || fromEnv === "" ? 10 : Number(fromEnv);
    const windowMs = 15 * 60_000;
    const KNOWN_PER_ACCOUNT = 5;
    const counts = new Map<string, { fails: number; inFlight: number; resetAt: number }>();
    const locked = new Map<string, number>(); // account -> lock end
    // account -> address -> failures since it last logged in, plus attempts in flight
    const known = new Map<string, Map<string, { fails: number; inFlight: number }>>();
    const noop = { done: () => {} };

    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [k, until] of locked) if (until <= now) locked.delete(k);
        for (const [k, e] of counts) if (e.resetAt <= now && e.inFlight === 0) counts.delete(k);
    }, 60_000);
    sweep.unref?.();

    const isLocked = (key: string) => {
        const until = locked.get(key);
        if (until === undefined) return false;
        if (until <= Date.now()) { locked.delete(key); return false; }
        return true;
    };
    const countFor = (key: string) => {
        let e = counts.get(key);
        if (e && e.resetAt <= Date.now() && e.inFlight === 0) { counts.delete(key); e = undefined; }
        if (!e) {
            if (counts.size >= MAX_TRACKED) {
                // Drop the entry with the fewest failures among the oldest
                // (entries exist only for real accounts, so filling the
                // table takes that many accounts).
                let victim: string | undefined, fewest = Infinity, scanned = 0;
                for (const [k, old] of counts) {
                    if (++scanned > 100) break;
                    if (old.inFlight === 0 && old.fails < fewest) { victim = k; fewest = old.fails; if (fewest === 0) break; }
                }
                if (victim !== undefined) counts.delete(victim);
            }
            e = { fails: 0, inFlight: 0, resetAt: Date.now() + windowMs };
            counts.set(key, e);
        }
        return e;
    };

    return {
        /** null when this address may not try this account now; otherwise call done(ok) after checking the password. */
        begin(key: string, address: string): { done: (ok: boolean) => void } | null {
            if (!(limit > 0)) return noop;
            const standing = known.get(key)?.get(address);
            const isKnown = standing !== undefined && standing.fails + standing.inFlight < limit;
            const e = countFor(key);
            if (!isKnown && (isLocked(key) || e.fails + e.inFlight >= limit)) return null;
            e.inFlight++;
            if (isKnown) standing!.inFlight++;
            let finished = false;
            return {
                done(ok: boolean) {
                    if (finished) return;
                    finished = true;
                    e.inFlight--;
                    if (isKnown) standing!.inFlight--;
                    if (ok) {
                        let set = known.get(key);
                        if (!set) {
                            if (known.size >= MAX_TRACKED) known.delete(known.keys().next().value!);
                            known.set(key, (set = new Map()));
                        }
                        set.delete(address);
                        set.set(address, { fails: 0, inFlight: 0 });
                        if (set.size > KNOWN_PER_ACCOUNT) set.delete(set.keys().next().value!);
                        return;
                    }
                    e.fails++;
                    if (e.fails >= limit && !locked.has(key)) locked.set(key, e.resetAt);
                    if (isKnown) standing!.fails++;
                },
            };
        },
    };
}
