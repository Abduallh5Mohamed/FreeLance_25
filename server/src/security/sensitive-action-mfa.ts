/**
 * Mandatory platform step-up for an explicitly selected sensitive action.
 *
 * Mount after authentication on the individual action, never on the MFA
 * enrolment/verification/recovery namespace. This component does not choose
 * which business actions are sensitive and grants no resource/tenant access.
 * The handler still performs its own resource authorization and transactional
 * authority checks. Importing this module opens no connection.
 */
import type { RequestHandler } from 'express';
import type { AuthRequest } from '../middleware/auth';
import {
    DEFAULT_STEPUP_MAX_AGE_SECONDS,
    MIN_MFA_SECRET_KEY_BYTES,
    STEPUP_HEADER,
    STEPUP_PURPOSE,
    verifyStepUpToken,
    type PlatformMfaStore,
} from '../services/platform-mfa';
import {
    createPlatformPermissionCheck,
    type AdminPermissionLookup,
} from './admin-permissions';

export interface SensitiveActionMfaDeps {
    /** The existing server-owned capability resolver; JWT role is never used. */
    permissions: AdminPermissionLookup;
    store: Pick<PlatformMfaStore, 'findRow'>;
    sealKey: () => Buffer | null;
    now: () => number;
    /**
     * Must read current identity and session authority from the server. Return
     * false for a revoked session, inactive identity or a mismatched session
     * owner; throw when that authority cannot be established.
     * A constant true implementation does not satisfy the production contract.
     */
    isIdentitySessionLive: (userId: string, sessionId: string) => Promise<boolean>;
}

export interface SensitiveActionMfaPolicy {
    /** Exact existing platform capability required by the guarded action. */
    permission: string;
    /** May tighten the existing default window, never silently extend it. */
    maxAgeSeconds?: number;
}

const nonempty = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.trim() === value;

const epochOf = (value: unknown): number | null => {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
    const epoch = typeof value === 'string' ? Number(value) : value;
    return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null;
};

export const createRequireSensitiveActionMfa = (
    deps: SensitiveActionMfaDeps,
    policy: SensitiveActionMfaPolicy,
): RequestHandler => {
    if (!deps || !deps.permissions
        || typeof deps.permissions.isSuperAdmin !== 'function'
        || typeof deps.permissions.getAdminPermissions !== 'function'
        || !deps.store || typeof deps.store.findRow !== 'function'
        || typeof deps.sealKey !== 'function' || typeof deps.now !== 'function'
        || typeof deps.isIdentitySessionLive !== 'function') {
        throw new Error('Sensitive action MFA requires live authority, capability, enrollment and key dependencies');
    }
    const maxAgeSeconds = policy?.maxAgeSeconds ?? DEFAULT_STEPUP_MAX_AGE_SECONDS;
    if (!policy || !nonempty(policy.permission)
        || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0
        || maxAgeSeconds > DEFAULT_STEPUP_MAX_AGE_SECONDS) {
        throw new Error('Sensitive action MFA requires an explicit capability and a bounded positive verification window');
    }
    const hasCapability = createPlatformPermissionCheck(policy.permission, deps.permissions);

    return async (request, res, next): Promise<void> => {
        const req = request as AuthRequest;
        res.set('Cache-Control', 'no-store');
        const userId = req.user?.id;
        if (!nonempty(userId)) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }
        const userSessionId = req.user?.sessionId;
        const requestSessionId = req.sessionId;
        const sessionId = userSessionId ?? requestSessionId;
        if (!nonempty(sessionId)
            || (userSessionId !== undefined && requestSessionId !== undefined
                && userSessionId !== requestSessionId)) {
            res.status(403).json({ error: 'A verified session is required', code: 'MFA_SESSION_REQUIRED' });
            return;
        }
        try {
            if (await deps.isIdentitySessionLive(userId, sessionId) !== true) {
                res.status(401).json({ error: 'Authentication required' });
                return;
            }
            if (!await hasCapability(userId)) {
                res.status(403).json({ error: 'Forbidden' });
                return;
            }
            const key = deps.sealKey();
            const nowMs = deps.now();
            if (!Buffer.isBuffer(key) || key.length < MIN_MFA_SECRET_KEY_BYTES
                || !Number.isSafeInteger(nowMs) || nowMs < 0) {
                res.status(503).json({ error: 'MFA verification is unavailable' });
                return;
            }
            const enrollment = await deps.store.findRow(userId);
            if (enrollment === null || enrollment.status !== 'active') {
                res.status(403).json({ error: 'Active MFA enrollment is required', code: 'MFA_ENROLLMENT_REQUIRED' });
                return;
            }
            const epoch = epochOf(enrollment.stepup_epoch);
            if (enrollment.user_id !== userId || epoch === null) {
                res.status(503).json({ error: 'MFA verification is unavailable' });
                return;
            }
            const verified = verifyStepUpToken(req.headers[STEPUP_HEADER], {
                expectedUserId: userId,
                expectedSessionId: sessionId,
                expectedPurpose: STEPUP_PURPOSE,
                currentEpoch: epoch,
                key,
                nowMs,
                maxAgeSeconds,
            });
            if (!verified.ok) {
                res.status(403).json({ error: 'Recent MFA verification is required', code: 'MFA_STEP_UP_REQUIRED' });
                return;
            }
        } catch {
            // No token, secret, request body or upstream exception is logged.
            res.status(503).json({ error: 'MFA verification is unavailable' });
            return;
        }
        next();
    };
};
