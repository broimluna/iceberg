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
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP listen address. |
| `GAME_SERVER_IP` / `GAME_SERVER_PORT` | `127.0.0.1` / `9933` | The game server address handed to clients on room join. |
| `ICEBERG_DB_PATH` | `src/cpi_data.db` | SQLite database file. (`DB_PATH` is read into `config.ts` but has never been used, so it has no effect.) |
| `JOIN_SIGNING_KEY` | *(auto)* | Key that signs `joinRoomData` for the SmartFox login. Must match `smartfox-server`. If unset, both servers share a random key in `<repo>/.iceberg-join-key`, created on first start. |
| `INTERNAL_API_SECRET` | *(empty)* | Optional shared secret for the internal bridge with `smartfox-server`. |

## Talking to the game server

- `smartfox-server` calls `POST /api/internal/grant-reward`,
  `/api/internal/add-coins` and `/api/internal/quest-objective` when its
  own game logic decides something was earned. Only localhost callers are
  accepted (plus the shared secret, if one is set).
- `src/smartfoxNotifier.ts` pushes player-data changes to the game
  server's notify port (9339).

Response signatures (`SignedResponse<T>`) are placeholders. The client
never verifies them. Anti-tamper comes from the server checking requests
against its own state instead of trusting what the client sends. That
work is ongoing, and `PUT /reward/v1` still accepts rewards from the
client without validation.

The endpoint reference is in
[`../docs/API_ENDPOINTS_DOCUMENTATION.md`](../docs/API_ENDPOINTS_DOCUMENTATION.md).
