// Guest Controller tokens: an access token is only an access token and a
// refresh token only refreshes, a used refresh token stops working, and
// tokens never reach the log.
import { startWebApi, makeChecker, issueApiKey, pw } from "./lib/harness.ts";

const { check, finish } = makeChecker();
const api = await startWebApi();
const gc = `${api.base}/jgc/v5/client/T`;

try {
  const reg = await fetch(`${gc}/guest/register?langPref=en`, {
    method: "POST", headers: { Authorization: `APIKEY ${await issueApiKey(api.base)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ password: pw("main"), profile: { username: "TokenUser" } }),
  });
  const body: any = await reg.json();
  const swid = body.data.profile.swid as string;
  const access = body.data.token.access_token as string;
  const refresh = body.data.token.refresh_token as string;
  check(!!access && !!refresh, "registration hands out both tokens");

  const cpi = (token: string) => fetch(`${api.base}/player/v1/`, { headers: { Authorization: "Basic " + btoa(`${token}:x`) } }).then((r) => r.status);
  const bearer = (token: string) => fetch(`${gc}/guest/${encodeURIComponent(swid)}`, { headers: { Authorization: `BEARER ${token}` } }).then((r) => r.status);
  const doRefresh = (token: string) => fetch(`${gc}/guest/refresh-auth/${token}`, { method: "POST" }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any }));
  const mix = (token: string) => fetch(`${api.base}/state`, { method: "POST", headers: { "X-Mix-OneIdToken": token, "Content-Type": "application/json" }, body: "{}" }).then((r) => r.status);

  check(await cpi(access) === 200, "the access token works on the game API");
  check(await cpi(refresh) === 401, "the refresh token doesn't work as an access token on the game API");
  check(await bearer(access) === 200, "the access token works as a bearer token");
  check(await bearer(refresh) === 401, "the refresh token doesn't work as a bearer token");
  check(await mix(refresh) === await mix("not-a-token") && await mix(access) !== await mix("not-a-token"), "the refresh token doesn't work as a Mix token");
  // A refused refresh is a 400 AUTHORIZATION_INVALID_REFRESH_TOKEN (the code the client maps).
  const refused = (r: { status: number; body: any }) => r.status === 400 && r.body?.error?.errors?.[0]?.code === "AUTHORIZATION_INVALID_REFRESH_TOKEN";
  check(refused(await doRefresh(access)), "an access token can't be used to refresh");

  const r1 = await doRefresh(refresh);
  check(r1.status === 200 && !!r1.body?.data?.token?.refresh_token, `the refresh token refreshes (${r1.status})`);
  check(refused(await doRefresh(refresh)), "a used refresh token stops working");

  await Bun.sleep(100);
  const logs = api.logs();
  check(!logs.includes(refresh) && !logs.includes(r1.body.data.token.refresh_token), "refresh tokens aren't written to the log");
  check(!logs.includes(access), "access tokens aren't written to the log");
} finally {
  await api.stop();
}
finish();
