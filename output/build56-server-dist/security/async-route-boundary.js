"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.asyncRouteBoundary = asyncRouteBoundary;
/**
 * Express 4 does not observe a handler's rejected promise. Forward synchronous
 * throws and asynchronous rejections to the application's existing error
 * middleware. This adapter grants no authority, emits no response and starts
 * no work at import time; callers must preserve their authentication guards.
 */
function asyncRouteBoundary(handler) {
    return (req, res, next) => {
        try {
            void Promise.resolve(handler(req, res, next)).catch(next);
        }
        catch (error) {
            next(error);
        }
    };
}
