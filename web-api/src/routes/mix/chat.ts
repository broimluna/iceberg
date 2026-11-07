/**
 * Mix chat routes (services/mixChat.ts, docs/MIX_API.md section 7).
 */
import express from "express";
import { authenticateMix } from "./auth.ts";
import { buildResponse } from "./common.ts";
import {
    createThread, addMessage, addMembers, removeMember, type MessageType,
    readPage, readRanges, readRecentPerThread, readSpecific, readSince, readSequenceNumbers,
    clearUnread, clearHistory, setThreadNickname, removeThreadNickname,
} from "../../services/mixChat.ts";
import { mixRoute } from "../../services/mixErrors.ts";

const router = express.Router();

/**
 * PUT /chatThread  {ChatThreadType, MemberUserIds}
 * -> {Status, Notification: AddChatThread}. ChatThreadCreator dispatches
 * the notification through the caller's sequence queue, and treats any
 * error status as a plain failure (it has no specific failure statuses).
 */
router.put('/chatThread', authenticateMix, (req, res) => mixRoute(res, () =>
    buildResponse({ Notification: createThread(req.mixUserId, req.body.ChatThreadType, req.body.MemberUserIds) })
));

/**
 * PUT /chatThread/textMessage | stickerMessage | gagMessage
 * {ChatThreadId, ClientChatMessageId, Text | ContentId [, TargetUserId]}
 * -> {Status, Notification: AddChatThread<Type>Message}.
 */
for (const [path, type] of [["textMessage", "TEXT"], ["stickerMessage", "STICKER"], ["gagMessage", "GAG"]] as const) {
    router.put(`/chatThread/${path}`, authenticateMix, (req, res) => mixRoute(res, () =>
        buildResponse({ Notification: addMessage(req.mixUserId, req.body.ChatThreadId, req.body.ClientChatMessageId, type as MessageType, req.body) })
    ));
}

/**
 * PUT /chatThreadMembership {ChatThreadId, AddedUserIds}
 * POST /chatThreadMembership/delete {ChatThreadId, RemovedUserId}
 * -> {Status, MembershipNotification, ChatMessageNotification}. The SDK
 * dispatches both through the caller's queue, so they are consecutive.
 */
router.put('/chatThreadMembership', authenticateMix, (req, res) => mixRoute(res, () =>
    buildResponse(addMembers(req.mixUserId, req.body.ChatThreadId, req.body.AddedUserIds))
));
router.post('/chatThreadMembership/delete', authenticateMix, (req, res) => mixRoute(res, () =>
    buildResponse(removeMember(req.mixUserId, req.body.ChatThreadId, req.body.RemovedUserId))
));

// History reads (ChatMessageRetriever). Each replies with every message list
// (Text, Sticker, Gag, Video, Photo, GameState, GameEvent, MemberListChanged),
// empty when there's nothing of that type.
const reads: [string, (req: any) => object][] = [
    ['/chatThread', (req) => readPage(req.mixUserId, req.body.ChatThreadId, req.body.Cursor, req.body.MaximumMessageCount, req.body.ExcludedChatMessageIds)],
    ['/chatThread/messages/bySequenceRange', (req) => readRanges(req.mixUserId, req.body.ChatThreadId, req.body.Ranges)],
    ['/chatThread/messages/recent', (req) => readRecentPerThread(req.mixUserId, req.body.LowerBoundSequenceNumbers, req.body.MaxMessagesPerChatThread)],
    ['/chatThread/specificMessages', (req) => readSpecific(req.mixUserId, req.body.ChatThreadId, req.body.MessageIds)],
    ['/chatThread/recentMessages', (req) => readSince(req.mixUserId, req.body.MessagesSince)],
    ['/chatThread/messages/sequenceNumber', (req) => readSequenceNumbers(req.mixUserId, req.body.ChatThreadId, req.body.StartMessageTimestamp)],
];
for (const [path, read] of reads) {
    router.post(path, authenticateMix, (req, res) => mixRoute(res, () => buildResponse(read(req))));
}

// Per-member state. Each replies {Status, Notification} for the caller only.
router.post('/chatThreadMembership/unreadMessageCount/delete', authenticateMix, (req, res) => mixRoute(res, () =>
    buildResponse({ Notification: clearUnread(req.mixUserId, req.body.ChatThreadId) })));
router.post('/chatThreadMembership/history/delete', authenticateMix, (req, res) => mixRoute(res, () =>
    buildResponse({ Notification: clearHistory(req.mixUserId, req.body.ChatThreadIds) })));
router.put('/chatThread/nickname', authenticateMix, (req, res) => mixRoute(res, () =>
    buildResponse({ Notification: setThreadNickname(req.mixUserId, req.body.ChatThreadId, req.body.Nickname) })));
router.post('/chatThread/nickname/delete', authenticateMix, (req, res) => mixRoute(res, () =>
    buildResponse({ Notification: removeThreadNickname(req.mixUserId, req.body.ChatThreadId) })));

export default router;
