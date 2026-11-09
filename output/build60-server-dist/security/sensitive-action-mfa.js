"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRequireSensitiveActionMfa = void 0;
const platform_mfa_1 = require("../services/platform-mfa");
const admin_permissions_1 = require("./admin-permissions");
const nonempty = (value) => typeof value === 'string' && value.length > 0 && value.trim() === value;
const epochOf = (value) => {
    if (typeof value !== 'number' && typeof value !== 'string')
        return null;
    if (typeof value === 'string' && !/^\d+$/.test(value))
        return null;
    const epoch = typeof value === 'string' ? Number(value) : value;
    return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null;
};
const createRequireSensitiveActionMfa = (deps, policy) => {
    if (!deps || !deps.permissions
        || typeof deps.permissions.isSuperAdmin !== 'function'
        || typeof deps.permissions.getAdminPermissions !== 'function'
        || !deps.store || typeof deps.store.findRow !== 'function'
        || typeof deps.sealKey !== 'function' || typeof deps.now !== 'function'
        || typeof deps.isIdentitySessionLive !== 'function') {
        throw new Error('Sensitive action MFA requires live authority, capability, enrollment and key dependencies');
    }
    const maxAgeSeconds = policy?.maxAgeSeconds ?? platform_mfa_1.DEFAULT_STEPUP_MAX_AGE_SECONDS;
    if (!policy || !nonempty(policy.permission)
        || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0
        || maxAgeSeconds > platform_mfa_1.DEFAULT_STEPUP_MAX_AGE_SECONDS) {
        throw new Error('Sensitive action MFA requires an explicit capability and a bounded positive verification window');
    }
    const hasCapability = (0, admin_permissions_1.createPlatformPermissionCheck)(policy.permission, deps.permissions);
    return async (request, res, next) => {
        const req = request;
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
            if (!Buffer.isBuffer(key) || key.length < platform_mfa_1.MIN_MFA_SECRET_KEY_BYTES
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
            const verified = (0, platform_mfa_1.verifyStepUpToken)(req.headers[platform_mfa_1.STEPUP_HEADER], {
                expectedUserId: userId,
                expectedSessionId: sessionId,
                expectedPurpose: platform_mfa_1.STEPUP_PURPOSE,
                currentEpoch: epoch,
                key,
                nowMs,
                maxAgeSeconds,
            });
            if (!verified.ok) {
                res.status(403).json({ error: 'Recent MFA verification is required', code: 'MFA_STEP_UP_REQUIRED' });
                return;
            }
        }
        catch {
            // No token, secret, request body or upstream exception is logged.
            res.status(503).json({ error: 'MFA verification is unavailable' });
            return;
        }
        next();
    };
};
exports.createRequireSensitiveActionMfa = createRequireSensitiveActionMfa;
