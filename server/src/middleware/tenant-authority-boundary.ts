import { NextFunction, Response } from 'express';
import { AuthRequest } from './auth';

const tenantSelectorKeys = new Set(['tenant_id', 'tenantId', 'tenant']);

/** Tenant identity is populated by auth middleware from active DB membership.
 * Reject client supplied selectors so legacy handlers cannot accidentally
 * treat request data as authority. */
export function enforceTenantAuthorityBoundary(req: AuthRequest, res: Response, next: NextFunction) {
    if (req.headers['x-tenant-id'] || req.headers['x-instructor-id']) {
        return res.status(400).json({ error: 'Tenant context is resolved from the authenticated membership' });
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
