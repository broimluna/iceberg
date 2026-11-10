// Game server party cache: fails closed, keeps the last state, logs once per outage.
import { makeChecker } from "./lib/harness.ts";

const { check, finish } = makeChecker();
let mode: "up" | "down" | "500" | "bad" = "down";
let body: unknown = { mode: "party", party: "47|halloween2026", active: ["47|halloween2026"] };
const stub = Bun.serve({
  port: 0,
  fetch() {
    if (mode === "500") return new Response("no", { status: 500 });
    if (mode === "bad") return Response.json({ mode: "auto" });
    return Response.json(body);
  },
});
const port = stub.port;
process.env.WEBAPI_INTERNAL_URL = `http://127.0.0.1:${port}`;
const { activePartyNames, refreshParties } = await import("../smartfox-server/src/parties.ts");

const lines: string[] = [];
const orig = console.log;
console.log = (...a: unknown[]) => { const l = a.join(" "); if (l.includes("[PARTY]")) lines.push(l); else orig(...a); };
const count = (w: string) => lines.filter((l) => l.includes(w)).length;
try {
  check(activePartyNames().length === 0, "empty before any refresh");

  // Review Focus 4: stub is down at start, one line per outage
  stub.stop(true);
  await refreshParties(); await refreshParties();
  check(activePartyNames().length === 0 && count("unreachable") === 1, "down at start: still [], one unreachable line");
} finally { console.log = orig; }

// bring the stub back on the same port
const stub2 = Bun.serve({
  port,
  fetch() {
    if (mode === "500") return new Response("no", { status: 500 });
    if (mode === "bad") return Response.json({ mode: "auto" });
    return Response.json(body);
  },
});
console.log = (...a: unknown[]) => { const l = a.join(" "); if (l.includes("[PARTY]")) lines.push(l); else orig(...a); };
try {
  mode = "up";
  await refreshParties();
  check(JSON.stringify(activePartyNames()) === '["halloween2026"]', "up: names from active keys");
  check(count("party state") === 1, "one party state line on recovery");
  await refreshParties();
  check(count("party state") === 1, "unchanged state is not logged again");

  mode = "500";
  await refreshParties(); await refreshParties();
  check(JSON.stringify(activePartyNames()) === '["halloween2026"]' && count("unreachable") === 2, "500: names kept, one more unreachable line only");

  mode = "bad";
  await refreshParties();
  check(JSON.stringify(activePartyNames()) === '["halloween2026"]', "bad shape: treated as failure, names kept");

  mode = "up";
  await refreshParties();
  check(count("party state") === 2, "recovery logs the state again");
} finally { console.log = orig; stub2.stop(true); }
finish();
