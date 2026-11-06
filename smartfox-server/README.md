# smartfox-server

Club Penguin Island's realtime multiplayer server: a from-scratch
TypeScript reimplementation of the SmartFoxServer 2X wire protocol (the
BitSwarm binary framing and the SFSObject codec), plus CPI's own
extension commands. It doesn't wrap the commercial SFS2X product, and
it doesn't need Java.

```sh
bun start
```

## Layout

- `src/handshake-server.ts`: entry point.
- `src/server.ts`: per-connection transport handling (raw TCP or
  WebSocket, detected automatically), packet framing and dispatch.
- `src/sfs-wire.ts`: the SFS2X binary codec (packet header, SFSObject and
  SFSArray).
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
| `SFS_TCP_PORT` | `9933` | Game server port. Also listens on 8080, because the OpenCPI client connects there for local servers. |
| `SFS_NOTIFY_PORT` | `9339` | Localhost-only port the WebAPI pushes updates to. |
| `WEBAPI_INTERNAL_URL` | `http://127.0.0.1:3000` | Where to send server-to-server reward grants. |
| `INTERNAL_API_SECRET` | *(empty)* | Optional shared secret for the internal bridge. If set, it must match on both servers. |
| `SFS_JOIN_DELAY_MS` | `0` | Debug only: delays the room-join push. |

The full command list, with wire shapes, is in
[`../docs/SMARTFOX_PACKETS_DOCUMENTATION.md`](../docs/SMARTFOX_PACKETS_DOCUMENTATION.md).
