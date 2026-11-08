# tools

Test scripts for `web-api`. Each one starts a throwaway copy of the web
API with its own empty database (`lib/harness.ts`), so your real
`cpi_data.db` is never touched. Run them from the repo root with Bun.
Each prints `PASS`/`FAIL` lines and ends with `ALL PASSED` (exit 0) or
`N FAILURE(S)` (exit 1).

```sh
for t in tools/*-test.ts; do bun "$t" || break; done
```

| Script | What it checks |
|---|---|
| `mix-friends-test.ts` | Mix friend invites, accept, remove, trust and cancel. Every notification follows the client's strict "latest + 1" sequence rule. |
| `webapi-fixes-test.ts` | `X-HTTP-Method-Override` routing, the invitations table migration, and online/offline session handling. |
| `mix-session-test.ts` | Mix login, the RSA→AES session, encrypted `/state`, and an invite delivered through a poll the way the SDK polls. |
| `mix-auth-test.ts` | Mix requests act only as the token's user: bogus tokens, forged `UserId` and foreign sessions get the SDK's 401 statuses. |
| `mix-security-test.ts` | Only the invitee can accept a friendship, with the invitation's trust; a rename can't redirect an invitation; display-name rules; a ban blocks CPI calls made with an existing token. |
| `mix-boot-test.ts` | The cpipe manifest (`GET /cpipe`) and files (`GET /cpipe/files/...`), including path traversal rejection. |
| `mix-config-test.ts` | The boot config tool round-trips, and `openssl` decrypts what it writes. |
| `webapi-auth-test.ts` | CPI access-token auth with default settings: valid tokens work, while expired, unknown or raw-SWID tokens get 401 and never create accounts. |

`lib/harness.ts` exports `startWebApi()` (copy, start, `restart`,
`stop`, `logs`) and `makeChecker()` (`check` and `finish`).

## Mix boot config

`mix-config.ts` writes the encrypted config the Disney Mix app reads at
boot (`StreamingAssets/donotcopy/n7c4c656`), pointing all of its
services at your server:

```sh
bun tools/mix-config.ts render http://192.168.1.50:3000 --out n7c4c656
bun tools/mix-config.ts decrypt n7c4c656     # inspect any config, including Disney's
```

`lib/mix-client.ts` is a test client that behaves like the Mix SDK
(login, key exchange, encrypted bodies, strict notification order). Use
it for any new Mix test.
