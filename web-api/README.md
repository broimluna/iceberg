# web-api

Club Penguin Island's REST/HTTP backend: Guest Controller (accounts and
login), Mix, inventory, catalog, quests, rewards, igloos, the Disney
Store and everything else the client called outside the realtime
SmartFox connection. It runs on Bun with Express and `bun:sqlite`.

```sh
bun install
bun start
```

The SQLite database (`cpi_data.db`) is created in the working directory
on first run.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP listen address. Use `HOST=127.0.0.1` when a reverse proxy on the same machine is the only way in. |
| `GAME_SERVER_IP` / `GAME_SERVER_PORT` | `127.0.0.1` / `9933` | The game server address handed to clients on room join. |
| `ICEBERG_DB_PATH` | `src/cpi_data.db` | SQLite database file. (`DB_PATH` is read into `config.ts` but has never been used, so it has no effect.) |
| `JOIN_SIGNING_KEY` | *(auto)* | Key that signs `joinRoomData` for the SmartFox login. Must match `smartfox-server`. If unset, both servers share a random key in `<repo>/.iceberg-join-key`, created on first start. |
| `INTERNAL_API_SECRET` | *(derived)* | Shared secret for the internal bridge with `smartfox-server`, required on every internal call in both directions. If unset, both servers derive it from `JOIN_SIGNING_KEY`. If set, it must match on both. |
| `SFS_NOTIFY_PORT` | `9339` | The game server's notify port on 127.0.0.1, where player-data changes are pushed. Must match `smartfox-server`. |
| `STAFF_ADMINS` | *(empty)* | Comma-separated usernames (exact case) that are always admins for the game server's staff commands. Name accounts that already exist. |
| `AUTH_LOGIN_PER_MIN` | `10` | Guest logins allowed per address per minute. `0` turns the limit off. |
| `AUTH_REGISTER_PER_HOUR` | `5` | Registrations allowed per address per hour. `0` turns it off. |
| `AUTH_APIKEY_PER_MIN` | `30` | API keys issued per address per minute. `0` turns it off. |
| `AUTH_ACCOUNT_FAILS_PER_15MIN` | `10` | Failed logins to one account (from any address) before its logins are refused until the 15 minutes are up, except from addresses that have logged into it before. `0` turns it off. |
| `TRUST_PROXY` | *(off)* | The number of reverse proxies in front of the web API (e.g. `1` for nginx or Cloudflare alone). The client's address for the limits above is then read that many entries from the right of `X-Forwarded-For`; entries further left come from the client and are ignored. Leave it unset without a proxy. IPv6 addresses are limited per /64. |
| `LEGACY_PASSWORD_CLAIM` | *(off)* | `1` lets the first login to an account that has no password set one. Only for old databases from before passwords existed: it lets anyone who knows the name take such an account. |
| `ICEBERG_DEBUG_ERRORS` | *(off)* | `1` puts error messages and stack traces in error responses. Local development only: the log always has them. |

## Talking to the game server

- `smartfox-server` calls `POST /api/internal/grant-reward`,
  `/api/internal/add-coins` and `/api/internal/quest-objective` when its
  own game logic decides something was earned. A call must come from
  localhost, carry the shared secret, and not have been relayed by a
  reverse proxy (any `X-Forwarded-For`, `Forwarded` or `X-Real-IP` header
  is refused, since a proxy on the same machine also connects from
  localhost).
- `src/smartfoxNotifier.ts` pushes player-data changes to the game
  server's notify port (9339).

Response signatures (`SignedResponse<T>`) are placeholders. The client
never verifies them. Anti-tamper comes from the server checking requests
against its own state instead of trusting what the client sends. That
work is ongoing, and `PUT /reward/v1` still accepts rewards from the
client without validation.

The endpoint reference is in
[`../docs/API_ENDPOINTS_DOCUMENTATION.md`](../docs/API_ENDPOINTS_DOCUMENTATION.md).
