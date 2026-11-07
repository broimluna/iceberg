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
- **iceberg:** `web-api/src/routes/mix.ts` and `guestcontroller.ts`.

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
- At runtime, `Mix/CpipeManifestApi.cs` requests
  `ExternalizedConstants.CpipeUrl + "?" + <query>` for a newer manifest.
  The server has to answer this, or keep answering "no update".
- The manifest JSON carries `manifest.cdnRoot` and `manifest.paths`
  (path to hash/version).

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

iceberg implements this in `mix.ts` (`mixEncryptionMiddleware`,
`buildRsaPublicKey`).

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

**Action:** set this to several seconds once chat lands, and confirm
against the CPI client's copy of `SessionResumer`.

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
IDs (Mix uses `DI-SPARK-PROD`) and different cellophane client tokens.

---

## 9. Open questions

- How does photo/video **upload** work? Where does `UgcMediaId` come from?
  Trace `ChatMessageSender.cs` / `IChatMessageSender.cs`.
- What exactly does `PilCheck` ("PIL") gate?
- The exact query parameters cpipe sends (`CpipeManifestApi.cs`) and
  the manifest response format the client accepts.
- Client-side trust gating: which message types are allowed in an
  untrusted thread?
- The CPI client's copy of `SessionResumer`: does it read
  `NotificationSequenceThreshold` the same way?
