// The internal bridge between web-api and smartfox-server: every call
// needs the shared secret (INTERNAL_API_SECRET, or one derived from
// JOIN_SIGNING_KEY), requests relayed by a reverse proxy are refused, the
// web API's notifier sends the secret to the configured notify port, and
// the listen addresses can be limited to localhost.
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { sleep } from "./lib/sfs-client.ts";

const { check, finish } = makeChecker();
const KEY = crypto.randomBytes(32).toString("hex");
const DERIVED = crypto.createHmac("sha256", KEY).update("iceberg internal api v1").digest("hex");
const EXPLICIT = "explicit-test-secret-0123456789";

/** A non-loopback IPv4 of this machine, to see whether a port is open beyond localhost. */
const lanAddress = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;

const canConnect = (port: number, host: string) => new Promise<boolean>((res) => {
  const s = net.connect(port, host, () => { s.destroy(); res(true); });
  s.on("error", () => res(false));
  setTimeout(() => { s.destroy(); res(false); }, 1500);
});

const internal = (base: string, headers: Record<string, string> = {}, path = "api/internal/session-ended") =>
  fetch(`${base}/${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ sessionId: 1 }) }).then((r) => r.status);

async function startGame(env: Record<string, string>) {
  const port = 19500 + Math.floor(Math.random() * 80);
  const notify = port + 100;
  const proc = Bun.spawn(["bun", "run", "src/handshake-server.ts"], {
    cwd: `${import.meta.dir}/../smartfox-server`,
    env: { ...process.env, SFS_TCP_PORT: String(port), SFS_NOTIFY_PORT: String(notify), WEBAPI_INTERNAL_URL: "http://127.0.0.1:1", JOIN_SIGNING_KEY: KEY, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  for (let i = 0; i < 100 && !(await canConnect(port, "127.0.0.1")); i++) await sleep(50);
  for (let i = 0; i < 100 && !(await canConnect(notify, "127.0.0.1")); i++) await sleep(50);
  return { port, notify, stop: () => proc.kill() };
}
const notifyStatus = (port: number, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/notify`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ type: "COINS_UPDATE", username: "nobody", coins: 1 }) }).then((r) => r.status);

const api = await startWebApi({ env: { JOIN_SIGNING_KEY: KEY } });
try {
  // ---- web API: the secret is always required ----
  check(await internal(api.base) === 403, "no secret: refused, even from localhost with no secret configured");
  check(await internal(api.base, {}, "API/Internal/session-ended") === 403, "no secret, other letter case: refused");
  check(await internal(api.base, { "X-Internal-Secret": "x".repeat(DERIVED.length) }) === 403, "a wrong secret of the right length: refused");
  check(await internal(api.base, { "X-Internal-Secret": DERIVED }) === 200, "the secret derived from JOIN_SIGNING_KEY: accepted");
  check(await internal(api.base, { "X-Internal-Secret": DERIVED, "X-Forwarded-For": "203.0.113.5" }) === 403, "right secret but relayed by a proxy (X-Forwarded-For): refused");
  check(await internal(api.base, { "X-Internal-Secret": DERIVED, Forwarded: "for=203.0.113.5" }) === 403, "right secret but relayed by a proxy (Forwarded): refused");

  await api.restart({ JOIN_SIGNING_KEY: KEY, INTERNAL_API_SECRET: EXPLICIT });
  check(await internal(api.base, { "X-Internal-Secret": EXPLICIT }) === 200, "INTERNAL_API_SECRET, when set, is the secret");
  check(await internal(api.base, { "X-Internal-Secret": DERIVED }) === 403, "and the derived one no longer works");

  // ---- web API: HOST is honoured ----
  if (lanAddress) {
    const port = Number(new URL(api.base).port);
    check(await canConnect(port, lanAddress), `default: web API reachable on ${lanAddress}`);
    await api.restart({ JOIN_SIGNING_KEY: KEY, HOST: "127.0.0.1" });
    check(!(await canConnect(port, lanAddress)), "HOST=127.0.0.1: web API not reachable beyond localhost");
    check(await canConnect(port, "127.0.0.1"), "HOST=127.0.0.1: still reachable on localhost");
  } else {
    console.log("SKIP listen-address checks: no non-loopback IPv4 on this machine");
  }

  // ---- game server notify listener ----
  const game = await startGame({});
  try {
    check(await notifyStatus(game.notify) === 401, "notify without the secret: refused");
    check(await notifyStatus(game.notify, { "X-Internal-Secret": DERIVED }) === 200, "notify with the derived secret: accepted");
    check(await notifyStatus(game.notify, { "X-Internal-Secret": DERIVED, "X-Forwarded-For": "203.0.113.5" }) === 403, "notify relayed by a proxy: refused");
    if (lanAddress) {
      check(!(await canConnect(game.notify, lanAddress)), "notify port listens on localhost only");
      check(await canConnect(game.port, lanAddress), "default: game port reachable beyond localhost");
    }
  } finally { game.stop(); }

  if (lanAddress) {
    const local = await startGame({ SFS_BIND_HOST: "127.0.0.1" });
    try {
      check(await canConnect(local.port, "127.0.0.1"), "SFS_BIND_HOST=127.0.0.1: game port open on localhost");
      check(!(await canConnect(local.port, lanAddress)), "SFS_BIND_HOST=127.0.0.1: game port closed beyond localhost");
    } finally { local.stop(); }
  }

  // ---- the web API's notifier sends the secret, to SFS_NOTIFY_PORT ----
  const seen: { url?: string; secret?: string } = {};
  const fake = http.createServer((req, res) => { seen.url = req.url; seen.secret = String(req.headers["x-internal-secret"] ?? ""); res.writeHead(200).end("{}"); });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  const fakePort = (fake.address() as net.AddressInfo).port;
  const child = Bun.spawn(["bun", "-e", `const m = await import(${JSON.stringify(`${import.meta.dir}/../web-api/src/smartfoxNotifier.ts`)}); process.exit((await m.notifyCoinsUpdate("x", 1)) ? 0 : 1);`], {
    env: { ...process.env, JOIN_SIGNING_KEY: KEY, SFS_NOTIFY_PORT: String(fakePort), INTERNAL_API_SECRET: "" },
    stdout: "pipe", stderr: "pipe",
  });
  const code = await child.exited;
  fake.close();
  check(code === 0 && seen.url === "/notify", `notifier reaches SFS_NOTIFY_PORT (exit ${code}, url ${seen.url})`);
  check(seen.secret === DERIVED, "notifier sends the shared secret");
} finally {
  await api.stop();
}
finish();
