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

Behind a proxy that only forwards some ports (Cloudflare's, for example,
forwards 8080 and 8443 but not 8088), keep using 8080 and 8443. For
encrypted servers, OpenCPI clients take the WebSocket port from the
`httpsPort` the WebAPI hands out, so 8088 only matters for local
unencrypted play.

To print a decoded SFSObject the way the Java API's `toJson()` does, use
`toJson` from `src/wire-helpers.ts`. A plain `JSON.stringify` shows the
`{type, value}` wrappers and throws on LONG values.

The full command list, with wire shapes, is in
[`../docs/SMARTFOX_PACKETS_DOCUMENTATION.md`](../docs/SMARTFOX_PACKETS_DOCUMENTATION.md).
