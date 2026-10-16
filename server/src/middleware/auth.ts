/**
 * Shared Authentication Middleware
 * JWT verification + device fingerprint binding
 */
import { Request, Response, NextFunction } from 'express';
import jwt, { Secret } from 'jsonwebtoken';
import crypto from 'crypto';
import {
    defaultPrincipalRepository,
    PrincipalRepository,
} from '../security/principal-repository';
import {
    StudentWorkspaceScope,
    isStaffIdentityLive,
    isUsersIdentityLive,
    selectActiveTenantScope,
    selectStudentWorkspaceScope,
} from '../security/identity-scope';

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
        identitySource?: 'users' | 'staff';
    };
    sessionId?: string;
    authResolved?: boolean;
}

const supportedRoles = new Set(['admin', 'instructor', 'teacher', 'staff', 'student', 'parent']);

/**
 * Verification options shared by every token check: only HMAC-SHA256 tokens
 * sealed with the server secret are accepted, so a token minted with any
 * other algorithm (including 'none') is rejected instead of trusted.
 */
const verifyOptions: jwt.VerifyOptions = { algorithms: ['HS256'] };

const readBearerToken = (req: Request): string | null => {
    const header = req.headers.authorization;
    if (!header) return null;
    const match = /^Bearer\s+([^\s]+)$/i.exec(header);
    if (!match) throw new Error('Malformed authorization header');
    return match[1];
};

const validateClaims = (decoded: any) => {
    if (!decoded || typeof decoded !== 'object' || typeof decoded.id !== 'string' || !decoded.id ||
        typeof decoded.role !== 'string' || !supportedRoles.has(decoded.role)) {
        throw new Error('Invalid token claims');
    }
    return decoded;
};

const isInstructorBillingPath = (req: Request, userId: string) => {
    const path = req.originalUrl.split('?')[0];
    return path.startsWith('/api/tenants/me') ||
        path === '/api/auth/me' ||
        path.startsWith('/api/support-tickets') ||
        path.startsWith('/api/notifications') ||
        (req.method === 'GET' && path.startsWith(`/api/instructor-wallet/${userId}`));
};

interface TokenClaims {
    id: string;
    role: string;
    email?: string | null;
    phone?: string | null;
    tv?: number | null;
    tenant_id?: string | null;
    student_enrollment_id?: string | null;
    instructor_id?: string | null;
    group_id?: string | null;
    grade_id?: string | null;
}

interface PrincipalFailure {
    status: number;
    body: { error: string; code?: string };
}

type PrincipalOutcome =
    | { ok: true; user: NonNullable<AuthRequest['user']> }
    | { ok: false; failure: PrincipalFailure };

const revoked = (error: string, code = 'SESSION_REVOKED'): PrincipalFailure => ({ status: 401, body: { error, code } });

/**
 * Authenticate the identity independently of any tenant/workspace selection
 * and derive every scope from server-side rows:
 * - users-table identities (every role, including admins) are live only while
 *   active, not under an active time-bound suspension, and their token
 *   version still matches, so revocation applies uniformly;
 * - staff-table identities have no token_version/suspension columns, so their
 *   row's is_active flag is the revocation signal (no schema invention);
 * - a missing, stale, or forged workspace selection yields no scope, and a
 *   selection that no longer resolves fails the request. Authentication never
 *   depends on having exactly one membership.
 *
 * No role bypasses per-request liveness; surface-level admin authorization
 * (platform permissions) layers on top of this authenticated principal.
 */
async function resolvePrincipal(claims: TokenClaims, req: Request, repository: PrincipalRepository): Promise<PrincipalOutcome> {
    let identitySource: 'users' | 'staff' = 'users';

    const identity = await repository.findUsersIdentity(claims.id);
    if (identity) {
        if (!isUsersIdentityLive(identity, Number(claims.tv || 0))) {
            return { ok: false, failure: revoked('Session revoked') };
        }
    } else if (claims.role === 'staff') {
        const staffIdentity = await repository.findStaffIdentity(claims.id);
        if (!isStaffIdentityLive(staffIdentity)) {
            return { ok: false, failure: revoked('Session revoked') };
        }
        identitySource = 'staff';
    } else {
        return { ok: false, failure: revoked('Session revoked') };
    }

    let billingOnly = false;
    if (claims.role === 'instructor') {
        const account = await repository.findInstructorAccount(claims.id);
        if (!account || account.tenant_status !== 'active') {
            return { ok: false, failure: { status: 403, body: { error: 'Instructor account is administratively suspended', code: 'TENANT_SUSPENDED' } } };
        }
        billingOnly = !Boolean(account.legacy_compat || account.allowed);
        if (billingOnly && !isInstructorBillingPath(req, claims.id)) {
            return { ok: false, failure: { status: 403, body: { error: 'Subscription grace period ended. Billing and support are still available.', code: 'BILLING_ONLY' } } };
        }
    }

    // Membership-derived scope is only ever populated from server-side rows;
    // JWT membership claims are selectors, never authority.
    let tenantId: string | undefined;
    let studentEnrollmentId: string | undefined;
    let instructorId: string | undefined;
    let groupId: string | undefined;
    let gradeId: string | undefined;

    if (claims.role === 'student') {
        const enrollments = await repository.findStudentEnrollments(claims.id);
        const scope: StudentWorkspaceScope | null = selectStudentWorkspaceScope(enrollments, claims);
        if (!scope && typeof claims.student_enrollment_id === 'string' && claims.student_enrollment_id) {
            // A previously issued selection stopped resolving: fail closed
            // instead of serving the request without the selected workspace.
            return { ok: false, failure: revoked('Selected workspace is no longer active', 'WORKSPACE_REVOKED') };
        }
        tenantId = scope?.tenantId;
        studentEnrollmentId = scope?.studentEnrollmentId;
        instructorId = scope?.instructorId ?? undefined;
        groupId = scope?.groupId ?? undefined;
        gradeId = scope?.gradeId ?? undefined;
    } else if (claims.role !== 'admin') {
        const memberships = await repository.findActiveTenantMemberships(claims.id);
        tenantId = selectActiveTenantScope(memberships, claims.tenant_id) ?? undefined;
    }
    // Roles without an active scope carry no membership-derived fields at all.

    return {
        ok: true,
        user: {
            id: claims.id,
            email: claims.email || null,
            phone: claims.phone || null,
            role: claims.role,
            billingOnly,
            tenantId,
            studentEnrollmentId,
            instructorId,
            groupId,
            gradeId,
            tokenVersion: Number(claims.tv || 0),
            identitySource,
        },
    };
}

/**
 * Build the strict authentication middleware over an injected repository.
 * Production uses the default SQL repository; hermetic tests inject isolated
 * fixtures through this boundary instead of bypassing production auth.
 */
export const createAuthenticateToken = (repository: PrincipalRepository = defaultPrincipalRepository) =>
    async (req: AuthRequest, res: Response, next: NextFunction) => {
        try {
            if (req.user && req.authResolved) return next();
            const token = readBearerToken(req);

            if (!token) {
                return res.status(401).json({ error: 'No token provided' });
            }

            const decoded = validateClaims(jwt.verify(token, getJwtSecret(), verifyOptions)) as TokenClaims;
            const outcome = await resolvePrincipal(decoded, req, repository);
            if (!outcome.ok) {
                return res.status(outcome.failure.status).json(outcome.failure.body);
            }
            req.user = outcome.user;
            req.authResolved = true;

            next();
        } catch (error: any) {
            if (error.name === 'TokenExpiredError') {
                return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
            }
            return res.status(401).json({ error: 'Invalid token' });
        }
    };

/**
 * Basic JWT authentication - verifies the token, the identity's liveness, and
 * attaches the principal with server-derived scopes. A principal with zero or
 * ambiguous memberships is authenticated but carries no tenant scope, so
 * protected routes deny data access instead of the request failing at
 * authentication.
 */
export const authenticateToken = createAuthenticateToken();

/**
 * Build the optional-authentication middleware over an injected repository
 * (same principal rules as createAuthenticateToken).
 */
export const createOptionalAuth = (repository: PrincipalRepository = defaultPrincipalRepository) =>
    async (req: AuthRequest, res: Response, next: NextFunction) => {
        if (req.authResolved) return next();
        try {
            const token = readBearerToken(req);

            if (token) {
                const decoded = validateClaims(jwt.verify(token, getJwtSecret(), verifyOptions)) as TokenClaims;
                const outcome = await resolvePrincipal(decoded, req, repository);
                if (!outcome.ok) {
                    return res.status(outcome.failure.status).json(outcome.failure.body);
                }
                req.user = outcome.user;
            }
            req.authResolved = true;
        } catch (error: any) {
            if (error.name === 'TokenExpiredError') {
                return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
            }
            return res.status(401).json({ error: 'Invalid token' });
        }
        next();
    };

/**
 * Optional JWT authentication - attaches req.user when a valid, live token is
 * present, otherwise lets the request through unauthenticated. Discovery,
 * join, and selection flows rely on this to recognize a member-independent
 * identity without granting data access.
 */
export const optionalAuth = createOptionalAuth();

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
        { expiresIn: '60s', algorithm: 'HS256' }
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
        const decoded = jwt.verify(token, getJwtSecret(), verifyOptions) as any;

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
