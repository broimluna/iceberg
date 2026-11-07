# Disney Mix support in the web API: design

- **Date:** 2026-11-07
- **Branch:** `mix-support`
- **Status:** awaiting review

Background on the protocol, with client citations, is in
[`docs/MIX_API.md`](../../MIX_API.md). This spec only decides what we
build. It doesn't repeat that reference.

## Goal

Make iceberg's existing `web-api` serve **both** front ends:

- **Club Penguin Island**, which already works and must keep working.
- The **Disney Mix app**, as recreated in
  [OpenCPIsland/DisneyMix](https://github.com/OpenCPIsland/DisneyMix)
  (Unity 6000.3.14f1).

The long-term target is everything the Mix client can call. We get
there in phases (see Phasing).

### Decisions already made

| Decision | Choice |
|---|---|
| Target client | The OpenCPIsland Unity recreation only. Retail Mix builds are out of scope because they don't run on modern OSes. |
| Accounts | One shared account. A Mix user is the same `player_identity` SWID as the CPI player, so friends, presence and display name are shared. |
| Real-time delivery | Notification polling only (`/notifications/sinceSequence`). No push, because the GCM/APNs credentials are gone. |
| Moderation | Real basic moderation: rule-based filter, stored reports, Disney's sanction ladder, and bans enforced on both apps. |
| Structure | Approach A: split `mix.ts` into a module first, with shared services, then build on it. |
| Host layout | One host. Guest Controller at `/`, Mix API at `/mix` (also at `/` as today), cpipe at `/cpipe`. |

### Non-goals

- Retail Mix APK/IPA support, and any DNS or hostname impersonation.
- Push notifications.
- Disney's `/integrationTestSupport/*` endpoints.
- Automatic sanctions. Every sanction is a moderator decision.
- A web moderation dashboard. The service layer allows adding one
  later.
- Restoring lost CDN content (see `MIX_API.md` §10). The server works
  with whatever content the client ships.

## Architecture

```
web-api/src/
  routes/mix/
    index.ts          mounts the sub-routers. server.ts mounts this at ['/', '/mix'] as today
    auth.ts           authenticateMix + the application/mix encryption middleware (moved from mix.ts)
    session.ts        /session/user, /session/user/delete
    state.ts          /state, /presence
    users.ts          /users/*, /search/displayname, /displayname*, /languagePreference,
                      /geolocation, /registration/text, /pil/check
    friends.ts        /friendship*
    notifications.ts  /notifications, /notifications/sinceSequence, /alert/clear
    moderation.ts     /moderation/text, /moderation/reportPlayer
    push.ts           /pushNotificationsSetting* (no-ops)
    chat.ts           /chatThread*, /chatThreadMembership*            (phase 3)
  routes/cpipe.ts     GET /cpipe, GET /cpipe/files/*                  (phase 1)
  services/
    mixNotify.ts      per-user notification log (moved from mix.ts + notifyMany)
    mixChat.ts        chat domain logic                               (phase 3)
    moderation.ts     filter, reports, sanctions, bans                (phase 2)
  data/mix/
    cpipe-manifest.json  copied from the recreation's StreamingAssets/1123402340.txt
    cpipe/               static cpipe files (initially donotcopy/n7c4c656)
tools/
  mix-config.ts       render or decrypt the encrypted Mix boot config
  mod.ts              moderator CLI
  lib/mix-client.ts   SDK-faithful test client
```

Routes are thin. They parse the request, authorize it, call a
service, and shape the response in the Mix format. All state changes
go through services, and those run inside a SQLite transaction.

## Data model

Existing tables stay as they are, apart from the threshold fix below:

- `mix_friendships`, `mix_friendship_invitations`, `mix_alerts`
- `mix_presence_state`, `mix_pending_notifications`

New tables, added in `database.ts` with `CREATE TABLE IF NOT EXISTS`
like the existing ones:

| Table | Columns | Constraints |
|---|---|---|
| `mix_chat_threads` | `id INTEGER PK`, `type TEXT` (`ONE_ON_ONE`/`GROUP`, the exact client strings to be confirmed against `ChatThreadType` parsing in phase 3), `is_trusted INTEGER`, `official_account_id TEXT NULL`, `created_by TEXT`, `created_at` | |
| `mix_chat_members` | `thread_id`, `swid`, `joined_seq INTEGER`, `left_at NULL`, `last_seen_seq INTEGER`, `history_cleared_seq INTEGER` | PK `(thread_id, swid)` |
| `mix_chat_messages` | `id INTEGER PK`, `thread_id`, `seq INTEGER`, `sender_swid`, `client_message_id INTEGER`, `type TEXT`, `payload TEXT` (JSON), `created_at` | UNIQUE `(thread_id, seq)`, UNIQUE `(sender_swid, client_message_id)` |
| `mix_chat_nicknames` | `swid`, `thread_id`, `nickname` | PK `(swid, thread_id)` |
| `mix_moderation_rules` | `id`, `pattern`, `kind` (`word`/`regex`), `action` (`mask`/`block`), `created_at` | |
| `mix_reports` | `id`, `reporter_swid`, `reported_swid`, `reason`, `thread_id NULL`, `message_id NULL`, `source` (`mix`/`cpi`), `status` (`open`/`actioned`/`dismissed`), `created_at` | |
| `mix_sanctions` | `id`, `swid`, `type` (an `AlertType` string), `level` 1–5, `alert_id`, `moderator`, `created_at` | history used to suggest the next level |
| `mix_bans` | `swid`, `kind` (`ban`/`lock`), `until NULL` (NULL = permanent), `sanction_id`, `created_at`, `lifted_at NULL` | |

**Two separate sequence counters:**

1. **Per-thread message `seq`.** It is `MAX(seq)+1` within the thread,
   assigned inside the send transaction. It feeds
   `ChatThreadLatestMessageSequenceNumbers`, unread counts (`latest −
   last_seen_seq`) and range reads.
2. **Per-user notification `sequence`.** This is the existing counter
   in `mix_pending_notifications`. Every chat event writes one row per
   affected member, each at that member's own next sequence.

**Visibility.** A member sees messages with `seq > max(joined_seq,
history_cleared_seq)`. Members who left see nothing after `left_at`.

## Components

### `services/mixNotify.ts` (phase 0)

- Takes over `notify()` from `mix.ts` unchanged.
- Adds `notifyMany(swids, type, build(swid) → fields)`.
- Must be called inside the caller's transaction, so a sequence number
  is never handed out without its row. That rules out gaps from
  partial writes.
- **Fix:** `NotificationSequenceThreshold`
  (`MaximumMissingNotificationTime` in the client, in **milliseconds**)
  goes from 100 to 10000. See `MIX_API.md` §5.

### Config and cpipe (phase 1)

**`tools/mix-config.ts`**

- `render <base-url> [--out file]`
  - Writes the AES-256-CBC + Base64 config, using the key and IV in
    `MIX_API.md` §2.
  - `guest_baseUrl` = base, `guest_v2_baseUrl` = base + `/jgc/v5`.
  - `mix_platform_services_url` = base + `/mix`.
  - `cpipe_url` = base + `/cpipe`.
  - Every other key is copied from Disney's original (`.og`) values.
- `decrypt <file>` prints the JSON.

**`GET /cpipe`**

- Request: `?restrict=true&cv=…[&v=…]`.
- Returns `data/mix/cpipe-manifest.json` with two changes:
  - `cdnRoot` is set to `<request origin>/cpipe/files`.
  - The `donotcopy/n7c4c656` entry gets the server's own version.
- Requires an `Authorization` header to be present, but doesn't check
  its value.
- Phase 1 has to find out, against the live client, how it treats an
  unchanged or older manifest version, and adjust the response to
  match.

**`GET /cpipe/files/*`**

- Static files from `data/mix/cpipe/`, with path traversal rejected.

**Guest Controller**

- Accepts client ID `DI-SPARK-PROD` alongside CPI's.
- Any per-client differences found in phase 1 are recorded in
  `MIX_API.md`.

### Moderation (phase 2): `services/moderation.ts`

**`filterText(text)`** → `{ text, moderated, blocked }`

- Checks text against the rules, which are cached in memory and
  invalidated on write.
- `mask` replaces each match with `*`. `block` sets `blocked`.
- Seeded with a small starter list. Rules are data, edited through
  `tools/mod.ts`.

**`report({reporter, reported, reason, source, threadId?, messageId?})`**

- Inserts an `open` report.

**`sanction(swid, type, level, moderator)`**, in one transaction:

1. Inserts a `mix_alerts` row with `Text = type` and `Level = level`,
   plus an `AddAlert` notification. The client then shows Disney's
   localized message.
2. If the ladder rung bans or locks, inserts a `mix_bans` row.
   - The duration table is in `moderation.ts` and transcribes the
     strings in `MIX_API.md` §9.
   - "contact support" rungs are permanent until lifted.
   - `VULNERABLE_PERSON` uses `kind = lock`.
3. Inserts the `mix_sanctions` row.

**`suggestLevel(swid, type)`** returns the last level for that type,
plus 1, capped at 5. It is only a suggestion.

**`isBanned(swid)`** returns the active ban or null. It is checked:

- in Mix `authenticateMix` (`Status: "UNAUTHORIZED_BANNED"`)
- at Guest Controller login (the error shape is decided in phase 2
  after checking what both clients display)

**Wiring:**

- Mix `PUT /moderation/text`
- Mix `PUT /moderation/reportPlayer`
- CPI `POST /chat/v1/message/verify`
- CPI `POST /moderation/v1/report/name/:displayName`
- the server-side check inside every chat text send

**`tools/mod.ts`:** `reports [--open]`, `report <id> dismiss|actioned`,
`sanction <swid|name> <TYPE> [level]`, `unban <swid|name>`,
`rules list|add|remove`.

### Chat (phase 3): `services/mixChat.ts` + `routes/mix/chat.ts`

**`createThread(creator, type, memberIds)`**

- Every member must be a friend of the creator.
- **One-on-one threads are deduplicated:** if a thread already exists
  for the pair, return it.
- `is_trusted` comes from the friendship trust flags.
- Emits `AddChatThread` to every member. The creator's copy is the
  response.

**`addMessage(sender, threadId, clientMessageId, type, payload)`**,
covering `text`, `sticker` and `gag` in phase 3:

1. Return the original result if `(sender, clientMessageId)` already
   exists, so client retries are safe.
2. Membership check. A non-member gets the not-found status (exact
   status string confirmed in phase 3).
3. Ban check.
4. For text, `filterText`: blocked text is rejected, masked text is
   stored masked.
5. Assign `seq` and insert the message.
6. `notifyMany` to current members.
7. Return the sender's notification as `Notification`.

**Membership**

- **Add:** requires friendship with the welcoming user. Emits
  `AddChatThreadMembership` and a `MemberListChanged` system message.
  The response carries both.
- **Remove:** sets `left_at` and emits `RemoveChatThreadMembership` and
  `MemberListChanged`.

**Per-member state**

- `history/delete` sets `history_cleared_seq = latest`.
- `unreadMessageCount/delete` sets `last_seen_seq = latest`.
- Both notify only the requesting user (on all their sessions).

**Thread nicknames**

- `PUT/POST …/nickname[/delete]`, per user.
- Emits `AddChatThreadNickname` / `RemoveChatThreadNickname` to that
  user only.

**Reads**

- `POST /chatThread` (paged with `Cursor`)
- `/chatThread/recentMessages`, `/chatThread/specificMessages`
- `/chatThread/messages/recent`, `/messages/bySequenceRange`,
  `/messages/sequenceNumber`
- All filtered by visibility.
- Responses group messages by type, as `GetChatThreadMessagesResponse`
  does.

**`/state` additions**

- `ChatThreads`, `ChatThreadNicknames`, `ChatThreadUnreadMessageCount`
- `ChatThreadLatestMessageSequenceNumbers` and
  `ChatThreadLastSeenMessageSequenceNumbers` (parallel lists, in the
  same order as `ChatThreads`)
- `GameStateChatMessages` (empty until phase 5)

**Trust gating** (which message types an untrusted thread allows) is
not enforced in phase 3. It's an open research item in `MIX_API.md`.
For now the server stores `is_trusted` correctly and emits
`UpdateChatThreadTrustStatus` when friendship trust is removed.

### Error handling

- Use the existing Mix response envelope (`buildResponse`, `Status`).
  Any new status string must be one the client parses. Each one is
  checked against the SDK source and recorded in `MIX_API.md` before
  use.
- Every multi-row write is a single transaction. If anything fails,
  nothing is written, including notification rows.
- Bad input (missing IDs, wrong types, oversized text) gets the
  client's generic bad-request status. The server never trusts
  `UserId` in the body over the authenticated session.

## Phasing

| # | Phase | Exit criteria |
|---|---|---|
| 0 | Refactor + threshold fix | `mix-friends-test.ts`, `webapi-fixes-test.ts` and `webapi-auth-test.ts` pass unchanged. CPI friends work live. |
| 1 | Boot and connect | The Mix recreation, with a `mix-config.ts` config, boots, logs in with an existing CPI account, and lists its CPI friends. `mix-boot-test.ts` passes. |
| 2 | Moderation | `mix-moderation-test.ts` passes. A sanction shows Disney's text. A ban logs out Mix and blocks login on both apps. |
| 3 | Core chat | `mix-chat-test.ts` passes. Two live Mix clients chat 1:1 and in a group, and history and unread counts survive restart and resync. |
| 4 | Media (photo/video, `/video/url`) | Gets its own spec once the `UgcMediaId` upload path is traced. |
| 5 | Games and extras (game state/event, `/avatar`, `/nickname`, official accounts) | Gets its own spec after research, informed by what content exists. |

Each phase pushes to `mix-support` and updates `MIX_API.md` (endpoint
status table and new findings) in the same commits.

## Testing

Follow the existing `tools/*-test.ts` pattern: each test starts a
throwaway copy of `web-api` with its own database on a spare port.

**`tools/lib/mix-client.ts`** is an SDK-faithful client:

- the real `PUT /session/user` RSA→AES key exchange and
  `application/mix` bodies (not `ALLOW_SWID_AUTH`)
- the `X-Mix-*` headers
- applying notifications only at `latest + 1`, and failing the test on
  any gap or on a notification missing fields the client's
  `NotificationValidator` requires

**New tests:**

- **`mix-boot-test.ts`:** config render/decrypt round-trip, `GET
  /cpipe` shape and `cdnRoot`, `GET /cpipe/files` (and traversal
  rejection), login with `DI-SPARK-PROD`, `/state` chat fields present
  and empty.
- **`mix-moderation-test.ts`:** mask and block, report storage,
  sanction → `AddAlert` with the right type and level, ban →
  `UNAUTHORIZED_BANNED` on Mix calls and refusal at Guest Controller
  login, unban restores access, CPI verify endpoint uses the same
  rules.
- **`mix-chat-test.ts`:** three users. One-on-one dedup, group
  fan-out with gap-free sequences for every member, a repeated
  `ClientChatMessageId` stored once, a non-member gets not-found,
  blocked text rejected and masked text stored masked, unread and
  clear-history semantics, member add/remove system messages, `/state`
  after resync matches the notification history.

**Regression:** every phase reruns `mix-friends-test.ts`,
`webapi-fixes-test.ts` and `webapi-auth-test.ts`.

**Live checks** need Unity 6000.3.14f1 to run the recreation. When
that isn't available, the phase report says the scripted client is
the only evidence.

## Open questions (tracked in `MIX_API.md` §11)

- The cpipe response to an unchanged or older manifest version (phase 1).
- The exact `ChatThreadType` strings and the not-found status string (phase 3).
- How the CPI client reacts to `UNAUTHORIZED_BANNED` and to a refused
  login (phase 2).
- The `UgcMediaId` upload path (phase 4).
- Client-side trust gating rules (phase 3, read-only research).
