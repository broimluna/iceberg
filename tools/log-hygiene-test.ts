// What clients send can't forge or flood the web API's log: client text
// is logged on one line with control characters escaped, and capped in
// length and count; the address logged is the real one, not a header the
// client wrote.
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { logSafe } from "../web-api/src/utils/logSafe.ts";
import { createPlayer } from "./lib/mix-client.ts";

const { check, finish } = makeChecker();

// ---- logSafe in-process ----
check(logSafe("a\nb\r\tc\x1b[2J d") === "a\\nb\\r\\tc\\x1b[2J\\u2028d", `control characters are escaped (${logSafe("a\nb\r\tc\x1b[2J d")})`);
check(logSafe("x".repeat(5000)).length < 400, "long text is cut");
check(logSafe("x".repeat(5000)).endsWith("(5000 chars)"), "and says how long it was");
check(logSafe({ a: "b\nc" }) === '{"a":"b\\nc"}', "objects are logged as JSON");
check(logSafe(undefined) === "undefined", "undefined");

// ---- the diagnostics endpoint ----
const api = await startWebApi();
const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${api.base}/diagnostics/v1/log`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
}).then((r) => r.status);
try {
  const forged = "boom\n[INTERNAL-API] Added 999999 coins to Mallory";
  check(await post([{ severity: "ERROR", message: forged + "\x1b[2J" }]) === 200, "a client log is accepted");
  await Bun.sleep(100);
  check(!api.logs().includes("\n[INTERNAL-API] Added 999999"), "a newline in a client log can't start a forged log line");
  check(!api.logs().includes("\x1b"), "escape sequences aren't written to the log");

  await post([{ severity: "ERROR", message: "y".repeat(100_000) }]);
  await Bun.sleep(100);
  check(!api.logs().includes("y".repeat(1000)), "a 100,000-character message is cut");

  const before = api.logs().split("[CLIENT LOG]").length;
  await post(Array.from({ length: 500 }, (_, i) => ({ severity: "CRITICAL", message: `entry ${i}` })));
  await Bun.sleep(100);
  const logged = api.logs().split("[CLIENT LOG]").length - before;
  check(logged <= 20, `500 entries in one request log at most 20 lines (${logged})`);

  await post([], { "X-Forwarded-For": "6.6.6.6" });
  await Bun.sleep(100);
  check(!api.logs().includes("6.6.6.6"), "without TRUST_PROXY, a client-written X-Forwarded-For isn't logged as the address");

  // ---- Mix bodies (friend requests, chat) are never logged ----
  await fetch(`${api.base}/mix/no-such-route`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ Text: "private-chat-words" }) });
  await Bun.sleep(100);
  check(!api.logs().includes("private-chat-words"), "an unencrypted Mix body isn't logged");

  // ---- errors don't leak internals to the client ----
  const bad = await fetch(`${api.base}/diagnostics/v1/log`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  const text = await bad.text();
  check(bad.status === 400, `a malformed body is a 400 (${bad.status})`);
  check(!/stack|\.ts:|node_modules|at /.test(text), `no stack trace or file paths in the response (${text.slice(0, 120)})`);
  const missing = await (await fetch(`${api.base}/no/such/route?x=%0Aforged`)).text();
  check(!missing.includes("forged"), "a 404 doesn't echo the URL back");

  // ---- room chat is logged for moderation, but on one line ----
  await api.restart({ ALLOW_SWID_AUTH: "1" });
  await createPlayer(api.base, api.dbPath, "{log-chat}", "Chatter");
  await fetch(`${api.base}/chat/v1/message/verify`, {
    method: "POST", headers: { Authorization: "Basic " + btoa("{log-chat}:x"), "Content-Type": "application/json" },
    body: JSON.stringify({ senderSessionId: 1, message: "hello\n[INTERNAL-API] Added 5 coins to Chatter", emotion: 0 }),
  });
  await Bun.sleep(100);
  check(!api.logs().includes("\n[INTERNAL-API] Added 5 coins"), "a newline in room chat can't start a forged log line");
} finally {
  await api.stop();
}
finish();
