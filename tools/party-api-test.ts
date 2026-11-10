// Party routes: public schedule JSON, internal party state and override.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";

const { check, finish } = makeChecker();
const api = await startWebApi();
const get = (p: string, h: Record<string, string> = {}) => fetch(api.base + p, { headers: h });
const post = (body: unknown, h: Record<string, string> = {}) =>
  fetch(api.base + "/api/internal/party-override", { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(body) });
const internal = () => api.internalHeaders();

try {
  let r = await get("/cdn/party-schedule.json");
  let j: any = await r.json();
  check(r.status === 200, "public schedule: 200 without auth");
  check((r.headers.get("cache-control") ?? "").includes("max-age=60"), "cache-control max-age=60");
  check(j.version === 1 && j.mode === "auto" && j.party === null, "version 1, auto, no party");
  check(Array.isArray(j.calendar) && j.calendar.length === 27, "27 calendar entries");
  check(Math.abs(j.serverTime - Date.now()) < 5000, "serverTime is now");
  check(Object.keys(j.calendar[0]).sort().join() === "calendar,end,id,name,start", "entry fields");

  check((await get("/api/internal/party")).status === 403, "internal GET refused without secret");
  r = await get("/api/internal/party", internal());
  j = await r.json();
  check(r.status === 200 && j.mode === "auto" && j.party === null && Array.isArray(j.active), "internal GET shape");

  check((await post({ mode: "none" })).status === 403, "internal POST refused without secret");
  r = await post({ mode: "party", party: "CarWorld", setBy: "root" }, internal());
  j = await r.json();
  check(r.status === 200 && j.party === "55|carworld" && JSON.stringify(j.active) === '["55|carworld"]', "set party by name");
  j = await (await get("/cdn/party-schedule.json")).json();
  check(j.mode === "party" && j.party === "55|carworld", "public JSON follows the override");

  r = await post({ mode: "party", party: "nope" }, internal());
  j = await r.json();
  check(r.status === 400 && j.error === "unknown party" && j.valid.includes("carworld"), "unknown party refused with valid list");
  r = await post({ mode: "sideways" }, internal());
  check(r.status === 400 && (await r.json() as any).error === "bad mode", "bad mode refused");
  r = await post({ mode: "party" }, internal());
  check(r.status === 400 && (await r.json() as any).error === "unknown party", "party mode without party refused");

  await api.restart();
  j = await (await get("/api/internal/party", internal())).json();
  check(j.mode === "party" && j.party === "55|carworld", "override survives a restart");

  j = await (await post({ mode: "none" }, internal())).json();
  check(j.mode === "none" && j.active.length === 0, "none");
  j = await (await post({ mode: "auto" }, internal())).json();
  check(j.mode === "auto" && j.party === null, "auto");

  await api.stop();
  const db = new Database(api.dbPath);
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('party_override', ?)", [JSON.stringify({ mode: "party", party: "99|gone" })]);
  db.close();
  await api.restart();
  j = await (await get("/api/internal/party", internal())).json();
  check(j.active.length === 0, "removed party: nothing active");
  j = await (await get("/cdn/party-schedule.json")).json();
  check(j.mode === "party" && j.party === "99|gone", "removed party: public JSON keeps the stored key");
  await get("/api/internal/party", internal()); await get("/api/internal/party", internal());
  const warned = api.logs().split("\n").filter((l) => l.includes("[PARTY] override names unknown party 99|gone"));
  check(warned.length === 1, `removed party: logged once (${warned.length})`);

  check((await get("/__mapping_cpremix_prod.json")).status === 404, "CDN mapping file stays a 404");
} finally {
  await api.stop();
}
finish(api.logs());
