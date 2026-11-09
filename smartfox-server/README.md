# smartfox-server

Club Penguin Island's realtime multiplayer server: a from-scratch
TypeScript reimplementation of the SmartFoxServer wire protocol (the
BitSwarm binary framing and the SFSObject codec), plus CPI's own
extension commands. It doesn't wrap the commercial SmartFoxServer
product, and it doesn't need Java.

It speaks both SmartFoxServer 2X (the retail client and older OpenCPI
builds) and SmartFoxServer 3 (newer OpenCPI builds). Each connection's
protocol is detected from its first packet, so both kinds of client can
share a room.

```sh
bun start               # or, to come back up after an admin's :restart:
bun run start:supervised
```

## Layout

- `src/handshake-server.ts`: entry point.
- `src/server.ts`: per-connection transport handling (raw TCP or
  WebSocket, and SFS2X or SFS3, all detected automatically), packet
  framing and dispatch.
- `src/sfs-wire.ts`: the binary codec for both protocols (packet header,
  SFSObject and SFSArray). The differences between SFS2X and SFS3 are
  listed at the top of the file.
- `src/handlers/sfs2x/`: system requests (handshake, login and room join,
  ping, user variables).
- `src/handlers/`: CPI extension commands, one file per feature. The
  command-to-handler map is in `handlers/registry.ts`.
- `src/commands/`: staff chat commands (see below).
- `src/supervisor.ts`: restarts the server when it exits for `:restart`.
- `src/session-registry.ts`: who's connected and in which room. Room
  broadcasts use this.
- `src/world-objects.ts`: scheduled world objects (MMO Room Items).
- `src/webapi-client.ts`, `src/notify-listener.ts`: the internal bridge to
  `web-api`.
- `src/diagnostic-listener.ts`: a raw TCP byte logger for protocol work
  (`bun run diagnostic`).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SFS_TCP_PORT` | `9933` | Game server port. Also listens on 8080 and 8088: for local, unencrypted servers the OpenCPI client connects to its HttpPort setting instead, which defaults to 8080 in SFS2X builds and 8088 in SFS3 builds. |
| `SFS_NOTIFY_PORT` | `9339` | Port the WebAPI pushes updates to. Listens on 127.0.0.1 only. |
| `SFS_BIND_HOST` | *(all interfaces)* | Address the game ports (9933, 8080, 8088) listen on. Set `127.0.0.1` when clients only arrive through a reverse proxy on this machine. |
| `WEBAPI_INTERNAL_URL` | `http://127.0.0.1:3000` | Where to send server-to-server reward grants. |
| `INTERNAL_API_SECRET` | *(derived)* | Shared secret for the internal bridge, required in both directions. If unset, both servers derive it from `JOIN_SIGNING_KEY`. If set, it must match on both servers. |
| `SFS_JOIN_DELAY_MS` | `0` | Debug only: delays the room-join push. |
| `JOIN_SIGNING_KEY` | *(auto)* | Key that checks the web API's signature on `joinRoomData` at login. Must match `web-api`. If unset, both servers share a random key in `<repo>/.iceberg-join-key`, created on first start. |
| `SFS_ALLOW_UNSIGNED_LOGIN` | *(off)* | Development only: `1` accepts logins whose `joinRoomData` isn't signed by this server's web API. |
| `SFS_MAX_PACKETS_PER_SEC` | `100` | A connection sending more packets than this in one second is closed. The retail client peaks around 6. `0` turns it off. |
| `SFS_MAX_MESSAGE_SIZE` | `1000000` | Largest packet a client may send, in bytes (also advertised in the handshake). A bigger one closes the connection. Real logins are far smaller. |
| `SFS_MAX_CONNECTIONS_PER_IP` | `16` | Further connections from the same address are closed. Behind a proxy, set `SFS_TRUST_PROXY`, or `0` here (and in `SFS_MAX_CONNECTS_PER_IP_PER_MIN`), since clients would otherwise all share the proxy's address. Per-address limits count IPv6 per /64. |
| `SFS_LOGIN_TIMEOUT_MS` | `10000` | Connections that haven't logged in by then are closed. `0` turns it off. |
| `SFS_IDLE_TIMEOUT_MS` | `120000` | Logged-in connections that send nothing for this long are closed. Clients ping every 4 seconds, so this only drops clients that have gone away, never idle players. `0` turns it off. |
| `SFS_MAX_CONNECTIONS` | `2000` | Logged-in players; further logins are closed. `0` turns it off. |
| `SFS_MAX_PENDING_LOGINS` | `200` | Connections still logging in, kept apart from the cap above; when full, the oldest one from the address holding the most is closed, so a flood of connections that never log in can't keep players out. `0` turns it off. |
| `SFS_MAX_CONNECTS_PER_IP_PER_MIN` | `60` | New connections one address may open per minute. `0` turns it off. Like `SFS_MAX_CONNECTIONS_PER_IP`, set it to `0` behind a proxy unless `SFS_TRUST_PROXY` is set. |
| `SFS_TRUST_PROXY` | `0` | The number of reverse proxies in front of the WebSocket ports (e.g. `1` for Caddy or nginx on the same machine). WebSocket connections from loopback then count against the client address in `X-Forwarded-For`, read that many entries from the right, so the per-address limits keep working behind the proxy. Leave it `0` when clients connect directly. |

Behind a proxy that only forwards some ports (Cloudflare's, for example,
forwards 8080 and 8443 but not 8088), keep using 8080 and 8443. For
encrypted servers, OpenCPI clients take the WebSocket port from the
`httpsPort` the WebAPI hands out, so 8088 only matters for local
unencrypted play.

### Input limits and login checks

A packet may not be larger than the 10 MB `ms` the handshake advertises,
and unparsed input may not pile up beyond that. A connection that breaks a
limit is closed. Before these limits, a client could keep the receive
buffer growing until the process ran out of memory.

The login only trusts the swid, sessionId and room in `joinRoomData` after
checking the web API's HMAC signature over them, so editing a captured
login packet no longer lets someone act as another player. A connection
gets one login. Running `smartfox-server` against a different web API
needs the same `JOIN_SIGNING_KEY` on both, or `SFS_ALLOW_UNSIGNED_LOGIN=1`
for local testing.

To print a decoded SFSObject the way the Java API's `toJson()` does, use
`toJson` from `src/wire-helpers.ts`. A plain `JSON.stringify` shows the
`{type, value}` wrappers and throws on LONG values.

The full command list, with wire shapes, is in
[`../docs/SMARTFOX_PACKETS_DOCUMENTATION.md`](../docs/SMARTFOX_PACKETS_DOCUMENTATION.md).

## Staff commands

Moderators and admins type commands into in-game chat. Only the person
who ran a command sees it and its reply (a system bubble over their own
penguin). For everyone else, including players typing the same thing,
chat starting with `:` is ordinary chat, and so are emoticons like `:)`
or `:D`.

Roles come from the web API: accounts named in its `STAFF_ADMINS`
variable (comma-separated usernames, exact case) are always admins, and
admins promote others in game. Only logins whose `joinRoomData` the web
API signed get a role, so `SFS_ALLOW_UNSIGNED_LOGIN` never grants one.

| Command | Role | What it does |
|---|---|---|
| `:help` | moderator | Lists the commands you can run. |
| `:online` | moderator | Who is online. |
| `:find <user>` | moderator | Which room a player is in. |
| `:kick <user>` | moderator | Disconnects a player ranked below you. |
| `:mute <user> [minutes]` / `:unmute <user>` | moderator | Stops a player's chat reaching anyone (default 10 minutes, at most 1440). Lasts until it expires or the server restarts. |
| `:ac <coins> [user]` | admin | Gives coins (1–1,000,000). |
| `:ai <type> <id> [user]` | admin | Gives an item: `equipment`, `durable`, `tube`, `decal`, `fabric`, `emote` or `colour`. |
| `:admin-alert <text>` | admin | Message to everyone: a popup on OpenCPI clients, a chat bubble on SFS2X clients. |
| `:restart [seconds]` / `:restart cancel` | admin | Counts down (default 30 s, up to a day), announcing each minute and at 30, 10 and 3 seconds, then restarts. |
| `:promote <user> moderator\|admin` / `:demote <user>` | admin | Changes a role; works for offline players. |

`[user]` defaults to yourself. Names can be typed in any case when only
one account matches.

### Running with auto-restart

`:restart` ends the process with exit code 75. `bun run start:supervised`
starts the server again whenever that happens; without it the server just
stops. Under systemd, plain `bun start` with
`Restart=on-failure` and `RestartForceExitStatus=75` does the same.
