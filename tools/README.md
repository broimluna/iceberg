# tools

Test scripts for `web-api` and `smartfox-server`. Each one starts a throwaway copy of the web
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
| `mix-content-test.ts` | Desktop bundle entries in the cpipe manifest (CRC32, mtime version, no `.meta`), serving them, and the base manifest when no bundles are installed. |
| `mix-config-test.ts` | The boot config tool round-trips, and `openssl` decrypts what it writes. |
| `webapi-auth-test.ts` | CPI access-token auth with default settings: valid tokens work, while expired, unknown or raw-SWID tokens get 401 and never create accounts. |
| `party-games-data-test.ts` | Party game definitions from `smartfox-server/data/party-games.json`: rules, trigger props, placement rewards. |
| `party-games-manager-test.ts` | The party game manager in-process: `pgame.start.v2` / `pgame.message` / `pgame.end` reach only the players, the game prop is shown to the room, rewards are granted and sent as `reward.add_delayed`, and bad messages are ignored. |
| `party-games-findfour-test.ts` | Find Four rules in-process: turn order, column fixes, wins in every direction, draws, the turn timeout and forfeits. |
| `auth-hardening-test.ts` | Guest login and registration: only issued API keys, password length, 210,000-round hashes (old ones still log in and are upgraded), no claiming password-less accounts, and per-address rate limits. |
| `connection-limits-test.ts` | Game server connection limits: no login within the timeout, silence after login (pings keep it open), the overall cap and the per-address connect rate. |
| `rate-limit-test.ts` | The rate limiter in-process: `TRUST_PROXY` reads the proxy-appended address, not one the client wrote; IPv6 is limited per /64; the address table stays bounded. |
| `name-rules-test.ts` | The shared username/display-name rule (`web-api/src/utils/names.ts`): emoji, rich-text tags, invisible and control characters, look-alike alphabets, padding and Unicode folding are refused on registration, profile updates and both renames. |
| `staff-roles-webapi-test.ts` | Staff roles in the web API: `STAFF_ADMINS` (exact names, so a look-alike account isn't an admin), `players.role`, and the internal identity / set-role endpoints. |
| `staff-unit-test.ts` | Staff command pieces in-process: what counts as a command (emoticons don't), roles before the account lookup answers, mutes at reconnect, the restart countdown schedule. |
| `staff-commands-test.ts` | Staff chat commands end to end with signed logins: rewards follow the signed swid not the login name, every command, role limits, mutes, `:announce` popups and a real `:restart` under the supervisor. Sections can be run on their own (`bun tools/staff-commands-test.ts economy`). |
| `party-games-test.ts` | Find Four end to end with a game server and three clients: the invitation, joining, a full match with coin rewards in the web API, and a forfeit by disconnect. |
| `consumable-signature-test.ts` | Consumable spend verification: the web API signs uses and refuses them without stock; the game server plays `con.use` only with a signed, unused spend for that player; `con.partial` is signed and the web API stores only signed partials. Covers tampering, replay, another player's payload and non-canonical signatures. |
| `internal-bridge-test.ts` | The internal bridge between the servers: the shared secret is always required (set or derived from the join key), proxied requests are refused, the web API's notifier sends the secret to `SFS_NOTIFY_PORT`, and `HOST` / `SFS_BIND_HOST` / the notify port keep listeners on localhost. |

`lib/harness.ts` exports `startWebApi()` (copy, start, `restart`,
`stop`, `logs`) and `makeChecker()` (`check` and `finish`).
`lib/sfs-client.ts` exports `startGameServer()` and `GameClient`, a fake
SFS2X client that logs in with signed joinRoomData and spends consumables
through the web API.

## Checking existing names

`check-names.ts` lists usernames and display names that break the name
rule (`web-api/src/utils/names.ts`), and names that clash ignoring case.
The rule only applies to names set from now on, so run this on a database
from before it. Read-only; exit code 1 when anything is found.

```sh
bun tools/check-names.ts --db web-api/src/cpi_data.db
```

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

## Mix content (stickers, gags, games)

`mix-content.ts` fills the git-ignored bundle tree that `/cpipe` lists
for desktop source builds of Mix (docs/MIX_API.md sections 2 and 10):

```sh
bun tools/mix-content.ts build --project ~/src/DisneyMix     # Linux bundles via Unity batchmode (~3 min)
bun tools/mix-content.ts import --from ~/src/DisneyMix/Assets/StreamingAssets/AssetBundles
```

It copies `windows64` and `standalonelinux64` bundles into
`web-api/data/mix/cpipe/AssetBundles/` and prints what's present against
Disney's final manifest. Restart web-api afterwards.
