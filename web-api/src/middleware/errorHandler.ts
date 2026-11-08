/**
 * Error Handler Middleware
 *
 * Centralized error handling for all routes.
 */

import type { Request, Response, NextFunction } from "express";
import { logSafe, logUrl } from "../utils/logSafe.ts";

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
    console.error(`[ERROR] ${req.method} ${logUrl(req.url)}: ${logSafe(err.message)}`);
    console.error(err.stack);

    // Details stay in the log. Clients only see them with
    // ICEBERG_DEBUG_ERRORS=1 (local development).
    const debug = process.env.ICEBERG_DEBUG_ERRORS === '1';
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;

    res.status(status).json({
        error: {
            message: debug ? err.message : status < 500 ? 'Bad request' : 'Internal server error',
            ...(debug && { stack: err.stack })
        }
    });
}

/**
 * 404 Handler
 */
export function notFoundHandler(req: Request, res: Response) {
    console.log(`[404] Route not found: ${req.method} ${logUrl(req.url)}`);
    res.status(404).json({
        error: {
            message: 'Route not found'
        }
    });
}
