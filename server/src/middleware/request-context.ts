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

import { randomUUID } from 'crypto';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import { AuthRequest } from './auth';

/** Response/request header used for the correlation id. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Maximum accepted correlation id length (bytes/characters). */
export const REQUEST_ID_MAX_LENGTH = 128;

/**
 * Strict, injection-safe correlation id: starts with an alphanumeric, then
 * 7..127 characters drawn from `[A-Za-z0-9._-]`. No spaces, control bytes,
 * quotes, commas or header-injection characters can ever round-trip.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

export interface RequestContext {
    /** Server-assigned (or safely accepted) correlation id; always present. */
    requestId: string;
    /** Tenant derived from the verified principal; null when none is scoped. */
    tenantId: string | null;
}

/** Request augmented with the correlation context. */
export interface ContextRequest extends Request {
    requestContext?: RequestContext;
    requestId?: string;
    tenantId?: string | null;
}

export interface RequestContextOptions {
    /** Override the header name (defaults to `x-request-id`). */
    headerName?: string;
    /** Injected id generator (defaults to `crypto.randomUUID`). */
    generate?: () => string;
}

/** Returns the value as a safe correlation id, or null when it is not safe. */
export function normalizeIncomingRequestId(value: unknown): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') return null;
    const candidate = raw.trim();
    if (!candidate || candidate.length > REQUEST_ID_MAX_LENGTH) return null;
    return REQUEST_ID_PATTERN.test(candidate) ? candidate : null;
}

/** Generates a fresh correlation id. */
export function generateRequestId(): string {
    return randomUUID();
}

/**
 * Reads the tenant id from the verified principal only. A request that is not
 * yet authenticated (or carries no scoped tenant) yields null; a client header
 * or body field is never consulted.
 */
export function resolveVerifiedTenantId(req: Request): string | null {
    const tenantId = (req as AuthRequest).user?.tenantId;
    return typeof tenantId === 'string' && tenantId.length > 0 ? tenantId : null;
}

/**
 * Returns the request context. The tenant id is recomputed from the verified
 * principal on every call, so a value attached before authentication is
 * corrected once the principal is resolved.
 */
export function getRequestContext(req: Request): RequestContext {
    const context = (req as ContextRequest).requestContext;
    return {
        requestId: context?.requestId ?? (req as ContextRequest).requestId ?? '',
        tenantId: resolveVerifiedTenantId(req) ?? context?.tenantId ?? null,
    };
}

/** Convenience: the correlation id, or an empty string when unmounted. */
export function getRequestId(req: Request): string {
    return getRequestContext(req).requestId;
}

const headerValue = (req: Request, headerName: string): unknown => {
    const value = req.headers?.[headerName];
    return value;
};

/**
 * Build the request-context middleware. Idempotent: if a context already
 * exists it is preserved (only the response header is refreshed).
 */
export function createRequestContextMiddleware(options: RequestContextOptions = {}): RequestHandler {
    const headerName = (options.headerName ?? REQUEST_ID_HEADER).toLowerCase();
    const generate = options.generate ?? generateRequestId;

    return (req: Request, res: Response, next: NextFunction): void => {
        const existing = (req as ContextRequest).requestContext;
        let requestId = existing?.requestId ?? (req as ContextRequest).requestId ?? '';
        if (!requestId) {
            const incoming = normalizeIncomingRequestId(headerValue(req, headerName));
            requestId = incoming ?? generate();
        }
        const context: RequestContext = {
            requestId,
            tenantId: resolveVerifiedTenantId(req) ?? existing?.tenantId ?? null,
        };
        (req as ContextRequest).requestContext = context;
        (req as ContextRequest).requestId = requestId;
        (req as ContextRequest).tenantId = context.tenantId;
        res.setHeader('X-Request-Id', requestId);
        next();
    };
}
