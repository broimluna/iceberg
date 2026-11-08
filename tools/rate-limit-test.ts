// web-api/src/utils/rateLimit.ts in-process: which address a request
// counts against, and that the table of addresses stays bounded.
import { makeChecker } from "./lib/harness.ts";
import { rateLimit, clientAddress, accountFailureLimit } from "../web-api/src/utils/rateLimit.ts";

const { check, finish } = makeChecker();
const req = (remote: string, xff?: string) => ({ socket: { remoteAddress: remote }, headers: xff ? { "x-forwarded-for": xff } : {} }) as any;
const res = () => { const r: any = { status: 0, headers: {} }; r.setHeader = (k: string, v: string) => (r.headers[k] = v); return r; };
const limiter = (limit: number) => rateLimit({ name: "test", envVar: "TEST_LIMIT_UNSET", defaultLimit: limit, windowMs: 60_000, onLimited: (r: any) => (r.status = 429) });
const hit = (mw: any, rq: any) => { const r = res(); let passed = false; mw(rq, r, () => (passed = true)); return passed; };

// Without a trusted proxy, X-Forwarded-For is ignored.
delete process.env.TRUST_PROXY;
check(clientAddress(req("10.0.0.1", "6.6.6.6")) === "10.0.0.1", "X-Forwarded-For is ignored unless TRUST_PROXY is set");

// Behind one proxy, the address it appended (right-most) counts; whatever
// the client wrote before it doesn't.
process.env.TRUST_PROXY = "1";
check(clientAddress(req("10.0.0.1", "1.1.1.1, 9.9.9.9")) === "9.9.9.9", `right-most entry behind 1 proxy (${clientAddress(req("10.0.0.1", "1.1.1.1, 9.9.9.9"))})`);
{
  const mw = limiter(2);
  const results = ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((spoof) => hit(mw, req("10.0.0.1", `${spoof}, 9.9.9.9`)));
  check(results[0] && results[1] && !results[2], `spoofed left-hand entries share the real address's limit (${results})`);
}
process.env.TRUST_PROXY = "2";
check(clientAddress(req("10.0.0.1", "6.6.6.6, 9.9.9.9, 8.8.8.8")) === "9.9.9.9", "second from the right behind 2 proxies");
check(clientAddress(req("10.0.0.1", "8.8.8.8")) === "10.0.0.1", "too few entries falls back to the socket address");
delete process.env.TRUST_PROXY;

// IPv6 addresses in one /64 are one host.
{
  const mw = limiter(2);
  const results = ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2:abcd::9"].map((a) => hit(mw, req(a)));
  check(results[0] && results[1] && !results[2], `addresses in one IPv6 /64 share a limit (${results})`);
  check(hit(mw, req("2001:db8:1:3::1")), "another /64 has its own");
  check(clientAddress(req("::ffff:192.0.2.7")) === "192.0.2.7", "IPv4-mapped IPv6 counts as the IPv4 address");
}

// The table of addresses is bounded.
{
  const mw = limiter(5);
  for (let i = 0; i < 60_000; i++) hit(mw, req(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`));
  check(mw.size() <= 50_000, `at most 50,000 addresses are tracked (${mw.size()})`);
}
// A locked account stays locked however many other accounts fail.
{
  process.env.AUTH_ACCOUNT_FAILS_PER_15MIN = "3";
  const limiter = accountFailureLimit();
  for (let i = 0; i < 3; i++) limiter.begin("victim", "9.9.9.9")!.done(false);
  check(limiter.begin("victim", "8.8.8.8") === null, "victim locked");
  for (let i = 0; i < 60_000; i++) limiter.begin(`other${i}`, "9.9.9.9")?.done(false);
  check(limiter.begin("victim", "8.8.8.8") === null, "still locked after 60,000 other accounts failed once");
  delete process.env.AUTH_ACCOUNT_FAILS_PER_15MIN;
}
finish();
