/**
 * Shared Authentication Middleware
 * JWT verification + device fingerprint binding
 */
import { Request, Response, NextFunction } from 'express';
import jwt, { Secret } from 'jsonwebtoken';
import crypto from 'crypto';
import { queryOne, execute } from '../db';

export const getJwtSecret = (): Secret => {
    const secret = process.env.JWT_SECRET;

    if (!secret) {
        throw new Error('JWT_SECRET is required');
    }

    return secret;
};

export interface AuthRequest extends Request {
    user?: {
        id: string;
        email: string | null;
        phone: string | null;
        role: string;
        sessionId?: string;
        billingOnly?: boolean;
        tenantId?: string;
        studentEnrollmentId?: string;
        instructorId?: string;
        groupId?: string;
        gradeId?: string;
        tokenVersion?: number;
    };
    sessionId?: string;
}

const isInstructorBillingPath = (req: Request, userId: string) => {
    const path = req.originalUrl.split('?')[0];
    return path.startsWith('/api/tenants/me') ||
        path === '/api/auth/me' ||
        path.startsWith('/api/support-tickets') ||
        path.startsWith('/api/notifications') ||
        (req.method === 'GET' && path.startsWith(`/api/instructor-wallet/${userId}`));
};

async function instructorAccountAccess(userId: string) {
    return queryOne<{ tenant_status: string; legacy_compat: number; allowed: number }>(
        `SELECT t.status AS tenant_status, t.legacy_compat,
                EXISTS(
                  SELECT 1 FROM tenant_subscriptions s
                  WHERE s.tenant_id=t.id AND (
                    (s.status IN ('active','past_due') AND (
                      s.period_ends_at>UTC_TIMESTAMP() OR DATE_ADD(s.period_ends_at,INTERVAL 4 DAY)>UTC_TIMESTAMP()
                    )) OR
                    (s.status='grace_period' AND s.grace_until>UTC_TIMESTAMP())
                  )
                ) AS allowed
         FROM users u
         INNER JOIN tenants t ON t.owner_user_id=u.id
         INNER JOIN tenant_memberships m ON m.tenant_id=t.id AND m.user_id=u.id AND m.status='active'
         WHERE u.id=? AND u.is_active=1
         ORDER BY t.created_at DESC LIMIT 1`,
        [userId]
    );
}

/**
 * Basic JWT authentication - verifies token and attaches user
 */
export const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');

        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const decoded = jwt.verify(token, getJwtSecret()) as any;
        if (decoded.role === 'student') {
            const tokenState = await queryOne<any>('SELECT token_version,is_active FROM users WHERE id=? AND role=\'student\' LIMIT 1', [decoded.id]);
            if (!tokenState?.is_active || Number(decoded.tv || 0) !== Number(tokenState.token_version || 0)) {
                return res.status(401).json({ error: 'Session revoked', code: 'SESSION_REVOKED' });
            }
        }
        let billingOnly = false;
        if (decoded.role === 'instructor') {
            const account = await instructorAccountAccess(decoded.id);
            if (!account || account.tenant_status !== 'active') {
                return res.status(403).json({ error: 'Instructor account is administratively suspended', code: 'TENANT_SUSPENDED' });
            }
            billingOnly = !Boolean(account.legacy_compat || account.allowed);
            if (billingOnly) {
                if (!isInstructorBillingPath(req, decoded.id)) {
                    return res.status(403).json({
                        error: 'Subscription grace period ended. Billing and support are still available.',
                        code: 'BILLING_ONLY',
                    });
                }
            }
        }
        req.user = {
            id: decoded.id,
            email: decoded.email || null,
            phone: decoded.phone || null,
            role: decoded.role,
            billingOnly,
            tenantId: decoded.tenant_id,
            studentEnrollmentId: decoded.student_enrollment_id,
            instructorId: decoded.instructor_id,
            groupId: decoded.group_id,
            gradeId: decoded.grade_id,
            tokenVersion: Number(decoded.tv || 0),
        };

        next();
    } catch (error: any) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
        }
        return res.status(401).json({ error: 'Invalid token' });
    }
};

/**
 * Optional JWT authentication - attaches req.user when a valid token is
 * present, otherwise lets the request through unauthenticated.
 * Used to scope data per-role without breaking public/student endpoints.
 */
export const optionalAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');

        if (token) {
            const decoded = jwt.verify(token, getJwtSecret()) as any;
            if (decoded.role === 'student') {
                const tokenState = await queryOne<any>('SELECT token_version,is_active FROM users WHERE id=? AND role=\'student\' LIMIT 1', [decoded.id]);
                if (!tokenState?.is_active || Number(decoded.tv || 0) !== Number(tokenState.token_version || 0)) {
                    return res.status(401).json({ error: 'Session revoked', code: 'SESSION_REVOKED' });
                }
            }
            let billingOnly = false;
            if (decoded.role === 'instructor') {
                const account = await instructorAccountAccess(decoded.id);
                if (!account || account.tenant_status !== 'active') {
                    return res.status(403).json({ error: 'Instructor account is administratively suspended', code: 'TENANT_SUSPENDED' });
                }
                billingOnly = !Boolean(account.legacy_compat || account.allowed);
                if (billingOnly && !isInstructorBillingPath(req, decoded.id)) {
                    return res.status(403).json({ error: 'Subscription grace period ended. Billing and support are still available.', code: 'BILLING_ONLY' });
                }
            }
            req.user = {
                id: decoded.id,
                email: decoded.email || null,
                phone: decoded.phone || null,
                role: decoded.role,
                billingOnly,
                tenantId: decoded.tenant_id,
                studentEnrollmentId: decoded.student_enrollment_id,
                instructorId: decoded.instructor_id,
                groupId: decoded.group_id,
                gradeId: decoded.grade_id,
                tokenVersion: Number(decoded.tv || 0),
            };
        }
    } catch {
        // Invalid/expired token - treat as unauthenticated
    }
    next();
};

/**
 * Return the user id when the caller is an 'instructor' role, else null.
 * Instructors only see/manage data that belongs to them.
 */
export const instructorScopeId = (req: AuthRequest): string | null => {
    return req.user && req.user.role === 'instructor' ? req.user.id : null;
};

/**
 * Require one of the supplied roles after authenticateToken.
 * This is a compatibility boundary while endpoint permissions are migrated.
 */
export const requireRoles = (...roles: string[]) => {
    const allowedRoles = new Set(roles);

    return (req: AuthRequest, res: Response, next: NextFunction) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        if (!allowedRoles.has(req.user.role)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        next();
    };
};

/**
 * Allow a principal to access its own resource, or a trusted legacy role.
 * Resource ownership remains server-derived instead of accepting a body id.
 */
export const requireSelfOrRoles = (paramName: string, ...roles: string[]) => {
    const allowedRoles = new Set(roles);

    return (req: AuthRequest, res: Response, next: NextFunction) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const resourceOwnerId = req.params[paramName];
        if (String(req.user.id) === String(resourceOwnerId) || allowedRoles.has(req.user.role)) {
            next();
            return;
        }

        return res.status(403).json({ error: 'Forbidden' });
    };
};

/**
 * Generate a short-lived video session token (2 minutes)
 * Bound to: userId, IP, userAgent, screenRes, fingerprint
 */
export function generateVideoSessionToken(payload: {
    userId: string;
    videoId: string;
    sessionId: string;
    ip: string;
    userAgent: string;
    fingerprint: string;
    screenRes: string;
    previewOnly?: boolean;
}): string {
    return jwt.sign(
        {
            sub: payload.userId,
            vid: payload.videoId,
            sid: payload.sessionId,
            ip: hashValue(payload.ip),
            ua: hashValue(payload.userAgent),
            fp: payload.fingerprint,
            sr: payload.screenRes,
            type: 'video_session',
            po: Boolean(payload.previewOnly)
        },
        getJwtSecret(),
        { expiresIn: '60s' }
    );
}

/**
 * Verify video session token and check binding
 */
export function verifyVideoSessionToken(token: string, req: Request): {
    valid: boolean;
    reason?: string;
    decoded?: any;
} {
    try {
        const decoded = jwt.verify(token, getJwtSecret()) as any;

        if (decoded.type !== 'video_session') {
            return { valid: false, reason: 'Invalid token type' };
        }

        // Check IP binding
        const currentIp = getClientIp(req);
        if (decoded.ip !== hashValue(currentIp)) {
            return { valid: false, reason: 'IP mismatch', decoded };
        }

        // Check User-Agent binding
        const currentUA = req.headers['user-agent'] || '';
        if (decoded.ua !== hashValue(currentUA)) {
            return { valid: false, reason: 'User-Agent mismatch', decoded };
        }

        const fingerprint = String(req.headers['x-video-fingerprint'] || '');
        const screenResolution = String(req.headers['x-screen-resolution'] || '');
        if (fingerprint && decoded.fp !== fingerprint) {
            return { valid: false, reason: 'Device fingerprint mismatch', decoded };
        }
        if (screenResolution && decoded.sr !== screenResolution) {
            return { valid: false, reason: 'Screen binding mismatch', decoded };
        }

        return { valid: true, decoded };
    } catch (error: any) {
        if (error.name === 'TokenExpiredError') {
            return { valid: false, reason: 'Token expired' };
        }
        return { valid: false, reason: 'Invalid token' };
    }
}

export function getClientIp(req: Request): string {
    return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        req.ip || 'unknown';
}

export function hashValue(val: string): string {
    return crypto.createHash('sha256').update(val).digest('hex').substring(0, 16);
}
