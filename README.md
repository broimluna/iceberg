# cpi-private-server

A from-scratch server recreation of **Club Penguin Island** (Disney, shut
down in 2018), for preservation. The goal is full online play: real
multiplayer, with a server that is authoritative over the game state.

This is a fan project. It is not affiliated with or endorsed by Disney,
and it does not include any game client or game assets.

## What's here

| Directory | What it is |
|---|---|
| [`smartfox-server/`](smartfox-server/) | The realtime multiplayer server. A from-scratch reimplementation of the SmartFoxServer wire protocol in TypeScript, speaking both SmartFoxServer 2X (SFS2X) and SmartFoxServer 3 clients. It needs no SmartFoxServer install, no Java and no license. |
| [`web-api/`](web-api/) | The REST/HTTP backend: accounts and login (Guest Controller), Mix, inventory, catalog, quests, rewards, igloos and the rest of what the client calls outside the realtime connection. |
| [`docs/`](docs/) | Protocol reference: every SFS2X extension command (`SMARTFOX_PACKETS_DOCUMENTATION.md`) and every WebAPI endpoint (`API_ENDPOINTS_DOCUMENTATION.md`). |

Both servers run on [Bun](https://bun.sh) (1.3 or newer) and need no
build step.

## Running it

```sh
# Terminal 1 - WebAPI (http://localhost:3000)
cd web-api && bun install && bun start

# Terminal 2 - game server (tcp 9933, plus 8080 and 8088 for OpenCPI clients)
cd smartfox-server && bun start
```

Then point the retail 1.13.0 client at your machine. Set the network
hosts (`GameServerHost`, `CPAPIServicehost`, `GuestControllerHostUrl`,
`MixAPIHostUrl`) in the client's built-in Tweaker console. The game
server also accepts the OpenCPI client's WebSocket transport on the
same ports, from both its older SFS2X builds and its newer SFS3 builds.

The two servers talk to each other over localhost: the game server
grants rewards server-to-server, and the WebAPI pushes player-data
changes back. See each directory's README for ports and environment
variables.

## Status

**Working, verified against real clients (retail 1.13.0 and OpenCPI):**
- Full SFS2X wire protocol: handshake, login, room join, ping, user
  variables, raw TCP and WebSocket transports, and the MMO items used for
  scheduled world objects (geysers, blinking lights).
- Multiple players in one room can see each other and each other's
  movement, with join and leave handled correctly.
- Chat, including the encrypted chat key exchange.
- Quests: setting quest state, completing objectives and granting rewards.
- Gear, pickups, consumable inventory, membership refresh, player location
  and state validation.
- SmartFoxServer 3 clients (the newer OpenCPI builds, which are what live
  players use), alongside SFS2X ones in the same room.
- Using consumables where other players can see it (`con.use` /
  `con.reuse`): one-shot props, party blasters and pinatas as MMO items
  with a countdown and coin rewards for nearby players, and trays that
  other players can take from.
- The whole WebAPI.
- Party games, tested live with the OpenCPI client: Find Four, Scavenger
  Hunt, Dance Battle and the tube races. The server owns the rules, timers,
  placements and rewards.

**Implemented, not yet checked with the real client:**
- Fish Bucket ("Ink or Swim"), the last party game: 2 to 4 players, a
  server-owned deck and turns. How the retail client's Fish and Start
  buttons reach a server is unconfirmed, so idle turns are dealt a card and
  the invitation starts by itself; the first live round settles it.
- Daily challenges counted by the server (`task.c`), including shared
  community challenges, with rewards paid once and only when complete.
  The server evaluates the scene switches most challenges depend on
  (trigger volumes, sitting, held items, outfits, interactions, "N players
  here at once") against each player's position and state.
- Igloo update broadcasts (`room.igloo_updated`) and room transient data
  (`zone.transfer`), which carries a held consumable into the next room.

**Not done yet:**
- A few daily challenges whose scene objects aren't in the game data
  (some event and zone-less ones), and the ones based on catalog
  submissions, consumable purchases and custom clothing.
- Island targets (`target.hit`), such as the jackhammer-breakable rocks.

## License

[AGPL-3.0](LICENSE). If you run a modified version as a public server,
you have to share your changes.
