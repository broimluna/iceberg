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
| `held-item-echo-test.ts` | A player holding a tray or a taken item who changes their own `con` never makes any client add a second held item (taking a slice, eating it, then pulling out something else; re-sending the same tray). |
| `post-deploy-fixes-test.ts` | Fixes from the first deployed server: `tcpPort` is a number when `GAME_SERVER_PORT` is set; login, refresh and validate errors use codes the client maps (wrong password, lockout, bad refresh token, size errors); each client gets its own random API key, and display-name validate doesn't call the caller's own name taken; a forged `quest.set` pays nothing; no `X-Powered-By`. |
| `connection-limits-test.ts` | Game server connection limits: no login within the timeout, silence after login (pings keep it open), the overall cap, the per-address connect rate, and per-address limits behind a proxy (`SFS_TRUST_PROXY`). |
| `rate-limit-test.ts` | The rate limiter in-process: `TRUST_PROXY` reads the proxy-appended address, not one the client wrote; IPv6 is limited per /64; the address table stays bounded. |
| `name-rules-test.ts` | The shared username/display-name rule (`web-api/src/utils/names.ts`): emoji, rich-text tags, invisible and control characters, look-alike alphabets, padding and Unicode folding are refused on registration, profile updates and both renames. |
| `staff-roles-webapi-test.ts` | Staff roles in the web API: `STAFF_ADMINS` (exact names, so a look-alike account isn't an admin), `players.role`, and the internal identity / set-role endpoints. |
| `staff-unit-test.ts` | Staff command pieces in-process: what counts as a command (emoticons don't), roles before the account lookup answers, mutes at reconnect, the restart countdown schedule. |
| `staff-commands-test.ts` | Staff chat commands end to end with signed logins: rewards follow the signed swid not the login name, every command, role limits, mutes, `:announce` popups and a real `:restart` under the supervisor. Sections can be run on their own (`bun tools/staff-commands-test.ts economy`). |
| `party-games-test.ts` | Find Four end to end with a game server and three clients: the invitation, joining, a full match with coin rewards in the web API, and a forfeit by disconnect. |
| `party-games-room-items-test.ts` | Room MMO items for party games in-process: an added item and its variables reach everyone in the room (not other rooms), a change sends only the changed variable, removal sends the id, and joiners get a snapshot. |
| `party-games-dance-rules-test.ts` | Dance Battle rules, pure: per-player and team scoring, the emote each move plays (failure move for misses), per-round sequence sets from the game data, win/tie/placement and the "nobody scored, nobody paid" rule. |
| `party-games-lobby-test.ts` | Scheduled party-game lobbies in-process: lobby windows end on the 6-minute boundary, team/role slots, joining by interacting with the lobby item, leaving, the 20-player cap, cancel with too few players or one team, and an emptied room dropping its lobby. |
| `party-games-dance-test.ts` | The Dance Battle session in-process (2 v 2 and a spectator): item and prop/pose lifecycle, junk input ignored, dance outcomes, team-mean scores over 4 rounds, placements and rewards, AFK match pays nothing, a team walking out only pays if the winners scored, quitting by putting the prop away. |
| `party-games-dance-e2e-test.ts` | Dance Battle end to end with a real web API and game server: `:dancebattle`, four players join by interaction, the game runs, the spectator sees it, placements and coin rewards land in the web API, and a new lobby can open. |
| `consumable-signature-test.ts` | Consumable spend verification: the web API signs uses and refuses them without stock; the game server plays `con.use` only with a signed, unused spend for that player; `con.partial` is signed and the web API stores only signed partials. Covers tampering, replay, another player's payload and non-canonical signatures. |
| `internal-bridge-test.ts` | The internal bridge between the servers: the shared secret is always required (set or derived from the join key), proxied requests are refused, the web API's notifier sends the secret to `SFS_NOTIFY_PORT`, and `HOST` / `SFS_BIND_HOST` / the notify port keep listeners on localhost. |
| `log-hygiene-test.ts` | Client text can't forge or flood the web API log (escaped, length- and count-capped), the logged address isn't a client-written header, and error responses carry no stack traces or echoed URLs. |
| `anonymous-access-test.ts` | Without a login the CPI game API answers 401 `{code: 3}` instead of acting as a shared fallback account; only the calls the client makes without credentials (other-player lookups, the encryption key, diagnostics) stay open. |
| `economy-test.ts` | Requests can't name their own rewards; counts can't go negative and purchases need the coins (Coins for Change, Disney store, igloo decorations); quests pay only for defined quests with every objective recorded; room collectibles pay once per respawn by the server's clock; unknown reward ids grant nothing; one player can't overwrite another's item or igloo layout; making clothing costs the template's coins; the catalog pays once per theme and checks the buyer's coins; the quick-notification reward is daily and the daily spin once a day; a fishing catch must be a prize from your own last cast; only consumables the game sells can be bought, at their real price. |
| `token-test.ts` | Guest Controller tokens: an access token only works as one (game API, bearer, Mix) and a refresh token only refreshes; a used refresh token stops working; no token reaches the log. |

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
