/**
 * Mix chat routes (services/mixChat.ts, docs/MIX_API.md section 7).
 */
import express from "express";
import { authenticateMix } from "./auth.ts";
import { buildResponse } from "./common.ts";
import { createThread } from "../../services/mixChat.ts";
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

export default router;
