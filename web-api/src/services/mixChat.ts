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

const sql = db.db;

export type ThreadType = "ONE_ON_ONE" | "GROUP";
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
 * creator is always one. Every other member must be the creator's friend.
 * A 1:1 that already exists is returned again, to the creator only.
 * IsTrusted mirrors friendship trust: for a group, every pair of members
 * must be trusted friends.
 */
export function createThread(creator: string, type: string, memberIds: unknown): MixNotification {
    if (type !== "ONE_ON_ONE" && type !== "GROUP") throw new MixError("INVALID_REQUEST");
    if (!Array.isArray(memberIds) || !memberIds.every((m) => typeof m === "string")) throw new MixError("INVALID_REQUEST");
    const others = [...new Set(memberIds as string[])].filter((m) => m !== creator);
    if (others.length === 0 || (type === "ONE_ON_ONE" && others.length !== 1)) throw new MixError("INVALID_REQUEST");
    for (const m of others) if (friendshipTrust(creator, m) === null) throw new MixError("USER_NOT_FRIEND");

    return db.inTransaction(() => {
        if (type === "ONE_ON_ONE") {
            const existing = existingOneOnOne(creator, others[0]!);
            if (existing !== null) {
                return notify(creator, "AddChatThread", { ChatThread: threadDto(existing), WelcomingUserId: creator });
            }
        }
        const members = [creator, ...others];
        let trusted = true;
        for (let i = 0; i < members.length && trusted; i++) {
            for (let j = i + 1; j < members.length; j++) {
                if (friendshipTrust(members[i]!, members[j]!) !== true) { trusted = false; break; }
            }
        }
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

export type MessageType = "TEXT" | "STICKER" | "GAG";
const NOTIFICATION_TYPE: Record<MessageType, string> = {
    TEXT: "AddChatThreadTextMessage",
    STICKER: "AddChatThreadStickerMessage",
    GAG: "AddChatThreadGagMessage",
};
const MAX_TEXT_UNITS = 1000;

type MessageRow = {
    id: number; thread_id: number; seq: number; sender_swid: string; client_message_id: number;
    type: string; payload: string; created_at: string;
};

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
        ClientChatMessageId: row.client_message_id,
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
 * Sends a TEXT, STICKER or GAG message. A retry with the same
 * (sender, ClientChatMessageId) gets back the sender's original
 * notification and writes nothing. Everyone in the thread, sender
 * included, gets AddChatThread<Type>Message at their own next sequence;
 * the message's SequenceNumber is the thread's next seq.
 */
export function addMessage(sender: string, threadId: unknown, clientMessageId: unknown, type: MessageType, fields: any): MixNotification {
    if (!Number.isSafeInteger(clientMessageId) || !Number.isSafeInteger(threadId)) throw new MixError("INVALID_REQUEST");
    const tid = threadId as number;
    const cid = clientMessageId as number;
    return db.inTransaction(() => {
        // 1. Retry: the original notification, unchanged.
        const prior = sql.query("SELECT * FROM mix_chat_messages WHERE sender_swid = ? AND client_message_id = ?").get(sender, cid) as MessageRow | null;
        if (prior) {
            const stored = sql.query(`SELECT data FROM mix_pending_notifications
                WHERE swid = ? AND type = ? AND json_extract(data, '$.Message.ChatMessageId') = ?
                ORDER BY sequence LIMIT 1`).get(sender, NOTIFICATION_TYPE[prior.type as MessageType] ?? "", prior.id) as { data: string } | null;
            if (stored) return JSON.parse(stored.data);
            // The pending row was cleaned up (older than an hour). Rebuild it
            // without writing; its SequenceNumber is already applied, so the
            // client's queue ignores it.
            return { Created: Date.parse(prior.created_at), NotificationId: prior.id, SequenceNumber: db.getMixNotificationSequence(sender), Message: toMessageDto(prior) };
        }

        // 2. Membership.
        if (!isMember(tid, sender)) throw new MixError("NOT_FOUND");

        // 3-4. Type fields.
        let payload: object;
        if (type === "TEXT") {
            const text = fields?.Text;
            if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT_UNITS) throw new MixError("INVALID_REQUEST");
            const f = filterText(text);
            if (f.blocked) throw new MixError("MODERATION_BLOCKED");
            payload = { Text: f.text, IsModerated: f.moderated };
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
        const seq = latestSeq(tid) + 1;
        const id = Number(sql.query(`INSERT INTO mix_chat_messages (thread_id, seq, sender_swid, client_message_id, type, payload, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(tid, seq, sender, cid, type, JSON.stringify(payload), new Date().toISOString()).lastInsertRowid);
        const message = toMessageDto(sql.query("SELECT * FROM mix_chat_messages WHERE id = ?").get(id) as MessageRow);
        const sent = notifyMany(currentMembers(tid), NOTIFICATION_TYPE[type], () => ({ Message: message }));
        return sent.get(sender)!;
    });
}
