// What the Disney Mix app needs before it can log in: the cpipe manifest
// (GET {cpipe_url}?restrict=true&cv=..., Mix/CpipeManifestApi.cs) and the
// files it names, served from cdnRoot.
import { mkdirSync, writeFileSync } from "node:fs";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { MixClient, createPlayer } from "./lib/mix-client.ts";

const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", MIX_CPIPE_CONFIG_VERSION: "1234" } });
const { check, finish } = makeChecker();

try {
  const noAuth = await fetch(`${api.base}/cpipe?restrict=true&cv=2.3`);
  check(noAuth.status === 400, `manifest without Authorization -> ${noAuth.status}`);

  const r = await fetch(`${api.base}/cpipe?restrict=true&cv=2.3`, { headers: { Authorization: "GAE 01D93B3F-8532-4A91-81E7-558BE3600600" } });
  const body: any = await r.json().catch(() => null);
  check(r.status === 200, `manifest -> ${r.status}`);
  check(body?.manifest?.version === "00134", `manifest version ${body?.manifest?.version}`);
  check(typeof body?.manifest?.cdnRoot === "string" && body.manifest.cdnRoot === `${api.base}/cpipe/files`, `cdnRoot ${body?.manifest?.cdnRoot}`);
  check(body?.manifest?.paths?.["donotcopy/n7c4c656"]?.v === 1234, `config entry v ${body?.manifest?.paths?.["donotcopy/n7c4c656"]?.v}`);
  check(Object.keys(body?.manifest?.paths ?? {}).length > 5000, `all manifest paths kept (${Object.keys(body?.manifest?.paths ?? {}).length})`);

  const dir = `${api.dir}/data/mix/cpipe/donotcopy`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/n7c4c656`, "ENCRYPTED-CONFIG");
  const f = await fetch(`${api.base}/cpipe/files/1234/donotcopy/n7c4c656`);
  check(f.status === 200 && (await f.text()) === "ENCRYPTED-CONFIG", `versioned file path -> ${f.status}`);
  const g = await fetch(`${api.base}/cpipe/files/donotcopy/n7c4c656`);
  check(g.status === 200, `unversioned file path -> ${g.status}`);

  const missing = await fetch(`${api.base}/cpipe/files/donotcopy/nope`);
  check(missing.status === 404, `missing file -> ${missing.status}`);
  const traversal = await fetch(`${api.base}/cpipe/files/..%2f..%2fsrc%2fserver.ts`);
  check(traversal.status === 404, `encoded path traversal -> ${traversal.status}`);
  const traversal2 = await fetch(`${api.base}/cpipe/files/1234/..%2f..%2f..%2fsrc%2fserver.ts`);
  check(traversal2.status === 404, `encoded traversal after a version -> ${traversal2.status}`);

  // The Mix app logs in with its own Guest Controller client ID.
  await createPlayer(api.base, api.dbPath, "{DDDD-4}", "dana");
  const M = new MixClient(api.base, { clientId: "DI-SPARK-PROD" });
  let loggedIn = false;
  try { await M.login("dana", "pw-dana"); await M.startSession(); loggedIn = true; } catch (e) { console.log((e as Error).message); }
  check(loggedIn, "login + session with client ID DI-SPARK-PROD");
  const st = loggedIn ? await M.state() : {};
  for (const k of ["ChatThreads", "ChatThreadNicknames", "ChatThreadUnreadMessageCount", "ChatThreadLatestMessageSequenceNumbers",
                   "ChatThreadLastSeenMessageSequenceNumbers", "GameStateChatMessages", "OfficialAccounts", "UserNicknames"]) {
    check(Array.isArray(st[k]) && st[k].length === 0, `/state ${k} is [] (${JSON.stringify(st[k])})`);
  }

  // Called right after /state at login (OfficialAccountGetter). A missing
  // route made the app show "Oops! Something went wrong". An empty list
  // passes the client's ValidateResponse.
  const oa = loggedIn ? await M.call("POST", "/officialAccount/all") : { http: 0, body: null };
  check(oa.http === 200 && oa.body?.Status === "OK" && Array.isArray(oa.body?.OfficialAccountIds) && oa.body.OfficialAccountIds.length === 0,
    `/officialAccount/all -> ${oa.http} ${JSON.stringify(oa.body)}`);
} finally {
  api.stop();
}
finish(api.logs());
