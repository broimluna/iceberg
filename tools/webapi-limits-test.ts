// Web API input limits: the lookups the client makes without a login take a
// bounded list of strings, a request that announces an encrypted body can't
// make the server buffer an unbounded one, and client-supplied values in
// these routes reach the log on one line.
import { statSync } from "node:fs";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { createPlayer } from "./lib/mix-client.ts";

const { check, finish } = makeChecker();
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1" } });
const AUTH = { Authorization: "Basic " + btoa("{limits-a}:x") };
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${api.base}${path}`, {
    method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
};

try {
  await createPlayer(api.base, api.dbPath, "{limits-a}", "LimitsA");

  // ---- /player/v1/names (no login needed) ----
  let r = await call("POST", "/player/v1/names", ["LimitsA", "NobodyHere"]);
  check(r.status === 200 && Array.isArray(r.json) && r.json.length === 2, `names: a list of names is answered (${r.status})`);
  for (const [label, body] of [["an object", { length: 3 }], ["a number", 7], ["a string", "LimitsA"]] as [string, unknown][]) {
    r = await call("POST", "/player/v1/names", body);
    check(r.status === 400, `names: ${label} instead of a list is refused with 400 (${r.status})`);
  }
  r = await call("POST", "/player/v1/names", Array.from({ length: 501 }, (_, i) => `Name${i}`));
  check(r.status === 400, `names: a 501-entry list is refused with 400 (${r.status})`);
  r = await call("POST", "/player/v1/names", ["LimitsA", 5, null, { a: 1 }, ["x"]]);
  check(r.status === 200 && Array.isArray(r.json) && r.json.length === 1, `names: entries that aren't strings are skipped (${r.status}, ${r.json?.length})`);

  // ---- /player/v1/id/online ----
  r = await call("POST", "/player/v1/id/online", ["{limits-a}"], AUTH);
  check(r.status === 200 && Array.isArray(r.json), `online: a list of swids is answered (${r.status})`);
  r = await call("POST", "/player/v1/id/online", { length: 2 }, AUTH);
  check(r.status === 400, `online: an object instead of a list is refused with 400 (${r.status})`);
  r = await call("POST", "/player/v1/id/online", Array.from({ length: 501 }, (_, i) => `{s${i}}`), AUTH);
  check(r.status === 400, `online: a 501-entry list is refused with 400 (${r.status})`);
  r = await call("POST", "/player/v1/id/online", ["{limits-a}", 5, { a: 1 }], AUTH);
  check(r.status === 200, `online: entries that aren't strings are skipped (${r.status})`);

  // ---- a body announced as encrypted is bounded ----
  const big = await fetch(`${api.base}/player/v1/names`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Encryption-Key-Id": "none" }, body: "A".repeat(3 * 1024 * 1024),
  }).then((x) => x.status, () => -1);
  check(big === 413 || big === -1, `encrypted body: 3 MB is refused with 413 or the connection is closed (${big})`);
  const small = await fetch(`${api.base}/player/v1/names`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Encryption-Key-Id": "none" }, body: "A".repeat(64 * 1024),
  }).then((x) => x.status, () => -1);
  check(small !== 413 && small !== -1, `encrypted body: 64 KB is still read (${small})`);
  r = await call("GET", "/player/v1/name/LimitsA");
  check(r.status === 200, `the server still answers after the oversized body (${r.status})`);

  const chunked = await fetch(`${api.base}/player/v1/names`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Encryption-Key-Id": "none" },
    body: new ReadableStream({
      start(c) { for (let i = 0; i < 48; i++) c.enqueue(new Uint8Array(64 * 1024).fill(65)); c.close(); },
    }),
  }).then((x) => x.status, () => -1);
  check(chunked === 413 || chunked === -1, `encrypted body: 3 MB sent without a length is refused too (${chunked})`);

  // ---- the database file is private to the server's account ----
  const mode = statSync(api.dbPath).mode & 0o777;
  check(mode === 0o600, `database file mode is 600 (${mode.toString(8)})`);

  // ---- breadcrumbs and tutorials take the ids the client sends, nothing else ----
  r = await call("POST", "/breadcrumb/v1/breadcrumb", [{ id: "Crumb_A" }, "Crumb_B"], AUTH);
  check(r.status === 200 && r.json?.breadcrumbCount === 2, `breadcrumbs: ids are stored (${r.status}, ${r.json?.breadcrumbCount})`);
  r = await call("POST", "/breadcrumb/v1/breadcrumb", [{ id: { nested: 1 } }, { id: ["x"] }, "B".repeat(5000), null, 7.5], AUTH);
  check(r.status === 200 && r.json?.breadcrumbCount === 2, `breadcrumbs: ids that aren't short strings are skipped (${r.status}, ${r.json?.breadcrumbCount})`);
  r = await call("POST", "/breadcrumb/v1/removebreadcrumbs", [{ id: { nested: 1 } }, "Crumb_A"], AUTH);
  check(r.status === 200 && r.json?.breadcrumbCount === 1, `breadcrumbs: removal skips malformed ids too (${r.status}, ${r.json?.breadcrumbCount})`);
  const before = JSON.stringify((await call("POST", "/tutorial/v1/tutorial", {}, AUTH)).json?.tutorialBytes);
  for (const id of [-1, 1.5, "7", 1e9, null]) {
    r = await call("POST", "/tutorial/v1/tutorial", { tutorialID: id, isComplete: true }, AUTH);
    check(r.status === 200 && JSON.stringify(r.json?.tutorialBytes) === before, `tutorial: id ${JSON.stringify(id)} changes nothing (${r.status})`);
  }

  // ---- client-supplied values reach the log on one line ----
  const forged = "\n[LOGIN] forged-line";
  await call("GET", `/player/v1/name/${encodeURIComponent("x" + forged)}`);
  await call("GET", `/player/v1/id/${encodeURIComponent("y" + forged)}`);
  await call("POST", `/moderation/v1/report/name/${encodeURIComponent("z" + forged)}`, { reason: "r" + forged }, AUTH);
  await call("POST", "/tutorial/v1/tutorial", { tutorialID: "t" + forged, isComplete: false }, AUTH);
  await call("POST", "/player/v1/profile", { colour: "c" + forged }, AUTH);
  await Bun.sleep(200);
  const forgedLines = api.logs().split("\n").filter((l) => l.startsWith("[LOGIN] forged-line"));
  check(forgedLines.length === 0, `log: no client value starts a line of its own (${forgedLines.length} forged line(s))`);
  check(api.logs().includes("forged-line"), "log: the values were logged (escaped)");
} finally {
  await api.stop();
}
finish(api.logs());
