/**
 * Request Logger Middleware
 *
 * Logs incoming requests with method, URL, and optional body.
 */

import type { Request, Response, NextFunction } from "express";
import { logSafe } from "../utils/logSafe.ts";

export function requestLogger(req: Request, res: Response, next: NextFunction) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${logSafe(req.url)}`);
    next();
}
