// Password hashing for guest-controller accounts. PBKDF2-SHA512 at 210,000
// rounds (current OWASP guidance), run asynchronously so a login doesn't
// block the server. Stored as "pbkdf2-sha512$<rounds>$<salt>$<hash>".
// Older hashes ("<salt>:<hash>", 1,000 rounds) still verify and are
// upgraded on the next successful login.
import crypto from "node:crypto";
import { promisify } from "node:util";

const pbkdf2 = promisify(crypto.pbkdf2);
const ROUNDS = 210_000;
const LEGACY_ROUNDS = 1000;
export const MIN_PASSWORD = 6;
export const MAX_PASSWORD = 128;

export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = (await pbkdf2(password, salt, ROUNDS, 64, "sha512")).toString("hex");
    return `pbkdf2-sha512$${ROUNDS}$${salt}$${hash}`;
}

/** ok: the password matches; upgrade: it matched an older format that should be re-hashed. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<{ ok: boolean; upgrade: boolean }> {
    if (!stored || typeof password !== "string") return { ok: false, upgrade: false };
    let salt: string, expected: string, rounds: number, upgrade: boolean;
    const parts = stored.split("$");
    if (parts.length === 4 && parts[0] === "pbkdf2-sha512") {
        rounds = Number(parts[1]);
        [salt, expected] = [parts[2]!, parts[3]!];
        upgrade = rounds < ROUNDS;
    } else {
        const legacy = stored.split(":");
        if (legacy.length !== 2) return { ok: false, upgrade: false };
        [salt, expected] = [legacy[0]!, legacy[1]!];
        rounds = LEGACY_ROUNDS;
        upgrade = true;
    }
    if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10_000_000 || !salt || !/^[0-9a-f]+$/.test(expected)) {
        return { ok: false, upgrade: false };
    }
    const actual = await pbkdf2(password, salt, rounds, 64, "sha512");
    const want = Buffer.from(expected, "hex");
    const ok = want.length === actual.length && crypto.timingSafeEqual(want, actual);
    return { ok, upgrade: ok && upgrade };
}
