"use strict";
/**
 * M8 Q4 — request/tenant correlation context.
 *
 * Every inbound request carries a correlation id that is (a) generated when the
 * caller supplies none, (b) accepted from the caller ONLY when it matches a
 * strict, injection-safe pattern, otherwise replaced by a fresh server id, and
 * (c) echoed back on the response so a client can correlate its call with the
 * server-side log/metric line.
 *
 * The tenant id is NEVER taken from the request. It is read from the verified
 * principal (`req.user.tenantId`), which the authentication middleware derives
 * from server-owned membership rows. A client-supplied tenant selector is not
 * even read here.
 *
 * The context is attached to the request and is safe to mount more than once:
 * a second run preserves an existing id (and its response header) instead of
 * regenerating it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.REQUEST_ID_PATTERN = exports.REQUEST_ID_MAX_LENGTH = exports.REQUEST_ID_HEADER = void 0;
exports.normalizeIncomingRequestId = normalizeIncomingRequestId;
exports.generateRequestId = generateRequestId;
exports.resolveVerifiedTenantId = resolveVerifiedTenantId;
exports.getRequestContext = getRequestContext;
exports.getRequestId = getRequestId;
exports.createRequestContextMiddleware = createRequestContextMiddleware;
const crypto_1 = require("crypto");
/** Response/request header used for the correlation id. */
exports.REQUEST_ID_HEADER = 'x-request-id';
/** Maximum accepted correlation id length (bytes/characters). */
exports.REQUEST_ID_MAX_LENGTH = 128;
/**
 * Strict, injection-safe correlation id: starts with an alphanumeric, then
 * 7..127 characters drawn from `[A-Za-z0-9._-]`. No spaces, control bytes,
 * quotes, commas or header-injection characters can ever round-trip.
 */
exports.REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
/** Returns the value as a safe correlation id, or null when it is not safe. */
function normalizeIncomingRequestId(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string')
        return null;
    const candidate = raw.trim();
    if (!candidate || candidate.length > exports.REQUEST_ID_MAX_LENGTH)
        return null;
    return exports.REQUEST_ID_PATTERN.test(candidate) ? candidate : null;
}
/** Generates a fresh correlation id. */
function generateRequestId() {
    return (0, crypto_1.randomUUID)();
}
/**
 * Reads the tenant id from the verified principal only. A request that is not
 * yet authenticated (or carries no scoped tenant) yields null; a client header
 * or body field is never consulted.
 */
function resolveVerifiedTenantId(req) {
    const tenantId = req.user?.tenantId;
    return typeof tenantId === 'string' && tenantId.length > 0 ? tenantId : null;
}
/**
 * Returns the request context. The tenant id is recomputed from the verified
 * principal on every call, so a value attached before authentication is
 * corrected once the principal is resolved.
 */
function getRequestContext(req) {
    const context = req.requestContext;
    return {
        requestId: context?.requestId ?? req.requestId ?? '',
        tenantId: resolveVerifiedTenantId(req) ?? context?.tenantId ?? null,
    };
}
/** Convenience: the correlation id, or an empty string when unmounted. */
function getRequestId(req) {
    return getRequestContext(req).requestId;
}
const headerValue = (req, headerName) => {
    const value = req.headers?.[headerName];
    return value;
};
/**
 * Build the request-context middleware. Idempotent: if a context already
 * exists it is preserved (only the response header is refreshed).
 */
function createRequestContextMiddleware(options = {}) {
    const headerName = (options.headerName ?? exports.REQUEST_ID_HEADER).toLowerCase();
    const generate = options.generate ?? generateRequestId;
    return (req, res, next) => {
        const existing = req.requestContext;
        let requestId = existing?.requestId ?? req.requestId ?? '';
        if (!requestId) {
            const incoming = normalizeIncomingRequestId(headerValue(req, headerName));
            requestId = incoming ?? generate();
        }
        const context = {
            requestId,
            tenantId: resolveVerifiedTenantId(req) ?? existing?.tenantId ?? null,
        };
        req.requestContext = context;
        req.requestId = requestId;
        req.tenantId = context.tenantId;
        res.setHeader('X-Request-Id', requestId);
        next();
    };
}
