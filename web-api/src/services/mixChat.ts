// Mix chat threads and messages (docs/MIX_API.md section 7).
//
// - A thread's members are rows in mix_chat_members; a member who left has
//   left_at set and is no longer "current".
// - Message SequenceNumber is per thread (MAX(seq)+1, from 1), separate from
//   the per-user notification sequence.
// - Thread-level notifications go to every current member via notifyMany;
//   the caller's copy is also returned in the HTTP reply, and the SDK runs
//   it through its sequence queue, so it is a real stored notification.
import * as db from "../database.ts";
import { notifyMany, notify, type MixNotification } from "./mixNotify.ts";
import { mixUser } from "../routes/mix/common.ts";
import { MixError } from "./mixErrors.ts";
import { filterText } from "./moderation.ts";
import { parseJson, isLong } from "../lib/bigJson.ts";

const sql = db.db;

export type ThreadType = "ONE_ON_ONE" | "GROUP";

// FriendSelectorPanel.MAX_GROUP_CHAT: 20 people, counting yourself. The
// SDK maps MAX_MEMBER_COUNT_EXCEEDED to its own result type.
const MAX_THREAD_MEMBERS = 20;
type ThreadRow = { id: number; type: string; is_trusted: number; official_account_id: string | null };

// ---------------------------------------------------------------------------
// Lookups

/** The friendship's IsTrusted, or null when the two aren't friends. */
function friendshipTrust(a: string, b: string): boolean | null {
    const row = sql.query("SELECT is_trusted FROM mix_friendships WHERE swid = ? AND friend_user_id = ?").get(a, b) as { is_trusted: number } | null;
    return row ? row.is_trusted === 1 : null;
}

export function currentMembers(threadId: number): string[] {
    return (sql.query("SELECT swid FROM mix_chat_members WHERE thread_id = ? AND left_at IS NULL ORDER BY rowid").all(threadId) as { swid: string }[])
        .map((r) => r.swid);
}

export function latestSeq(threadId: number): number {
    return (sql.query("SELECT COALESCE(MAX(seq), 0) AS n FROM mix_chat_messages WHERE thread_id = ?").get(threadId) as { n: number }).n;
}

/** The ChatThread wire shape (MixDomain/ChatThread.cs). */
export function threadDto(threadId: number) {
    const t = sql.query("SELECT id, type, is_trusted, official_account_id FROM mix_chat_threads WHERE id = ?").get(threadId) as ThreadRow | null;
    if (!t) throw new MixError("NOT_FOUND", 404);
    return {
        ChatThreadId: t.id,
        ChatThreadType: t.type,
        IsTrusted: t.is_trusted === 1,
        Members: currentMembers(t.id).map((swid) => mixUser(swid, db.getPlayerBySwid(swid))),
        OfficialAccountId: t.official_account_id ?? null,
    };
}

/** True when every pair of these users are trusted friends. */
function allPairsTrusted(members: string[]): boolean {
    for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
            if (friendshipTrust(members[i]!, members[j]!) !== true) return false;
        }
    }
    return true;
}

function existingOneOnOne(a: string, b: string): number | null {
    const row = sql.query(`SELECT t.id FROM mix_chat_threads t
        JOIN mix_chat_members ma ON ma.thread_id = t.id AND ma.swid = ? AND ma.left_at IS NULL
        JOIN mix_chat_members mb ON mb.thread_id = t.id AND mb.swid = ? AND mb.left_at IS NULL
        WHERE t.type = 'ONE_ON_ONE' ORDER BY t.id LIMIT 1`).get(a, b) as { id: number } | null;
    return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// PUT /chatThread

/**
 * Creates a ONE_ON_ONE or GROUP thread. Members are deduplicated and the
 * creator is always one. Every other member must be the creator's friend
 * (FORBIDDEN_NOT_FRIENDS), and a thread holds at most 20 people
 * (MAX_MEMBER_COUNT_EXCEEDED).
 * A 1:1 that already exists is returned again, to the creator only.
 * IsTrusted mirrors friendship trust: for a group, every pair of members
 * must be trusted friends.
 */
export function createThread(creator: string, type: string, memberIds: unknown): MixNotification {
    if (type !== "ONE_ON_ONE" && type !== "GROUP") throw new MixError("INVALID_REQUEST");
    if (!Array.isArray(memberIds) || !memberIds.every((m) => typeof m === "string")) throw new MixError("INVALID_REQUEST");
    const others = [...new Set(memberIds as string[])].filter((m) => m !== creator);
    if (others.length === 0 || (type === "ONE_ON_ONE" && others.length !== 1)) throw new MixError("INVALID_REQUEST");
    if (others.length + 1 > MAX_THREAD_MEMBERS) throw new MixError("MAX_MEMBER_COUNT_EXCEEDED");
    // FORBIDDEN_NOT_FRIENDS is the SDK's string (ChatThreadMemberAdder).
    for (const m of others) if (friendshipTrust(creator, m) === null) throw new MixError("FORBIDDEN_NOT_FRIENDS");

    return db.inTransaction(() => {
        if (type === "ONE_ON_ONE") {
            const existing = existingOneOnOne(creator, others[0]!);
            if (existing !== null) {
                return notify(creator, "AddChatThread", { ChatThread: threadDto(existing), WelcomingUserId: creator });
            }
        }
        const members = [creator, ...others];
        const trusted = allPairsTrusted(members);
        const threadId = Number(sql.query("INSERT INTO mix_chat_threads (type, is_trusted, created_by) VALUES (?, ?, ?)")
            .run(type, trusted ? 1 : 0, creator).lastInsertRowid);
        const add = sql.query("INSERT INTO mix_chat_members (thread_id, swid) VALUES (?, ?)");
        for (const m of members) add.run(threadId, m);
        const thread = threadDto(threadId);
        const sent = notifyMany(members, "AddChatThread", () => ({ ChatThread: thread, WelcomingUserId: creator }));
        return sent.get(creator)!;
    });
}

// ---------------------------------------------------------------------------
// /state

/**
 * The chat fields of GetStateResponse. The two sequence lists are flat
 * [threadId, seq, threadId, seq, ...] pairs (SequenceNumberUtils), and
 * unread counts list only threads with something unread.
 */
export function stateFor(swid: string) {
    const rows = sql.query(`SELECT thread_id, last_seen_seq, history_cleared_seq FROM mix_chat_members
        WHERE swid = ? AND left_at IS NULL ORDER BY thread_id`).all(swid) as { thread_id: number; last_seen_seq: number; history_cleared_seq: number }[];
    const ChatThreads = [];
    const ChatThreadUnreadMessageCount = [];
    const ChatThreadLatestMessageSequenceNumbers: number[] = [];
    const ChatThreadLastSeenMessageSequenceNumbers: number[] = [];
    for (const r of rows) {
        const latest = latestSeq(r.thread_id);
        ChatThreads.push(threadDto(r.thread_id));
        ChatThreadLatestMessageSequenceNumbers.push(r.thread_id, latest);
        ChatThreadLastSeenMessageSequenceNumbers.push(r.thread_id, r.last_seen_seq);
        const unread = latest - Math.max(r.last_seen_seq, r.history_cleared_seq);
        if (unread > 0) ChatThreadUnreadMessageCount.push({ ChatThreadId: r.thread_id, UnreadMessageCount: unread });
    }
    const ChatThreadNicknames = (sql.query(`SELECT n.thread_id, n.nickname FROM mix_chat_nicknames n
        JOIN mix_chat_members m ON m.thread_id = n.thread_id AND m.swid = n.swid AND m.left_at IS NULL
        WHERE n.swid = ?`).all(swid) as { thread_id: number; nickname: string }[])
        .map((n) => ({ ChatThreadId: n.thread_id, Nickname: n.nickname }));
    return {
        ChatThreads,
        ChatThreadNicknames,
        ChatThreadUnreadMessageCount,
        ChatThreadLatestMessageSequenceNumbers,
        ChatThreadLastSeenMessageSequenceNumbers,
        GameStateChatMessages: [],
    };
}

// ---------------------------------------------------------------------------
// Messages

export type MessageType = "TEXT" | "STICKER" | "GAG" | "GAME_STATE";
const NOTIFICATION_TYPE: Record<string, string> = {
    TEXT: "AddChatThreadTextMessage",
    STICKER: "AddChatThreadStickerMessage",
    GAG: "AddChatThreadGagMessage",
    GAME_STATE: "AddChatThreadGameStateMessage",
    MEMBER_LIST_CHANGED: "AddChatThreadMemberListChangedMessage",
};
const MAX_TEXT_UNITS = 1000;
const MAX_GAME_PAYLOAD = 256 * 1024; // GameName + Payload (a JSON string, e.g. runner ghost data)

type MessageRow = {
    id: number; thread_id: number; seq: number; sender_swid: string; client_message_id: number;
    type: string; payload: string; created_at: string;
    /** client_message_id as text: SQLite keeps 64 bits exactly, a JS number doesn't. */
    cid_text: string;
};
// Every message read selects this, so the 64-bit client id survives.
const MSG = "SELECT *, CAST(client_message_id AS TEXT) AS cid_text FROM mix_chat_messages";

/** A stored C# long back as a number when it fits exactly, else a BigInt. */
function toLong(text: string): number | bigint {
    const big = BigInt(text);
    return Number.isSafeInteger(Number(big)) ? Number(big) : big;
}

/**
 * A mix_chat_messages row in its wire shape (MixDomain/*ChatMessage.cs).
 * payload holds the type's own fields: TEXT {Text, IsModerated},
 * STICKER {ContentId}, GAG {ContentId, TargetUserId}. created_at is an
 * ISO-8601 string with milliseconds, so Created round-trips exactly.
 */
export function toMessageDto(row: MessageRow) {
    return {
        Created: Date.parse(row.created_at),
        ChatMessageId: row.id,
        // System messages have no client id (they're stored with a made-up
        // one only to keep (sender, client_message_id) unique). Client ids are
        // random 64-bit longs, negative ones included, and must round-trip.
        ClientChatMessageId: row.type === "MEMBER_LIST_CHANGED" ? 0 : toLong(row.cid_text),
        ChatThreadId: row.thread_id,
        SenderUserId: row.sender_swid,
        SequenceNumber: row.seq,
        MessageType: row.type,
        ...JSON.parse(row.payload),
    };
}

function isMember(threadId: number, swid: string): boolean {
    return !!sql.query("SELECT 1 FROM mix_chat_members WHERE thread_id = ? AND swid = ? AND left_at IS NULL").get(threadId, swid);
}

/**
 * Sends a TEXT, STICKER, GAG or GAME_STATE message. A retry with the same
 * (sender, ClientChatMessageId) gets back the sender's original
 * notification and writes nothing. Everyone in the thread, sender
 * included, gets AddChatThread<Type>Message at their own next sequence;
 * the message's SequenceNumber is the thread's next seq.
 */
export function addMessage(sender: string, threadId: unknown, clientMessageId: unknown, type: MessageType, fields: any): MixNotification {
    if (!isLong(clientMessageId) || !Number.isSafeInteger(threadId)) throw new MixError("INVALID_REQUEST");
    const tid = threadId as number;
    const cid = clientMessageId;
    return db.inTransaction(() => {
        // 1. Retry: the original notification, unchanged.
        const prior = sql.query(`${MSG} WHERE sender_swid = ? AND client_message_id = ?`).get(sender, cid) as MessageRow | null;
        if (prior) {
            const stored = sql.query(`SELECT data FROM mix_pending_notifications
                WHERE swid = ? AND type = ? AND json_extract(data, '$.Message.ChatMessageId') = ?
                ORDER BY sequence LIMIT 1`).get(sender, NOTIFICATION_TYPE[prior.type as MessageType] ?? "", prior.id) as { data: string } | null;
            if (stored) return parseJson(stored.data);
            // The pending row was cleaned up (older than an hour). Rebuild it
            // without writing; its SequenceNumber is already applied, so the
            // client's queue ignores it.
            return { Created: Date.parse(prior.created_at), NotificationId: prior.id, SequenceNumber: db.getMixNotificationSequence(sender), Message: toMessageDto(prior) };
        }

        // 2. Membership. In a 1:1 the two must still be friends: unfriending
        // someone has to stop their messages, not just the thread's trust.
        if (!isMember(tid, sender)) throw new MixError("NOT_FOUND");
        const kind = (sql.query("SELECT type FROM mix_chat_threads WHERE id = ?").get(tid) as { type: string }).type;
        if (kind === "ONE_ON_ONE") {
            const other = currentMembers(tid).find((m) => m !== sender);
            if (!other || friendshipTrust(sender, other) === null) throw new MixError("FORBIDDEN_NOT_FRIENDS");
        }

        // 3-4. Type fields.
        let payload: object;
        if (type === "TEXT") {
            const text = fields?.Text;
            if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT_UNITS) throw new MixError("INVALID_REQUEST");
            const f = filterText(text);
            if (f.blocked) throw new MixError("MODERATION_BLOCKED");
            payload = { Text: f.text, IsModerated: f.moderated };
        } else if (type === "GAME_STATE") {
            const { GameName, Payload } = fields ?? {};
            if (typeof GameName !== "string" || GameName.length === 0 || GameName.length > 64) throw new MixError("INVALID_REQUEST");
            if (typeof Payload !== "string" || Payload.length === 0 || Payload.length > MAX_GAME_PAYLOAD) throw new MixError("INVALID_REQUEST");
            payload = { GameName, State: Payload }
        } else {
            const contentId = fields?.ContentId;
            if (typeof contentId !== "string" || contentId.length === 0 || contentId.length > 256) throw new MixError("INVALID_REQUEST");
            if (type === "GAG") {
                const target = fields?.TargetUserId;
                if (typeof target !== "string" || !isMember(tid, target)) throw new MixError("INVALID_REQUEST");
                payload = { ContentId: contentId, TargetUserId: target };
            } else {
                payload = { ContentId: contentId };
            }
        }

        // 5. Store and fan out.
        return storeMessage(sender, tid, cid, type, payload, currentMembers(tid)).get(sender)!;
    });
}

/**
 * Inserts a message at the thread's next seq and sends its notification to
 * `recipients`, each at their own next notification sequence. Call inside
 * inTransaction.
 */
function storeMessage(sender: string, tid: number, cid: number | bigint, type: string, payload: object, recipients: string[]): Map<string, MixNotification> {
    const seq = latestSeq(tid) + 1;
    const id = Number(sql.query(`INSERT INTO mix_chat_messages (thread_id, seq, sender_swid, client_message_id, type, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(tid, seq, sender, cid, type, JSON.stringify(payload), new Date().toISOString()).lastInsertRowid);
    const message = toMessageDto(sql.query(`${MSG} WHERE id = ?`).get(id) as MessageRow);
    return notifyMany(recipients, NOTIFICATION_TYPE[type]!, () => ({ Message: message }));
}

/** A MEMBER_LIST_CHANGED system message (MemberListChangedChatMessage). */
function storeMemberListChanged(actor: string, tid: number, memberIds: string[], isAdded: boolean, recipients: string[]) {
    const cid = -((sql.query("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM mix_chat_messages").get() as { n: number }).n);
    return storeMessage(actor, tid, cid, "MEMBER_LIST_CHANGED", { MemberUserIds: memberIds, IsAdded: isAdded }, recipients);
}

// ---------------------------------------------------------------------------
// Membership (group threads only; ChatThreadMemberAdder / GroupChatThread)

function groupThread(threadId: unknown): ThreadRow & { created_by: string } {
    if (!Number.isSafeInteger(threadId)) throw new MixError("INVALID_REQUEST");
    const t = sql.query("SELECT id, type, is_trusted, official_account_id, created_by FROM mix_chat_threads WHERE id = ?").get(threadId as number) as (ThreadRow & { created_by: string }) | null;
    if (!t) throw new MixError("NOT_FOUND");
    if (t.type !== "GROUP") throw new MixError("INVALID_REQUEST");
    return t;
}

/**
 * Adds friends of the actor to a group. New members start at the current
 * seq (they don't see older messages) and get AddChatThread first. Then
 * everyone gets AddChatThreadMembership {Members: the added users} and a
 * MEMBER_LIST_CHANGED message. If an added user isn't trusted with every
 * member, a trusted group becomes untrusted, and the existing members get
 * UpdateChatThreadTrustStatus last, so the actor's two reply notifications
 * stay consecutive.
 */
export function addMembers(actor: string, threadId: unknown, userIds: unknown) {
    const t = groupThread(threadId);
    if (!Array.isArray(userIds) || userIds.length === 0 || !userIds.every((u) => typeof u === "string")) throw new MixError("INVALID_REQUEST");
    return db.inTransaction(() => {
        const existing = currentMembers(t.id);
        if (!existing.includes(actor)) throw new MixError("USER_NOT_THREAD_MEMBER");
        const added = [...new Set(userIds as string[])];
        if (added.some((u) => existing.includes(u))) throw new MixError("USER_ALREADY_THREAD_MEMBER");
        if (existing.length + added.length > MAX_THREAD_MEMBERS) throw new MixError("MAX_MEMBER_COUNT_EXCEEDED");
        if (added.some((u) => friendshipTrust(actor, u) === null)) throw new MixError("FORBIDDEN_NOT_FRIENDS");

        const latest = latestSeq(t.id);
        const join = sql.query(`INSERT INTO mix_chat_members (thread_id, swid, joined_seq, last_seen_seq, history_cleared_seq)
            VALUES (?1, ?2, ?3, ?3, ?3)
            ON CONFLICT(thread_id, swid) DO UPDATE SET left_at = NULL, joined_seq = ?3, last_seen_seq = ?3, history_cleared_seq = ?3`);
        for (const u of added) join.run(t.id, u, latest);

        const everyone = currentMembers(t.id);
        const lostTrust = t.is_trusted === 1 && !allPairsTrusted(everyone);
        if (lostTrust) sql.query("UPDATE mix_chat_threads SET is_trusted = 0 WHERE id = ?").run(t.id);

        const thread = threadDto(t.id);
        notifyMany(added, "AddChatThread", () => ({ ChatThread: thread, WelcomingUserId: actor }));
        const addedUsers = added.map((u) => mixUser(u, db.getPlayerBySwid(u)));
        const membership = notifyMany(everyone, "AddChatThreadMembership", () => ({ ChatThreadId: t.id, Members: addedUsers, WelcomingUserId: actor }));
        const message = storeMemberListChanged(actor, t.id, added, true, everyone);
        if (lostTrust) notifyMany(existing, "UpdateChatThreadTrustStatus", () => ({ ChatThreadId: t.id, IsTrusted: false }));
        return { MembershipNotification: membership.get(actor)!, ChatMessageNotification: message.get(actor)! };
    });
}

/**
 * Removes a member from a group. Anyone may leave; removing someone else
 * takes the thread's creator. The removed user and the remaining members
 * get RemoveChatThreadMembership and the MEMBER_LIST_CHANGED message, then
 * the removed user's membership ends (left_at).
 */
export function removeMember(actor: string, threadId: unknown, userId: unknown) {
    const t = groupThread(threadId);
    if (typeof userId !== "string") throw new MixError("INVALID_REQUEST");
    return db.inTransaction(() => {
        const members = currentMembers(t.id);
        if (!members.includes(actor) || !members.includes(userId)) throw new MixError("USER_NOT_THREAD_MEMBER");
        if (userId !== actor && actor !== t.created_by) throw new MixError("USER_NOT_THREAD_MEMBER");
        const membership = notifyMany(members, "RemoveChatThreadMembership", () => ({ ChatThreadId: t.id, MemberUserId: userId }));
        const message = storeMemberListChanged(actor, t.id, [userId], false, members);
        sql.query("UPDATE mix_chat_members SET left_at = ? WHERE thread_id = ? AND swid = ?").run(new Date().toISOString(), t.id, userId);
        return { MembershipNotification: membership.get(actor)!, ChatMessageNotification: message.get(actor)! };
    });
}


// ---------------------------------------------------------------------------
// Reading history (ChatMessageRetriever, docs/MIX_API.md section 7)
//
// A reader sees messages with seq > max(joined_seq, history_cleared_seq).
// After leaving, they keep seeing what was sent up to their left_at (which
// includes the system message announcing the departure). Someone who was
// never a member gets NOT_FOUND.

const HISTORY_LISTS: Record<string, string> = {
    TEXT: "Text", STICKER: "Sticker", GAG: "Gag", VIDEO: "Video", PHOTO: "Photo",
    GAME_STATE: "GameState", GAME_EVENT: "GameEvent", MEMBER_LIST_CHANGED: "MemberListChanged",
};
const MAX_READ = 500;

type Visibility = { floor: number; leftAt: string | null };

function visibility(swid: string, threadId: unknown): Visibility {
    if (!Number.isSafeInteger(threadId)) throw new MixError("INVALID_REQUEST");
    const m = sql.query("SELECT joined_seq, history_cleared_seq, left_at FROM mix_chat_members WHERE thread_id = ? AND swid = ?")
        .get(threadId as number, swid) as { joined_seq: number; history_cleared_seq: number; left_at: string | null } | null;
    if (!m) throw new MixError("NOT_FOUND");
    return { floor: Math.max(m.joined_seq, m.history_cleared_seq), leftAt: m.left_at };
}

/** The visible-message condition for one thread, as SQL plus its parameters. */
function visibleWhere(threadId: number, v: Visibility): [string, any[]] {
    return v.leftAt
        ? ["thread_id = ? AND seq > ? AND created_at <= ?", [threadId, v.floor, v.leftAt]]
        : ["thread_id = ? AND seq > ?", [threadId, v.floor]];
}

/** Messages grouped as GetChatThreadMessagesResponse: every list present. */
export function groupMessages(rows: MessageRow[]) {
    const out: Record<string, object[]> = Object.fromEntries(Object.values(HISTORY_LISTS).map((k) => [k, []]));
    for (const r of rows) out[HISTORY_LISTS[r.type] ?? "Text"]!.push(toMessageDto(r));
    return out;
}

/**
 * POST /chatThread: newest first, 50 per page. Cursor is the lowest seq
 * returned (as a string); the next page continues below it, and a null
 * Cursor means there's nothing older. (This SDK version never calls it.)
 */
export function readPage(swid: string, threadId: unknown, cursor: unknown, maxCount: unknown, excluded: unknown) {
    const v = visibility(swid, threadId);
    const [where, params] = visibleWhere(threadId as number, v);
    const below = typeof cursor === "string" && /^\d+$/.test(cursor) ? Number(cursor) : Number.MAX_SAFE_INTEGER;
    const size = Number.isSafeInteger(maxCount) && (maxCount as number) > 0 ? Math.min(maxCount as number, 50) : 50;
    const skip = new Set(Array.isArray(excluded) ? excluded.filter((x) => Number.isSafeInteger(x)) : []);
    const rows = (sql.query(`${MSG} WHERE ${where} AND seq < ? ORDER BY seq DESC LIMIT ?`)
        .all(...params, below, size + 1) as MessageRow[]);
    const page = rows.slice(0, size);
    const more = rows.length > size;
    return {
        Cursor: more && page.length ? String(page[page.length - 1]!.seq) : null,
        ...groupMessages(page.filter((r) => !skip.has(r.id))),
    };
}

/** POST /chatThread/messages/bySequenceRange: inclusive [start, end] pairs. */
export function readRanges(swid: string, threadId: unknown, ranges: unknown) {
    const v = visibility(swid, threadId);
    if (!Array.isArray(ranges) || ranges.length % 2 === 1 || !ranges.every((x) => Number.isSafeInteger(x))) throw new MixError("INVALID_REQUEST");
    const [where, params] = visibleWhere(threadId as number, v);
    const rows: MessageRow[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < ranges.length && rows.length < MAX_READ; i += 2) {
        for (const r of sql.query(`${MSG} WHERE ${where} AND seq BETWEEN ? AND ? ORDER BY seq LIMIT ?`)
            .all(...params, ranges[i], ranges[i + 1], MAX_READ - rows.length) as MessageRow[]) {
            if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
        }
    }
    return { Cursor: null, ...groupMessages(rows) };
}

/**
 * POST /chatThread/messages/recent: LowerBoundSequenceNumbers is flat
 * [threadId, lowerSeq, ...] pairs (inclusive); returns the newest
 * MaxMessagesPerChatThread (default 20) at or above each bound. Threads
 * the caller can't read are skipped.
 */
export function readRecentPerThread(swid: string, lowerBounds: unknown, maxPerThread: unknown) {
    if (!Array.isArray(lowerBounds) || lowerBounds.length % 2 === 1 || !lowerBounds.every((x) => Number.isSafeInteger(x))) throw new MixError("INVALID_REQUEST");
    const n = Number.isSafeInteger(maxPerThread) && (maxPerThread as number) > 0 ? Math.min(maxPerThread as number, 100) : 20;
    const rows: MessageRow[] = [];
    for (let i = 0; i < lowerBounds.length && rows.length < MAX_READ; i += 2) {
        let v: Visibility;
        try { v = visibility(swid, lowerBounds[i]); } catch { continue; }
        const [where, params] = visibleWhere(lowerBounds[i], v);
        const newest = sql.query(`${MSG} WHERE ${where} AND seq >= ? ORDER BY seq DESC LIMIT ?`)
            .all(...params, lowerBounds[i + 1], n) as MessageRow[];
        rows.push(...newest.reverse());
    }
    return { Cursor: null, ...groupMessages(rows) };
}

/** POST /chatThread/specificMessages: by ChatMessageId; invisible ones are left out. */
export function readSpecific(swid: string, threadId: unknown, messageIds: unknown) {
    const v = visibility(swid, threadId);
    if (!Array.isArray(messageIds)) throw new MixError("INVALID_REQUEST");
    const ids = [...new Set(messageIds.filter((x) => Number.isSafeInteger(x)))].slice(0, MAX_READ);
    const [where, params] = visibleWhere(threadId as number, v);
    const rows = ids.length === 0 ? [] : sql.query(`${MSG} WHERE ${where} AND id IN (${ids.map(() => "?").join(",")}) ORDER BY seq`)
        .all(...params, ...ids) as MessageRow[];
    return groupMessages(rows);
}

/** POST /chatThread/recentMessages: everything visible to the caller created after MessagesSince (ms), newest 500. */
export function readSince(swid: string, since: unknown) {
    const after = new Date(Number.isFinite(since) ? (since as number) : 0).toISOString();
    const memberships = sql.query("SELECT thread_id FROM mix_chat_members WHERE swid = ?").all(swid) as { thread_id: number }[];
    const rows: MessageRow[] = [];
    for (const { thread_id } of memberships) {
        const [where, params] = visibleWhere(thread_id, visibility(swid, thread_id));
        rows.push(...(sql.query(`${MSG} WHERE ${where} AND created_at > ?`).all(...params, after) as MessageRow[]));
    }
    rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return groupMessages(rows.slice(0, MAX_READ).reverse());
}

/**
 * POST /chatThread/messages/sequenceNumber: flat [ChatMessageId, seq]
 * pairs for visible messages created up to StartMessageTimestamp (the
 * client sends its current time). The client uses them to fill in
 * sequence numbers for messages it stored locally with seq 0
 * (UserDatabase.UpdateChatMessageSequenceNumbers), and rejects an odd
 * length or a seq <= 0.
 */
export function readSequenceNumbers(swid: string, threadId: unknown, startTimestamp: unknown) {
    const v = visibility(swid, threadId);
    const until = new Date(Number.isFinite(startTimestamp) ? (startTimestamp as number) : Date.now()).toISOString();
    const [where, params] = visibleWhere(threadId as number, v);
    const rows = sql.query(`SELECT id, seq FROM mix_chat_messages WHERE ${where} AND created_at <= ? ORDER BY seq DESC LIMIT 1000`)
        .all(...params, until) as { id: number; seq: number }[];
    return { SequenceNumbers: rows.reverse().flatMap((r) => [r.id, r.seq]) };
}

// ---------------------------------------------------------------------------
// Per-member state: unread, history clears, thread nicknames. These
// notifications go to the caller only.

function requireMember(swid: string, threadId: unknown): number {
    if (!Number.isSafeInteger(threadId)) throw new MixError("INVALID_REQUEST");
    if (!isMember(threadId as number, swid)) throw new MixError("NOT_FOUND");
    return threadId as number;
}

/** POST /chatThreadMembership/unreadMessageCount/delete: everything up to now is seen. */
export function clearUnread(swid: string, threadId: unknown): MixNotification {
    const tid = requireMember(swid, threadId);
    return db.inTransaction(() => {
        sql.query("UPDATE mix_chat_members SET last_seen_seq = ? WHERE thread_id = ? AND swid = ?").run(latestSeq(tid), tid, swid);
        return notify(swid, "ClearUnreadMessageCount", { ChatThreadIds: [tid] });
    });
}

/**
 * POST /chatThreadMembership/history/delete {ChatThreadIds}: the caller
 * stops seeing everything sent so far in each thread (others keep it).
 */
export function clearHistory(swid: string, threadIds: unknown): MixNotification {
    if (!Array.isArray(threadIds) || threadIds.length === 0) throw new MixError("INVALID_REQUEST");
    const tids = [...new Set(threadIds.map((t) => requireMember(swid, t)))];
    return db.inTransaction(() => {
        for (const tid of tids) {
            const latest = latestSeq(tid);
            sql.query("UPDATE mix_chat_members SET history_cleared_seq = ?, last_seen_seq = ? WHERE thread_id = ? AND swid = ?").run(latest, latest, tid, swid);
        }
        return notify(swid, "ClearMemberChatHistory", { ChatThreadIds: tids });
    });
}

/**
 * PUT /chatThread/nickname: the caller's own name for a thread, 1-32
 * UTF-16 units, run through the shared filter (blocked gives
 * MODERATION_BLOCKED, masked words are stored masked).
 */
export function setThreadNickname(swid: string, threadId: unknown, nickname: unknown): MixNotification {
    const tid = requireMember(swid, threadId);
    if (typeof nickname !== "string" || nickname.length < 1 || nickname.length > 32) throw new MixError("INVALID_REQUEST");
    const f = filterText(nickname);
    if (f.blocked) throw new MixError("MODERATION_BLOCKED");
    return db.inTransaction(() => {
        sql.query(`INSERT INTO mix_chat_nicknames (swid, thread_id, nickname) VALUES (?, ?, ?)
            ON CONFLICT(swid, thread_id) DO UPDATE SET nickname = excluded.nickname`).run(swid, tid, f.text);
        return notify(swid, "AddChatThreadNickname", { ChatThreadNickname: { ChatThreadId: tid, Nickname: f.text } });
    });
}

/** POST /chatThread/nickname/delete */
export function removeThreadNickname(swid: string, threadId: unknown): MixNotification {
    const tid = requireMember(swid, threadId);
    return db.inTransaction(() => {
        sql.query("DELETE FROM mix_chat_nicknames WHERE swid = ? AND thread_id = ?").run(swid, tid);
        return notify(swid, "RemoveChatThreadNickname", { ChatThreadId: tid });
    });
}

// ---------------------------------------------------------------------------
// Trust follows friendships. Trust is what unlocks free text for kids
// (section 7), so a thread may never keep trust its members no longer have.

/**
 * Called inside the friendship trust-removal and unfriend transactions,
 * after the caller's own reply notification, so that reply stays the
 * caller's next sequence. Every trusted thread containing both users
 * becomes untrusted, and its current members get
 * UpdateChatThreadTrustStatus {ChatThreadId, IsTrusted: false}.
 */
export function onFriendshipTrustRemoved(a: string, b: string): void {
    const threads = sql.query(`SELECT t.id FROM mix_chat_threads t
        JOIN mix_chat_members ma ON ma.thread_id = t.id AND ma.swid = ? AND ma.left_at IS NULL
        JOIN mix_chat_members mb ON mb.thread_id = t.id AND mb.swid = ? AND mb.left_at IS NULL
        WHERE t.is_trusted = 1`).all(a, b) as { id: number }[];
    for (const { id } of threads) {
        sql.query("UPDATE mix_chat_threads SET is_trusted = 0 WHERE id = ?").run(id);
        notifyMany(currentMembers(id), "UpdateChatThreadTrustStatus", () => ({ ChatThreadId: id, IsTrusted: false }));
    }
}