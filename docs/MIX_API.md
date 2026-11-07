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
  Guest Controller, Mix API, and cpipe all at one host
  (`http://10.0.0.76:5782`), with `guest_v2_baseUrl` at `/jgc/v5`.

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
| PUT | `/chatThread` | AddChatThreadRequest | ❌ |
| POST | `/chatThread` | GetChatThreadMessagesRequest | ❌ |
| PUT | `/chatThreadMembership` | AddChatThreadMembershipRequest | ❌ |
| POST | `/chatThreadMembership/delete` | RemoveChatThreadMembershipRequest | ❌ |
| POST | `/chatThreadMembership/history/delete` | ClearMemberChatHistoryRequest | ❌ |
| POST | `/chatThreadMembership/unreadMessageCount/delete` | ClearUnreadMessageCountRequest | ❌ |
| PUT | `/chatThread/textMessage` | AddChatThreadTextMessageRequest | ❌ |
| PUT | `/chatThread/stickerMessage` | AddChatThreadStickerMessageRequest | ❌ |
| PUT | `/chatThread/gagMessage` | AddChatThreadGagMessageRequest | ❌ |
| PUT | `/chatThread/photoMessage` | AddChatThreadPhotoMessageRequest | ❌ |
| PUT | `/chatThread/videoMessage` | AddChatThreadVideoMessageRequest | ❌ |
| PUT | `/chatThread/gameStateMessage` | AddChatThreadGameStateMessageRequest | ❌ |
| POST | `/chatThread/gameStateMessage` | UpdateChatThreadGameStateMessageRequest | ❌ |
| POST | `/chatThread/recentMessages` | GetRecentChatThreadMessagesRequest | ❌ |
| POST | `/chatThread/specificMessages` | GetSpecificChatThreadMessagesRequest | ❌ |
| POST | `/chatThread/messages/recent` | GetChatThreadsRecentMessagesRequest | ❌ |
| POST | `/chatThread/messages/bySequenceRange` | GetChatThreadMessagesBySequenceRangesRequest | ❌ |
| POST | `/chatThread/messages/sequenceNumber` | GetChatThreadSequenceNumberRequest | ❌ |
| PUT | `/chatThread/nickname` | AddChatThreadNicknameRequest | ❌ |
| POST | `/chatThread/nickname/delete` | RemoveChatThreadNicknameRequest | ❌ |
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
| PUT | `/moderation/text` | ModerateTextRequest | ⚠️ placeholder filter |
| PUT | `/moderation/reportPlayer` | ReportPlayerRequest | ⚠️ logs only |
| PUT | `/alert/clear` | ClearAlertsRequest | ✅ |
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

### Community modifications in the recreation

The recreation's `NotificationPoller.HandleGetNotificationsResponse`
has a non-original block that treats a null
`NotificationSequenceCounter` as "no change". Keep that in mind when
comparing against CPI's untouched copy of the SDK. A server should
always send the counter anyway.

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
  - iceberg will use `PROFILE_USER_BANNED` for temporary bans and
    `PROFILE_DISABLED` for permanent bans and locks.
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

### Text moderation

`PUT /moderation/text` takes `{Text, ChatThreadId, ModerationPolicy}`
and returns `{Text, Moderated}`. The client asks *before* sending, and
gets back possibly-masked text plus a flag.

Reports: `PUT /moderation/reportPlayer` takes `{ReportedUserId,
Reason}`.

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
- Client-side trust gating: which message types are allowed in an
  untrusted thread?
- The CPI client's copy of `SessionResumer`: does it read
  `NotificationSequenceThreshold` the same way?
- How the CPI client reacts to `UNAUTHORIZED_BANNED` on its Mix calls,
  and what each app shows when Guest Controller login is refused for
  a banned account.
- How the client treats a cpipe manifest response whose version is
  unchanged or older than the one it holds.
