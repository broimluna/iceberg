# Disney Mix API

A living reference for the Disney Mix platform API, as used by both
**Club Penguin Island** and the **Disney Mix** chat app, and as recreated
in iceberg's `web-api`. It records what we find, where we found it, and
why Mix works the way it does, so the knowledge survives even if the
clients or the people who studied them don't.

Add to it as you learn things. When you write something down, cite the
client class it came from. Mark anything you inferred rather than read
as **(inferred)**.

Sources used so far:

- **Mix client:** the [OpenCPIsland/DisneyMix](https://github.com/OpenCPIsland/DisneyMix)
  Unity recreation (decompiled C#, `Assets/Scripts/Assembly-CSharp/`).
  Paths below are relative to that folder. The SDK lives in
  `Disney/Mix/SDK/` and the app UI in `Mix/`.
- **CPI client:** the same Mix SDK ships inside CPI as `MixSDK`. See
  `client-build/clients/android/decompiled/`.
- **iceberg:** `web-api/src/routes/mix/` (one file per area), `services/mixNotify.ts`, and `routes/guestcontroller.ts`.

---

## 1. The big picture: one platform, two apps

Mix was not just an app. It was Disney's social platform (accounts,
friends, presence, chat, moderation) with its own SDK. Disney Mix the
app was the flagship client. Club Penguin Island was built on the same
SDK and reused the same back end for friends and identity. That is why
CPI's friend system speaks `/friendship/invitation`, `/state`, and
`/notifications/sinceSequence`: those are Mix calls.

A Mix client talks to three services:

| Service | What it does | Original host |
|---|---|---|
| **Guest Controller** (`/jgc/v5/...`) | Disney account login, registration, tokens | `registerdisney.go.com` |
| **Mix Platform Services** | The Mix API itself: everything in section 4 | `di-mixprod-us-prod-1.appspot.com/mix/` |
| **cpipe** | Versioned content CDN (manifest, config, asset bundles) | `dicpipe.disney.io/serve/mix/prod` |

Mix Platform Services ran on **Google App Engine** (`appspot.com`). That
fits the API's style: stateless JSON over HTTP with polling, and no
sockets anywhere. App Engine of that era couldn't hold long-lived
connections, which goes a long way toward explaining why Mix is a
polling design (see section 5). **(inferred)**

In iceberg, all three run in one `web-api` process. Mix routes are
mounted at both `/` and `/mix` (`server.ts`), so a client that keeps the
original `/mix/` path suffix works too.

---

## 2. Boot sequence and the encrypted config

### The config file `donotcopy/n7c4c656`

Before the Mix app can log in, it needs to know where the services
are. It reads them from a remote config file:

- Path: `donotcopy/n7c4c656`. The `_dev` and `_qa` variants exist for
  other environments, and `GetEnvironment()` is hard-coded to `"prod"`
  (`Mix/ConfigurationManager.cs`).
- It is loaded through cpipe like any other asset. On first run the
  copy bundled in `StreamingAssets/` is used ("cache then bundle").
- It is encrypted: Base64 over **AES-256-CBC**, PKCS7 padding.
  - The key is built from string fragments in `ConfigurationManager.GetKey()`:
    `U8rYu9uzHmujSvAogNfj4IfuC9GRJzNCarb+cfaYN5k=` (Base64, 32 bytes).
  - The IV is a fixed byte array in `GetIV()`:
    `05ec55c6795f972c0f38a2206a81e369`.
  - Splitting the key into fragments is obfuscation against `strings`,
    not real security.

To decrypt it (no `xxd` needed):

```sh
KEY=$(echo -n 'U8rYu9uzHmujSvAogNfj4IfuC9GRJzNCarb+cfaYN5k=' | base64 -d | od -An -tx1 | tr -d ' \n')
base64 -d n7c4c656 | openssl enc -d -aes-256-cbc -K "$KEY" -iv 05ec55c6795f972c0f38a2206a81e369
```

Encrypting is the same command with `-e` instead of `-d`, piped
through `base64 -w0`.

**Generating one for iceberg:** `bun tools/mix-config.ts render
<base URL> --out n7c4c656` writes Disney's original 16 keys with:

- `guest_baseUrl` = base, `guest_v2_baseUrl` = base + `/jgc/v5`
- `mix_platform_services_url` = base + `/mix`
- `cpipe_url` = base + `/cpipe`

`decrypt <file>` prints any config.

The recreation ships two copies:

- **`n7c4c656.og`** is Disney's original prod config:
  ```json
  {"guest_baseUrl":"https://registerdisney.go.com",
   "guest_v2_baseUrl":"https://registerdisney.go.com/jgc/v2",
   "guest_clientId":"DI-SPARK-PROD",
   "cpipe_url":"https://dicpipe.disney.io/serve/mix/prod",
   "mix_platform_services_url":"https://di-mixprod-us-prod-1.appspot.com/mix/",
   "mix_platform_services_cellophane":"F7EA7678-FE45-4A00-89EB-496EFDA74761",
   "cellophane_client_id_assets":"GAE 01D93B3F-8532-4A91-81E7-558BE3600600",
   "gcm_sender_id":"133104891689",
   "force_update_version":"2.3", ...}
  ```
- **`n7c4c656`** is the recreation's working copy. It points the
  Guest Controller, Mix API, and cpipe all at the root of one host
  (`http://10.0.0.76:5782`), with `guest_v2_baseUrl` at `/jgc/v5`.
  That is a different machine and port from the `10.0.0.77:80` the
  prebuilt build is hard-wired to (section "Live boot" below), so the
  recreation dev evidently ran more than one server setup (inferred).
- **iceberg's render** (`tools/mix-config.ts`) instead puts the Mix API
  at `<base>/mix` and cpipe at `<base>/cpipe`, closer to Disney's
  layout (`.../mix/` on App Engine, cpipe on its own path). The server
  mounts the Mix routes at both `/mix` and the root, so either config
  works. Those must be **two separate `app.use` calls**: Express 4
  compiles `app.use(['/', '/mix'], r)` into a single layer whose `/`
  alternative always matches first and strips nothing, so the router
  sees `/mix/state` and every `/mix/...` call 404'd. Nobody noticed
  because CPI and the prebuilt Mix build both call the root
  (`mix-boot-test` now runs a session under `/mix`).

Mix's internal codename was **Spark**. You can see it in the Guest
Controller client ID `DI-SPARK-PROD` and in the asset paths under
`http://10.190.6.223/spark/` that are baked into hundreds of asset
references.

### Which keys are fatal

`Mix/ExternalizedConstants.cs` marks each key as fatal or non-fatal if
missing. If a fatal key is missing, the app deletes its cached config
and refetches it. Otherwise it boots with defaults.

- **Fatal:** `guest_baseUrl`, `guest_clientId`,
  `cellophane_client_id_assets`, `cpipe_url`,
  `mix_platform_services_url`, `mix_platform_services_cellophane`
- **Non-fatal:** legal/help URLs, `force_update_version`, store links,
  `gcm_sender_id`

### cpipe

cpipe is a versioned file manifest. The app maps a logical path to a
versioned CDN URL (`Mix/CpipeFileManifest.cs`, `Mix/Assets/CpipeManager.cs`).

- First-run manifest: `StreamingAssets/1123402340.txt`
  (`AssetManager.GetCpipeFileNameInStreamingAssets()`).
- At runtime, `Mix/CpipeManifestApi.GetCpipeManifest` requests
  `GET {cpipe_url}?restrict=true&cv=<client version>&v=<manifest version>`.
  - The `v` parameter is only sent when the client already has a
    manifest version.
  - It sends `Authorization: <cellophane_client_id_assets>`, i.e.
    `Authorization: GAE 01D93B3F-8532-4A91-81E7-558BE3600600`. "GAE"
    is Google App Engine again: the cellophane asset token was an App
    Engine credential.
  - The server has to answer this, or keep answering "no update".
- The class also contains a `generateToken()` that SHA1-signs
  `"<version>-<ENV>"` with another fragment-built key. Nothing in the
  manifest request uses it. It is probably left over from an older
  signed-URL scheme. **(inferred)**
- Bundled manifest format (`StreamingAssets/1123402340.txt`):
  ```json
  {"manifest": {"version": "00134", "unique": "1487182197",
                "cdnRoot": "", "url": "",
                "paths": {"<relative path>": {"crc": "EAD7584A", "v": 1487031360}, ...}},
   "ab": ...}
  ```
  - `paths` has 5,459 entries, including all three
    `donotcopy/n7c4c656{,_dev,_qa}` configs. Each entry is a CRC32 plus
    a Unix-time version.
  - `unique` 1487182197 is **2017-02-15**, so this is a snapshot of
    the content as of that date. (Shutdown date: to confirm and cite.)
  - Because `cdnRoot` is empty, the client resolves everything against
    its bundled `StreamingAssets`. That is why the recreation boots
    with no CDN at all.
  - The original app built a file's CDN URL as `cdnRoot` + path, and
    the `v` value is what busted caches when a file changed
    (`CpipeFileManifest.TranslateFileUrl`).

**In iceberg** (`routes/cpipe.ts`):
- `GET /cpipe` returns the recreation's manifest `00134` with
  `cdnRoot = <origin>/cpipe/files`, and gives the boot config entry
  the version `config.mix.cpipeConfigVersion`. That defaults to the
  server start time and can be overridden with
  `MIX_CPIPE_CONFIG_VERSION`.
- Bumping the version should make the app refetch the config from
  `GET /cpipe/files/<v>/donotcopy/n7c4c656`, which is served from
  `web-api/data/mix/cpipe/`. Because the default version is the server
  start time, every restart advertises a "newer" config. So render the
  same config there as you bundle in the build
  (`bun tools/mix-config.ts render <url> --out
  web-api/data/mix/cpipe/donotcopy/n7c4c656`). Otherwise the refetch
  404s. That directory is git-ignored because it's per-deployment. This lets us repoint an installed app
  without rebuilding it (to be confirmed live in phase 1).
- Without an `Authorization` header the request gets 400. With one,
  only its presence is checked, since it's a public token.
- **Desktop bundles (2026-11-07).** `GET /cpipe` also lists every file
  under `web-api/data/mix/cpipe/AssetBundles/{windows64,standalonelinux64}/`
  (`services/mixContent.ts`). The key is the path under `cpipe/` with
  forward slashes (`AssetBundles/windows64/hd/stickers/…/x_hd.unity3d`),
  `crc` is the file's CRC32 as 8 uppercase hex digits (Disney's format),
  and `v` is the file's mtime in whole Unix seconds. `.meta` files are
  skipped, and the base `android`/`iphone` entries are left alone.
  - Why mtime: the client puts `v` into the download URL
    (`cdnRoot/<v>/<path>`) and uses it as the Unity cache version for
    the bundle. A re-imported bundle that changed gets a new mtime, so
    installed apps download it again instead of using a stale cache.
  - Why only files on disk: the client hides stickers and gags whose
    bundle isn't in the manifest (§10), so the manifest must never
    promise content the server doesn't have.
  - The tree is scanned once at startup, like the config version, so new
    bundles show up after an import and a restart. With no tree, web-api
    logs one `[CPIPE]` line and serves the base manifest unchanged.
  - The tree is git-ignored: the bundles are Disney assets rebuilt by the
    recreation (~68 MB per platform). Fill it with
    `bun tools/mix-content.ts import` (§10).

- **The client refreshes the manifest (2026-11-07, source builds).** The
  app loads the manifest twice at startup, and only the second load
  asks the server:
  1. `AssetManager` start: `CpipeFileManifestLoader.Load` with
     `aIsFirstRun == true` uses the cached manifest from the last boot
     or else the bundled `1123402340.txt`. It can't ask the network,
     because `cpipeManager.cpipe` (the `cpipe_url` holder) isn't set up
     yet.
  2. `StartUpSequence` → `CpipeUpdateOperation` → `LoadCpipe` with
     `aIsFirstRun == false`: calls `GET /cpipe?restrict=true&cv=…&v=…`.
     A 200 body replaces the manifest (and is cached), a 304 or any
     failure keeps the first one. A new manifest triggers
     `RefreshInventoy()`, which rebuilds the sticker and gag lists
     against it (§10). If its config `v` is newer, the config refetch
     (above) runs and `CpipeUpdateOperation` waits for it: that's why
     `donotcopy/n7c4c656` must exist under `web-api/data/mix/cpipe/`.
     Checked live: boot completes, no stall.
     The request has a 10 s watchdog (`REFRESH_TIMEOUT_SECONDS`): `WWW` has no
     timeout of its own, so a host that drops packets would otherwise hold boot
     for the OS connect timeout. On timeout the refresh reports "unchanged".

The point of cpipe was that content (stickers, gags, games, the config
itself) could be updated without shipping a new app build.

---

## 3. Transport: headers and the `application/mix` encryption

Every Mix API call is built in
`Disney/Mix/SDK/Internal/MixWebCallFactory.cs`:

- **Headers**
  - `Content-Type: application/mix` once a session exists.
    The session-start call is plain, unencrypted `application/json`
    (`MixSessionStartWebCallEncryptor` passes bytes through unchanged
    and has no session ID). It has to be: no symmetric key exists yet.
  - `X-Mix-OneIdToken`: the Guest Controller access token.
  - `X-Mix-ClientToken`: the "cellophane" client token from config
    (`F7EA7678-...` for Mix).
  - `X-Mix-UserSessionId`: the Mix session ID, once there is one.
- **Body:** every request extends `BaseUserRequest`, and the factory
  fills in `UserId` (the SWID) and `Timestamp` (epoch ms, corrected
  for server clock offset).
- **Timeouts:** 10 s latency timeout and 30 s max per call by default.

### The session key exchange (`PUT /session/user`)

Implemented in `MixSessionStarter.cs`:

1. The client generates an **RSA keypair** once and stores it in its
   local database (`GetRsaParameters`/`SetRsaParameters`).
2. `PUT /session/user` sends the public key.
3. The server replies with `SessionId` and `EncryptedSymmetricKey`: a
   fresh 32-byte AES key, encrypted with that RSA public key.
4. From then on, every request and response body is encrypted with
   **AES-256-CBC + PKCS7**, using a **random 16-byte IV prepended** to
   the ciphertext (`MixEncryptor.cs`).
5. The client keeps both `CurrentSymmetricEncryptionKey` and
   `PreviousSymmetricEncryptionKey`, so responses still in flight
   during a session refresh can still be decrypted.

Why bother with this when HTTPS already existed? The same symmetric
key is stored as `keychain.PushNotificationKey`. Push payloads went
through Apple/Google push servers, which HTTPS doesn't protect end to
end. Encrypting with the per-session key kept chat content in push
notifications unreadable to the push providers. **(inferred from the
key reuse)**

iceberg implements this in `routes/mix/auth.ts` (`mixEncryptionMiddleware`)
and `routes/mix/session.ts` (`buildRsaPublicKey`).

### HTTP status semantics (`MixWebCall`)

The client treats HTTP status codes very differently, so a server has
to pick them carefully:

- **5xx**: retried once automatically, then reported as an error.
  Never use 5xx for an expected failure.
- **429**: reported as `THROTTLED` without reading the body. This is a
  built-in rate-limit signal.
- **401**: the body's `Status` goes to the unauthorized handler
  (`MixWebCallFactory`):
  - `UNAUTHORIZED_ONEID_TOKEN` refreshes the Guest Controller token
  - `UNAUTHORIZED_MIX_SESSION` redoes the key exchange
  - `UNAUTHORIZED_BANNED` logs the user out
  - anything else refreshes both
- **Other 4xx**: the body's `Status` is passed to the specific
  feature's error handler. For example, `ChatThreadMemberAdder`
  switches on `USER_ALREADY_THREAD_MEMBER` and
  `USER_NOT_THREAD_MEMBER`. This is how domain errors reach the UI.
- **2xx**: the body is parsed as the typed response.

All error bodies are encrypted like any other response once a session
exists.

### iceberg's Mix auth (fixed 2026-11-07)

Before this fix, `authenticateMix` accepted any non-empty
`X-Mix-OneIdToken` and trusted the body's `UserId`, so any client could
act as any user. A test reproduced it: alice's token sent a friend
invite as bob. Now (`routes/mix/auth.ts`):

- The token must be an unexpired Guest Controller **access** token.
  Otherwise the response is `401 UNAUTHORIZED_ONEID_TOKEN`, and the SDK
  refreshes its token and retries.
- A body `UserId` that differs from the token's SWID gets the same 401.
  Handlers always see the token's SWID in `UserId`.
- An encrypted request whose `X-Mix-UserSessionId` belongs to another
  SWID gets `401 UNAUTHORIZED_MIX_SESSION`, and the SDK redoes the key
  exchange.

`tools/mix-auth-test.ts` covers all three.

**Live check (2026-11-07, real CPI Windows client, two accounts):**
- login, session start, `/state`, friend search, invite, accept, remove,
  and 31 polls, with **zero** auth failures
- one `guest/refresh-auth` during the session, handled normally
- only 2 `/state` calls (one per login), so the resync loop from the
  `sinceSequence` bug (§5) is gone in practice

---

## 4. Endpoint inventory

These are all 61 calls in `MixWebCallFactory`. The status column shows
iceberg's current state.

**Session and sync**

| Method | Path | Request type | iceberg |
|---|---|---|---|
| PUT | `/session/user` | StartUserSessionRequest | ✅ |
| POST | `/session/user/delete` | BaseUserRequest | ✅ |
| POST | `/state` | GetStateRequest | ✅ (no chat yet) |
| POST | `/notifications` | GetNotificationsRequest | ✅ |
| POST | `/notifications/sinceSequence` | GetNotificationsSinceSequenceRequest | ✅ |
| PUT | `/presence` | SetPresenceRequest | ✅ |
| POST | `/presence` | BaseUserRequest | ✅ |

**Users and profile**

| Method | Path | Request type | iceberg |
|---|---|---|---|
| POST | `/users/byUserId` | GetUsersByUserIdRequest | ✅ |
| POST | `/users/byDisplayName` | GetUsersByDisplayNameRequest | ✅ |
| POST | `/search/displayname` | DisplayNameSearchRequest | ✅ |
| PUT | `/displayname` | SetDisplayNameRequest | ✅ |
| POST | `/displayname/validate` | ValidateDisplayNamesRequest | ✅ (+ `/v2`) |
| PUT | `/avatar` | SetAvatarRequest | ❌ |
| PUT | `/nickname` | AddNicknameRequest | ❌ |
| POST | `/nickname/delete` | RemoveNicknameRequest | ❌ |
| POST | `/languagePreference` | SetLanguageRequest | ✅ |
| POST | `/geolocation` | BaseUserRequest | ✅ |
| POST | `/registration/text` | GetRegistrationTextRequest | ✅ |
| POST | `/pil/check` | PilCheckRequest | ✅ |

**Friends**

| Method | Path | Request type | iceberg |
|---|---|---|---|
| PUT | `/friendship` | AddFriendshipRequest | ✅ |
| POST | `/friendship/delete` | RemoveFriendshipRequest | ✅ |
| PUT | `/friendship/invitation` | AddFriendshipInvitationRequest | ✅ |
| POST | `/friendship/invitation/delete` | RemoveFriendshipInvitationRequest | ✅ |
| POST | `/friendship/trust/delete` | RemoveFriendshipTrustRequest | ✅ |
| POST | `/friendship/recommend` | BaseUserRequest | ✅ |

**Chat** (Mix app only; CPI never calls these)

| Method | Path | Request type | iceberg |
|---|---|---|---|
| PUT | `/chatThread` | AddChatThreadRequest | ✅ (section 7) |
| POST | `/chatThread` | GetChatThreadMessagesRequest | ✅ (section 7) |
| PUT | `/chatThreadMembership` | AddChatThreadMembershipRequest | ✅ (section 7) |
| POST | `/chatThreadMembership/delete` | RemoveChatThreadMembershipRequest | ✅ (section 7) |
| POST | `/chatThreadMembership/history/delete` | ClearMemberChatHistoryRequest | ✅ (section 7) |
| POST | `/chatThreadMembership/unreadMessageCount/delete` | ClearUnreadMessageCountRequest | ✅ (section 7) |
| PUT | `/chatThread/textMessage` | AddChatThreadTextMessageRequest | ✅ (section 7) |
| PUT | `/chatThread/stickerMessage` | AddChatThreadStickerMessageRequest | ✅ (section 7) |
| PUT | `/chatThread/gagMessage` | AddChatThreadGagMessageRequest | ✅ (section 7) |
| PUT | `/chatThread/photoMessage` | AddChatThreadPhotoMessageRequest | ❌ |
| PUT | `/chatThread/videoMessage` | AddChatThreadVideoMessageRequest | ❌ |
| PUT | `/chatThread/gameStateMessage` | AddChatThreadGameStateMessageRequest | ❌ |
| POST | `/chatThread/gameStateMessage` | UpdateChatThreadGameStateMessageRequest | ❌ |
| POST | `/chatThread/recentMessages` | GetRecentChatThreadMessagesRequest | ✅ (section 7) |
| POST | `/chatThread/specificMessages` | GetSpecificChatThreadMessagesRequest | ✅ (section 7) |
| POST | `/chatThread/messages/recent` | GetChatThreadsRecentMessagesRequest | ✅ (section 7) |
| POST | `/chatThread/messages/bySequenceRange` | GetChatThreadMessagesBySequenceRangesRequest | ✅ (section 7) |
| POST | `/chatThread/messages/sequenceNumber` | GetChatThreadSequenceNumberRequest | ✅ (section 7) |
| PUT | `/chatThread/nickname` | AddChatThreadNicknameRequest | ✅ (section 7) |
| POST | `/chatThread/nickname/delete` | RemoveChatThreadNicknameRequest | ✅ (section 7) |
| POST | `/video/url` | GetVideoUrlRequest | ❌ |

**Official accounts** (brand channels users could follow)

| Method | Path | Request type | iceberg |
|---|---|---|---|
| POST | `/officialAccount/all` | BaseUserRequest | ❌ |
| PUT | `/officialAccount/add` | AddOfficialAccountFollowshipRequest | ❌ |
| POST | `/officialAccount/remove` | RemoveOfficialAccountFollowshipRequest | ❌ |

**Moderation, alerts and push**

| Method | Path | Request type | iceberg |
|---|---|---|---|
| PUT | `/moderation/text` | ModerateTextRequest | ✅ shared rule filter (section 9) |
| PUT | `/moderation/reportPlayer` | ReportPlayerRequest | ✅ stored in `mix_reports` |
| PUT | `/alert/clear` | ClearAlertsRequest | ✅ (was broken until 2026-11-07, see section 9) |
| POST | `/pushNotificationsSetting` | TogglePushNotificationRequest | ✅ (no-op) |
| POST | `/pushNotificationsSetting/delete` | BaseUserRequest | ✅ (no-op) |

**Disney's internal test hooks** (`/integrationTestSupport/...`), not
needed:

`moderation/tempBan`, `officialAccount/publishPhoto`,
`officialAccount/publishText`, `officialAccount/publishVideo`,
`pushNotification/massSend`, `user/alert`, `user/session/expire`.

These are still worth knowing about. The `officialAccount/publish*`
hooks show that official accounts posted text, photo, and video into
chat threads. `user/alert` and `moderation/tempBan` show how alerts and
temp bans reached users: as ordinary notifications through the same
pipeline.

**Notes on the shapes**

- Every "add" response returns the **notification** that the action
  produced. For example, `AddChatThreadTextMessageResponse.Notification`
  is an `AddChatThreadTextMessageNotification`. The sender learns about
  its own action the same way everyone else does.
- **PUT means create. POST means read or delete.** Deletes are
  `POST .../delete`, never HTTP `DELETE`. **(inferred)** This is
  probably because some proxies and platform HTTP stacks of the time
  didn't support `DELETE` with a body.

---

## 5. Notifications: how Mix stays in sync

This is the core of Mix. Every change that affects a user (a new
friend, a message, a nickname, an alert, a temp ban) becomes a
**notification** in that user's own ordered stream. Each notification
carries a **per-user `SequenceNumber`**.

### The rules the client enforces

From `NotificationPoller.cs` and the `NotificationQueue` behind it:

- The client polls `POST /notifications/sinceSequence` with
  `SequenceNumber = latest + 1` and `ExcludeNotificationSequenceNumbers`
  (ones it already holds out of order).
- It applies notifications **strictly in order**. Only `latest + 1` is
  applied. Anything later waits in the queue. Sequence `0` is
  rejected. iceberg learned this the hard way. See `docs/HANDOFF.md` in
  `cpi-private-server` and `tools/mix-friends-test.ts`.
- If the server's `NotificationSequenceCounter` is ahead of what the
  client has received, the missing numbers are **gaps**. Each gap is
  timestamped. If a gap stays open longer than
  `MaximumMissingNotificationTime`, the poller **pauses** and raises a
  synchronization error. The session then resyncs from scratch with
  `/state`.

The point of this design is that the client never has to guess.
Either it has every event in order, or it knows it is out of sync and
reloads the full snapshot. This is the classic "event log + snapshot"
pattern. `/state` is the snapshot, and `/notifications` is the log.

### Poll intervals and adaptive backoff

`/state` returns `PollIntervals`, `PokeIntervals` (in seconds; the
client multiplies by 1000) and `NotificationIntervalsJitter`.

- `UsePollIntervals = !pushNotificationsEnabled` (`Session.cs`).
  - **Poll** intervals are used when there is no push. The client has
    to find out on its own.
  - **Poke** intervals are used when push is on. Push "pokes" it, so
    polling is just a safety net.
- Backoff (`GetNextIntervalIndex`):
  - if a poll returns nothing and nothing is missing, move one step
    along the interval list (capped at the last entry)
  - on any activity, jump back to index 0
- In practice, active chats poll fast, idle ones back off, and jitter
  spreads clients out so they don't all hit the server at once.

iceberg sends `PollIntervals: [2, 5, 10]`, `PokeIntervals: [2, 3, 5]`,
and `NotificationIntervalsJitter: 1000`. We have no push (the GCM/APNs
keys died with Disney's accounts), so clients always use the poll
intervals.

### ⚠️ Finding: `NotificationSequenceThreshold` is a time, not a count

`SessionResumer.cs` does
`notificationPoller.MaximumMissingNotificationTime = response.NotificationSequenceThreshold.Value`.
That value is then compared against `epochTime.Milliseconds - <when the
gap was first seen>`, so it is in **milliseconds**.

iceberg currently sends `NotificationSequenceThreshold: 100`. That
means any gap that isn't filled within **100 ms** triggers a full
resync. It is harmless while every notification is written atomically
with its sequence number. It becomes a problem once chat fan-out
creates many notifications at once.

**Fixed in iceberg (2026-11-07):** `/state` now sends `10000` (10 s). Notifications are written through `services/mixNotify.ts` inside one SQLite transaction (`inTransaction`), so a sequence number is never handed out without its row. Whether the CPI client's own copy of `SessionResumer` reads it the same way is still an open question (§11).

### ⚠️ Finding (fixed 2026-11-07): `sinceSequence` is inclusive

`NotificationPoller.Poll` sends `SequenceNumber = LatestSequenceNumber + 1`.
That means "give me everything from the next one I need onward", so the
value is **inclusive**.

iceberg used to answer with `sequence > SequenceNumber`. That skipped
exactly the notification the client was waiting for, every time. The
client saw a gap, waited out `NotificationSequenceThreshold` (100 ms),
paused, and resynced the whole snapshot through `/state`. So CPI
friends *appeared* to work, but every friend event cost a full resync
instead of one poll.

The fix treats the value as inclusive. `tools/mix-session-test.ts`
reproduces the old behavior with an SDK-faithful client, and
`tools/mix-friends-test.ts` had been written to the bug (polling with
`latest`) and now polls with `latest + 1` like the SDK.

### ⚠️ Finding (fixed 2026-11-07): logout deleted the user's friends

`POST /session/user/delete` is the SDK's **logout**. CPI calls it too.
iceberg answered it with `clearAllMixDataForUser()`, which deleted the
caller's rows in:

- `mix_friendships`
- `mix_friendship_invitations`
- `mix_alerts`
- `mix_pending_notifications`

So every logout erased that player's half of each friendship and left
the friend's half dangling (one-sided). It was found live when a Mix
client crash-logout emptied `tboskk`'s friends list.

Logout now only deletes the Mix session and the presence state. Data
damaged before the fix can be found with:

```sql
SELECT f.swid, f.friend_user_id FROM mix_friendships f
WHERE NOT EXISTS (SELECT 1 FROM mix_friendships r
                  WHERE r.swid = f.friend_user_id AND r.friend_user_id = f.swid);
```

### Community modifications in the recreation

The recreation's `NotificationPoller.HandleGetNotificationsResponse`
has a non-original block that treats a null
`NotificationSequenceCounter` as "no change". Keep that in mind when
comparing against CPI's untouched copy of the SDK. A server should
always send the counter anyway.

### Live boot with the real Mix app (2026-11-07)

This used the prebuilt `testing` release of OpenCPIsland/DisneyMix
(Windows IL2CPP, Unity 6000.3.10f1, built 2026-03-16) under Wine.

- **That build ignores `StreamingAssets/donotcopy/n7c4c656`.** It ships
  Disney's original config, but all its traffic goes to
  `http://10.0.0.77:80`, the recreation dev's LAN machine (also the
  `player-connection-ip` in `boot.config`). The current GitHub source has
  no such hard-code, so a fresh build from source should honor our
  config. For testing, a local redirect works:
  `ip addr add 10.0.0.77/32 dev lo`, plus an iptables `OUTPUT` DNAT from
  `10.0.0.77:80` to `127.0.0.1:3000`. Paths are the same as iceberg's
  root-mounted Mix routes.
- It also retries `https://localhost:443` constantly. **Correction
  (2026-11-07): these are the asset downloads** (sticker, gag, game and
  avatar bundles), not analytics. See "Content delivery in source
  builds" below. Login doesn't depend on them.
- Login order seen on the wire:
  1. `POST /jgc/v5/client/DI-SPARK-PROD/api-key`
  2. `guest/login?expand=profile,displayName,marketing`
  3. `PUT /session/user`
  4. `POST /state` (body has `GameStateSince`, `AvatarSince`, `ClientVersion: "2.3.0"`)
  5. `POST /officialAccount/all` (twice)
  6. `POST /notifications/sinceSequence`, backing off 2 s → 5 s → 10 s, matching `PollIntervals`
- **`/officialAccount/all` must answer** with `{OfficialAccountIds: [...]}`,
  where each entry needs `OaId`, `OaName`, `IsAvailable`, `CanUnfollow`
  (`OfficialAccountGetter.ValidateResponse`). A 404 makes the app show
  "Oops! Something went wrong". iceberg returns an empty list until
  phase 5.
- **Every user object needs an `Avatar`.** `FriendRecommender` and
  `DisplayNameSearcher` do `Avatar.AvatarId.Value` without a null check.
  A recommendation without one crashed the Friends screen and the app
  logged out. iceberg gives each user a default avatar with a stable
  `AvatarId` (48 bits of the SWID's SHA-256) until real avatars exist.
- The avatar editor calls `PUT /avatar` with the full avatar. Its
  `AvatarId` arrives as `-9223372036854776000`, which is `long.MinValue`
  after losing JSON double precision, meaning "new avatar". This is
  phase 5.
- Logging out calls `POST /session/user/delete` (see the logout finding
  above).

### Building the Mix app from source (native Linux, 2026-11-07)

Building OpenCPIsland/DisneyMix yourself avoids the prebuilt build's
hard-wired `10.0.0.77`, because a source build reads the bundled config.

1. Unity **6000.3.14f1** with **Linux Build Support (IL2CPP)** (Unity
   Hub). The Linux editor already includes Mono.
2. Render the config into the project and into cpipe:
   `bun tools/mix-config.ts render http://127.0.0.1:3000 --out
   <DisneyMix>/Assets/StreamingAssets/donotcopy/n7c4c656`, and the same
   for `web-api/data/mix/cpipe/donotcopy/n7c4c656` (section 2).
3. Build headless:
   `Unity -batchmode -quit -nographics -projectPath <DisneyMix>
   -buildTarget Linux64 -buildLinux64Player <out>/DisneyMix.x86_64
   -logFile build.log`. The first run imports the whole project. On
   this machine the whole thing took about 6 minutes, with IL2CPP
   (`GameAssembly.so`, 61 MB, 1.0 GB build in total).

What we learned doing it:
- **The project builds with IL2CPP on Linux unchanged.** On a Linux
  host the editor adds `com.unity.sdk.linux-x86_64` and
  `com.unity.toolchain.linux-x86_64-linux` to `Packages/manifest.json`.
  Those are Unity's own sysroot and clang, so no system C++ compiler
  is needed.
- **Case sensitivity:** upstream ships `Resources/json/AssetBundles.json`
  with a lowercase `assetbundles.json.meta`. That only pairs up on
  Windows and macOS. On Linux, Unity renames the meta to match. The GUID
  is unchanged, so nothing breaks. (The repo was evidently made on
  Windows.)
- **Flatpak Unity Hub + batchmode:** Hub's license file stays inside
  the sandbox, so the native editor exits with code 198 ("No valid Unity
  Editor license found"). Copy
  `~/.var/app/com.unity.UnityHub/config/unity3d/Unity/licenses/UnityEntitlementLicense.xml`
  to `~/.config/unity3d/Unity/licenses/`. A Personal license includes
  the `com.unity.editor.headless` entitlement that batchmode needs.

**Rebuilding the Linux asset bundles (2026-11-07).** The recreation ships
its rebuilt bundles only as `StreamingAssets/AssetBundles/windows64/`.
Windows bundles aren't rebuilt here (no Windows build support is
installed, and they're in the repo already). The Linux ones come from
the client's own editor script:

```sh
bun tools/mix-content.ts build --project ~/src/DisneyMix
bun tools/mix-content.ts import --from ~/src/DisneyMix/Assets/StreamingAssets/AssetBundles
```

- `build` runs `Unity -batchmode -quit -nographics -buildTarget Linux64
  -executeMethod RebuildAssetBundles.RebuildAllBatch` with the log in
  `<project>-bundles.log`. On this machine it took **166 s** and wrote
  **1,264 bundles** to `standalonelinux64/` (142 stickers, 28 gags, 611
  game files), exactly as many as `windows64/` has. Exit 198 means the
  license copy above is missing, and the tool says so.
- `RebuildAssetBundles.RebuildAll` (the "Tools/AssetBundles/Rebuild from
  JSON" menu item) builds every named bundle flat into `_raw/`, then
  moves each one to the path `Resources/json/AssetBundles.json` gives it,
  replacing the `platform` token with the target's folder name
  (`StandaloneLinux64` → `standalonelinux64`). Two changes to it were
  needed for batch use (client branch `iceberg/content-delivery`):
  - **It deleted all of `StreamingAssets/AssetBundles/` first,** including
    the prebuilt `windows64` bundles, so building Linux would have wiped
    Windows. It now clears only the target platform's folder.
  - **It can't fail a batch run.** It reports a failed build or a missing
    JSON with `Debug.LogError` and returns, so `-quit` still exits 0.
    The new `RebuildAllBatch()` wrapper exits 1 when it throws or leaves
    no `.unity3d` for the platform.
- A Linux player build also packs `standalonelinux64/` into its own
  StreamingAssets, so it can show local stickers with no server.

---

## 6. `/state`: the snapshot

`GetStateResponse` (`MixDomain/GetStateResponse.cs`):

- `Users`, `UserNicknames`, `Friendships`, `FriendshipInvitations`, `Alerts`
- `OfficialAccounts`: followed official account IDs
- `ChatThreads`, `ChatThreadNicknames`, `ChatThreadUnreadMessageCount`
- `ChatThreadLatestMessageSequenceNumbers` and
  `ChatThreadLastSeenMessageSequenceNumbers`: these are parallel lists.
  Together they tell the client which threads are unread without
  downloading messages.
- `GameStateChatMessages`: live game state for in-chat games, so a game
  in progress survives a resync
- `PollIntervals`, `PokeIntervals`, `NotificationIntervalsJitter`,
  `NotificationSequenceThreshold`
- `NotificationSequenceCounter`: where the log starts after this
  snapshot
- `Timestamp`: server time. The client stores the offset and uses it to
  stamp every later request (`BaseUserRequest.Timestamp`).

The CPI client only uses the friends and presence parts. The Mix app
uses all of it.

---

## 7. Chat model

### Threads

`ChatThread`:

- `ChatThreadId` (long)
- `ChatThreadType` (one-on-one or group)
- `IsTrusted`
- `Members` (`User` list)
- `OfficialAccountId`, set when the thread is an official account's
  channel

Thread `IsTrusted` mirrors friendship trust. Mix was built for kids
under COPPA, and parental "trust" between two friends unlocked free
text chat. Without it, chat was limited to safer forms (stickers,
gags, moderated text). `UpdateChatThreadTrustStatusNotification`
exists because removing trust on a friendship has to downgrade every
thread the two share. **(inferred: the exact client-side gating is not
yet traced)**

### Messages

All message types extend `BaseChatMessage`:

- `ChatMessageId` (server ID)
- `ClientChatMessageId`: the client's own ID, so a retried send can be
  deduplicated and the optimistic local bubble matched to the server's
  copy
- `ChatThreadId`, `SenderUserId`
- `SequenceNumber`: **per thread**, separate from the per-user
  notification sequence
- `Created`, `MessageType`

| Type | Extra fields |
|---|---|
| Text | text |
| Sticker | `ContentId` |
| Gag | `ContentId`, `TargetUserId`: a gag is an animated prank aimed at a specific member |
| Photo | `UgcMediaId`, `PhotoId`, `Caption`, `PhotoFlavors` (resized variants). Sending only takes `UgcMediaId`, so the upload happens elsewhere first. |
| Video | resolved to a playable URL through `POST /video/url` |
| GameState | `GameName`, `State`. Created by PUT with a `Payload`, updated by POST, and announced with `UpdateChatThreadGameStateMessageNotification`. This is how turn-based games lived inside a chat. |
| GameEvent | events within a game |
| MemberListChanged | the system message shown when people join or leave |

### Why two kinds of sequence numbers

- The **per-thread message sequence** lets a client page history
  (`/messages/bySequenceRange`), spot missing messages in a thread, and
  compute unread counts as `latest − lastSeen` from two integers.
- The **per-user notification sequence** is the delivery log. A
  message sent to a 5-person group becomes 5 notifications, one in
  each member's stream at that member's own next sequence. Each of
  them carries the same message with the same thread sequence.

### Exact strings (confirmed in the SDK)

- `ChatThreadType`: `ONE_ON_ONE`, `GROUP`, `OFFICIAL_ACCOUNT`
  (`ChatThreadTypeConverter`, `StateGetter`). Official account
  channels are a third thread type, not a flag on a group.
- `MessageType`: `TEXT`, `STICKER`, `GAG`, `PHOTO`, `VIDEO`,
  `GAME_STATE`, `GAME_EVENT`, `MEMBER_LIST_CHANGED`
  (`ChatMessageParser`).
- Read errors: `NOT_FOUND`, `INSUFFICIENT_READ_PERMISSION`
  (`AbstractChatThread`).
- Member-add errors: `USER_ALREADY_THREAD_MEMBER`,
  `USER_NOT_THREAD_MEMBER` (`ChatThreadMemberAdder`).

### Creating threads in iceberg (`services/mixChat.ts`)

`PUT /chatThread` takes `{ChatThreadType, MemberUserIds}` and replies
`{Status: "OK", Notification: AddChatThread}`.

- **The reply is a real notification.** `ChatThreadCreator` validates it
  and runs it through the caller's notification queue, so it carries the
  caller's next sequence number. Every other member gets the same
  `AddChatThread {ChatThread, WelcomingUserId: <creator>}` through
  polling, at their own next sequence.
- Members are deduplicated, and the creator is always one of them.
  `ONE_ON_ONE` needs exactly one other member. Only `ONE_ON_ONE` and
  `GROUP` can be created: `OFFICIAL_ACCOUNT` channels belong to the
  server.
- Every other member must be the creator's friend, or
  `400 FORBIDDEN_NOT_FRIENDS`. A thread holds at most **20 people**,
  counting the creator, or `400 MAX_MEMBER_COUNT_EXCEEDED`.
  `ChatThreadCreator` itself sends every error to one failure callback,
  but `ChatThreadMemberAdder` names these exact strings (below), so
  iceberg uses them for creation too. The 20 comes from the UI's
  `FriendSelectorPanel.MAX_GROUP_CHAT` (`RemoteMembers + 1`).
- Creating a 1:1 that already exists returns the existing thread, in a
  fresh `AddChatThread` for the creator only. The other member already
  has it.
- `IsTrusted` mirrors friendship trust. A 1:1 takes the friendship's
  trust. A group is trusted only if every pair of members are trusted
  friends.
- `ChatThread.Members` are full user objects with avatars, like
  everywhere else (section 5).

### Sending messages in iceberg (`addMessage`)

`PUT /chatThread/textMessage`, `/stickerMessage` and `/gagMessage` take
`{ChatThreadId, ClientChatMessageId}` plus `Text`, `ContentId`, or
`ContentId` and `TargetUserId`. They reply
`{Status: "OK", Notification: AddChatThread<Type>Message}`.

- **Retries are free.** `(sender, ClientChatMessageId)` is unique. A
  repeat returns the sender's original stored notification byte for byte,
  with the same `ChatMessageId`, thread `SequenceNumber` and notification
  `SequenceNumber`, and writes nothing. This is what `ClientChatMessageId`
  is for: the app can resend after a timeout without duplicating the
  bubble. If the stored notification has already been cleaned up (after
  an hour), the reply is rebuilt from the message row. Its notification
  sequence is one the client has already applied, so the client ignores
  it.
- The sender must be a current member, or `400 NOT_FOUND` (the
  `AbstractChatThread` read-error string, reused).
- **In a 1:1, the two must still be friends**, or
  `400 FORBIDDEN_NOT_FRIENDS`. Unfriending keeps the old thread (and its
  history), but neither side can send into it any more. Otherwise
  unfriending someone who's bothering you wouldn't stop their messages.
  Groups only check friendship when a member is added.
- **Text:** 1–1000 UTF-16 units, otherwise `400 INVALID_REQUEST`. Text runs
  through the shared filter (section 9). Masked words are stored masked,
  with `IsModerated: true`; the validator requires `IsModerated` on every
  text message. A block rule gives `400 MODERATION_BLOCKED`. **This is an
  iceberg-defined status:** the SDK's send path has no moderation-specific
  failure, so the app just shows the send as failed.
- **Sticker:** needs a non-empty `ContentId`. **Gag:** also needs a
  `TargetUserId` who is a current member (a gag is a prank aimed at
  someone in the chat).
- The message gets the thread's next `SequenceNumber` (from 1). Every
  current member, sender included, gets the notification at their own
  next notification sequence. Messages sent at the same moment by two
  members stay gap-free in every stream, because the insert and the
  fan-out share one SQLite transaction.
- `Created` is the message's stored timestamp (ISO-8601 with
  milliseconds), so history reads return the same value as the live
  notification.

### Adding and removing members

`PUT /chatThreadMembership {ChatThreadId, AddedUserIds}` and
`POST /chatThreadMembership/delete {ChatThreadId, RemovedUserId}` both
reply with `{Status, MembershipNotification, ChatMessageNotification}`.
The SDK validates and dispatches both through the caller's queue, so
they are the caller's next two notifications, in that order.

- **Statuses** (`ChatThreadMemberAdder` maps each one to its own result
  type): `NOT_FOUND`, `USER_NOT_THREAD_MEMBER` (the actor isn't in the
  thread), `USER_ALREADY_THREAD_MEMBER`, `FORBIDDEN_NOT_FRIENDS` (each
  added user must be the actor's friend) and `MAX_MEMBER_COUNT_EXCEEDED`.
  `ChatThreadMemberRemover` has no specific statuses.
- Only `GROUP` threads change membership. Only `GroupChatThread`
  exposes removal in the SDK, so iceberg answers `INVALID_REQUEST` for a
  1:1.
- **Adding:**
  - New members get `AddChatThread` first.
  - Then every member, new ones included, gets
    `AddChatThreadMembership {ChatThreadId, Members, WelcomingUserId}`.
    `Members` lists only the **added** users: `HandleChatMembersAdded`
    inserts each one into the thread.
  - Then everyone gets a `MEMBER_LIST_CHANGED` message
    (`{MemberUserIds, IsAdded: true}`, sent by the actor).
  - New members start at the thread's current seq, so they see the
    system message but not older history.
- **Trust drops when needed.** If an added user isn't a trusted friend of
  every member, a trusted group becomes untrusted, and the existing
  members get `UpdateChatThreadTrustStatus {ChatThreadId, IsTrusted:
  false}`. It's sent last, so the actor's two reply notifications stay
  consecutive. (The plan left this out, but trust is what unlocks free
  text, so a group must never keep trust it no longer has.)
- **Removing:** anyone may leave. Removing someone else takes the
  thread's creator (`USER_NOT_THREAD_MEMBER` otherwise, an iceberg
  choice). The removed user and the remaining members get
  `RemoveChatThreadMembership {ChatThreadId, MemberUserId}` and the
  `MEMBER_LIST_CHANGED` message (`IsAdded: false`). Then the membership
  ends, and the user's `/state` and sends stop seeing the thread.
- System messages have no client message id, so they show
  `ClientChatMessageId: 0`.

### 64-bit ids: `ClientChatMessageId` (found live, 2026-11-07)

The SDK's ids are C# `long`s, and **the app's `ClientChatMessageId` is a
random 64-bit value**, e.g. `2211020771495972600` or
`-8014680941660341000`. That's far past JavaScript's
`Number.MAX_SAFE_INTEGER` (2^53 − 1). The app matches the server's reply,
and later the polled copy and history, to its pending bubble by that
exact id. So a server written in JavaScript has to carry it losslessly
end to end:

- **Parse:** iceberg decrypts Mix bodies with `lib/bigJson.ts`
  `parseJson`. Integer literals a JS number can't hold exactly become
  `BigInt`, using the JSON.parse reviver's source text.
- **Store:** SQLite `INTEGER` holds the full 64 bits. Message reads also
  select `CAST(client_message_id AS TEXT)`, because the driver would
  otherwise hand back a rounded number.
- **Serialize:** replies and stored notifications go through
  `stringifyJson`, which writes BigInts as bare digits (`JSON.rawJSON`).
- A plain `JSON.parse` turned the first live sends into
  `400 INVALID_REQUEST` (the id wasn't a safe integer). Had it got past
  that check, the rounded id would have left every bubble stuck on
  "retry".
- Ids outside the signed 64-bit range give `INVALID_REQUEST`.
  `MEMBER_LIST_CHANGED` system messages report `ClientChatMessageId: 0`.

### Reading history

Every read replies with all eight message lists (`Text`, `Sticker`,
`Gag`, `Video`, `Photo`, `GameState`, `GameEvent`, `MemberListChanged`),
empty when there's nothing of that type. `ChatMessageRetriever` rejects a
reply with any list missing.

**Who sees what:** a reader sees `seq > max(joined_seq,
history_cleared_seq)`. After leaving a group they still see what was sent
up to their departure, including the system message announcing it, and
nothing after. Someone who was never a member gets `400 NOT_FOUND`.

| Route | Request | Behavior |
|---|---|---|
| `POST /chatThread/messages/recent` | `LowerBoundSequenceNumbers` (flat `[threadId, lowerSeq, ...]` pairs, inclusive), `MaxMessagesPerChatThread` | The newest N (default 20) at or above each bound. **This is what the app calls when a chat opens**: lower bound 1 with nothing cached, otherwise its last message's seq − 1. Threads the caller can't read are skipped. |
| `POST /chatThread/messages/bySequenceRange` | `ChatThreadId`, `Ranges` (flat inclusive `[start, end, ...]`) | Fills gaps in the local cache (`GetSequenceRanges`). An odd-length list gives `INVALID_REQUEST`. |
| `POST /chatThread/messages/sequenceNumber` | `ChatThreadId`, `StartMessageTimestamp` (the client's current time) | **Not a single number.** `SequenceNumbers` is flat `[ChatMessageId, seq, ...]` pairs. The client uses them to backfill seqs on messages it cached with seq 0 (`UpdateChatMessageSequenceNumbers`), and rejects an odd length or any seq ≤ 0. |
| `POST /chatThread/specificMessages` | `ChatThreadId`, `MessageIds` | By id. Ids the caller can't see are left out without an error. |
| `POST /chatThread/recentMessages` | `MessagesSince` (ms) | Everything visible to the caller created after that time, newest 500. Never called by this SDK version. |
| `POST /chatThread` | `ChatThreadId`, `Cursor`, `MaximumMessageCount`, `ExcludedChatMessageIds` | Pages newest first, at most 50. `Cursor` is the lowest seq returned, as a string, and `null` when nothing older is left. Never called by this SDK version; `TimestampOffset` is ignored. |

### Unread counts, history clears, thread nicknames and trust

These four notifications go to the caller only. The caller must be a
current member, or `400 NOT_FOUND`.

- `POST /chatThreadMembership/unreadMessageCount/delete {ChatThreadId}`
  marks everything seen (`last_seen_seq = latest`). The reply is
  `ClearUnreadMessageCount {ChatThreadIds: [id]}`; the notification
  carries a list even though the request names one thread.
- `POST /chatThreadMembership/history/delete {ChatThreadIds}` (a **list**
  in the SDK) hides everything sent so far from the caller only
  (`history_cleared_seq = latest`, and unread drops to 0). The reply is
  `ClearMemberChatHistory {ChatThreadIds}`. Other members keep their
  history, and the caller sees new messages as usual.
- `PUT /chatThread/nickname {ChatThreadId, Nickname}`: the caller's own
  name for a thread, which nobody else sees. It must be 1–32 UTF-16 units
  and runs through the shared filter: blocked gives `MODERATION_BLOCKED`,
  masked words are stored masked. The reply is
  `AddChatThreadNickname {ChatThreadNickname: {ChatThreadId, Nickname}}`.
  `POST /chatThread/nickname/delete` replies
  `RemoveChatThreadNickname {ChatThreadId}`.
- **Trust follows friendship.** When `/friendship/trust/delete` or
  `/friendship/delete` runs, every trusted thread both users are in
  becomes untrusted, and its members get
  `UpdateChatThreadTrustStatus {ChatThreadId, IsTrusted: false}`. Those
  are sent after the caller's own reply notification, so the reply stays
  the caller's next sequence. Unfriending is included (the plan only
  named trust removal) because ex-friends keep their old threads, and
  those must not keep the trust that unlocks free text.

### Chat in `/state`

- `ChatThreads`: every thread the user is a current member of.
- **`ChatThreadLatestMessageSequenceNumbers` and
  `ChatThreadLastSeenMessageSequenceNumbers` are flat pairs**:
  `[threadId, seq, threadId, seq, ...]`.
  `SequenceNumberUtils.CreateSequenceNumberDictionary` reads index `i`
  as a thread ID and `i+1` as its sequence. They are not lists parallel
  to `ChatThreads` (`List<long?>` was the only way to send a map in this
  JSON shape).
- `ChatThreadUnreadMessageCount`: `{ChatThreadId, UnreadMessageCount}`,
  only for threads with something unread:
  `latest - max(last_seen, history_cleared)`.
- `ChatThreadNicknames`: `{ChatThreadId, Nickname}`, the user's own names
  for threads.

### Polling returns every list

`POST /notifications/sinceSequence` replies with every list field of
`GetNotificationsResponse` (29 of them), empty when nothing is pending.
A stored notification goes in the list named by its type. Until
2026-11-07 the route had a fixed switch over the friendship and alert
types. Any other type, such as `AddChatThread`, was stored and given a
sequence number but never sent, so the client saw a gap
(`NotificationSequenceCounter` ahead of what it received) and fell back
to a full resync.

### Status strings and type strings (confirmed, 2026-11-07)

From the SDK, unless marked as iceberg's own choice:

| Status | Where | Source |
|---|---|---|
| `NOT_FOUND` | thread doesn't exist, or the caller isn't (or was never) a member | `AbstractChatThread`, `ChatThreadMemberAdder` |
| `INSUFFICIENT_READ_PERMISSION` | defined by the SDK; iceberg answers `NOT_FOUND` instead | `AbstractChatThread` |
| `USER_ALREADY_THREAD_MEMBER`, `USER_NOT_THREAD_MEMBER` | member add/remove | `ChatThreadMemberAdder` |
| `FORBIDDEN_NOT_FRIENDS` | adding a non-friend (iceberg also uses it for thread creation and trust removal) | `ChatThreadMemberAdder` |
| `MAX_MEMBER_COUNT_EXCEEDED` | more than 20 people (`FriendSelectorPanel.MAX_GROUP_CHAT`) | `ChatThreadMemberAdder` |
| `INVALID_REQUEST` | malformed or out-of-range input | iceberg's choice |
| `MODERATION_BLOCKED` | text or nickname hit a block rule | iceberg's choice |

Types: `ChatThreadType` is `ONE_ON_ONE`, `GROUP` or `OFFICIAL_ACCOUNT`.
`MessageType` is `TEXT`, `STICKER`, `GAG`, `PHOTO`, `VIDEO`, `GAME_STATE`,
`GAME_EVENT` or `MEMBER_LIST_CHANGED`. iceberg sends `TEXT`, `STICKER`,
`GAG` and `MEMBER_LIST_CHANGED`. Photo, video and game messages, and the
per-friend `/nickname` endpoints, are later phases.

**Trust and typing, live:** `tboskk` and `tboskk1` are untrusted friends,
and the app let them type and send free text in their 1:1. So untrusted
threads aren't limited to stickers in this client; the server-side
filter is what moderates them.

### Chat notification types

From `GetNotificationsResponse`:

- `AddChatThread`, `AddChatThreadMembership`, `RemoveChatThreadMembership`
- `AddChatThread{Text,Sticker,Gag,Photo,Video,GameState,GameEvent,MemberListChanged}Message`
- `UpdateChatThreadGameStateMessage`
- `AddChatThreadNickname`, `RemoveChatThreadNickname`
- `ClearMemberChatHistory`, `ClearUnreadMessageCount`
- `UpdateChatThreadTrustStatus`

Also user-level: `AddNickname`/`RemoveNickname` (per-user nicknames for
friends), `SetAvatar`, and `AddFollowship`/`RemoveFollowship` (official
accounts).

---

## 8. Identity: one account, two apps

Mix and CPI share Disney accounts through the Guest Controller. A user
is a **SWID**. In iceberg, a Mix user is the same `player_identity` SWID
as the CPI player, so friends, presence, and display name are shared
across both apps. This matches how Disney ran it: your CPI friends
*were* your Mix friends.

The apps identify themselves with different Guest Controller client
IDs:

- Mix uses `DI-SPARK-PROD`.
- The CPI Windows client uses `DI-CLUBPENGUINISLANDWIN.GC.SERVER-PROD`
  (seen live in `/jgc/v5/client/<id>/guest/login`).

They also send different cellophane client tokens.

### Friend invitations and display names in iceberg (fixed 2026-11-07)

A security review after the phase 0-3 merge found three ways to abuse
names and invitations. All are fixed and covered by
`tools/mix-security-test.ts`.

- **Only the invitee can accept.** An invitation is stored as two rows
  with the same `invitation_id`, one per side, with `is_inviter` set on
  the inviter's row. `PUT /friendship` looked up the id among the
  *caller's* rows, so the inviter found their own row and could accept
  their own invitation, forcing a friendship. Now a match on an
  `is_inviter` row is answered with `INVITATION_DOES_NOT_EXIST`, as if
  it weren't there.
- **Trust comes from the invitation.** The accept call's `IsTrusted`
  used to be copied onto both friendship rows, so the accepting player
  could upgrade an untrusted invitation to trusted on their own. In Mix,
  trust is what unlocks free text chat (§7), so it has to be what the
  inviter offered. iceberg now ignores the accept call's `IsTrusted` and
  uses the stored one.
- **Invitations remember SWIDs, not just names.** Accepting found the
  inviter with `getPlayerByDisplayName(friend_display_name)`. If the
  inviter renamed, the name could point at someone else, and the
  friendship went to them. Invitation rows now carry `friend_swid`
  (added by a column migration). Rows from before it still fall back to
  the name.
- **`PUT /displayname` enforces rules.** It used to store anything.
  Now the name is trimmed and must be 3-20 characters (CPI
  registration's limit, `guestcontroller.ts`). It must not be used by
  another player as a display name or username, case-insensitively,
  because `getPlayerByDisplayName` matches both. Failing any of these
  gives `DISPLAYNAME_ASSIGNMENT_FAILED`. A name the shared filter
  (§9, "Text moderation") blocks or masks gives
  `DISPLAYNAME_MODERATION_FAILED`. Both are the statuses the client's
  `DisplayNameUpdater` switches on, so the app shows its own error for
  each.

---

## 9. Moderation: alerts, bans and the escalation ladder

### Terminology trap: "gag" is not a mute

In Mix, a **gag** is a *prank*. `GagChatMessage` (`ContentId`,
`TargetUserId`) plays an animated joke aimed at a friend in the chat,
and the `hd/gags/` bundles are those animations. There is nothing in
the SDK that mutes a user. When iceberg needs a word for a temporary
chat or account suspension, it says **ban**, never gag.

### Bans

- A banned user's calls fail with `Status: "UNAUTHORIZED_BANNED"`
  (`MixWebCallFactory`, the error switch).
  - The client does not retry.
  - It raises `OnAuthenticationLost` with `AccountBannedEventArgs`,
    which logs the user out.
- Compare the other auth failures:
  - `UNAUTHORIZED_ONEID_TOKEN` refreshes the Guest Controller token
  - `UNAUTHORIZED_MIX_SESSION` re-runs the session key exchange
  - anything else refreshes both
- A ban is all-or-nothing at the API level. There is no
  "can log in but can't chat" status.
- At **Guest Controller login** (`GuestControllerErrorParser`):
  - `PROFILE_USER_BANNED` gives `LoginFailedTemporaryBanResult`, and
    on token refresh `RefreshTemporaryBanError`
  - `PROFILE_DISABLED` gives `LoginFailedProfileDisabledResult`
  - `AUTHORIZATION_ACCOUNT_LOCKED_OUT` gives
    `LoginFailedAccountLockedOutResult` (a password lockout, not a
    moderation one)
  - iceberg uses `PROFILE_USER_BANNED` for temporary bans and
    `PROFILE_DISABLED` for permanent bans and locks, on both
    `guest/login` (after the password check, so a wrong password still
    says `INVALID_CREDENTIALS` and doesn't reveal the ban) and
    `guest/refresh-auth`. Body:
    `{error: {keyCategory: "LOGIN", errors: [{code, inputName: null, developerMessage}]}}`.
  - **The HTTP status must be 400.** `GuestControllerClient` only
    parses an error body when the status is 400 or 2xx. On 401–499 it
    reports a bare failure ("authentication unavailable") without
    reading the code. So a ban sent as 401 on refresh would never show
    as a ban. The existing refresh-token errors are 401s, which is fine
    for them: they really are "log in again".
- `DISPLAYNAME_MODERATION_FAILED` comes from `DisplayNameUpdater`.

### Alerts are moderation warnings sent to the offender

`Alert` = `{AlertId, Level, Text, Timestamp}`. The field names hide
what's in them:

- **`Text` holds a category** from `AlertType` / `AlertTypeUtils`.
  The values are:
  - `CYBERCRIMINAL`, `CYBERBULLY`, `DATING_TEENS`, `OFFENSIVE_USER`
  - `OVERSHARING_CHILD`, `POTENTIAL_PAEDOPHILE`, `SEX_PEST`
  - `SPAMMER`, `TERRORIST`, `TROLL`, `VULNERABLE_PERSON`
- **`Level` holds a severity from 1 to 5**, stored as a string.
- The app shows the localized string `customtokens.alerts.<type>_<level>`
  (`Mix/Ui/AlertTokenMappings.cs`, `AlertLocalNotification`).

Alerts arrive as `AddAlert` notifications and in `/state.Alerts`. They
are dismissed with `PUT /alert/clear`. Disney's test hook
`integrationTestSupport/user/alert` sent `{Level, Text: <type>}`, which
is exactly how a moderator would trigger one.

The category names are Disney's internal classification of the
**offender**, not of a message. Some of them (`VULNERABLE_PERSON`,
`OVERSHARING_CHILD`) protect the user rather than punish them.
`VULNERABLE_PERSON` *locks* the account instead of banning it.

### The ladder (from `localization/en_US.2_3.json`)

Levels with no string have no mapping: those categories start at
level 3.

| Category | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| CYBERCRIMINAL (cheating, third-party tools) | warning | **72 h ban** | ban, contact support | same | same |
| CYBERBULLY | warning | warning | **12 h** | **24 h** | **permanent** |
| DATING_TEENS | warning | "may be banned" | **12 h** | **24 h** | ban |
| OFFENSIVE_USER (language) | warning | **12 h** | **24 h** | **72 h** | ban |
| OVERSHARING_CHILD (personal info) | safety warning | same | same | same | ban |
| POTENTIAL_PAEDOPHILE | – | – | ban, contact support | same | same |
| SEX_PEST | warning | **12 h** | **24 h** | ban | ban |
| SPAMMER | warning | **24 h** | **72 h** | **permanent** | permanent |
| TERRORIST | – | – | ban, contact support | same | same |
| TROLL | warning | **12 h** | **24 h** | **72 h** | **permanent** |
| VULNERABLE_PERSON | – | – | **locked**, contact support | same | same |

Example strings:

- `troll_1`: "Please respect everyone, no bullying or being mean to
  others."
- `offensive_user_4`: "You used a rude or inappropriate word. This
  account has been banned for 72 hours."
- `cybercriminal_2`: "You were caught cheating. This account has been
  banned for 72 hours."
- Support contact: `support@disneymix.com`

Two consequences:

- The client only *displays* the alert text. The ban itself must be
  enforced server-side through `UNAUTHORIZED_BANNED`. The durations
  live only in the strings, so the server has to apply the matching
  duration itself.
- Because the server picks `(type, level)` and the client supplies the
  wording, a recreation gets Disney's original, localized moderation
  messages for free, in all five languages that have strings.

### Sanctions in iceberg (`services/moderation.ts`)

- `LADDER` transcribes the table above:
  - "warning" (and "may be banned") is no ban
  - "N h" is a ban of N hours
  - "permanent", "ban" and "contact support" are a ban until lifted
  - "locked" is a lock until lifted
  - `POTENTIAL_PAEDOPHILE`, `TERRORIST` and `VULNERABLE_PERSON` start
    at level 3, because levels 1–2 have no strings.
- `sanction(swid, type, level, moderator)` clamps the level to the
  category's range. Then, in one transaction, it stores the alert,
  queues an `AddAlert` notification
  (`Alert: {AlertId, Level: "<n>", Text: "<TYPE>", Timestamp}`; the
  validator wants all four), adds the ban or lock row if the rung has
  one, and records the sanction.
- `suggestLevel` is the last level for that category plus one, so
  repeat offenders climb the ladder by default.
- Enforcement is server-side only: Mix calls get 401
  `UNAUTHORIZED_BANNED`, and Guest Controller login/refresh get the
  400 codes above. CPI web-api calls (`middleware/auth.ts`) get
  401 `{code: 3}`, which is CPI's "refresh your token". The refresh is
  then refused with the ban, which the game shows. Before 2026-11-07
  CPI only checked bans at login and refresh, so an access token issued
  before the ban kept working for up to its 1-hour lifetime. Tokens
  aren't deleted on a ban: Mix needs a valid token to receive
  `UNAUTHORIZED_BANNED`, the status that makes it log the user out with
  a ban message. A player already inside a SmartFox room stays there
  until they disconnect, but can't join again, because joining goes
  through web-api. A ban is active while `lifted_at IS NULL` and
  `until` (ISO-8601 UTC, so it compares as text) is null or in the
  future.
- Operator CLI: `bun tools/mod.ts sanction <swid|name> <TYPE> [level]`
  (prints the alert and the resulting ban) and
  `bun tools/mod.ts unban <swid|name>`. The CLI writes through the
  same service code via `ICEBERG_DB_PATH`, so the alert's notification
  gets the user's next sequence number even while the server runs.

### Live check with CPI (2026-11-07)

On `tboskk1`, logged into the CPI client, using `bun tools/mod.ts`:

- **`sanction tboskk1 TROLL 1`** (a warning): within one poll, CPI showed
  an orange **"Warning!"** popup with Disney's `troll_1` text: "Please
  respect everyone, no bullying or being mean to others." So CPI
  consumes Mix `AddAlert` notifications and maps `(Text, Level)` to the
  same `customtokens.alerts.*` strings as the Mix app.
- **Pressing OK** sends `PUT /alert/clear` with the alert's id. In
  iceberg this route still used an in-memory `alerts` map that no longer
  existed, so every dismissal was a 500, and the alert came back
  through `/state`. It now deletes only the caller's own alerts. It
  replies with a `ClearAlert` notification stored like any other, so it
  carries the next sequence number. `LocalUser.ClearAlerts` validates
  that notification and runs it through the sequence queue, so a
  made-up number would be rejected.
- **`sanction tboskk1 TROLL`** (suggested level 2, a 12 h ban): CPI's next
  `POST /notifications/sinceSequence` got 401 `UNAUTHORIZED_BANNED`, and
  CPI logged out at once. Its account picker then showed the saved
  penguin with a red **"Banned"** stamp and a padlock. So the
  `AccountBannedEventArgs` path is wired in CPI too.
- The Mix app wasn't checked live for bans; it uses the same SDK paths.

### Text moderation

`PUT /moderation/text` takes `{Text, ChatThreadId, ModerationPolicy}`
and returns `{Text, Moderated}`. The client asks *before* sending, and
gets back possibly-masked text plus a flag.

**In iceberg** (`services/moderation.ts`), Mix's `/moderation/text` and
CPI's `POST /chat/v1/message/verify` share one filter. That way, a word
masked in CPI chat is also masked in Mix. Disney ran both through one
moderation service too (inferred: both apps send text to the server
before showing it, and CPI's verify reply has the same "masked text plus
`moderated` flag" shape).
- Rules live in `mix_moderation_rules` as `(pattern, kind, action)`.
  - A `word` rule is a whole word, case-insensitive. Its edges are
    Unicode letters and digits (`\p{L}\p{N}`), so `darn` doesn't hit
    `darned`, and accented or emoji text passes untouched.
  - A `regex` rule is used as given, with flags `giu`.
  - `mask` replaces each match with one `*` per code point, so the
    length on screen matches.
  - `block` masks the whole message.
  - `Moderated` (CPI: `moderated`) is true for either action.
- A new database is seeded once with three masked words (the most common
  English swear words). Operators manage the list with
  `bun tools/mod.ts rules list | add <pattern> [--regex] [--block] |
  remove <id>`, and `--db <file>` picks another database.
- **Live edits without a restart:** the server caches compiled rules and
  rechecks `PRAGMA data_version` on every call. SQLite changes that
  value whenever *another* connection commits, such as the CLI, so a
  rule the CLI adds applies on the next message. The server's own
  writes don't change it, so `addRule`/`removeRule` drop the cache
  directly.

Reports: `PUT /moderation/reportPlayer` takes `{ReportedUserId,
Reason}`.

**Reports in iceberg.** Both apps write to one table, `mix_reports`.
- **Mix** sends the reported user's swid (`ReportedUserId`).
- **CPI** sends `POST /moderation/v1/report/name/<displayName>`, with the
  reason as the whole body: a bare JSON string such as `"ChatSwearing"`.
  The server resolves the name to a swid. An unknown name still gets a
  200 and is stored as `name:<displayName>`, so the endpoint can't be
  used to check whether an account exists.
  - Express's JSON parser runs in strict mode, which only accepts
    objects and arrays. It used to reject that body with a 400 before
    the route ran, so unencrypted CPI reports never arrived. A non-strict
    parser now covers just that path. Encrypted CPI requests were never
    affected, because `encryption.ts` uses a plain `JSON.parse`.
- Operators triage with `bun tools/mod.ts reports [--open]` and
  `bun tools/mod.ts report <id> dismiss|actioned`. Acting on a report
  (alerts, bans) is the sanction ladder below.

---

## 10. Content preservation status (checked 2026-11-07)

### Where the content lived

- `cpipe_url` (`dicpipe.disney.io/serve/mix/prod`) only served
  **manifests**.
- The files themselves came from `cdnRoot`. Archived manifest `00053`
  (2016-06-18) has
  `cdnRoot: http://7e65011e-d1aa-935a-265a-3f36f7c14c51.disney.io`.
  The client's own test helper
  (`Mix/Test/AssetManagerLoadTextIntegrationTestHelper.cs`) uses the
  same host.
- That host was a **Google Cloud Storage bucket** named after the
  domain. It was publicly listable: the archived root returns a GCS
  `ListBucketResult` with `Generation`/`MetaGeneration` fields.
- Files sat under a version-timestamp prefix:
  `/<v>/AssetBundles/<platform>/...`. Manifests sat under
  `/manifests/__manifest_mix_prod.<version>.json`.
- **Today the bucket is deleted.** `storage.googleapis.com` answers
  `NoSuchBucket`, and `dicpipe.disney.io` doesn't resolve.

### What the Wayback Machine has

- The **first page of the bucket listing** only: 1,000 keys, truncated
  at `.../would_you_rather/.../316_hd.unity3d`. It was captured
  2017-06-01 and 2018-03-08. The crawler never followed `?marker=` to
  the next pages.
- About 1,000 files from that first page, all from the **2016-01-08
  build prefix `1452223917`**, **Android HD only**:
  - avatar thumbs (266)
  - Would You Rather (247)
  - Meme Generator (103)
  - avatar parts (~240)
  - a handful of other game bundles
- Manifest `00053` (4,506 paths), captured four times in 2016.

### What the recreation has vs. the final manifest

The recreation's bundled manifest is version `00134` (2017-02-15).
Counting logical files once (Android and iPhone duplicates merged,
compared against the recreation's rebuilt `windows64` bundles):
**1,302 present and 1,428 missing.**

| Area | Present | Missing | Notes |
|---|---|---|---|
| `hd/gogs` (in-chat games) | 611 | 455 | |
| `hd/stickers` | 142 | 412 | |
| `sd/avatar` + `sd/avatar_multiplane` | 0 | 422 | Low-res duplicates of HD. Likely not needed. |
| `hd/avatar_thumbs` | 293 | 19 | |
| `hd/avatar_multiplane` | 172 | 34 | |
| `hd/gags` | 28 | 24 | |
| `hd/official_accounts` | 0 | 30 | |
| `hd/stickerpack_thumbs` | 16 | 10 | |
| game data (`Drop`, `Friendzy`, `CardsOfDoom`, `Writers_Block`, `Fireworks`) | 1 | ~9 | |

Of the 1,428 missing, **Wayback covers only 54** (18 gags, 36 game
bundles), and those are from the January 2016 build, not the final
one.

Wayback bundles are Unity 5-era Android builds. The recreation runs
on Unity 6, which can't load them directly. Anything recovered has to
be extracted (e.g. AssetRipper) and rebuilt, which is presumably how
the recreation's `windows64` bundles were made.

### Content delivery in source builds (fixed 2026-11-07)

Chat text worked end to end in a native Linux build of
OpenCPIsland/DisneyMix, but the sticker, gag, game and "recents" panels
showed nothing, or a warning icon per item. There were three causes, all
on the content side rather than the chat API. They are fixed on the
client branch `iceberg/content-delivery` and in iceberg.
Games (`hd/gogs`) are imported and served by the same pipeline, but
nothing here makes in-chat games playable (live check: they load but are
buggy; that's the next spec).

**What was wrong, and what changed in the client**

1. **The catalog path used a Windows separator.** `Mix/Data/ContentData.cs`
   (recreation code, not Disney's) did
   `zipFileBasePath = Application.StreamingAssetsPath + "\\"`, so on Linux
   or macOS it read `…/StreamingAssets\contentdata.joe`, a file that
   doesn't exist. The catalog (sticker packs, gags, games) never loaded,
   and `StickerPackSelector.PackIconLoader` threw an index-out-of-range
   error. Fixed with `Path.Combine(Application.streamingAssetsPath, …)`
   (`f10caf9c`).
2. **Asset URLs ended up at `https://localhost:443`.**
   - On desktop, `SettingsManager.GetDeviceString()` returns `"iphone"`
     (anything but Android), so asset paths were `AssetBundles/iphone/hd/…`,
     and `AssetManager.BundleFolder` named `standalonelinux`, a folder
     nothing writes. Now one constant in `AssetManager` names the platform
     folder (`windows64`, `standalonelinux64`, …) and the new
     `SettingsManager.GetBundlePlatform()` returns it. `GetCpipePrefix` and
     `BackgroundLoader` use it. `GetDeviceString()` is unchanged (other
     code may rely on it) (`f10caf9c`). `GetCpipePrefix` also normalises
     `\` to `/`: on Windows `Path.Combine` produced
     `AssetBundles/windows64/hd\…`, which no manifest lists.
   - The source build never fetched a manifest from the network. The
     recreation stubbed `Mix/CpipeFileManifestLoader.Load(...)` to
     `PrepareManifest(null, true)` ("CPIPE backend retired: always use
     bundled preload manifest"), and Disney's fetcher
     `CpipeManifestApi.GetCpipeManifest` had no callers, so iceberg's
     `cpipe_url` and `/cpipe` were never used. The bundled manifest has
     `cdnRoot: ""`, so `TranslateFileUrl` produced a bare `/<v>/<path>`
     that Unity resolves against `https://localhost`.
     `PreloadData.PreloadCpipeManifest` fills `CpipeData` from
     `<persistentDataPath>/cache/<sha("cpipeManfiest")>.txt` if it
     exists, else from the bundled manifest (the key really is spelled
     `cpipeManfiest`, Disney's typo).
   - Now `Load()` calls `GetCpipeManifest` again, but **only when
     `aIsFirstRun` is false** (`ed9b5c92`). Startup loads the manifest
     twice, as Disney's app did. The first load (from `AssetManager`
     start) must keep using the bundled or cached manifest, because
     `cpipeManager.cpipe` is still null then and a network request would
     crash in `AssetManager.GetCpipeUrl`. The second comes from
     `StartUpSequence`'s `CpipeUpdateOperation`. Every refresh failure
     (empty body, error status, bad JSON, an exception) reports
     `CpipeUnchanged`, which keeps the first-load manifest. So a build with
     no server boots exactly as before. A successful refresh caches the
     manifest, so the next boot starts from it, and raises `CpipeData`,
     which makes `AssetManager` call `EntitlementsManager.RefreshInventoy()`.
3. **Nothing served the bundles under the manifest's paths.** The rebuilt
   bundles shipped only in `StreamingAssets/AssetBundles/windows64/hd/…`,
   and both manifests listed only `android` and `iphone` paths. iceberg now
   lists and serves them (§2, "Desktop bundles").

**Hiding missing content** (`9a9e7bde`). The recreation lacks most of the
final catalog (table below), so listing every catalog item would show a
warning icon for each missing bundle. `AssetManager.IsBundleAvailable`
is true when the item's path is in the loaded manifest **or** exists under
the build's StreamingAssets. `RefreshStickers` and `RefreshGags` skip items
that fail it, and `RefreshStickerPacks` skips packs left with no sticker.
They run again on every `RefreshInventoy()`, so the lists follow the
manifest from the refresh, not just the first one (`ContentData` parses
once, possibly before the refresh, so it's the wrong place). Games, avatar
parts and other types are not filtered. Because received messages can now
reference a sticker the receiver hides, `GetStickerData` can return null:
null guards were added in `MessageUtils`, `MessageLocalNotification`,
`StickerSearch` and `MediaTray`, and chat items fall back to Disney's own
"update the app" placeholder.

**Two fixes found by the live check** (the first run against iceberg's
real `/cpipe`):
- `c8b8cc1c`, `ContentData`: always parse the bundled
  `StreamingAssets/contentdata.joe`. The old code also overwrote
  `zipFileBasePath` before an "is the argument empty" check, so the check
  was dead. After the manifest refresh the base manifest still lists
  Disney's `contentdata.joe.gz`, which iceberg can't serve, so the 404
  produced an empty argument, "Error loading JOE data",
  `EntitlementsStartOperation` failed, and `OperationStack` quit the app.
- `bea1554e`, `AssetObject.LoadBinaryCoroutine`: a 404 with an empty body
  leaves `www.bytes` null, which threw a NullReferenceException that killed
  the coroutine, so the load never finished. It now checks for null, and
  `WebBinaryResponseHandler` already handles the failure.
iceberg still lists `contentdata.joe.gz` and `localization/*` that it
can't serve, because the base manifest is kept as is. Both are harmless
now.

**Setup per deployment** (again when content changes):
`bun tools/mix-content.ts build --project ~/src/DisneyMix` (Linux bundles;
166 s, 1,264 bundles per platform), then
`bun tools/mix-content.ts import --from
~/src/DisneyMix/Assets/StreamingAssets/AssetBundles`, then restart
web-api. `windows64` isn't built here: it ships prebuilt in the client
repo (the import copies it), and Windows build support isn't installed.
Also render `web-api/data/mix/cpipe/donotcopy/n7c4c656` (§2), or the config
refetch 404s.

**Live check** (native Linux build, bundles moved out of the build's
StreamingAssets so only the network could supply them):
- `GET /cpipe?restrict=true&cv=2.3.1[&v=00134]` is logged on boot.
- Boot reaches login with no stall on the config refetch.
- Opening the panels fetched 62 `standalonelinux64/hd/stickers/…` and 17
  `hd/gags/…` bundles. A sticker and a gag sent from the app rendered in
  the app's own history. (Both sides were one account in a self-chat; the
  `ContentId` relay is covered by `tools/mix-chat-test.ts`.)
- With the local bundles restored and web-api stopped, the app boots to
  its registration screen (the stock "try again later" dialog, since
  there's no server). Panels can't be inspected there without a login.
- **Not tested: Windows.** Coverage is review, and the imported
  `windows64` files being byte-identical to the client repo's.

**What the import summary reports** (per platform, the two are identical).
"Listed" counts only `.unity3d` entries under `AssetBundles/iphone/` in
manifest `00134`: the manifest also lists macOS `.DS_Store` files, which
Disney's upload evidently swept up (inferred).

| Area | Present | Listed |
|---|---|---|
| `hd/stickers` | 142 | 554 |
| `hd/gags` | 28 | 49 |
| `hd/gogs` | 611 | 1,065 |
| `hd/avatar_thumbs` | 293 | 312 |
| `hd/avatar_multiplane` | 172 | 206 |
| other | 18 | 58 |

Present stickers are 142 files, but the catalog maps only 64 of them to
`_hd` bundles the client asks for (the rest are `_thumb` files); gags are
13 of 13 catalog gags. So the panels show 64 stickers and 13 gags. The
"Present" gag count (28) is a file count, probably including variants per
language (inferred).

### Better leads than Wayback

- **On-device caches.** Mix downloaded bundles into Unity's cache on
  the device. Old phones and tablets that ever ran Mix, and backups of
  them, may still hold the final-version files.
- **APK/IPA archives** of different Mix versions. Each one bundles a
  `StreamingAssets` snapshot.
- Other crawls (Common Crawl, community scrapes) of the bucket's
  later listing pages.

---

## 11. Open questions

- How does photo/video **upload** work? Where does `UgcMediaId` come from?
  Trace `ChatMessageSender.cs` / `IChatMessageSender.cs`.
- What exactly does `PilCheck` ("PIL") gate?
- Client-side trust gating, beyond typed text: does `IsTrusted` change
  anything else in the composer (e.g. links, photos)? Typed text is
  allowed in untrusted threads (see section 7).
- The CPI client's copy of `SessionResumer`: does it read
  `NotificationSequenceThreshold` the same way?
- How the client treats a cpipe manifest response whose version is
  unchanged or older than the one it holds.
