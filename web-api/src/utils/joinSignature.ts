// Signs the joinRoomData SignedResponse that the client hands to the
// SmartFox server at login. smartfox-server/src/join-signature.ts checks
// it, so a player can't log into the realtime server as someone else by
// editing the swid (it used to trust the client and the signature was a
// constant).
//
// The signature is an HMAC-SHA256 over "swid|sessionId|room|goodUntil".
// Those four fields are what SmartFox relies on, and each one reads the
// same in both processes. sessionId is under 2^31, so JSON keeps it exact.
//
// Key: JOIN_SIGNING_KEY, or a random key kept in <repo>/.iceberg-join-key
// (git-ignored), created by whichever server starts first.
import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const KEY_FILE = path.resolve(import.meta.dir, "../../../.iceberg-join-key");

let key: string | null = null;
function signingKey(): string {
    if (key) return key;
    if (process.env.JOIN_SIGNING_KEY) return (key = process.env.JOIN_SIGNING_KEY);
    try {
        writeFileSync(KEY_FILE, crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    return (key = readFileSync(KEY_FILE, "utf8").trim());
}

export function signJoin(swid: string, sessionId: number | string, room: string, goodUntil: number): string {
    return crypto.createHmac("sha256", signingKey()).update(`${swid}|${sessionId}|${room}|${goodUntil}`).digest("base64url");
}
