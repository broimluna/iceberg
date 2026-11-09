# Club Penguin Island - SmartFox Packet Documentation

Catalogs every SmartFox packet type the retail 1.13.0 client sends and
receives, at all three layers: standard SmartFoxServer 2X system
requests/events (the real SFS2X SDK, `SmartFox2X.dll`), SFS2X **User
Variables** (a standard SFS2X mechanism CPI uses for room-broadcast
player state), and CPI's own custom Zone/Room **Extension commands**
(the real CPI game-logic packets). Companion to
`API_ENDPOINTS_DOCUMENTATION.md` for the WebAPI side.

**Sourcing**: extracted directly from decompiled client code (Mono,
`ilspycmd`) - see `00-client-1.13.0-android-teardown.md` for the
toolchain. All class/line references point into
`ClubPenguinClient.decompiled.cs` unless stated otherwise
(`client-build/clients/android/decompiled/`, gitignored - re-decompile
from the client to regenerate). Every command name, wire key, and field
type below is copied verbatim from real code, not inferred - where a
field's exact meaning wasn't obvious from the variable/method name
alone, that's said explicitly rather than guessed.

---

## Part 1: Standard SFS2X protocol (built into the SDK, not CPI-specific)

This layer exists for any SmartFoxServer 2X game - a from-scratch
reimplementation of our own SFS2X server needs to speak this regardless
of CPI-specific logic. Full class list: `SmartFox2X.decompiled.cs`,
namespaces `Sfs2X.Requests` (line 11032), `Sfs2X.Requests.Buddylist`
(13195), `Sfs2X.Requests.Game` (13459 and 39751), `Sfs2X.Requests.MMO`
(13980).

### 1.1 Outgoing system requests (client -> server), with wire type codes

The `RequestType` enum (`SmartFox2X.decompiled.cs:12596`) gives the
**exact numeric wire-protocol type ID** for every standard request:

| Code | Request | Code | Request |
|---|---|---|---|
| 0 | Handshake | 17 | SpectatorToPlayer |
| 1 | Login | 18 | PlayerToSpectator |
| 2 | Logout | 19 | ChangeRoomCapacity |
| 3 | GetRoomList | 20 | PublicMessage |
| 4 | JoinRoom | 21 | PrivateMessage |
| 5 | AutoJoin | 22 | ModeratorMessage |
| 6 | CreateRoom | 23 | AdminMessage |
| 7 | GenericMessage | 24 | KickUser |
| 8 | ChangeRoomName | 25 | BanUser |
| 9 | ChangeRoomPassword | 26 | ManualDisconnection |
| 10 | ObjectMessage | 27 | FindRooms |
| 11 | SetRoomVariables | 28 | FindUsers |
| 12 | **SetUserVariables** | 29 | PingPong |
| 13 | **CallExtension** | 30 | SetUserPosition |
| 14 | LeaveRoom | 200 | InitBuddyList |
| 15 | SubscribeRoomGroup | 201-205 | AddBuddy, BlockBuddy, RemoveBuddy, SetBuddyVariables, GoOnline |
| 16 | UnsubscribeRoomGroup | 300-304 | InviteUser, InvitationReply, CreateSFSGame, QuickJoinGame, JoinRoomInvite |

**Three type codes matter for CPI**: 1 (`Login`, traced in
`04-build-order-and-sfs2x-auth-handoff.md` - username set, password
always `""`, real auth proof is the `joinRoomData` param), 12
(`SetUserVariables` - see Part 2 below), and 13 (`CallExtension` - see
Part 3, every CPI-specific packet). Buddylist (200s) and SFSGame/
invitation (300s) requests: present in the SDK, **no CPI call sites
found** in `ClubPenguinClient.dll`/`ReMix-Game.dll` - likely unused
(friends are handled by the Mix/Account WebAPI instead, per
`02-server-architecture-from-memory.md`). Worth confirming rather than
assuming before deprioritizing.

### 1.2 Incoming system events (server -> client)

Full constant list, `SmartFox2X.decompiled.cs:3979-4081`
(`Sfs2X.Core.SFSEvent`):

```
connection, connectionLost, connectionRetry, connectionResume,
connectionAttemptHttp, handshake, udpInit, pingPong, socketError,
configLoadSuccess, configLoadFailure, cryptoInit,
login, loginError, logout,
roomAdd, roomRemove, roomCreationError, roomJoin, roomJoinError,
roomNameChange, roomNameChangeError, roomPasswordStateChange,
roomPasswordStateChangeError, roomCapacityChange, roomCapacityChangeError,
roomFindResult, roomGroupSubscribe, roomGroupUnsubscribe,
roomGroupSubscribeError, roomGroupUnsubscribeError,
userEnterRoom, userExitRoom, userCountChange, userFindResult,
userVariablesUpdate, roomVariablesUpdate,
publicMessage, privateMessage, moderatorMessage, adminMessage, objectMessage,
extensionResponse,
spectatorToPlayer, playerToSpectator, spectatorToPlayerError, playerToSpectatorError,
invitation, invitationReply, invitationReplyError,
proximityListUpdate, mmoItemVariablesUpdate
```

**Two matter most for CPI**: `userVariablesUpdate` (Part 2) and
`extensionResponse` (Part 3) - the command name arrives in
`evt.Params["cmd"]` (`ClubPenguinClient.decompiled.cs:2047`).

**Disconnect reason** (system controller 0, action 1005,
`ClientDisconnection`): `dr` = byte index into the reason list (0 idle,
1 kick, 2 ban). The client disconnects with that reason. SFS3 handles the
same action and key (`ResClientDisconnect`; its fourth reason, 3, is
"unknown", the only one it reconnects after). The server sends 1 for
`:kick` and 0 for `:admin-swre-restart`.

Lower-level transport events also present, connection plumbing only:
`Sfs2X.Bitswarm.BBox.BBEvent` (bb-connect, bb-disconnect, bb-data,
bb-ioError, bb-securityError - the BlueBox/HTTP tunneling fallback) and
the base `Sfs2X.Core.BaseEvent` family (connect, disconnect,
reconnectionTry, ioError, securityError, dataError). Buddylist events
(`SFSBuddyEvent`, `SmartFox2X.decompiled.cs:3951-3965`): same
"no confirmed CPI use" caveat as 1.1's buddylist requests.

---

## Part 2: SFS2X User Variables (room-broadcast player state)

**A distinct channel from Part 3's Extension commands** - discovered
while tracing outgoing calls, easy to miss since it doesn't go through
`ExtensionRequest`/`CallExtension` at all. This is the *standard* SFS2X
User Variables mechanism (`SetUserVariablesRequest`, type 12 above): a
value set here is attached to the user's presence in the room and
**broadcast automatically by the server to everyone else in the room**
on change (`userVariablesUpdate` event) - no explicit request/response
round trip, no custom Extension logic needed server-side beyond
accepting the `SetUserVariablesRequest` and rebroadcasting, which is
core SFS2X behavior, not CPI-specific code.

All 12 confirmed, `SocketUserVars` enum
(`ClubPenguinClient.decompiled.cs:7904`), each tagged with its real wire
key + SFS2X value type via `[SocketUserVar(key, type)]`:

| Wire key | Enum name | Type | Set via (client method) |
|---|---|---|---|
| `outfit` | `OUTFIT` | STRING | `SetOutfit(SignedResponse<PlayerOutfitDetails>)` |
| `proto` | `PROTOTYPE` | STRING | `PrototypeSetState(object)` |
| `con` | `EQUIPPED_OBJECT` | OBJECT | `EquipConsumable(string type)` / `DequipeHeldObject()` (sic - typo in client). While the server has `con_prop` set on the player, their own `con` change is not echoed as is (with the old `con_prop` it would read as a new held item): the server sends the removal and the new `con` instead, or nothing if it's the same item. |
| `bubble` | `AIR_BUBBLE` | OBJECT | `SetAirBubble(float, int)` / `RemoveAirBubble()` |
| `con_prop` | `EQUIPPED_OBJECT_PROPERTIES` | STRING | Server-set JSON `{"actionCount": n}`. With `con` it makes a `PlayerHeldItem` (a held tray or an item taken from one): `con` and `con_prop` changed together = item added, `con_prop` alone = item changed, both NULL = item removed. |
| `sess` | `SESSION_ID` | STRING | Not set by this client code - read-only here (`getSessionId(User)` reads it back via `user.GetVariable(...)`); almost certainly set server-side per-connection |
| `loc` | `LOCOMOTION_STATE` | INT | `SetLocomotionState(LocomotionState)` |
| `colour` | `PROFILE` | STRING | `SetProfile(SignedResponse<Profile>)` - note the wire key is `colour` despite the C# name being generic `PROFILE` |
| `on_quest` | `ON_QUEST` | STRING | (declared; no direct setter call site found) |
| `awayfromkeyboard` | `AWAY_FROM_KEYBOARD` | INT | `SetAwayFromKeyboard(int)` |
| `tube` | `SELECTED_TUBE` | STRING | `SetSelectedTube(SignedResponse<EquipTubeResponse>)` |
| `tempheadstatus` | `TEMPORARY_HEAD_STATUS` | INT | `SetTemporaryHeadStatus(int)` |

All setters funnel through one `updateUserVars(...)` helper
(`ClubPenguinClient.decompiled.cs` near line 1690) which only sends a
var that actually changed (`addIfChanged`), then issues one
`SetUserVariablesRequest(list)` covering everything changed in that
call - i.e. these can and do batch into a single wire packet.
`getSessionId(User)`/`getSessionId(int? userId)` (`:2531`, `:2537`) -
used throughout Part 3's incoming handlers - resolve a room-local
`userId`/`User` to the actual session ID by reading this `sess` variable
back off them, not from anything Extension-side.

---

## Part 3: CPI's custom Extension commands (the real game logic)

All 39 commands travel as `CallExtension` (type 13) packets, resolved
through one exhaustive enum: `SmartfoxCommand`
(`ClubPenguinClient.decompiled.cs:7652`), each tagged with its real wire
string via `[SmartfoxCommands("...")]`, parsed back on receipt via
`SmartFoxCommand.FromString()` (`:7756`) - confirmed bidirectional, same
names both ways. Every command below now has its real field-level
payload traced from either the outgoing constructor or the incoming
dispatch switch (`:2047`-`:2205`) or both - only a couple of true edge
cases remain unconfirmed, called out explicitly where that's the case.

**Universal serialization notes** (apply to everything below): payloads
are `ISFSObject`/`SFSObject` (`Sfs2X.Entities.Data`,
`SmartFox2X.decompiled.cs:6741`); CPI's helper is
`SmartFoxGameServerClientShared.serialize(...)`; many fields are
themselves JSON strings (`mt.JsonService.Serialize(...)`) wrapped inside
one SFSObject string field, not native SFSObject nesting - read `.GetUtfString(key)`
then JSON-deserialize, don't expect a native nested object. Many
payloads are also `SignedResponse<T>`-wrapped JSON (see
`05-recovered-original-api-docs.md` - `{goodUntil, swid, data, signature}`,
signature can be any string for a private server).

### Chat

| Wire | Enum | Dir | Payload |
|---|---|---|---|
| `chat.msg` | `CHAT` | BOTH | OUT: `msg` = JSON `SignedResponse<ChatMessage>`, encrypted via `SmartFoxEncryptor.EncryptParameter` if a key's been established. IN: `msg` -> JSON-deserialized `ReceivedChatMessage`. |
| `chat.activity` | `CHAT_ACTIVITY` | BOTH | No payload either direction - a bare typing-indicator-start ping. IN triggers `CHAT_ACTIVITY_RECEIVED` with just the sender's session ID (resolved from `senderId`/`userId`, not a packet field). |
| `chat.activity_cancel` | `CHAT_ACTIVITY_CANCEL` | BOTH | Same shape as above, typing-indicator-stop. |

System messages: the OpenCPI client draws a `ReceivedChatMessage` whose
`message` starts with U+200B as a system message, and U+200B U+200C as a
system error (blocked-chat style). The server uses these, addressed only
to the player and with their own `senderSessionId`/`senderId`, to answer
staff commands (`smartfox-server/README.md`). Other clients show the text
as normal chat; the prefix characters are invisible.

### Time & encryption (the connection-setup sequence)

| Wire | Enum | Dir | Payload |
|---|---|---|---|
| `time.get` | `GET_SERVER_TIME` | BOTH | OUT: `ct` = a locally-generated request counter (`timestampRequestCount++`), used to correlate the reply and measure round-trip time. IN: `ct` (echoed counter) + `st` (server time) - client computes `serverTime + roundTrip/2` as its synced clock (`timeStampRecieved`). |
| `time.error` | `SERVER_TIME_ERROR` | IN | No payload - client just retries `fetchServerTimestamp`. |
| `encryption.get` | `GET_ROOM_ENCRYPTION_KEY` | BOTH | **Real RSA key exchange, fully traced**: client generates/holds an RSA keypair locally (`CPKeyValueDatabase.GetRsaParameters()`), sends `pkm` (modulus, base64) + `pke` (exponent, base64) as its **public** key. Server is expected to encrypt a symmetric key with it and return `ek` (base64, RSA-encrypted) - client decrypts locally to get the actual key, which then initializes `SmartFoxEncryptor` (`:2274`) for all subsequent `chat.msg`-style encrypted params. Fetched automatically right after the first successful time sync (`fetchEncryptionKeyAfterwards` flag on `fetchServerTimestamp`). |
| `encryption.error` | `ENCRYPTION_KEY_ERROR` | IN | No payload - treated as fatal: client tears down the connection and raises `ROOM_JOIN_ERROR`. |

### Movement (highest-frequency packet)

| Wire | Enum | Dir | Payload |
|---|---|---|---|
| `l.a` | `LOCOMOTION_ACTION` | BOTH | `a` = action type (byte, `LocomotionAction` enum), `p` = position (Vec3), `t` = server timestamp (long) - always present. `d` = direction (Vec3), `v` = velocity (Vec3), `o` = object (JSON `ActionedObject`) - optional, only when relevant to the action type. Sendable UDP (`droppable` flag on `send()`) - the one command confirmed to use CPI's UDP path, consistent with being the highest-frequency traffic. IN: session ID comes from the sender's room `userId`, not a packet field (same pattern as chat activity). |

### Prototype / debug channel

| Wire | Enum | Dir | Payload |
|---|---|---|---|
| `proto` | `PROTOTYPE` | BOTH | OUT (`PrototypeSendAction`): `data` = JSON string, caller-defined shape. IN: `data` -> parsed as a generic `LitJson` object (`JsonMapper.ToObject`, not a fixed C# type) plus the sender's session ID. A prototyping channel: no shipped game code (OpenCPI included) sends it or listens for it, so iceberg doesn't relay it. There's also a *separate* `PROTOTYPE` User Variable (Part 2) for per-user prototype state, which the client sets itself. |

### Quests

| Wire | Enum | Dir | Payload |
|---|---|---|---|
| `quest.c_obj` | `COMPLETE_OBJECTIVE` | OUT | `obj` = objective identifier (string). |
| `quest.set` | `SET_QUEST_STATES` | BOTH | OUT: `data` = JSON `SignedResponse<QuestStateCollection>`, the collection the web API returned (sent on every room join). iceberg seeds the session's objective list (what `quest.s_obj` reports) from the active quest's `completedObjectives`. The web API signs this collection with a placeholder, so the game server can't verify it: a client can seed any objectives. That changes only what `quest.s_obj` echoes back; quest rewards come from the objectives the web API recorded itself. IN: no payload consumed - just a sync-complete trigger (`QUEST_DATA_SYNCED`). |
| `quest.s_obj` | `SERVER_OBJECTIVE_COMPLETED` | IN | `data` -> JSON `SignedResponse<QuestObjectives>`. |
| `quest.error` | `SERVER_QUEST_ERROR` | IN | No payload - generic `QUEST_ERROR` event. |

### Consumables

| Wire | Enum | Dir | Payload |
|---|---|---|---|
| `con.set` | `SET_CONSUMABLE_INVENTORY` | OUT | `data` = JSON `SignedResponse<ConsumableInventory>`. |
| `con.use` | `USE_CONSUMABLE` | BOTH | OUT: `type` = JSON `SignedResponse<UsedConsumable>` (`type`, `partialCount`), `prop` = JSON caller-defined properties (a Vector3 drop point for world consumables). IN: `senderId` + `type` string. The client passes the IN `type` to `UsePropCMD` as the experience instance id, not as a consumable name; for one-shot props that id is the user's session id. Only one-shot consumables get an IN `con.use`; world consumables are driven by `con.mmoitemdeployed` and the MMO item. |
| `con.reuse` | `REUSE_CONSUMABLE` | OUT | `type` = string, `prop` = JSON properties object. Sent only for `QuestOnly` consumables when not on the prototype quest; nothing is spent. |
| `con.reuse_error` | `REUSE_FAILED` | IN | `type` = string, `prop` -> `LitJson`-parsed properties. |
| `con.mmoitemdeployed` | `CONSUMABLE_MMO_DEPLOYED` | IN | `ownerId` (user id) + `senderId` (the MMO item id, not a user) -> `SessionId`/`ExperienceId`. Both keys required or the event is dropped. Must arrive before the owner's `con` user variable is cleared, so the owner's prop isn't stored on dequip. |
| `con.partial` | `SET_CONSUMABLE_PARTIAL_COUNT` | IN | `data` -> JSON `SignedResponse<UsedConsumable>` (`type`, `partialCount`). Sent when a player puts away a tray that still has items; the client stores it with `POST /consumable/v1/partial` and sends it back as `partialCount` in the next `con.use`. |

### Rewards

| Wire | Enum | Dir | Payload |
|---|---|---|---|
| `reward.add` | `RECEIVED_REWARDS` | IN | `reward` -> JSON `SignedResponse<RewardedUserCollectionJsonHelper>`. |
| `reward.add_delayed` | `RECEIVED_REWARDS_DELAYED` | IN | Same shape as above. The client holds it until something claims it by `(source, sourceId)` (`ClaimDelayedReward`), then echoes it to `PUT /reward/v1`. Party games send it with `source` 5 (`MINI_GAME`) and `sourceId` = the session id, and their end popup claims it. |
| `reward.room` | `RECEIVED_ROOOM_REWARDS` | IN | `reward` -> JSON `SignedResponse<InRoomRewards>`. (Enum name has the typo `ROOOM` - three O's - verbatim in the client, keep it if this needs to round-trip against real client behavior.) |
| `reward.levelup` | `PROGRESSION_LEVELUP` | IN | `level` = int + sender session ID. |
| `reward.broadcast` | `SEND_EARNED_REWARDS` | OUT | `reward` = JSON `SignedResponse<RewardedUserCollectionJsonHelper>` - client broadcasting its own earned rewards (to the room? to other systems?) rather than receiving them. |

### Room / igloo / zone

| Wire | Enum | Dir | Payload |
|---|---|---|---|
| `room.igloo_updated` | `IGLOO_UPDATED` | BOTH | **Asymmetric keys**: OUT uses `igloo_data` (JSON `SignedResponse<IglooData>`, sent `asText: true`) after the owner saves through the WebAPI. IN uses `igloo_id` (plain string), which the client passes to `POST /igloo/v1/iglooId/layout/active` before reloading the igloo scene. The igloo id is the owner's SWID (the igloo ZoneId's `instanceId`). Only other players in the igloo need the IN packet. |
| `room.force_leave` | `FORCE_LEAVE` | IN | `zone_id` -> JSON-deserialized `ZoneId`. Server-forced room eviction. |
| `zone.logout` | `LEAVE_ROOM` | OUT | No payload - bare notification before leaving. |
| `zone.transfer` | `ROOM_TRANSIENT_DATA` | IN | `d` -> JSON `SignedResponse<TransientData>` (`equippedConsumable`, `equippedConsumableProperties`, `questCurrentObjectiveData`, `questObjectiveState`), stored as `mt.LastRoomTransientData`. Server-pushed when the player leaves a room; the client sends it back as `transientData` (UTF string) in the next Login request's params and clears it once that room join completes or fails. |
| `zone.player_location` | `GET_PLAYER_LOCATION` | BOTH | OUT: `swid` = the target player's SWID (string) - a *lookup by SWID*, not a broadcast. IN: `pos` -> a Vec3 (`deserializeVec3`), no session/SWID echoed back in the payload itself - correlate by request order, not a response ID. |
| `zone.player_notfound` | `PLAYER_NOT_FOUND` | IN | No payload - error response to the above when the SWID lookup misses. |

### Tasks (daily challenges)

| Wire | Enum | Dir | Payload |
|---|---|---|---|
| `task.p` | `PICKUP` | OUT | `id` = string (item identifier), `t` = string (a tag), `p` = position (Vec3). Full 3-field trace, method signature `Pickup(string id, string tag, Vector3 position)`. |
| `task.c` | `TASK_COUNT` | IN | `t` = task ID (string), `c` = counter (int) - plain fields, not JSON-wrapped, unusual for this protocol (most things are JSON strings inside SFSObject fields; this one uses native SFSObject typing directly). |
| `task.r` | `TASK_PROGRESS` | IN | `d` -> JSON `SignedResponse<TaskProgress>`. |

### Membership, validation, equipment

| Wire | Enum | Dir | Payload |
|---|---|---|---|
| `membership.refresh` | `MEMBERSHIP_REFRESH` | OUT | `rights` = JSON `SignedResponse<MembershipRightsRefresh>`. |
| `validate.state` | `GET_SIGNED_STATE` | BOTH | OUT: **no payload** (`GetSignedStateOfLocalPlayer()` calls bare `send(SmartfoxCommand.GET_SIGNED_STATE)`). IN: `data` -> JSON `SignedResponse<InWorldState>`. A parameterless "give me a fresh signed state" request - directly relevant to the auth/session work in `04-`/`05-...md`. |
| `durable.equip` | `EQUIP_DURABLE` | OUT | `type` = JSON `SignedResponse<EquipDurableResponse>` (despite the key name `type`, the value is the full signed equip response, not a bare type string). |
| `dispensable.equip` | `EQUIP_DISPENSABLE` | OUT | `type` = int (an item ID, despite the key name) - genuinely simpler than `EQUIP_DURABLE` above, no signed wrapper. |

### Web service bridge

| Wire | Enum | Dir | Payload |
|---|---|---|---|
| `wsevent.{0}` | `WEBSERVICE_EVENT` | OUT | **Resolved**: `{0}` is substituted with `wsEvent.Data.type` at call time (`SendWebServiceEvent(SignedResponse<WebServiceEvent> wsEvent)`, `string.Format`) - so the real wire command is `wsevent.<the WebServiceEvent's own type field>`, a small family of dynamically-named commands, not one fixed string. Payload: `d` = JSON `SignedResponse<WebServiceEvent>` (the full wrapper, sent again even though `type` was already used to build the command name). The client forwards every entry of a WebAPI response's `wsEvents` this way and expects no reply. `WebServiceEvent` = `{type: int, details: JSON}`; the only type the client's offline server produces is 1, a fishing catch, with `details` = the winning reward name. |

### Server notices (OpenCPI client)

Not in the retail client: clients without them ignore unknown commands
(`SmartFoxCommand.FromString` returns null and `onExtensionResponse`
returns early).

| Wire | Dir | Payload |
|---|---|---|
| `server.alert` | IN | `message` (utf_string, at most 500 characters): shown as a popup. Sent by `:admin-alert` and the restart countdown. |
| `server.restarting` | IN | `message` = a localization key, `GlobalUI.ErrorMessages.ServerRestarting`: the "server restarting" popup. Sent when a `:admin-swre-restart` countdown starts. |

### Party games

| Wire | Enum | Dir | Payload |
|---|---|---|---|
| `pgame.start` | `PARTY_GAME_START` | IN | `owner` (long), `id` -> sessionId (int), `template` -> templateId (int), `players` (long array). The client builds the same player list as v2 from it. iceberg sends v2 only. |
| `pgame.start.v2` | `PARTY_GAME_START_V2` | IN | `id` -> sessionId (int), `template` -> templateId (int, `PartyGameDefinition.GameTypes`), `players` -> JSON `PartyGamePlayerCollection` `{"Players":[{"TeamId":0,"UserSessionId":<long>,"RoleId":0}, ...]}`. `Players[0]` is the owner. |
| `pgame.end` | `PARTY_GAME_END` | IN | `id` -> sessionId (int), `results` -> JSON `List<PartyGameEndPlayerResult>` `[{"PlayerSessionId":<long>,"Placement":<int>}]`, reshaped client-side into a `sessionId -> placement` map. An empty list closes the game with no end popup; otherwise `PartyGameEndGamePopup` shows every listed player. |
| `pgame.message` | `PARTY_GAME_MESSAGE` | BOTH | `id` = sessionId, `type` = `PartyGameSessionMessageTypes`, `message` = JSON of that type's `PartyGameSessionMessages` class. Same keys both ways, but OUT sends `id` and `type` as **LONG** (`SmartFoxGameServerClientShared.serialize` has no int overload, so ints widen to long); IN reads them as INT (`GetInt`). |

The client's `PartyGameManager` starts a session for **any** `pgame.start.v2`
it receives (the game hides remote players and takes over the camera), so
`pgame.start.v2`, `pgame.message` and `pgame.end` go to the game's players
only. Placement rewards go to each player as `reward.add_delayed` with
`source` 5 (`MINI_GAME`) and `sourceId` = the session id; the end popup
claims them (`ClaimDelayedReward`), which echoes the reward to
`PUT /reward/v1`. Session ids in the JSON are numbers and can exceed 2^53.

`PartyGameSessionMessageTypes`:

| # | Name | # | Name |
|---|---|---|---|
| 0 | SetRole | 7 | PlayerLeftGame |
| 1 | SetGameState | 8 | PlayDanceMoves |
| 2 | AddItem | 9 | DanceMoveSequenceComplete |
| 3 | RemoveItem | 10 | SetTubeRaceModifierLayout |
| 4 | SetGameStartPositions | 11 | CollectTubeRaceScoreModifier |
| 5 | ShowTurnOutput | 12 | PlayerFinishedTubeRace |
| 6 | PlayerTurnStart | 13 | TubeRacePlayerResult |

#### Invitations (`partyGameLobby` consumables)

`ScavengerHuntGroup`, `FishBucketGroup` and `FindFourGroup` are held out like
a shareable tray: `con` {type `consum`, name} plus `con_prop`
`{"actionCount": open slots}` (`TotalItemQuantity`), read by the client's
`InvitationalItemExperience`. Another player accepts by interacting with
the holder (`l.a` Interact on the player). When the last slot fills, the
invitation is removed (`con` + `con_prop` NULL) and the game starts about a
second later. The gap matters: the SFS client applies user variables on
arrival but dispatches their change events once per frame, so a game `con`
landing in the same frame as the removal makes the removal's handler throw
(it reads the new `con` with no `con_prop`) and the invitation never closes. During
the game each player holds the game's `PlayerProp` as `con` {type `pgame`,
name} with no `con_prop` (the client raises `PARTYGAME_EQUIPPED`), shown to
the whole room and cleared at the end.

#### Find Four (template 2)

| Type | Dir | `message` |
|---|---|---|
| 1 SetGameState | IN | `{"GameStateId": 0 Intro / 1 Game / 2 Finished}`. `PlayerTurnStart` is ignored outside Game. |
| 6 PlayerTurnStart | IN | `{"PlayerId": <long>}`. The client enables its controls if it's the local player and auto-sends its current column at `TurnTimeInSeconds - 1`. |
| 5 ShowTurnOutput | OUT | `{"PlayerId": <own id>, "ScoreDelta": <column>}`, then controls off until the echo. |
| 5 ShowTurnOutput | IN | `{"PlayerId": <mover>, "ScoreDelta": <column>}`. The client drops the token there (and draws its own win highlight). |

`Players[0]` is red and moves first. iceberg decides turns, columns (a full
or invalid column becomes the nearest open one), wins, draws (both players
get placement 1) and forfeits (the player who stays gets placement 0 and is
the only one in `results`). A player quits by putting the game prop away
(their own `con` change); the client then waits for `pgame.end`, so the match
ends at once for both: the one who stays at 0, the quitter listed at 1 with
no reward (the owner's end screen looks up its own placement). Rules and timings come from `GameData` in
`smartfox-server/data/party-games.json`.

#### Scheduled lobbies (Dance Battle, tube races)

Templates with launcher method 1 (ZoneSchedule) open a lobby in every room
of their zone (the room name's third `:` field) on multiples of
`EveryXMinutesAfterTheHour` since the epoch, for `LobbyLengthInSeconds`. A
room has at most one lobby per template (Mt Blizzard runs red and blue at
once) and a player is in at most one. The lobby is a room MMO item
(`PartygameLobbyMmoItem`): `category` 6, `creator` 0, `int_a` template,
`ttl` seconds (all INT: the client reads them with `IntValue`, which throws
on a double), `statetimestamp` (string, epoch seconds), `score` (string,
the roster as `PartyGamePlayerCollection`). Joining is an `l.a` Interact
with `o` `{"type":1,"id":"<item id>"}`: the server equips the lobby prop
(`con` {type `pgame`}) and, when `LobbyLocomotionState` is non-zero, sets
`loc` (tubes: 1 Slide). Putting the lobby prop away (the client's X button
clears its own `con`) leaves the lobby. When the time is up the prop comes
off and the game starts about a second later.

#### Tube races (templates 4 red, 5 blue)

| Type | Dir | `message` |
|---|---|---|
| 10 SetTubeRaceModifierLayout | IN | `{"ModifierLayoutId": n}`: which of the course's three modifier layouts the client shows. |
| 11 CollectTubeRaceScoreModifier | OUT | `{"ModifierId": n}`, when the racer touches a modifier. |
| 12 PlayerFinishedTubeRace | OUT | `{}`, when the racer crosses the finish. |
| 13 TubeRacePlayerResult | IN | `{"PlayerId": <long>, "CompletionTimeInMilliseconds": <long>, "ScoreModifier": n, "OverallScore": n}`. The local player's own result opens its end popup ("calculating" until `pgame.end`); others add rows. |

`loc` is 7 (Racing) during the race and 0 after. The server times each
racer from the start; a finish under `MinimumCompletionTimeInSeconds`, over
`MaximumCompletionTimeInSeconds` or more than `MaxValidationRadius` from
`RaceEndPosition` (last reported position) scores `DefaultPoints`, and so
does a path that teleports: the path starts at the lobby's `LobbyLocation`,
and a jump of more than 20 m between two positions, or any stretch of at
least 1 s averaging more than 30 m/s (the tube tops out at 12 m/s), is
invalid. Every finish is logged (`[TUBE] ... valid= reason= maxJump=
maxSpeed=`). A claimed
modifier counts only if it is in the active layout and the racer's reported
path passed within 3 m of it (positions in
`smartfox-server/data/tube-races.json`). Score =
`StartingPoints - ms * PointsDeductedPerSecond / 1000 + modifiers`. The race
ends when everyone has a result, or at the maximum time plus 5 s, when the
unfinished get a `DefaultPoints` result; `pgame.end` follows
`ShowRewardsDelayInSeconds` later. Valid racers are placed first, by score
then time, then invalid and unfinished ones by time, capped at 4. A lone
racer, or the only valid racer, gets `SinglePlayerPlacement` (the others
come after), so an idle second account doesn't turn a solo run into a win.
Invalid and unfinished racers are placed but not paid.

---

## Implementation notes

1. **Encryption is a real RSA handshake, not a shared secret** - see
   `encryption.get` above. Client-generated RSA keypair, server encrypts
   a session key with the client's public modulus/exponent, client
   decrypts locally. Once established, applies connection-wide
   (`ClubPenguinClient.decompiled.cs:1380`, `:2038` - checked
   unconditionally, not per-command) via `SmartFoxEncryptor`
   (`:2274`, `:13861`). Related, not yet explored: `CPEncryptor`
   (`:13408`), `RsaEncryptor` (`:13839`).
2. **Three distinct channels, don't conflate them**: (a) standard SFS2X
   system requests (Part 1 - login, room join, raw transport), (b) User
   Variables (Part 2 - room-broadcast persistent player state, no custom
   server logic needed beyond accepting `SetUserVariablesRequest`), (c)
   Extension commands (Part 3 - CPI's actual custom game logic, needs a
   real server-side handler per command). A server that only implements
   (c) and ignores (b) will silently break anything relying on outfit/
   profile/locomotion-state broadcast to other room occupants.
3. **`SFSObject` fields are usually JSON-in-a-string, not native
   nesting** - `.GetUtfString(key)` then `JsonService.Deserialize<T>`
   is the dominant pattern; a few commands (`task.c`'s `c`, `l.a`'s
   `a`/`t`) use native SFSObject scalar typing directly instead. Check
   which pattern a given field uses rather than assuming.
4. **Short field keys are a real client-wide convention**, not just
   movement - `zn`/`un`/`pw`/`p`/`pi`/`id`/`rl`/`rs` for the base
   `LoginRequest` (`SmartFox2X.decompiled.cs:12313-12327`) follow the
   same pattern.
5. **Not every OUT/IN pair is symmetric in shape** - `con.use`,
   `room.igloo_updated`, and `pgame.start` vs `pgame.start.v2` all send
   and receive meaningfully different payloads. Don't assume a
   round-trip echoes the same fields back.
6. **Confirmed from `04-build-order-and-sfs2x-auth-handoff.md`**: real
   auth doesn't happen in Part 3 at all - `Login` (Part 1, type 1)
   always carries an empty password, the actual proof is `joinRoomData`.
   None of these 39 commands re-authenticate; they all assume a session
   already established at login time.

## Status: closed out

Every item originally listed here is resolved - see
`06-room-join-flow-and-remaining-items.md` for the full detail on each:

- `pgame.start.v2`'s `players` shape - resolved (`PartyGamePlayerCollection`
  JSON, `PartyGame.dll`).
- Buddylist/SFSGame system requests - **confirmed genuinely unused**,
  not just unsearched. All 109 of 109 managed DLLs decompiled and
  searched; zero construction sites anywhere outside
  `ClubPenguinClient.dll`, which itself has none.
- `con_prop`/`on_quest` User Variables - **confirmed read-only from the
  client** (`user.GetVariable(...)` call sites only, no setter anywhere
  in all 109 assemblies) - these are server-authored values our server
  needs to *set*, the client only ever reads them back off other users.
- Server-side room/zone join flow - fully traced, see
  `06-room-join-flow-and-remaining-items.md`: no separate
  `JoinRoomRequest` exists, SFS2X's built-in login-time room auto-join
  handles it, and `JoinRoomData`'s exact struct definition (all field
  types) is now known precisely, not reconstructed from usage.

All 109 of the client's managed DLLs have been decompiled and searched
at this point - nothing further to find through more client-side static
analysis alone. What's left (exact server-side Zone/Extension naming
conventions, `offline_mode`'s config override source) needs either the
CDN cloner's recovered content or actual implementation work to surface.
