# Disney Mix Support (Phases 0–3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make iceberg's `web-api` serve the OpenCPIsland Disney Mix recreation alongside Club Penguin Island:
- shared accounts
- boot config and cpipe
- shared moderation with Disney's sanction ladder
- 1:1 and group chat

**Architecture:**
- Phase 0 splits `routes/mix.ts` into `routes/mix/*`, moves notification writing into `services/mixNotify.ts`, and makes Mix auth actually check the token.
- Later phases add `services/moderation.ts` and `services/mixChat.ts`, each called by thin route files.
- Every multi-row write runs in one SQLite transaction, so a per-user notification sequence number is never allocated without its row.

**Tech Stack:** Bun ≥ 1.3 (1.4.2 installed), TypeScript (ESM, run directly by Bun, no tsc), Express 4, `bun:sqlite`, Node `crypto`.

**Spec:** `docs/superpowers/specs/2026-11-07-mix-support-design.md`. Protocol reference: `docs/MIX_API.md`. Read both before starting.

## Global Constraints

**Repo and git**
- Repo is iceberg (`~/Desktop/cpi-private-server-release`), branch `mix-support`. Commit after every task and push (`git push`).
- Commit message style: a plain imperative sentence, no `feat:` prefix (matches `git log`). No attribution lines.
- Never modify `web-api/src/cpi_data.db*` or commit them. Tests run against throwaway copies (Task 1).

**Mix client source**
- Clone with `git clone --depth 1 https://github.com/OpenCPIsland/DisneyMix "$HOME/src/DisneyMix"` (outside the repo).
- `MIX_SDK` below means `$HOME/src/DisneyMix/Assets/Scripts/Assembly-CSharp/Disney/Mix/SDK/Internal`.

**Wire format**
- Mix responses use the existing envelope `{ Status: "OK", ...fields }`.
- Auth failures: HTTP **401** with `{ Status }`. The client routes 401s by status (`MixWebCallFactory`):
  - `UNAUTHORIZED_ONEID_TOKEN`
  - `UNAUTHORIZED_MIX_SESSION`
  - `UNAUTHORIZED_BANNED`
- Domain failures: HTTP **400** with `{ Status }`. The client reads `Status` from 4xx bodies (`MixWebCall`).
- 5xx is retried once by the client, so never use it for domain errors.

**Exact client strings**
- Chat thread types: `ONE_ON_ONE`, `GROUP`, `OFFICIAL_ACCOUNT`.
- Message types (`ChatMessageParser`): `TEXT`, `STICKER`, `GAG`, `PHOTO`, `VIDEO`, `GAME_STATE`, `GAME_EVENT`, `MEMBER_LIST_CHANGED`.
- Chat statuses:
  - reads: `NOT_FOUND`, `INSUFFICIENT_READ_PERMISSION` (`AbstractChatThread`)
  - adding members: `USER_NOT_THREAD_MEMBER`, `USER_ALREADY_THREAD_MEMBER` (`ChatThreadMemberAdder`)
- Guest Controller ban codes (`GuestControllerErrorParser`):
  - `PROFILE_USER_BANNED`: temporary ban, on login and refresh
  - `PROFILE_DISABLED`: permanent ban or lock

**Values**
- `NotificationSequenceThreshold` = `10000` (milliseconds; see `MIX_API.md` §5).
- Mix boot config:
  - AES-256-CBC + Base64, PKCS7
  - key Base64 `U8rYu9uzHmujSvAogNfj4IfuC9GRJzNCarb+cfaYN5k=`
  - IV hex `05ec55c6795f972c0f38a2206a81e369`
- Mix Guest Controller client ID: `DI-SPARK-PROD`.

**Documentation**
- Every task that learns something new about the protocol adds it to `docs/MIX_API.md`, in the same commit, citing the client class.
- Update the endpoint status table in §4 when an endpoint goes ✅.

## Review Focus

1. **A burst of notifications for one user.** A user who receives several notifications at once (group fan-out plus their own send) must still see gap-free, strictly increasing sequence numbers. *Pinned in Task 12* (concurrent sends from two members).
2. **A client that retries after a timeout.** The same `ClientChatMessageId` re-sent must return the original notification with no second row in any member's notification log. *Pinned in Task 12.*
3. **A forged body `UserId`.** A valid token for user A with `UserId: B` in the body must never act as B. *Pinned in Task 4.*
4. **Unicode and very long chat text.** Emoji and accented text survive the filter and storage unchanged, and text over 1000 UTF-16 units is rejected with `400 INVALID_REQUEST`. *Pinned in Task 8 (filter) and Task 12 (send).*
5. **A ban expiring while the user is offline.** Once `until` passes, login and Mix calls work again without a moderator. *Pinned in Task 10.*

---

## Phase 0: Foundation

### Task 1: Test harness in iceberg and ported regression tests

The three existing tests live in the other checkout (`~/Desktop/cpi-private-server/tools/`) and hard-code iceberg's path. Bring them into iceberg so they travel with the code.

**Files:**
- Create: `tools/lib/harness.ts`
- Create: `tools/mix-friends-test.ts`, `tools/webapi-fixes-test.ts`, `tools/webapi-auth-test.ts` (ported from `~/Desktop/cpi-private-server/tools/`)
- Create: `tools/README.md`: how to run, one line per test

**Interfaces:**
- Produces:
  - `startWebApi(opts?: { port?: number; env?: Record<string,string>; beforeStart?: (dbPath: string) => void }): Promise<{ base: string; dbPath: string; dir: string; logs: () => string; stop: () => void }>`
    - Copies `web-api/{src,data,package.json}` (excluding `cpi_data.db*`) and `smartfox-server/data` into a temp dir, keeping the sibling layout.
    - Symlinks `node_modules`.
    - Locates the repo from `import.meta.dir`.
    - Spawns `bun run src/server.ts` with `PORT` and waits until `GET {base}/` answers (any status, ≤ 10 s) instead of sleeping.
  - `makeChecker(): { check(cond: boolean, msg: string): void; finish(logs?: string): never }`
    - Prints `PASS`/`FAIL` lines.
    - `finish` prints `ALL PASSED` or `N FAILURE(S)` and exits 0 or 1.

- [ ] **Step 1:** Port each test by replacing its copy/spawn preamble with `startWebApi()`. Keep every `check` exactly as it is. `webapi-fixes-test.ts` seeds an old schema before boot, so use `beforeStart`.
- [ ] **Step 2:** Run `cd ~/Desktop/cpi-private-server-release && for t in mix-friends webapi-fixes webapi-auth; do bun tools/$t-test.ts || break; done`. Expected: each ends with `ALL PASSED` (the baseline: 23, 13 and 5 checks, per HANDOFF).
- [ ] **Step 3:** Commit: `Bring the web API regression tests into the repo with a shared harness`.

### Task 2: SDK-faithful Mix test client

**Files:**
- Create: `tools/lib/mix-client.ts`
- Create: `tools/mix-session-test.ts`

**Interfaces:**
- Consumes: `startWebApi`, `makeChecker` (Task 1). `decryptAesCbc(buf: Buffer, key: Buffer): Buffer` and `encryptAesCbc(buf, key): Buffer` from `web-api/src/lib/crypto.ts` (IV-prefixed, as `MixEncryptor`).
- Produces:
  - `createPlayer(base: string, dbPath: string, swid: string, displayName: string): Promise<void>`
    - Hits `GET /player/v1` with Basic `swid:x`. Needs the server started with env `ALLOW_SWID_AUTH=1`.
    - Sets the display name in `player_identity`, the same way `mix-friends-test` does today.
  - `class MixClient`, constructed with `(base: string, opts?: { clientId?: string })`. `clientId` defaults to `"CPI-TEST"`. iceberg's Guest Controller routes don't read `:clientId` today, so any value works; Task 7 passes `"DI-SPARK-PROD"` explicitly.
    - `login(displayName: string, password: string): Promise<void>`
      - `POST /jgc/v5/client/{clientId}/api-key`, then `/guest/login` with the `api-key` header.
      - Stores `swid` and `accessToken`.
    - `startSession(): Promise<void>`
      - Generates an RSA-2048 keypair and sends `PUT /session/user` (plain JSON) with `PublicKeyModulus`/`PublicKeyExponent` Base64.
      - Decrypts `EncryptedSymmetricKey` (PKCS#1 v1.5) and stores `sessionId` and `key`.
    - `call(method: "PUT" | "POST", path: string, body?: object): Promise<{ http: number; body: any }>`
      - Sends `Content-Type: application/mix` (once a session exists), `X-Mix-OneIdToken`, `X-Mix-ClientToken: F7EA7678-FE45-4A00-89EB-496EFDA74761` and `X-Mix-UserSessionId`.
      - Fills `UserId` and `Timestamp`, encrypts the request, and decrypts the response.
    - `state(): Promise<any>`: calls `/state` and sets `latest = NotificationSequenceCounter`.
    - `poll(): Promise<any[]>`
      - `POST /notifications/sinceSequence` with `SequenceNumber: latest + 1` (as `NotificationPoller.Poll`) and `ExcludeNotificationSequenceNumbers: []`.
      - Returns all notifications from every typed list, flattened and sorted by `SequenceNumber`, each tagged `{ type, n }`.
    - `apply(n: any, type: string): boolean`
      - Accepts only `SequenceNumber === latest + 1` and non-zero.
      - Checks the type's required fields per `MIX_SDK/NotificationValidator.cs` (encode each `Validate(...)` overload you need as a field list in a `REQUIRED` table keyed by response list name, e.g. `AddChatThread`).
      - Advances `latest` on success.
    - `drain(): Promise<{ type: string; n: any }[]>`: `poll()`, then `apply` each in order. It throws if any notification is rejected or if a gap remains.

- [ ] **Step 1: Write `tools/mix-session-test.ts`.** Two players (`alice`, `bob`) and clients that log in, start sessions and call `state()`. Checks:
  - `/state` decrypts and has `Status === "OK"`
  - `PollIntervals` deep-equals `[2,5,10]`
  - `NotificationSequenceCounter === 0`
  - an invite from alice to bob via `call("PUT","/friendship/invitation",{InviteeDisplayName:"bob",IsTrusted:false})` yields a notification alice can `apply`
  - bob's `drain()` returns exactly one `AddFriendshipInvitation`
- [ ] **Step 2:** Run `bun tools/mix-session-test.ts`. Expected: `ALL PASSED`. It runs against the current server unchanged: this task is the test client, not a fix. If a check fails, the client is wrong, not the server.
- [ ] **Step 3:** Commit: `Add an SDK-faithful Mix test client`.

### Task 3: Split `mix.ts`, add `mixNotify`, fix the threshold

Pure move plus two intended changes: the threshold value, and transactions.

**Files:**
- Delete: `web-api/src/routes/mix.ts`
- Create: `web-api/src/routes/mix/{index,common,auth,session,state,users,friends,notifications,moderation,push}.ts`. The route grouping is in the spec's Architecture block.
  - `common.ts` holds `hashUserId`, `buildResponse`, `getTimestamp`, `generateId`, `mixUser`, `generateDefaultAvatar` and the `presenceState` map.
- Create: `web-api/src/services/mixNotify.ts`
- Modify: `web-api/src/database.ts` (add and export `inTransaction`)
- Modify: `web-api/src/routes/index.ts`: `mixRoutes` now from `./mix/index.ts`. `server.ts` keeps `app.use(['/', '/mix'], routes.mixRoutes)`.

**Interfaces:**
- Produces:
  - `inTransaction<T>(fn: () => T): T`, exported from `database.ts`. Uses `db.transaction(fn)()`. It is re-entrant: when already inside a transaction, it just calls `fn()` (track depth in a module variable).
  - `notify(swid: string, type: string, fields: object): MixNotification`: same behavior as the old `mix.ts` helper.
  - `notifyMany(swids: string[], type: string, build: (swid: string) => object): Map<string, MixNotification>`: runs inside `inTransaction`, with one row per swid.
  - `type MixNotification = { Created: number; NotificationId: number; SequenceNumber: number; [k: string]: unknown }`, exported from `mixNotify.ts`.
  - `routes/mix/auth.ts` exports `mixEncryptionMiddleware` and `authenticateMix`. Behavior is unchanged in this task.

- [ ] **Step 1:** Add to `mix-session-test.ts`: `check(state.NotificationSequenceThreshold === 10000, "threshold is 10 s in ms")`. Run it and expect that one FAIL.
- [ ] **Step 2:** Do the split. Set `NotificationSequenceThreshold: 10000` in `state.ts`. Every existing handler that writes several notifications or rows (friendship accept, invitation, remove) wraps its writes in `inTransaction`.
- [ ] **Step 3:** Run Task 1's three tests plus `mix-session-test.ts`. Expected: all `ALL PASSED`.
- [ ] **Step 4:** Document the threshold fix in `MIX_API.md` §5: change "Action: …" to "Fixed in iceberg: 10000".
- [ ] **Step 5:** Commit: `Split the Mix routes into a module and write notifications through one service`.

### Task 4: Bind Mix requests to the authenticated user

**Files:**
- Modify: `web-api/src/routes/mix/auth.ts`
- Modify: `tools/mix-friends-test.ts` (use `MixClient` with real logins instead of the token `"t"`)
- Test: `tools/mix-auth-test.ts`

**Interfaces:**
- Consumes: `db.getGuestToken(token): { tokenType; swid; ... } | null`.
- Produces: after `authenticateMix`, `req.mixUserId: string` is the token's swid, and `req.body.UserId` is overwritten with it.

**`authenticateMix` rules, in order:**
1. A missing token, or one that isn't an unexpired `access` token, gets `401 UNAUTHORIZED_ONEID_TOKEN`.
2. A body `UserId` that is present and differs from the token's swid gets `401 UNAUTHORIZED_ONEID_TOKEN`.
3. For encrypted requests, a session (`X-Mix-UserSessionId`) belonging to a different swid than the token gets `401 UNAUTHORIZED_MIX_SESSION`. `getMixSessionById` returns the session's swid; use it.
4. `PUT /session/user` is plain JSON and follows rules 1 and 2.

- [ ] **Step 1: Write `tools/mix-auth-test.ts`.** Checks:
  - a bogus token gives HTTP 401 and `UNAUTHORIZED_ONEID_TOKEN`
  - alice's token with `UserId: bob` gives 401 and nothing changes: bob's `state()` counter is unchanged and bob has no friendship
  - alice's token with bob's `X-Mix-UserSessionId` gives 401 `UNAUTHORIZED_MIX_SESSION`
  - alice's own calls give 200
- [ ] **Step 2:** Run it. Expected: the forged-user and foreign-session checks FAIL.
- [ ] **Step 3:** Implement the rules.
- [ ] **Step 4:** Port `mix-friends-test.ts` onto `MixClient` with the same assertions. Run all tests. Expected: all pass.
- [ ] **Step 5: Live CPI check.** Ask the user to start the server, log in to CPI, open the friends list and send or accept a friend invite. Record the outcome in the task report. If CPI sends a token we don't recognize, stop and report back: don't loosen the rule.
- [ ] **Step 6:** Document in `MIX_API.md` §3 that iceberg binds `X-Mix-OneIdToken` to the session and body. Commit: `Tie every Mix request to the user its token belongs to`.

---

## Phase 1: Boot and connect

### Task 5: Mix boot config tool

**Files:**
- Create: `tools/mix-config.ts`
- Test: `tools/mix-config-test.ts`

**Interfaces:**
- Produces:
  - `renderConfig(baseUrl: string): Record<string,string>`
    - The 16 keys of Disney's original config (values in `MIX_API.md` §2), with:
      - `guest_baseUrl` = base, `guest_v2_baseUrl` = `${base}/jgc/v5`
      - `mix_platform_services_url` = `${base}/mix`
      - `cpipe_url` = `${base}/cpipe`
    - `baseUrl` has any trailing `/` stripped.
  - `encryptConfig(obj): string` (Base64) and `decryptConfig(b64: string): any`, both using the Global Constraints key and IV.
  - CLI: `bun tools/mix-config.ts render <baseUrl> [--out <file>]` writes the encrypted text (to stdout if `--out` is omitted); `bun tools/mix-config.ts decrypt <file>` prints pretty JSON.

- [ ] **Step 1: Write the test.** Checks:
  - `decryptConfig(encryptConfig(renderConfig("http://h:1/")))` has `cpipe_url === "http://h:1/cpipe"`
  - `mix_platform_services_url === "http://h:1/mix"`
  - `guest_clientId === "DI-SPARK-PROD"`
  - exactly 16 keys
  - piping the CLI output through `openssl enc -d -aes-256-cbc -K <hex> -iv <hex>` (after `base64 -d`) parses as JSON with the same `cpipe_url`. This is an independent check of the cipher.
- [ ] **Step 2:** Run and see it fail. Implement. Run and see it pass.
- [ ] **Step 3:** Add usage to `tools/README.md` and a "Generating a config" note to `MIX_API.md` §2. Commit: `Add a tool to render and decrypt the Mix boot config`.

### Task 6: cpipe endpoints

**Files:**
- Create: `web-api/src/routes/cpipe.ts`
- Create: `web-api/data/mix/cpipe-manifest.json`, a verbatim copy of the recreation's `Assets/StreamingAssets/1123402340.txt`
- Create: `web-api/data/mix/cpipe/.gitkeep`
- Modify: `web-api/src/routes/index.ts` and `server.ts` (mount `cpipeRoutes` before `mixRoutes`)
- Modify: `web-api/src/config.ts`: `mix.cpipeConfigVersion: number`, default `Math.floor(Date.now()/1000)` at boot, overridable with env `MIX_CPIPE_CONFIG_VERSION`
- Test: `tools/mix-boot-test.ts`

**Interfaces:**
- Produces:
  - `GET /cpipe` (any query)
    - 400 `{error:"missing authorization"}` without an `Authorization` header.
    - Otherwise returns the manifest JSON with `manifest.cdnRoot = "<proto>://<host>/cpipe/files"` (from the request) and `manifest.paths["donotcopy/n7c4c656"].v = config.mix.cpipeConfigVersion`.
    - The file is read once and cached.
  - `GET /cpipe/files/<v>/<path>` and `GET /cpipe/files/<path>`
    - Static files from `data/mix/cpipe/`. The leading numeric version segment is ignored, because the original CDN used `/<v>/` prefixes (`MIX_API.md` §10).
    - Any path whose resolved file lies outside that directory gets 404.
    - Missing files get 404.

- [ ] **Step 1: Write `mix-boot-test.ts`.** Checks:
  - `GET /cpipe?restrict=true&cv=2.3` without `Authorization` gives 400
  - with `Authorization: GAE x` gives 200, and `manifest.version === "00134"` and `manifest.cdnRoot` ends with `/cpipe/files`
  - the config entry `v` equals `MIX_CPIPE_CONFIG_VERSION=1234` passed via the harness env
  - after writing a file into `<dir>/data/mix/cpipe/donotcopy/n7c4c656`, `GET /cpipe/files/1234/donotcopy/n7c4c656` returns its bytes
  - `GET /cpipe/files/..%2f..%2fsrc%2fserver.ts` gives 404
- [ ] **Step 2:** Fail, implement, pass. Rerun all earlier tests.
- [ ] **Step 3:** Commit: `Serve the Mix cpipe manifest and files`.

### Task 7: Mix client compatibility and the empty chat state

**Files:**
- Modify: `web-api/src/routes/mix/state.ts` (adds chat fields, empty for now)
- Modify: `web-api/src/routes/guestcontroller.ts`, only if Step 2 shows `DI-SPARK-PROD` is rejected anywhere
- Test: extend `tools/mix-boot-test.ts`

- [ ] **Step 1: Extend the test.** Checks:
  - `new MixClient(base, { clientId: "DI-SPARK-PROD" })` can `login`, `startSession` and `state()`
  - `/state` has `ChatThreads`, `ChatThreadNicknames`, `ChatThreadUnreadMessageCount`, `ChatThreadLatestMessageSequenceNumbers`, `ChatThreadLastSeenMessageSequenceNumbers`, `GameStateChatMessages` and `OfficialAccounts`, each deep-equal to `[]`, plus `UserNicknames: []`
- [ ] **Step 2:** Run it, implement the missing parts, and run it again.
- [ ] **Step 3: Live boot (needs Unity 6000.3.14f1).**
  - Render a config for the server's LAN URL and place it at `<DisneyMix>/Assets/StreamingAssets/donotcopy/n7c4c656`.
  - Run `scn_Main` and log in with an existing CPI account.
  - Expected: the friends list shows that account's CPI friends.
  - Record how the client handled `GET /cpipe` (did it re-request, and did it accept an unchanged `version`?) and every unknown request in the server log, in `MIX_API.md` §2 and §11.
  - If Unity isn't available, say so in the report and leave the open question.
- [ ] **Step 4:** Commit: `Let the Disney Mix app log in and load its state`.

---

## Phase 2: Moderation

### Task 8: Moderation rules and text filter (Mix and CPI)

**Files:**
- Create: `web-api/src/services/moderation.ts`
- Modify: `web-api/src/database.ts`: tables `mix_moderation_rules`, `mix_reports`, `mix_sanctions` and `mix_bans`, with columns exactly as in the spec's Data model
- Modify: `web-api/src/routes/mix/moderation.ts` (`PUT /moderation/text`)
- Modify: `web-api/src/routes/chat.ts` (`POST /chat/v1/message/verify`)
- Create: `tools/mod.ts` (rules subcommands only in this task)
- Test: `tools/mix-moderation-test.ts`

**Interfaces:**
- Produces, in `moderation.ts`:
  - `filterText(text: string): { text: string; moderated: boolean; blocked: boolean }`
    - `word` rules match case-insensitively on whole words (Unicode-aware: `\p{L}\p{N}` boundaries, flag `u`).
    - `regex` rules are used as given with flags `giu`.
    - `mask` replaces each match with the same number of `*` (count code points).
    - Any `block` match sets `blocked: true`.
  - `addRule(pattern: string, kind: "word" | "regex", action: "mask" | "block"): number`
  - `removeRule(id: number): boolean`
  - `listRules(): Rule[]`
  - The rules cache is reloaded whenever `PRAGMA data_version` differs from the value seen at the last load. That pragma changes when *another* connection commits, so rules added by `tools/mod.ts` reach a running server. `addRule` and `removeRule` also clear the cache directly.
  - The starter list is seeded on first table creation with **3** `mask` word rules, chosen by the implementer from common English profanity. Document the choice in the code comment, not in the test.
- `PUT /moderation/text` returns `{ Status:"OK", Text, Moderated }`, with `Moderated = moderated || blocked`. For blocked text, `Text` is fully masked.
- CPI verify returns `moderated: true` and the masked `message` when moderated or blocked.
- `tools/mod.ts rules list | add <pattern> [--regex] [--block] | remove <id>` opens the DB at `web-api/src/cpi_data.db`, overridable with `--db`.

- [ ] **Step 1: Write the test.** Uses `beforeStart` to insert rules: word `darn` mask, word `heck` block, regex `\bf+o+o+\b` mask. Checks:
  - `filterText` via `/moderation/text`: `"Darn it"` gives `"**** it"` with `Moderated`
  - `"what the heck"` gives `Moderated`
  - `"fooooo"` is masked
  - `"darned"` is unchanged (whole word)
  - `"héllo 👋 café"` is unchanged and `Moderated` is false
  - CPI verify with `"darn"` gives `moderated: true`
  - while the server runs, `bun tools/mod.ts rules add gosh --db <dbPath>`, then `"gosh"` is masked on the next `/moderation/text` call
- [ ] **Step 2:** Fail, implement, pass. Rerun earlier tests.
- [ ] **Step 3:** Commit: `Add a shared text filter for Mix and CPI chat`.

### Task 9: Reports

**Files:**
- Modify: `services/moderation.ts`, `routes/mix/moderation.ts`, `routes/moderation.ts` (CPI), `tools/mod.ts`
- Test: extend `tools/mix-moderation-test.ts`

**Interfaces:**
- Produces:
  - `report(r: { reporter: string; reported: string; reason: string; source: "mix" | "cpi"; threadId?: number; messageId?: number }): number`
  - `listReports(status?: "open" | "actioned" | "dismissed"): ReportRow[]`
  - `setReportStatus(id: number, status: "actioned" | "dismissed"): boolean`
- Mix `PUT /moderation/reportPlayer` stores a report with `reporter = req.mixUserId`.
- CPI report resolves `:displayName` to a swid with `db.getPlayerByDisplayName`.
  - An unknown name is still 200: we don't confirm whether accounts exist.
  - It stores a report with `source:"cpi"` and `reported` set to the display name prefixed `name:`.
- CLI: `reports [--open]` and `report <id> dismiss|actioned`.

- [ ] **Step 1:** Add checks:
  - alice reports bob via Mix, then via CPI (`POST /moderation/v1/report/name/bob` with Basic auth for alice's swid and a JSON-string body)
  - `mix_reports` then has 2 `open` rows with the right reporter, reported, source and reason
- [ ] **Step 2:** Fail, implement, pass. Commit: `Store player reports from Mix and CPI`.

### Task 10: Sanctions, alerts and bans

**Files:**
- Modify: `services/moderation.ts`, `routes/mix/auth.ts`, `routes/guestcontroller.ts` (login and refresh-auth), `tools/mod.ts`
- Test: extend `tools/mix-moderation-test.ts`

**Interfaces:**
- Produces:
  - `type AlertTypeName`: the 11 strings in `MIX_API.md` §9.
  - `LADDER: Record<AlertTypeName, { min: 1 | 3; rungs: [Rung, Rung, Rung, Rung, Rung] }>`, where `Rung = null | { kind: "ban" | "lock"; hours: number | null }` (`hours: null` = permanent).
    - The values transcribe §9's table: "warning" is `null`, "N h" is `{ban, N}`, "permanent", "ban" and "contact support" are `{ban, null}`, and "locked" is `{lock, null}`.
    - `min` is 3 for `POTENTIAL_PAEDOPHILE`, `TERRORIST` and `VULNERABLE_PERSON`, and 1 for the rest.
  - `sanction(swid: string, type: AlertTypeName, level: number, moderator: string): { alertId: number; ban: BanRow | null }`
    - Clamps `level` to `[min, 5]`.
    - In one `inTransaction`:
      1. `db.addMixAlert(swid, String(level), type, Date.now())`
      2. an `AddAlert` notification via `notify` with `Alert: { AlertId, Level: String(level), Text: type, Timestamp }` (check the field shape against `MixDomain/AddAlertNotification.cs` and `NotificationValidator`)
      3. a ban row if the rung is non-null (`until = now + hours`, or null)
      4. a sanction row
  - `suggestLevel(swid, type): number`: the last level for that type plus 1, clamped to `[min, 5]`.
  - `isBanned(swid): BanRow | null`: an active row has `lifted_at IS NULL AND (until IS NULL OR until > now)`.
  - `liftBan(swid): boolean`
- `authenticateMix`: after resolving the token's swid, `isBanned` gives `401 UNAUTHORIZED_BANNED`.
- Guest Controller `guest/login` and `refresh-auth`, after the credentials check:
  - a temporary ban gives `buildError('LOGIN','PROFILE_USER_BANNED', …)`
  - a permanent ban or lock gives `PROFILE_DISABLED`
  - same HTTP status as the existing invalid-credentials error
- CLI:
  - `sanction <swid|displayName> <TYPE> [level]`: the level defaults to `suggestLevel`. It prints the alert and ban.
  - `unban <swid|displayName>`

- [ ] **Step 1: Add checks.**
  - **Warning only:** `sanction(bob,"TROLL",1)` (call the service from the test via `tools/mod.ts --db <dbPath>`). Bob's `drain()` yields an `AddAlert` with `Text:"TROLL"` and `Level:"1"`, and bob's calls still return 200.
  - **Temporary ban:** `sanction(bob,"TROLL")` gives suggested level 2, which is a 12 h ban. Bob's next call gets 401 `UNAUTHORIZED_BANNED`. A fresh login gets `PROFILE_USER_BANNED`.
  - **Expiry:** set `until` to the past directly in SQL. Login works again.
  - **Lock:** `sanction(bob,"VULNERABLE_PERSON",1)` is clamped to 3, which is a lock. Login gets `PROFILE_DISABLED`.
  - **Unban:** `unban bob`. Login works.
- [ ] **Step 2:** Fail, implement, pass. Rerun all tests.
- [ ] **Step 3: Live checks (CPI client, plus Mix if Unity is available).** Ban a test account and record what each app shows on its next Mix call and on login. Add the results to `MIX_API.md` §9 and remove the matching §11 open question.
- [ ] **Step 4:** Add the GC ban codes to `MIX_API.md` §9. Commit: `Apply Disney's sanction ladder with alerts and bans on both apps`.

---

## Phase 3: Core chat

Shared interfaces for Tasks 11–15, all in `web-api/src/services/mixChat.ts` unless noted:

- `class MixError extends Error { constructor(public status: string, public http: 400 | 401 = 400) }`, in `services/mixErrors.ts`.
  - Routes catch it and reply `res.status(e.http).json({ Status: e.status })`.
  - Any other error is a 500.
- Wire DTOs follow `MixDomain/*.cs` field names exactly:
  - `ChatThread`: `ChatThreadId`, `ChatThreadType`, `IsTrusted`, `Members` (a `mixUser` list), `OfficialAccountId: null`
  - message: `ChatMessageId`, `ClientChatMessageId`, `ChatThreadId`, `SenderUserId`, `SequenceNumber`, `Created`, `MessageType`, plus the type's fields
- `toMessageDto(row): object` maps a `mix_chat_messages` row to its wire shape.
  - `payload` JSON holds the type fields: TEXT `{Text}`, STICKER `{ContentId}`, GAG `{ContentId, TargetUserId}`, MEMBER_LIST_CHANGED (fields per `MixDomain/MemberListChangedChatMessage.cs`).
  - Check field names against `MixDomain/TextChatMessage.cs` and `StickerChatMessage.cs`.

Thread-level notifications go to **current members** (`left_at IS NULL`) via `notifyMany`. "Own" notifications go only to the actor, via `notify`.

### Task 11: Threads and `/state` chat fields

**Files:**
- Create: `services/mixErrors.ts`, `services/mixChat.ts`, `routes/mix/chat.ts`
- Modify: `database.ts`: tables `mix_chat_threads`, `mix_chat_members`, `mix_chat_messages`, `mix_chat_nicknames`, per the spec, with indexes on `mix_chat_members(swid)` and `mix_chat_messages(thread_id, seq)`
- Modify: `routes/mix/index.ts`, `routes/mix/state.ts`
- Test: `tools/mix-chat-test.ts`

**Interfaces:**
- Produces:
  - `createThread(creator: string, type: "ONE_ON_ONE" | "GROUP", memberIds: string[]): MixNotification`
    - Members are deduplicated. The creator is implicitly a member.
    - Every other member must be the creator's friend, or `400 USER_NOT_FRIEND`. First grep `MIX_SDK` for the creation failure statuses (`ChatThreadCreator*`) and use the client's string if one exists. Record the one you use in `MIX_API.md`.
    - `ONE_ON_ONE` requires exactly 1 other member, or `400 INVALID_REQUEST`.
    - If one already exists for the pair, `ONE_ON_ONE` returns a fresh `AddChatThread` notification for the creator only, with the existing thread.
    - `is_trusted` = the friendship's `IsTrusted` for 1:1. For groups, it is true only if every pair of members is trusted.
    - Emits `AddChatThread { ChatThread, WelcomingUserId: creator }` to all members and returns the creator's copy.
  - `stateFor(swid): { ChatThreads; ChatThreadNicknames; ChatThreadUnreadMessageCount; ChatThreadLatestMessageSequenceNumbers; ChatThreadLastSeenMessageSequenceNumbers; GameStateChatMessages: [] }`
    - The two sequence lists are parallel to `ChatThreads`.
    - Unread = `latest − max(last_seen_seq, history_cleared_seq)`, never below 0. Only threads with unread > 0 are listed.
- Route: `PUT /chatThread`, with body `{ ChatThreadType, MemberUserIds }` and response `{ Status:"OK", Notification }`.

- [ ] **Step 1: Write `tools/mix-chat-test.ts`.** Users alice, bob and carol: alice and bob are friends, alice and carol are friends, bob and carol are not. Make them friends through the API, using the invite and accept flow from `mix-friends-test`. Checks:
  - alice creates 1:1 with bob: alice `apply`s the response, bob `drain`s one `AddChatThread` with type `ONE_ON_ONE`
  - creating it again returns the same `ChatThreadId`, and bob's `drain()` is empty
  - bob creates a group with carol: 400
  - alice creates a group with bob and carol: everyone gets `AddChatThread` with type `GROUP`
  - `state()` lists 2 threads for alice and both sequence lists are `[0,0]`
- [ ] **Step 2:** Fail, implement, pass. Commit: `Create Mix chat threads and report them in state`.

### Task 12: Sending text, sticker and gag messages

**Files:**
- Modify: `services/mixChat.ts`, `routes/mix/chat.ts`
- Test: extend `tools/mix-chat-test.ts`

**Interfaces:**
- Consumes: `filterText`, `isBanned` (Tasks 8 and 10), `notifyMany`, `inTransaction`.
- Produces: `addMessage(sender: string, threadId: number, clientMessageId: number, type: "TEXT" | "STICKER" | "GAG", fields: object): MixNotification`, in this order:
  1. An existing `(sender, clientMessageId)` returns the sender's original notification. Look up the sender's `mix_pending_notifications` row whose `data.Message.ChatMessageId` matches, and return its `data` unchanged. No new rows.
  2. Thread exists and the sender is a current member, or `400 NOT_FOUND`.
  3. TEXT only:
     - `Text` is a string of 1–1000 UTF-16 units, or `400 INVALID_REQUEST`
     - `filterText`: blocked gives `400 MODERATION_BLOCKED` (record the status in `MIX_API.md` as an iceberg-defined status)
     - store `filterText().text`
  4. STICKER and GAG need a non-empty `ContentId`. GAG's `TargetUserId` must be a current member. Otherwise `400 INVALID_REQUEST`.
  5. `seq = COALESCE(MAX(seq),0)+1`, insert, then `notifyMany(members, "AddChatThread<Type>Message", () => ({ Message }))` with `<Type>` = `Text`, `Sticker` or `Gag`. Return the sender's copy.
- Ban: `authenticateMix` already rejects banned users, so there's no extra check here.
- Routes: `PUT /chatThread/textMessage | stickerMessage | gagMessage`, with body `{ ChatThreadId, ClientChatMessageId, Text | ContentId [, TargetUserId] }` and response `{ Status:"OK", Notification }`.

- [ ] **Step 1: Add checks.**
  - **Text:** alice sends `"hi 👋"` to the 1:1. Alice applies her copy and bob drains one `AddChatThreadTextMessage` with `Message.SequenceNumber === 1` and `Text === "hi 👋"`.
  - **Retry:** resending the same `ClientChatMessageId` returns an identical `Notification`, and bob's `drain()` is empty.
  - **Moderation:** with a `darn` mask rule seeded, `"darn"` is stored as `"****"`, and `heck` (block) gives 400 `MODERATION_BLOCKED`.
  - **Length:** 1001 characters gives 400 `INVALID_REQUEST`.
  - **Non-member:** carol sending to the 1:1 gives 400 `NOT_FOUND`.
  - **Sticker and gag:** they work in the group. A gag targeting a non-member gives 400.
  - **Burst:** alice and bob each send 10 messages concurrently (`Promise.all`) to the group. Every member's `drain()` succeeds (gap-free), and the thread seqs are exactly 1..N with no duplicates (query SQL).
- [ ] **Step 2:** Fail, implement, pass. Commit: `Send text, sticker and gag messages in Mix chat`.

### Task 13: Adding and removing members

**Files:**
- Modify: `services/mixChat.ts`, `routes/mix/chat.ts`
- Test: extend `tools/mix-chat-test.ts`

**Interfaces:**
- Produces:
  - `addMembers(actor: string, threadId: number, userIds: string[]): { MembershipNotification: MixNotification; ChatMessageNotification: MixNotification }`
    - Group only. On a 1:1 it gives `400 INVALID_REQUEST`.
    - The actor must be a member, or `400 USER_NOT_THREAD_MEMBER`.
    - Any id that's already a member gives `400 USER_ALREADY_THREAD_MEMBER`.
    - Each new id must be the actor's friend.
    - New members get `joined_seq = latest`.
    - Emits `AddChatThreadMembership { ChatThreadId, Members, WelcomingUserId }` to all current members, including the new ones.
    - New members also get `AddChatThread`.
    - Then a `MEMBER_LIST_CHANGED` message is added through the same path as `addMessage` (sender = actor, no moderation) and emitted as `AddChatThreadMemberListChangedMessage`.
    - Returns the actor's two copies.
  - `removeMember(actor: string, threadId: number, userId: string): { MembershipNotification; ChatMessageNotification }`
    - Removing yourself (leaving) is always allowed for members.
    - Removing someone else needs the actor to be the thread creator, or `400 USER_NOT_THREAD_MEMBER`. Check `MixDomain/RemoveChatThreadMembershipRequest.cs` for the field name.
    - Emits `RemoveChatThreadMembership` and the system message to the remaining members plus the removed user, then sets `left_at`.
- Routes:
  - `PUT /chatThreadMembership { ChatThreadId, AddedUserIds }`, returning `{ MembershipNotification, ChatMessageNotification }`
  - `POST /chatThreadMembership/delete`, returning the same keys

- [ ] **Step 1: Add checks.**
  - In a group of alice and bob, alice adds carol. Carol drains `AddChatThread` + `AddChatThreadMembership` + `AddChatThreadMemberListChangedMessage`. Bob drains the membership and system message.
  - Adding carol again gives 400 `USER_ALREADY_THREAD_MEMBER`.
  - Carol leaves. Alice and bob drain `RemoveChatThreadMembership`, and carol's later send gives `NOT_FOUND`.
  - Adding to the 1:1 gives 400.
- [ ] **Step 2:** Fail, implement, pass. Commit: `Add and remove Mix group chat members`.

### Task 14: Reading history

**Files:**
- Modify: `services/mixChat.ts`, `routes/mix/chat.ts`
- Test: extend `tools/mix-chat-test.ts`

**Interfaces:**
- `visibleFloor(swid, threadId): number` = `max(joined_seq, history_cleared_seq)`. Readers see `seq > floor`, and for members who left, only `seq <=` the seq at their `left_at`. A non-member who never joined gets `400 NOT_FOUND`.
- Each reader returns the `GetChatThreadMessagesResponse` grouping: lists `Text`, `Sticker`, `Gag`, `Video`, `Photo`, `GameState`, `GameEvent` and `MemberListChanged`, with absent types as `[]`.
- Read each request and response class in `MixDomain/` for field names before implementing:

| Route | Request class | Behavior |
|---|---|---|
| `POST /chatThread` | `GetChatThreadMessagesRequest` | Pages newest first. `Cursor` is the opaque string of the lowest seq returned. Page size 50. |
| `POST /chatThread/recentMessages` | `GetRecentChatThreadMessagesRequest` (`MessagesSince` ms) | All visible messages across the user's threads created after `MessagesSince`, max 500. |
| `POST /chatThread/specificMessages` | `GetSpecificChatThreadMessagesRequest` | By id list. Non-visible ids are silently omitted. |
| `POST /chatThread/messages/recent` | `GetChatThreadsRecentMessagesRequest` | Latest N per thread for the given threads. N = request value or 20. |
| `POST /chatThread/messages/bySequenceRange` | `GetChatThreadMessagesBySequenceRangesRequest` (`Ranges` = flat `[start,end,start,end…]`, inclusive) | Odd-length `Ranges` gives `400 INVALID_REQUEST`. |
| `POST /chatThread/messages/sequenceNumber` | `GetChatThreadSequenceNumberRequest` | Latest seq for the thread. |

- [ ] **Step 1: Add checks.**
  - **Paging:** after 60 messages, `POST /chatThread` returns 50 messages and a `Cursor`. The next page returns 10 and a null `Cursor`.
  - **Ranges:** `bySequenceRange [1,3,5,5]` returns seqs `{1,2,3,5}`.
  - **Late joiner:** carol, added after seq 60, sees nothing at or below 60.
  - **Outsider:** a never-member gets `NOT_FOUND`.
  - **Sequence number:** `sequenceNumber` equals the max seq.
- [ ] **Step 2:** Fail, implement, pass. Commit: `Read Mix chat history`.

### Task 15: Unread counts, clearing history, nicknames and trust

**Files:**
- Modify: `services/mixChat.ts`, `routes/mix/chat.ts`, `routes/mix/friends.ts` (trust removal hook)
- Test: extend `tools/mix-chat-test.ts`

**Interfaces:**
- `clearUnread(swid, threadId): MixNotification`
  - Sets `last_seen_seq = latest` and emits `ClearUnreadMessageCount` (fields per `MixDomain`) to swid only.
  - Route: `POST /chatThreadMembership/unreadMessageCount/delete`.
- `clearHistory(swid, threadId): MixNotification`
  - Sets `history_cleared_seq = latest` and `last_seen_seq = latest`, and emits `ClearMemberChatHistory` to swid only.
  - Route: `POST /chatThreadMembership/history/delete`.
- `setThreadNickname(swid, threadId, nickname: string): MixNotification`
  - 1–32 UTF-16 units, passed through `filterText`: blocked gives 400 `MODERATION_BLOCKED`, masked is stored masked.
  - Emits `AddChatThreadNickname { ChatThreadNickname: { ChatThreadId, Nickname } }` to swid only.
  - `removeThreadNickname` emits `RemoveChatThreadNickname`.
  - Routes: `PUT /chatThread/nickname`, `POST /chatThread/nickname/delete`.
- `onFriendshipTrustRemoved(a: string, b: string): void`
  - Called inside the existing `/friendship/trust/delete` transaction.
  - Every thread containing both a and b with `is_trusted = 1` becomes `0`, and `UpdateChatThreadTrustStatus` (fields per `MixDomain`) goes to its members.

- [ ] **Step 1: Add checks.**
  - **Unread:** after bob sends 3 messages, alice's `state()` shows unread 3 for the thread. After `clearUnread`, it's absent.
  - **History:** after `clearHistory`, alice's `POST /chatThread` returns `[]` while bob still sees all messages.
  - **Nicknames:** a nickname round-trip shows in `state().ChatThreadNicknames`. Its removal clears it.
  - **Trust:** make alice and bob trusted, create a trusted 1:1, remove trust. Both drain `UpdateChatThreadTrustStatus`, and `state()` shows `IsTrusted: false`.
  - **Resync:** a fresh `state()` for every user matches what their drained notifications built up (thread ids, unread, nicknames).
- [ ] **Step 2:** Fail, implement, pass. Commit: `Track unread counts, history clears, thread nicknames and trust in Mix chat`.

### Task 16: Phase 3 acceptance and docs

- [ ] **Step 1:** Run every test in `tools/`: `for t in tools/*-test.ts; do bun $t || exit 1; done`. Expected: all `ALL PASSED`.
- [ ] **Step 2: Live check (Unity required).** Two Mix recreation clients chat 1:1 and in a group, restart the server, and confirm history and unread counts are intact. Also log in to CPI on one account and confirm friends and presence still work. If Unity isn't available, say so explicitly in the report.
- [ ] **Step 3: Update `MIX_API.md`.**
  - §4: mark the implemented endpoints ✅.
  - §7: add the status strings and type strings now confirmed.
  - §11: remove the answered questions.
- [ ] **Step 4:** Commit: `Mark Mix chat endpoints as implemented`. Push.
