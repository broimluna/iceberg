# Party games, part 1: framework and Find Four: design

- **Date:** 2026-11-07
- **Status:** design approved in chat 2026-11-07; spec awaiting review
- **Scope:** the shared party-game framework in `smartfox-server`, plus
  Find Four (template 2). Scavenger Hunt, Fish Bucket, Dance Battle and
  the tube races come later, each with its own spec, on top of this.

## Goal

Two players in the same room can play Find Four. One buys and uses the
Find Four invitation (`FindFourGroup`, 30 coins), the other accepts it,
they play a full match, and both see the result and get the placement
reward. The server owns everything that decides the outcome: turns,
token placement, wins, draws, timeouts, forfeits and rewards. Clients
only report which column they chose.

## Background: what the client expects

### Commands

| Command | Direction | Params |
|---|---|---|
| `pgame.start.v2` | server → players | `id` int (session id), `template` int, `players` UTF string: JSON `{"Players":[{"TeamId":0,"UserSessionId":<long>,"RoleId":0}, ...]}` |
| `pgame.message` | both | `id` int, `type` int (`PartyGameSessionMessageTypes`), `message` UTF string (JSON of the message class) |
| `pgame.end` | server → players | `id` int, `results` UTF string: JSON `[{"PlayerSessionId":<long>,"Placement":<int>}, ...]` |
| `reward.add_delayed` | server → player | `reward` UTF string: `SignedResponse<RewardedUserCollectionJsonHelper>` with `source` 5 (`MINI_GAME`) and `sourceId` = session id |

`pgame.start` (v1, `owner` + `players` long array) also exists, but the
client's `PartyGameManager` builds the same player list from either form.
We send v2 only, as the client's own offline tube race does.

`PartyGameManager` starts a session for **any** `pgame.start.v2` it
receives, and `FindFour.startGame` hides remote players and takes over
the camera. So the start, the messages and the end go **only to the
match's players**, never to the room.

An empty `results` list is the client's "balk" path, which closes the
game with no end popup. A non-empty list shows `PartyGameEndGamePopup`.
That popup claims the delayed reward with
`ClaimDelayedReward(MINI_GAME, sessionId)`, and the client then echoes
it to `PUT /reward/v1`. That route already returns current assets
without applying anything, so the reward isn't paid twice.

### Find Four session messages

From `FindFour.handleSessionMessage` and `sendTurnOutput`:

| Type | Name | Direction | JSON |
|---|---|---|---|
| 1 | SetGameState | server → players | `{"GameStateId": 0 Intro / 1 Game / 2 Finished}` |
| 5 | ShowTurnOutput | client → server | `{"PlayerId": <own session id>, "ScoreDelta": <column>}` |
| 5 | ShowTurnOutput | server → players | `{"PlayerId": <mover>, "ScoreDelta": <column actually used>}` |
| 6 | PlayerTurnStart | server → players | `{"PlayerId": <whose turn>}` |

Client behaviour the server has to match:
- `players[0]` is red, and the board appears at their position. Everyone
  else is blue.
- `PlayerTurnStart` is ignored unless the client is in the Game state,
  so `SetGameState{1}` must come first.
- After sending its move the client disables its controls and waits.
  Every move it sends must get a `ShowTurnOutput` back, or it is stuck.
- The client auto-sends its current column at `TurnTimeInSeconds - 1`.
- `FindFourBoard.PlaceToken(column)` drops the token itself and draws the
  win highlight from its own check. That's display only; the server's
  result is what counts.

### Lobby

`FindFourGroup` is a `partyGameLobby` consumable: `Shareable`,
`TotalItemQuantity` 1, no `RecipientConsumable`. On the wire it is the
same player-held item as a shareable tray: `con` {type `consum`, name
`FindFourGroup`} plus `con_prop` `{"actionCount":1}`. The client's
`InvitationalItemExperience` reads `actionCount`. A second player joins
by interacting with the owner, the same input as taking from a tray.
`PlayerProp` 89 (`FindFourGameServerAdded`) is the prop held during the
match. It's equipped as `con` {type `pgame`, name
`FindFourGameServerAdded`} without `con_prop`, and the client raises
`PARTYGAME_EQUIPPED` for it.

## Design

### Data: `smartfox-server/data/party-games.json`

Generated from the game's static data exports (`PartyGames.json`,
`PartyGameLaunchers.json`, plus the lobby/player props from `Props.json`),
the same way as `daily-tasks.json`. One entry per template:

```json
{
  "2": {
    "id": 2, "gameType": 2, "lobbyType": 0,
    "minPlayers": 2, "maxPlayers": 2, "numTeams": 1,
    "gameData": { "IntroTimeInSeconds": 5, "OutroTimeInSeconds": 4, "TurnTimeInSeconds": 20,
                  "ChipPlaceTimeInSeconds": 2, "PlayerProp": 89, "SequenceCountToWin": 4,
                  "GameBoardWidth": 7, "GameBoardHeight": 6, "DefaultColumn": 3 },
    "lobbyData": { "LobbyProp": 0 },
    "rewards": [ { "placement": 0, "reward": { "coins": 20, "mascotXP": { "AuntArctic": 15 } } },
                 { "placement": 1, "reward": { "coins": 10, "mascotXP": { "AuntArctic": 10 } } } ],
    "launcher": { "method": 0, "triggerProp": "FindFourGroup", "lobbyProp": null,
                  "scheduledZone": null, "everyXMinutes": 0 },
    "playerProp": "FindFourGameServerAdded"
  }
}
```

Prop ids are resolved to `NameOnServer` strings, because that's what
`con` carries. All six templates are generated now, so later games need
no generator changes. `iglooSlots: 0` and other zero fields are dropped
from the rewards.

### Modules (`smartfox-server/src/party-games/`)

- **`definitions.ts`** loads `party-games.json`. It has typed accessors
  (`getPartyGame(templateId)`) and a lookup from trigger-prop name to
  template (`templateForTrigger("FindFourGroup") → 2`).
- **`session.ts`** is the abstract `PartyGameSession`: `id`,
  `templateId`, `players` (ordered; index 0 is the owner), and a
  `timer(ms, fn)` helper whose timers all get cleared on end. It also
  provides `sendMessage(type, obj)` to the players, `end(placements)`,
  and the hooks `onStart()`, `onMessage(player, type, json)` and
  `onPlayerLeft(player)`.
- **`manager.ts`**:
  - `startSession(templateId, players)` gives out increasing session
    ids, equips every player with `con` {pgame, playerProp} (broadcast
    to the room so onlookers see the prop), sends `pgame.start.v2` to
    the players, and calls `onStart`.
  - The `pgame.message` handler parses `id`, `type` and `message`. It
    ignores the packet unless the sender is a player in that session and
    the JSON parses, and caps the message at a few KB.
  - The end path sends `pgame.end` to the players still connected,
    unequips the `con` of every player still holding the game prop,
    grants each placement's reward through `grantReward`, sends
    `reward.add_delayed` to that player, and drops the session.
  - It tracks which session each player is in (one at a time) and hooks
    room changes and disconnects into `onPlayerLeft`.
- **`find-four.ts`**: the rules (below).
- **`handlers/consumables.ts`**: `useConsumable` handles
  `partyGameLobby` by holding the invitation out like a tray (actionCount
  = `TotalItemQuantity`). In `handlePlayerInteraction`, when the holder's
  item is a `partyGameLobby` consumable, a take fills a slot instead of
  handing out a recipient item. The joiner's hands must be free and they
  can't already be in a party game; the owner can't be in one either.
  When the last slot fills, the invitation is removed and the manager
  starts the session with `[owner, ...joiners]`. Storing the invitation
  before anyone joins keeps today's behaviour (`con.partial`, item
  kept). Fish Bucket's owner-presses-Start lobby and the scheduled
  MMO-item lobbies are out of scope here.
- **Registration:** `pgame.message` goes in the extension command table,
  next to the `con.*` commands.

### Find Four rules

State: a 7×6 grid (width and height come from the data), the turn
index, and a `waiting` flag.

1. `onStart`: send `SetGameState{0}`, wait `IntroTimeInSeconds`, then
   send `SetGameState{1}` and start the owner's turn.
2. **Turn start:** send `PlayerTurnStart{PlayerId}` and arm a backstop
   at `TurnTimeInSeconds + 2` s. If no valid move has arrived by then,
   the server plays `DefaultColumn`, or the nearest open column if that
   one is full.
3. **Move** (`ShowTurnOutput` from a client): ignored unless it's from
   the player whose turn it is and the server is waiting for that
   player. Its `PlayerId` field is ignored; the sender's own session id
   is used. A column that isn't a number is treated as `DefaultColumn`,
   and out-of-range or full columns become the nearest open column
   (ties go to the lower index). Then the server places the token, sends
   `ShowTurnOutput{mover, column}` to both players and clears the
   backstop.
4. After `ChipPlaceTimeInSeconds`, the server checks for a win
   (`SequenceCountToWin` in a row, horizontally, vertically or on either
   diagonal, through the new token) or a full board:
   - Win: placements are winner 0, other player 1.
   - Full board: it's a draw, and both players get placement 1 (the
     second-place reward), so draws can't be farmed for first.
   - Otherwise: the next player's turn.
5. **End:** send `SetGameState{2}`, wait `OutroTimeInSeconds`, then end
   with the placements.
6. **A player leaving** (disconnect or room change) before the end: the
   player who stays wins (placement 0). Their match ends at once, with
   no outro, so their client isn't left waiting. `results` lists only
   the player who stayed, because the end popup looks up every listed
   player and the leaver's avatar is gone. The leaver gets no
   `pgame.end` and no reward.

### Rewards

Each player's `rewards[placement]` reward is granted with `grantReward`
the moment the session ends, so it's paid even if the client never
claims it. `reward.add_delayed` with that same reward is sent to that
player only:
`{"goodUntil":0,"signature":"","swid":"","data":{"source":5,"sourceId":"<session id>","rewards":{"<playerSessionId>":{...}}}}`.
Placements without a reward entry get nothing.

### Timing in tests

`PARTY_GAME_TIME_SCALE` (env, default 1) multiplies every party-game
delay, so tests can run a whole match in well under a second. It's read
once at startup and has no other effect.

## Error handling

- `pgame.message` with an unknown session, from a non-player, with bad
  JSON or with an unknown type is logged and ignored.
- Every session callback (message handler and timer) runs in a
  try/catch. If one throws, the session ends with empty `results` (the
  client's balk path), so no client is left stuck, and nobody is paid.
- An invalid `templateId`, or a missing player prop in the data, means
  the session doesn't start. The invitation stays as a held item, and
  the problem is logged.
- `grantReward` failures are logged and don't block the end (the same
  as for party blasters).

## Docs

- `docs/SMARTFOX_PACKETS_DOCUMENTATION.md`: replace the party game
  section with the commands, session message types, Find Four messages
  and lobby flow above.

## Testing

`tools/party-games-test.ts` in iceberg is a fake-client end-to-end test
using a temp WebAPI (`lib/harness.ts`), the game server on its own port,
and `PARTY_GAME_TIME_SCALE=0.01`. Three clients log in to the same room:
owner, guest and spectator. It checks:

1. The owner's `con.use FindFourGroup` makes the room see a held item
   with `{"actionCount":1}`.
2. When the guest interacts with the owner, both get `pgame.start.v2`
   with the owner first, and the spectator gets no `pgame.*`. All three
   see both players' `con` set to {pgame, `FindFourGameServerAdded`}.
3. The order is intro state 0, then state 1, then `PlayerTurnStart` for
   the owner.
4. A guest move during the owner's turn is ignored, with no
   `ShowTurnOutput`.
5. A move into a full column is placed in the nearest open column, and
   both players get that column.
6. Wins: horizontal, vertical and both diagonals. Each gives
   `pgame.end` with the right placements, coins in the WebAPI database
   (20 for the winner, 10 for the loser) and `reward.add_delayed` to
   each player with the right `sourceId`. `con` is cleared afterwards.
7. A draw (a scripted full board) gives placement 1 to both.
8. The turn timeout: with no move, the server plays `DefaultColumn`.
9. Forfeit: the guest disconnects mid-match, the owner gets `pgame.end`
   with placement 0 and is paid.
10. The guarantees: a player can't join a second game while in one, a
    non-player's `pgame.message` is ignored, and a malformed message
    doesn't crash the server.

The existing suites cover regressions: the held-consumable tests (the
tray path changes) and the SFS3 harness (new extension responses).
Then there's a live test with two OpenCPI clients.

## Out of scope (later specs)

Scavenger Hunt (same lobby, a 2-player hide/find), Fish Bucket (lobby
with an owner Start button, card decks), the scheduled MMO-item lobbies
(Dance Battle in Town, the tube races on Mt Blizzard), daily-challenge
hooks for party games, and `pgame.start` v1.
