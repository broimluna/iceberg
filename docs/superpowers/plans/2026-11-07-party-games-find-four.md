# Party games framework + Find Four Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two players in a room can play a full, server-authoritative Find Four match started from the `FindFourGroup` invitation, with placement rewards paid.

**Architecture:** A `smartfox-server/src/party-games/` module: data loader, abstract session, manager (ids, `pgame.*` wire, rewards, disconnects), and a `FindFour` session. The existing held-tray code in `handlers/consumables.ts` gets a `partyGameLobby` branch that starts a session when the invitation's last slot is taken.

**Tech Stack:** Bun + TypeScript (no tsconfig; see Verification), the existing `sfs-wire.ts` codec, and the WebAPI internal `grant-reward` route. Tests are Bun scripts in `tools/` using `tools/lib/harness.ts`.

**Spec:** `docs/superpowers/specs/2026-11-07-party-games-find-four-design.md`

## Global Constraints

- Wire commands and keys exactly: `pgame.start.v2` {`id` int, `template` int, `players` UTF JSON `{"Players":[{"TeamId":0,"UserSessionId":<long>,"RoleId":0}]}`}, `pgame.message` {`id` int, `type` int, `message` UTF JSON}, `pgame.end` {`id` int, `results` UTF JSON `[{"PlayerSessionId":<long>,"Placement":<int>}]`}, `reward.add_delayed` {`reward` UTF JSON SignedResponse, `source` 5, `sourceId` = session id as string}.
- `pgame.*` go **only to the session's players**. Only the `con` user-variable changes go to the room.
- `UserSessionId` / `PlayerSessionId` are JSON **numbers**. `session.playerSessionId` is a decimal string that can exceed 2^53, so splice it into the JSON text unquoted. Never `Number()` it.
- In-game `con` = {type `pgame`, name `FindFourGameServerAdded`}, with no `con_prop`.
- Session message types: SetGameState 1, ShowTurnOutput 5, PlayerTurnStart 6. Game states: Intro 0, Game 1, Finished 2.
- Rewards come from the data (template 2: placement 0 → 20 coins + AuntArctic 15; placement 1 → 10 coins + AuntArctic 10). Draw → both get placement 1. A leaver forfeits, and `results` then lists only the player who stayed.
- Every party-game delay is multiplied by `PARTY_GAME_TIME_SCALE` (env, default 1, read once).
- iceberg rules: no references to private material (`OLDCPIFILES`, `research/`, `/home/tyler`, DumbFox) in code, comments or commits. Comments must be short protocol facts. Commit as the repo's configured noreply identity with no attribution lines. Write variable type bytes with `putVariableType(kind)`, never `putByte(n)`.

## Review Focus

1. **A move that arrives during the chip-place delay, or a duplicate move**: it must be ignored, never placing two tokens. *Test: Task 3 `double move ignored`.*
2. **A player who disconnects during the intro or the 2 s chip delay**: the pending timers must be cleared, so they don't fire into an ended session. *Test: Task 2 `timers cleared on end`, Task 4 forfeit during intro.*
3. **Both players disconnecting, or the winner disconnecting during the outro**: there must be no throw, no double `end`, and nothing sent to closed connections. *Test: Task 2 `end is idempotent`.*
4. **The guest taking while already holding something, or the owner interacting with themselves while holding the invitation**: no game starts and nothing changes, because the invitation isn't edible. *Test: Task 4 checks (guest busy, self-interact).*
5. **A `message` that's huge, non-JSON or not an object, or a `ScoreDelta` that's a float or a string**: it must be ignored, or it becomes the nearest valid column, with no crash. *Test: Task 3 `column normalisation`, Task 2 `bad pgame.message ignored`.*

---

### Task 1: Party game data and loader

**Files:**
- Create (dev repo, private): `~/Desktop/cpi-private-server/tools/extract-party-games.py`
- Create: `smartfox-server/data/party-games.json` (generated output, committed)
- Create: `smartfox-server/src/party-games/definitions.ts`
- Test: `tools/party-games-data-test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PartyGameReward { coins?: number; mascotXP?: Record<string, number> }
  export interface PartyGameDef {
    id: number; gameType: number; lobbyType: number;
    minPlayers: number; maxPlayers: number; numTeams: number;
    gameData: Record<string, unknown>; lobbyData: Record<string, unknown>;
    rewards: { placement: number; reward: PartyGameReward }[];
    launcher: { method: number; triggerProp: string | null; lobbyProp: string | null; scheduledZone: string | null; everyXMinutes: number } | null;
    playerProp: string | null;
  }
  export function getPartyGame(templateId: number): PartyGameDef | undefined;
  export function templateForTrigger(propName: string): number | undefined;
  export function rewardFor(def: PartyGameDef, placement: number): PartyGameReward | undefined;
  ```

- [ ] **Step 1: Write the generator.** `python3 -I tools/extract-party-games.py <out.json>` reads `PartyGames.json`, `PartyGameLaunchers.json` and `Props.json` from the CPI Project's `Generated/Export/ServerData/StaticGameDataExports/`, using the same default path as `extract-daily-tasks.py`. For each template it parses `GameData` / `LobbyData` (JSON strings) into objects, keeps only non-zero, non-empty reward fields (`coins`, `mascotXP`, plus any other non-empty list), maps `PlayerProp`, `LobbyProp` and the launcher's `TriggerProp` / `LobbyProp` ids to the prop's `NameOnServer` (or `null`), and writes `{ "<id>": PartyGameDef }` with sorted keys and 2-space indent. Write it to `../cpi-private-server-release/smartfox-server/data/party-games.json`.
- [ ] **Step 2: Check the output.** `jq '."2".playerProp, ."2".launcher.triggerProp, ."2".gameData.GameBoardWidth, ."2".rewards' party-games.json` should print `"FindFourGameServerAdded"`, `"FindFourGroup"`, `7`, and two rewards with coins 20/10 and AuntArctic 15/10. Also check that `."1".launcher.triggerProp` is `"FishBucketGroup"` and `."4".launcher.scheduledZone` is `"MtBlizzard"`.
- [ ] **Step 3: Write the failing test** `tools/party-games-data-test.ts` (`makeChecker`, no servers), with these checks:
  - `getPartyGame(2)?.gameData.SequenceCountToWin === 4`, `minPlayers === 2 && maxPlayers === 2`
  - `templateForTrigger("FindFourGroup") === 2`, `templateForTrigger("ScavengerHuntGroup") === 0`, `templateForTrigger("PizzaGroup") === undefined`
  - `rewardFor(def2, 0)` deep-equals `{coins: 20, mascotXP: {AuntArctic: 15}}`; `rewardFor(def2, 4) === undefined`
  - `getPartyGame(99) === undefined`
- [ ] **Step 4:** Run `bun tools/party-games-data-test.ts`. Expected: FAIL (module missing).
- [ ] **Step 5: Implement `definitions.ts`.** Load the JSON once at import (relative to `import.meta.dir`, the way `daily-tasks.ts` loads its data). The trigger map is built from `launcher.triggerProp`.
- [ ] **Step 6:** Run the test again. Expected: `ALL PASSED`.
- [ ] **Step 7: Commit (iceberg)** `party-games.json`, `definitions.ts` and the test: `feat(party-games): party game definitions from static game data`. The generator stays uncommitted in the dev repo (private repo, never pushed), like the other extractors.

### Task 2: Session base class and manager

**Files:**
- Create: `smartfox-server/src/party-games/session.ts`, `smartfox-server/src/party-games/manager.ts`
- Modify: `smartfox-server/src/handlers/registry.ts` (add `"pgame.message"`), `smartfox-server/src/server.ts:267-275` (call `onPartyGamePlayerLeft(session)` in the close handler, right after `unregister`)
- Test: `tools/party-games-manager-test.ts` (in-process; fake `RegisteredSession`s with capturing `send`, like `tools/world-objects-test.ts`)

**Interfaces:**
- Consumes: `getPartyGame`, `rewardFor` (Task 1); `grantReward(username, RewardGrant)` from `webapi-client.ts`; `register` / `getByRoom` from `session-registry.ts`.
- Produces:
  ```ts
  // session.ts
  export const TIME_SCALE: number;               // PARTY_GAME_TIME_SCALE, default 1
  export interface PartyGamePlayer { entry: RegisteredSession; left: boolean }
  export abstract class PartyGameSession {
    readonly id: number; readonly templateId: number; readonly def: PartyGameDef;
    readonly players: PartyGamePlayer[];         // index 0 = owner
    ended: boolean;
    constructor(id: number, def: PartyGameDef, players: RegisteredSession[]);
    protected timer(seconds: number, fn: () => void): void;   // scaled by TIME_SCALE, cleared on end, wrapped in the session's error guard
    protected sendMessage(type: number, body: object | string): void; // pgame.message to players not left; string = pre-built JSON
    protected endWith(placements: Map<RegisteredSession, number>): void; // delegates to manager's endSession
    abstract onStart(): void;
    abstract onMessage(player: PartyGamePlayer, type: number, message: unknown): void;
    abstract onPlayerLeft(player: PartyGamePlayer): void;
  }
  // manager.ts
  export type SessionFactory = (id: number, def: PartyGameDef, players: RegisteredSession[]) => PartyGameSession;
  export function registerGameType(gameType: number, factory: SessionFactory): void;
  export function startPartyGame(templateId: number, players: RegisteredSession[]): PartyGameSession | undefined;
  export function endSession(session: PartyGameSession, placements: Map<RegisteredSession, number>): void;
  export function sessionOf(s: Session): PartyGameSession | undefined;
  export function handlePartyGameMessage(innerParams: SFSObjectData, ctx: HandlerContext): void;
  export function onPartyGamePlayerLeft(s: Session): void;
  export function canStart(templateId: number): boolean;           // def + playerProp + factory exist
  export function setRewardGranter(fn: (username: string, reward: RewardGrant) => unknown): void; // tests only; default grantReward
  ```

Behaviour the test pins down. A test-only session class is registered under an unused `gameType` (e.g. 99, with a `def` built inline via the factory) or uses template 2 before Find Four is registered:

- [ ] **Step 1: Write the failing tests:**
  - `start sends pgame.start.v2 to players only`: owner + guest + spectator in one room. Only owner and guest get `pgame.start.v2`. `template` === 2. `players` JSON text contains the owner's id first, unquoted (regex `^\{"Players":\[\{"TeamId":0,"UserSessionId":<ownerId>,"RoleId":0\},\{…<guestId>…\}\]\}$`).
  - `prop equipped for the room`: all three get a user-var update (0/12) for each player with `con` = SFS object {type `pgame`, name `FindFourGameServerAdded`} and no `con_prop`.
  - `ids increase`: two sessions get ids `n` and `n+1`.
  - `refuses busy player`: `startPartyGame` with a player already in a session → `undefined`, nothing sent.
  - `bad pgame.message ignored`: from a non-player, an unknown `id`, a `message` over 4096 bytes, non-JSON → `onMessage` is never called, and none of them throws.
  - `pgame.message routed`: from a player, valid → `onMessage(player, type, parsedJson)` is called once.
  - `end`: `endSession` with owner→0, guest→1 sends `pgame.end` to both. `results` parses to `[{PlayerSessionId:<owner>,Placement:0},{…guest…,Placement:1}]`, numbers spliced unquoted. Both get `con` set to null (room-wide). `sessionOf` is undefined for both afterwards.
  - `rewards`: with `grantReward` replaced by a recorder (inject through `setRewardGranter(fn)`, exported from manager.ts for tests only), it's called with `(owner.userName, {coins:20, mascotXP:{AuntArctic:15}})` and `(guest.userName, {coins:10, …10})`. Each player gets one `reward.add_delayed` whose JSON has `data.source === 5`, `data.sourceId === String(session.id)`, and `data.rewards` keyed by their own session id only.
  - `end is idempotent`: a second `endSession` sends nothing more and grants nothing more.
  - `timers cleared on end`: a session that arms `timer(0.05, spy)` and then ends: the spy never fires.
  - `left player`: `onPartyGamePlayerLeft(guest.session)` marks the guest `left`, calls `onPlayerLeft` once, and later sends skip the guest. An exception thrown in `onMessage` ends the session with empty `results` (`[]`) and grants nothing.
- [ ] **Step 2:** Run `bun tools/party-games-manager-test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `session.ts`.** The error guard is a try/catch around every timer callback, and the manager wraps `onMessage` / `onPlayerLeft` the same way. On a throw, log it and call `endSession(session, new Map())`.
- [ ] **Step 4: Implement `manager.ts`.**
  - `startPartyGame` looks up the def and the factory by `def.gameType`. It refuses if any player is already in a session, if there are fewer than `minPlayers` or more than `maxPlayers` players, or if `playerProp` is null.
  - The player list and results JSON are built as strings around the raw `playerSessionId` text.
  - The `con` var is built like `objectConVar` in `consumables.ts`, using a local copy of it (it isn't exported). When setting it, also set `session.heldObject = playerProp` and leave `equippedConsumable` undefined. On end, clear both, and send `con` NULL only for players whose `heldObject` is still the game prop.
  - `endSession` order: set `ended`, clear timers, send `pgame.end`, clear `con`, grant + `reward.add_delayed`, then delete from the maps.
  - `handlePartyGameMessage` reads `id` (int), `type` (int) and `message` (UTF) through the `wire-helpers.ts` getters.
- [ ] **Step 5: Wire up registry and server.** `registry.ts`: `"pgame.message": handlePartyGameMessage`. `server.ts`: call `onPartyGamePlayerLeft(session)` in `socket.on("close")`, after `unregister`. `onPartyGamePlayerLeft` must cope with the session already being unregistered: send only to players still registered.
- [ ] **Step 6:** Run the test. Expected: `ALL PASSED`.
- [ ] **Step 7: Commit** `feat(party-games): session manager, pgame wire and placement rewards`.

### Task 3: Find Four rules

**Files:**
- Create: `smartfox-server/src/party-games/find-four.ts`
- Modify: `smartfox-server/src/party-games/manager.ts` (register gameType 2 → `FindFour` at module load)
- Test: `tools/party-games-findfour-test.ts` (in-process, same fakes as Task 2, `PARTY_GAME_TIME_SCALE=0.01` set in the test before importing)

**Interfaces:**
- Consumes: `PartyGameSession`, `registerGameType`, `startPartyGame` (Task 2).
- Produces: `export class FindFour extends PartyGameSession` and `export function normaliseColumn(board: number[][], wanted: unknown, defaultColumn: number): number`. `board[col]` is the stack of tokens in that column, each a player index of 0 or 1.

Timing comes from `def.gameData`: `IntroTimeInSeconds`, `TurnTimeInSeconds`, `ChipPlaceTimeInSeconds`, `OutroTimeInSeconds`, `GameBoardWidth`, `GameBoardHeight`, `SequenceCountToWin`, `DefaultColumn`. The backstop is `TurnTimeInSeconds + 2`.

- [ ] **Step 1: Write the failing tests.** Messages are read from the owner's captured `pgame.message`s as `(type, JSON)`.
  - `column normalisation` (pure): on an empty 7×6 board, `normaliseColumn(b, 3, 3) === 3`; `"x"` → 3; `9` → 6; `-2` → 0; `2.7` → 3 (floor first, then nearest); a full column 3 with 2 and 4 open → 2 (ties go to the lower index); a full board → -1.
  - `intro then game`: after start, the order is `SetGameState{0}`, then `SetGameState{1}`, then `PlayerTurnStart{owner}`.
  - `turn enforced`: a guest `ShowTurnOutput{ScoreDelta:0}` on the owner's turn sends nothing.
  - `move echoed`: the owner sends column 3 → both get `ShowTurnOutput{"PlayerId":<owner>,"ScoreDelta":3}`, followed after the chip delay by `PlayerTurnStart{guest}`.
  - `double move ignored`: the owner sends column 3 twice quickly → exactly one `ShowTurnOutput`.
  - `spoofed PlayerId ignored`: the guest's move with `PlayerId` = owner's id is echoed with the guest's id.
  - `full column redirected`: column 0 is filled (6 alternating moves), and then a move to column 0 is echoed as column 1.
  - `wins`: four scripted games, horizontal (owner 0,1,2,3 with the guest on 6), vertical, rising diagonal and falling diagonal. Each sends `SetGameState{2}`, then `pgame.end` with the winner at 0 and the loser at 1.
  - `draw`: a scripted 42-move sequence that fills the board with no four in a row. Check it offline with the same win check before you hard-code it. → `pgame.end` with both at placement 1.
  - `timeout backstop`: no move for `TurnTimeInSeconds + 2` (scaled) → `ShowTurnOutput` for the owner with `DefaultColumn` (3).
  - `forfeit`: the guest leaves mid-game → the owner gets `pgame.end` right away (no `SetGameState{2}` first), and `results` is exactly `[{owner, 0}]`. The same happens if the guest leaves during the intro, and no later timer sends anything.
- [ ] **Step 2:** Run `PARTY_GAME_TIME_SCALE=0.01 bun tools/party-games-findfour-test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `FindFour`.** The state is `board`, `turn` (player index) and `waitingFor` (player index, or -1). `onMessage` handles only type 5, while `waitingFor === sender index`; it sets `waitingFor = -1` before scheduling anything. The win check counts both directions from the placed token for each of the 4 axes. `onPlayerLeft` ends with only the remaining player at 0, provided the session hasn't already ended.
- [ ] **Step 4:** Run the test. Expected: `ALL PASSED`.
- [ ] **Step 5: Commit** `feat(party-games): Find Four`.

### Task 4: Invitation lobby and end-to-end test

**Files:**
- Modify: `smartfox-server/src/handlers/consumables.ts`. This touches `useConsumable` (the `default:` TODO branch around line 262) and `handlePlayerInteraction` (around 393-430), plus the self-interaction (edible) guard.
- Create: `tools/party-games-test.ts` (real servers: `startWebApi` + a spawned `smartfox-server` on its own port with `PARTY_GAME_TIME_SCALE=0.01`, `JOIN_SIGNING_KEY` and `WEBAPI_INTERNAL_URL` pointing at the harness WebAPI; logins signed the way `tools/smartfox-hardening-test.ts` does it; fake-client helpers like `setCon`, `use` and `interactWith` modelled on the held-consumables test's)
- Modify: `tools/README.md` (add the four new test scripts to the table)

**Interfaces:**
- Consumes: `templateForTrigger`, `getPartyGame` (Task 1); `startPartyGame`, `sessionOf` (Task 2); `getByRoomExcluding`, and the registered entries for owner and guest.

- [ ] **Step 1: Write the failing e2e test.** Create three WebAPI players (owner, guest, spectator) in `Alpine` Town, log all three in, then check:
  - `invitation held`: the owner sends `setCon("FindFourGroup")` and then `use("FindFourGroup")` → everyone sees one update with `con` = `consum:FindFourGroup` and `con_prop` = `{"actionCount":1}`.
  - `self-interact does nothing`: the owner interacting with themselves → no update, no `pgame.*`.
  - `busy guest refused`: the guest holds a tray item (`setCon` + `use` a `PizzaGroup`, then store it again) or is in another game → interacting with the owner starts nothing. The guest is cleared again afterwards.
  - `join starts the match`: the guest interacts with the owner → the invitation is removed (`con`/`con_prop` NULL for the owner, before the `pgame` `con`), both players get `pgame.start.v2`, the spectator gets none, and everyone sees both players' `con` = `pgame:FindFourGameServerAdded`.
  - `full match`: the owner plays 0,1,2,3 and the guest 6,6,6 → `pgame.end`. The WebAPI DB coins rise by 20 for the owner and 10 for the guest (read them through `bun:sqlite` on `api.dbPath`, as before/after deltas). Each player gets `reward.add_delayed`, and every `con` is NULL afterwards.
  - `forfeit by disconnect`: a new invitation and join, then the guest's socket closes → the owner gets `pgame.end` with `[{owner,0}]` and +20 coins.
  - `server alive`: the spectator can still `time.get` and gets an answer.
- [ ] **Step 2:** Run `bun tools/party-games-test.ts`. Expected: FAIL at `join starts the match`.
- [ ] **Step 3: Implement the lobby branch.**
  - In `useConsumable`, `case "partyGameLobby"` holds the item out via the existing `setHeldItem(session, type, def.totalItemQuantity ?? 1)`, but only if `templateForTrigger(type)` is defined. Otherwise it logs, as it does today.
  - Before any slot is taken, `canStart(template)` must be true. If it isn't, log it and change nothing, so the invitation stays held (spec: Error handling).
  - In `handlePlayerInteraction`, before the tray checks: if the holder's `equippedConsumable` is a `partyGameLobby` consumable with `heldActionCount > 0`, the taker's hands must be empty and neither the taker nor the holder may be in a session (`sessionOf`). Record the taker on the holder's pending lobby (a `Map<number /*holder userId*/, RegisteredSession[]>` in consumables.ts), and decrement through `setHeldActionCount`. At 0, call `removeHeldItem(holder)` and then `startPartyGame(template, [holderEntry, ...takers])`, then delete the pending entry.
  - The pending entry is also deleted when the holder releases or stores the item (`releaseHeldItem`) or disconnects. Clean up next to the existing release path.
  - The self-interaction edible guard already excludes `partyGameLobby` (it isn't `serverAdded` or non-shareable `playerHeld`). Keep it that way, and confirm it with the test.
- [ ] **Step 4:** Run `bun tools/party-games-test.ts`. Expected: `ALL PASSED`.
- [ ] **Step 5: Regressions.** Run `bun tools/<each>-test.ts` for all iceberg `tools/*-test.ts`, then the dev repo's `tools/held-consumables-test.ts`, `consumables-test.ts`, `multiplayer-test.ts` and `room-state-test.ts` (`grep -c '^PASS'` counts should be unchanged: 37, 57, 33, 17). Then run the SFS3 harness as described in the dev repo's `docs/HANDOFF.md`. Everything should pass.
- [ ] **Step 6: Commit** `feat(party-games): Find Four invitation lobby` (consumables.ts, the test, README).

### Task 5: Docs, verification and live test

**Files:**
- Modify: `docs/SMARTFOX_PACKETS_DOCUMENTATION.md` (party game section)
- Modify (dev repo, private): `docs/HANDOFF.md` (status, new tests, generator)

- [ ] **Step 1: Packet docs.** Replace the party game section with the four commands and their exact params (from Global Constraints), the `PartyGameSessionMessageTypes` table (0–13), the Find Four message table, and the invitation → `pgame` `con` flow, all taken from the spec's Background section.
- [ ] **Step 2: Typecheck and build.** Run the strict `tsc` command from the dev repo's `docs/HANDOFF.md` ("Verifying a change", step 0) over `smartfox-server/src/**/*.ts`, then `bun build src/handshake-server.ts --target=bun --outdir <scratch>`. Expected: no errors, and no new "will always be undefined" warnings.
- [ ] **Step 3: Private-ref scan.** `git diff origin/main..HEAD | grep -n -i -E "OLDCPIFILES|research/|dumbfox|/home/tyler|scratchpad|CPI-Project"`. Expected: no output.
- [ ] **Step 4: Commit and push** `docs: party game packets and Find Four`, then `git push`.
- [ ] **Step 5: Live test.** Restart both servers (HANDOFF "Running the servers") and ask Tyler for a two-client test: buy + use Find Four, have the second client accept, play to a win, confirm the end popup and coins, then repeat with one client closing mid-game. Watch the game-server log for `pgame` lines and errors.
- [ ] **Step 6: Update HANDOFF.md** (dev repo, not committed to iceberg): framework + Find Four done, new tests and their PASS counts, `tools/extract-party-games.py`, and the remaining party games listed next.
