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
bun start
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
| `SFS_NOTIFY_PORT` | `9339` | Localhost-only port the WebAPI pushes updates to. |
| `WEBAPI_INTERNAL_URL` | `http://127.0.0.1:3000` | Where to send server-to-server reward grants. |
| `INTERNAL_API_SECRET` | *(empty)* | Optional shared secret for the internal bridge. If set, it must match on both servers. |
| `SFS_JOIN_DELAY_MS` | `0` | Debug only: delays the room-join push. |
| `JOIN_SIGNING_KEY` | *(auto)* | Key that checks the web API's signature on `joinRoomData` at login. Must match `web-api`. If unset, both servers share a random key in `<repo>/.iceberg-join-key`, created on first start. |
| `SFS_ALLOW_UNSIGNED_LOGIN` | *(off)* | Development only: `1` accepts logins whose `joinRoomData` isn't signed by this server's web API. |
| `SFS_MAX_PACKETS_PER_SEC` | `100` | A connection sending more packets than this in one second is closed. The retail client peaks around 6. `0` turns it off. |
| `SFS_MAX_CONNECTIONS_PER_IP` | `16` | Further connections from the same address are closed. Set `0` if clients come through a proxy, since they'd all share its address. |

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
