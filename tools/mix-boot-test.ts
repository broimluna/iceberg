// What the Disney Mix app needs before it can log in: the cpipe manifest
// (GET {cpipe_url}?restrict=true&cv=..., Mix/CpipeManifestApi.cs) and the
// files it names, served from cdnRoot.
import { mkdirSync, writeFileSync } from "node:fs";
import { startWebApi, makeChecker, pw } from "./lib/harness.ts";
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
  try { await M.login("dana", pw("dana")); await M.startSession(); loggedIn = true; } catch (e) { console.log((e as Error).message); }
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

  // Every user object the Mix app receives needs a complete Avatar: the
  // client dereferences it (FriendRecommender, DisplayNameSearcher), and a
  // missing one crashed the Friends screen and logged the app out.
  const avatarOk = (av: any) => !!av && Number.isSafeInteger(av.AvatarId)
    && ["Accessory", "Brow", "Costume", "Eyes", "Hair", "Hat", "Nose", "Mouth", "Skin"].every((k) => typeof av[k]?.SelectionKey === "string");
  await createPlayer(api.base, api.dbPath, "{EEEE-5}", "erin");
  const rec = loggedIn ? await M.call("POST", "/friendship/recommend") : { body: null };
  const recs = rec.body?.FriendRecommendations ?? [];
  check(recs.length > 0 && recs.every((r: any) => avatarOk(r.Avatar)), `recommendations carry avatars (${JSON.stringify(recs[0]?.Avatar?.AvatarId)})`);
  const found = loggedIn ? await M.call("POST", "/search/displayname", { DisplayName: "erin" }) : { body: null };
  check(found.body?.DisplayName === "erin" && avatarOk(found.body?.Avatar), "display name search result carries an avatar");
  const byId = loggedIn ? await M.call("POST", "/users/byUserId", { UserIds: ["{EEEE-5}"] }) : { body: null };
  check(avatarOk(byId.body?.Users?.[0]?.Avatar), "users/byUserId carries an avatar");
  const byName = loggedIn ? await M.call("POST", "/users/byDisplayName", { DisplayNames: ["erin"] }) : { body: null };
  check(avatarOk(byName.body?.Users?.[0]?.Avatar), "users/byDisplayName carries an avatar");
  const st2 = loggedIn ? await M.state() : {};
  check((st2.Users ?? []).length > 0 && st2.Users.every((u: any) => avatarOk(u.Avatar)), "/state Users carry avatars");
  check(byId.body?.Users?.[0]?.Avatar?.AvatarId === byName.body?.Users?.[0]?.Avatar?.AvatarId, "a user's default AvatarId is stable across calls");

  // tools/mix-config.ts points mix_platform_services_url at <base>/mix, so
  // a source-built app sends every Mix call under /mix. An Express array
  // mount (['/', '/mix']) is one layer whose '/' alternative always wins,
  // which left every /mix/... route a 404.
  await createPlayer(api.base, api.dbPath, "{FFFF-6}", "finn");
  const P = new MixClient(api.base, { clientId: "DI-SPARK-PROD", mixBase: `${api.base}/mix` });
  let prefixed = false;
  try { await P.login("finn", pw("finn")); await P.startSession(); prefixed = true; } catch (e) { console.log((e as Error).message); }
  check(prefixed, "session start under /mix");
  const pst = prefixed ? await P.call("POST", "/state") : { http: 0 };
  check(pst.http === 200, `/mix/state -> ${pst.http}`);
  const poa = prefixed ? await P.call("POST", "/officialAccount/all") : { http: 0, body: null };
  check(poa.http === 200 && poa.body?.Status === "OK", `/mix/officialAccount/all -> ${poa.http}`);
} finally {
  api.stop();
}
finish(api.logs());
