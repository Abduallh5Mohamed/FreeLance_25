import { NextFunction, Response } from 'express';
import { AuthRequest } from './auth';

const tenantSelectorKeys = new Set(['tenant_id', 'tenantId', 'tenant']);

/**
 * Provider callbacks are unauthenticated but signature-gated: they carry the
 * tenant in their signed payload. These two paths are the ONLY places a
 * body/query tenant selector is tolerated, because the signature is the trust
 * anchor and the handler verifies it before any state change. Every other path
 * (and the header rule everywhere) stays strict.
 */
const CALLBACK_PATH_RE = /(?:^|\/)video-assets\/callbacks\/[^/]+$/;
const USAGE_PROVIDER_PATH_RE = /(?:^|\/)video-assets\/usage\/provider$/;

function isSignatureVerifiedCallback(path: string): boolean {
    const clean = path.split('?')[0].replace(/\/+$/, '');
    return CALLBACK_PATH_RE.test(clean) || USAGE_PROVIDER_PATH_RE.test(clean);
}

function requestPath(req: AuthRequest): string {
    if (typeof req.originalUrl === 'string' && req.originalUrl.length > 0) return req.originalUrl;
    if (typeof req.path === 'string' && req.path.length > 0) return req.path;
    return '';
}

/** Tenant identity is populated by auth middleware from active DB membership.
 * Reject client supplied selectors so legacy handlers cannot accidentally
 * treat request data as authority. */
export function enforceTenantAuthorityBoundary(req: AuthRequest, res: Response, next: NextFunction) {
    if (req.headers['x-tenant-id'] || req.headers['x-instructor-id']) {
        return res.status(400).json({ error: 'Tenant context is resolved from the authenticated membership' });
    }

    // Only the signature-verified callback paths may carry a tenant selector in
    // the body/query; the tenant is then taken from the verified payload.
    if (isSignatureVerifiedCallback(requestPath(req))) {
        return next();
    }

    const hasSelector = (value: unknown): boolean => {
        if (!value || typeof value !== 'object') return false;
        if (Array.isArray(value)) return value.some(hasSelector);
        return Object.entries(value as Record<string, unknown>)
            .some(([key, nested]) => tenantSelectorKeys.has(key) || hasSelector(nested));
    };

    if (hasSelector(req.body) || hasSelector(req.query)) {
        return res.status(400).json({ error: 'Tenant context must not be supplied by the client' });
    }

    next();
}
