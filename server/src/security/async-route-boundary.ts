import type { RequestHandler } from 'express';

/**
 * Express 4 does not observe a handler's rejected promise. Forward synchronous
 * throws and asynchronous rejections to the application's existing error
 * middleware. This adapter grants no authority, emits no response and starts
 * no work at import time; callers must preserve their authentication guards.
 */
export function asyncRouteBoundary(handler: RequestHandler): RequestHandler {
    return (req, res, next): void => {
        try {
            void Promise.resolve(handler(req, res, next)).catch(next);
        } catch (error: unknown) {
            next(error);
        }
    };
}
