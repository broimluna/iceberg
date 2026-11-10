/**
 * Middleware Index
 *
 * Re-exports all middleware for easy importing.
 */

import { requestLogger as logger } from "./logger.ts";
import { errorHandler, notFoundHandler } from "./errorHandler.ts";
import { authenticate, requireAuth, requireGameLogin, parseBasicAuth, isGameApiPath } from "./auth.ts";

export {
    logger,
    errorHandler,
    notFoundHandler,
    authenticate,
    requireAuth,
    requireGameLogin,
    isGameApiPath,
    parseBasicAuth
};
