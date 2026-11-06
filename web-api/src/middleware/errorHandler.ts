/**
 * Error Handler Middleware
 *
 * Centralized error handling for all routes.
 */

import type { Request, Response, NextFunction } from "express";

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
    console.error(`[ERROR] ${req.method} ${req.url}:`, err.message);
    console.error(err.stack);

    // Don't leak error details in production
    const isDev = process.env.NODE_ENV !== 'production';

    res.status(err.status || 500).json({
        error: {
            message: isDev ? err.message : 'Internal server error',
            ...(isDev && { stack: err.stack })
        }
    });
}

/**
 * 404 Handler
 */
export function notFoundHandler(req: Request, res: Response) {
    console.log(`[404] Route not found: ${req.method} ${req.url}`);
    res.status(404).json({
        error: {
            message: `Route not found: ${req.method} ${req.url}`
        }
    });
}
