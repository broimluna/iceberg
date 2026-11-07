/**
 * Mix API Routes
 *
 * Disney Mix platform API, shared by Club Penguin Island (friends,
 * presence) and the Disney Mix app. See docs/MIX_API.md.
 *
 * Authentication: X-Mix-OneIdToken (Guest Controller access token) and
 * X-Mix-ClientToken. After PUT /session/user, bodies are AES-256-CBC
 * (application/mix) with the session's symmetric key.
 */
import express from "express";
import { mixEncryptionMiddleware } from "./auth.ts";
import users from "./users.ts";
import state from "./state.ts";
import notifications from "./notifications.ts";
import friends from "./friends.ts";
import session from "./session.ts";
import moderation from "./moderation.ts";
import push from "./push.ts";

const router = express.Router();
router.use(mixEncryptionMiddleware);
router.use(users, state, notifications, friends, session, moderation, push);

export default router;
