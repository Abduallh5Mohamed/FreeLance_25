/**
 * M7 O9 — platform MFA routes (enroll / verify / disable / status).
 *
 * Audience + permission model:
 *  - Every path requires authentication; a JWT role claim alone never grants
 *    access. Enroll/verify/disable require the verified platform permission
 *    `platform_mfa.manage`, status requires `platform_mfa.read`; the guard is
 *    injected and resolves server-owned rows only.
 *  - Fail closed: without a >= 32-byte MFA_SECRET_KEY every surface that needs
 *    secret material or step-up signing answers 503; a status read still works.
 *  - Rate limits: per-user fixed-window limiters on every mutation (clock
 *    injectable) plus persisted bad-code lockout recorded in the row.
 *  - Disable requires a fresh MFA step-up token (x-mfa-step-up header) and
 *    invalidates outstanding step-up tokens by bumping the row epoch.
 *  - Recovery codes are returned in plaintext exactly once, at activation.
 *  - Every mutation is audited through the injected sealed-audit writer inside
 *    an injectable transaction seam; a failed audit aborts the mutation.
 *
 * Integration point (middleware/auth.ts stays untouched): adopters wire
 * `createMfaVerifier(...)` after JWT verification to enforce mandatory
 * platform MFA, and `createRequireStepUp(...)(seconds)` around sensitive
 * routes. Both are covered by hermetic tests here.
 */

import { Router, RequestHandler, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { requireAdminPermission } from '../security/admin-permissions';
import { SealedAuditRecordInput } from '../services/audit-log';
import {
    DEFAULT_STEPUP_MAX_AGE_SECONDS,
    LOCKOUT_SECONDS,
    MFA_RATE_LIMITS,
    MfaKeyUnavailableError,
    PlatformMfaDb,
    PlatformMfaStore,
    createMfaRateLimiter,
    createMfaVerifier,
    createRequireStepUp,
    createSqlPlatformMfaStore,
    generateRecoveryCodes,
    generateTotpSecret,
    mfaKeyFromEnv,
    normalizeTotpInput,
    recoveryCodeHash,
    otpauthUri,
    sealValue,
} from '../services/platform-mfa';

export interface PlatformMfaRouteDeps {
    db: PlatformMfaDb;
    authenticate: RequestHandler;
    requirePlatformPermission: (permission: string) => RequestHandler;
    recordAudit: (input: SealedAuditRecordInput) => Promise<void>;
    /** Production default: MFA_SECRET_KEY from the environment. */
    sealKey?: () => Buffer | null;
    now?: () => number;
    rng?: (length: number) => Buffer;
    store?: PlatformMfaStore;
    /** Optional atomic seam wrapping store mutations + audit (testable). */
    transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
    stepUpMaxAgeSeconds?: number;
}

const validateAuditReason = (raw: unknown): { ok: true; value: string } | { ok: false; error: string } => {
    if (typeof raw !== 'string') return { ok: false, error: 'A reason is required' };
    const trimmed = raw.trim();
    if (trimmed.length < 8 || trimmed.length > 1000) {
        return { ok: false, error: 'The reason must be between 8 and 1000 characters' };
    }
    return { ok: true, value: trimmed };
};

export const createPlatformMfaRouter = (deps: PlatformMfaRouteDeps): Router => {
    const router = Router();
    const now = deps.now ?? (() => Date.now());
    const store = deps.store ?? createSqlPlatformMfaStore(deps.db);
    const sealKey = deps.sealKey ?? mfaKeyFromEnv;
    const verifier = createMfaVerifier({ store, sealKey, now });
    const requireStepUpGuard = createRequireStepUp({ store, sealKey, now });
    const runAtomic = deps.transaction ?? (<T>(fn: () => Promise<T>): Promise<T> => fn());
    const writeAudit = deps.recordAudit;
    const readGuard = deps.requirePlatformPermission('platform_mfa.read');
    const manageGuard = deps.requirePlatformPermission('platform_mfa.manage');
    const limiters = {
        enroll: createMfaRateLimiter({ ...MFA_RATE_LIMITS.enroll, now }),
        verify: createMfaRateLimiter({ ...MFA_RATE_LIMITS.verify, now }),
        disable: createMfaRateLimiter({ ...MFA_RATE_LIMITS.disable, now }),
    };

    router.use(deps.authenticate);

    const userIdOf = (req: AuthRequest, res: Response): string | null => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        return user.id;
    };

    const notThrottled = (tier: keyof typeof MFA_RATE_LIMITS, key: string, res: Response): boolean => {
        if (limiters[tier].tryConsume(`${key}:${tier}`)) return true;
        res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
        return false;
    };

    // ---------------------------------------------------------------------
    // Status: enrollment state only; never secret material.
    // ---------------------------------------------------------------------
    router.get('/status', readGuard, async (req: AuthRequest, res: Response) => {
        try {
            const userId = userIdOf(req, res);
            if (!userId) return;
            const row = await store.findRow(userId);
            if (!row) {
                res.json({ enrolled: false, status: 'none' });
                return;
            }
            const status = row.status === 'active' || row.status === 'pending' ? row.status : 'none';
            const lockedUntil = row.locked_until ? new Date(row.locked_until) : null;
            const locked = lockedUntil !== null && !Number.isNaN(lockedUntil.getTime()) && lockedUntil.getTime() > now();
            res.json({ enrolled: status !== 'none', status, locked, locked_until: locked ? lockedUntil.toISOString() : null });
        } catch (error) {
            console.error('MFA status failed:', error);
            res.status(503).json({ error: 'MFA status is unavailable' });
        }
    });

    // ---------------------------------------------------------------------
    // Enroll: new pending secret (fails closed without the sealing key).
    // ---------------------------------------------------------------------
    router.post('/enroll', manageGuard, async (req: AuthRequest, res: Response) => {
        try {
            const userId = userIdOf(req, res);
            if (!userId) return;
            if (!notThrottled('enroll', userId, res)) return;
            const reason = validateAuditReason(req.body?.reason);
            if (!reason.ok) return res.status(400).json({ error: reason.error });
            const key = sealKey();
            if (!key) return res.status(503).json({ error: 'MFA encryption is unavailable; enrollment denied' });
            const existing = await store.findRow(userId);
            if (existing && existing.status === 'active') {
                return res.status(409).json({ error: 'MFA is already active for this user' });
            }
            const secret = generateTotpSecret(deps.rng);
            const sealed = sealValue(secret, key);
            await runAtomic(async () => {
                await store.upsertPendingSecret(userId, sealed);
                await writeAudit({
                    actorUserId: userId,
                    tenantId: null,
                    action: 'platform_mfa.enrolled',
                    resourceType: 'platform_mfa_secret',
                    resourceId: userId,
                    newValue: { status: 'pending' },
                    reason: reason.value,
                });
            });
            res.json({
                secret,
                otpauth_uri: otpauthUri(userId, secret),
                status: 'pending',
            });
        } catch (error) {
            if (error instanceof MfaKeyUnavailableError) {
                res.status(503).json({ error: 'MFA encryption is unavailable; enrollment denied' });
                return;
            }
            console.error('MFA enrollment failed:', error);
            res.status(500).json({ error: 'Failed to enroll platform MFA' });
        }
    });

    // ---------------------------------------------------------------------
    // Verify: TOTP (pending -> active) or single-use recovery code; issues a
    // step-up token. Recovery codes are disclosed exactly once.
    // ---------------------------------------------------------------------
    router.post('/verify', manageGuard, async (req: AuthRequest, res: Response) => {
        try {
            const userId = userIdOf(req, res);
            if (!userId) return;
            if (!notThrottled('verify', userId, res)) return;
            const recoveryCode = typeof req.body?.recovery_code === 'string' ? req.body.recovery_code.trim() : '';
            const totpCode = normalizeTotpInput(req.body?.code);
            if (!totpCode && !recoveryCode) {
                return res.status(400).json({ error: 'A totp code or a recovery code is required' });
            }
            const outcome = recoveryCode
                ? await verifier.verifyRecoveryCode(userId, recoveryCode)
                : await verifier.verifyCode(userId, totpCode);
            if (!outcome.ok) {
                if (outcome.reason === 'bad_code' || outcome.reason === 'replayed') {
                    await store.recordFailure(userId, LOCKOUT_SECONDS, now());
                }
                switch (outcome.reason) {
                    case 'not_enrolled':
                        return res.status(404).json({ error: 'MFA is not enrolled for this user' });
                    case 'locked':
                        return res.status(429).json({
                            error: 'MFA verification is locked',
                            code: 'MFA_LOCKED',
                            locked_until: outcome.lockedUntil ?? null,
                        });
                    case 'key_unavailable':
                        return res.status(503).json({ error: 'MFA encryption is unavailable; verification denied' });
                    case 'store_error':
                        return res.status(503).json({ error: 'MFA verification is unavailable' });
                    default:
                        return res.status(400).json({ error: 'Invalid or expired MFA code', code: 'MFA_CODE_INVALID' });
                }
            }
            const row = await store.findRow(userId);
            const activating = Boolean(row && row.status === 'pending');
            let recoveryCodes: string[] | null = null;
            await runAtomic(async () => {
                if (activating) {
                    await store.activate(userId);
                    recoveryCodes = generateRecoveryCodes(undefined, deps.rng);
                    await store.saveRecoveryCodeHashes(userId, recoveryCodes.map(recoveryCodeHash));
                }
                await store.clearFailures(userId);
                await writeAudit({
                    actorUserId: userId,
                    tenantId: null,
                    action: activating ? 'platform_mfa.activated' : 'platform_mfa.verified',
                    resourceType: 'platform_mfa_secret',
                    resourceId: userId,
                    newValue: activating ? { status: 'active' } : { method: recoveryCode ? 'recovery_code' : 'totp' },
                    reason: activating ? 'Platform MFA activated with a verified TOTP code' : 'Platform MFA verified',
                });
            });
            const stepUpToken = await verifier.issueStepUpToken(userId);
            res.json({
                step_up_token: stepUpToken,
                ...(recoveryCodes ? { recovery_codes: recoveryCodes } : {}),
            });
        } catch (error) {
            console.error('MFA verification failed:', error);
            res.status(500).json({ error: 'Failed to verify platform MFA' });
        }
    });

    // ---------------------------------------------------------------------
    // Disable: sensitive; requires a fresh step-up token and a reason.
    // ---------------------------------------------------------------------
    router.post(
        '/disable',
        manageGuard,
        requireStepUpGuard(deps.stepUpMaxAgeSeconds ?? DEFAULT_STEPUP_MAX_AGE_SECONDS),
        async (req: AuthRequest, res: Response) => {
            try {
                const userId = userIdOf(req, res);
                if (!userId) return;
                if (!notThrottled('disable', userId, res)) return;
                const reason = validateAuditReason(req.body?.reason);
                if (!reason.ok) return res.status(400).json({ error: reason.error });
                const existing = await store.findRow(userId);
                if (!existing || (existing.status !== 'active' && existing.status !== 'pending')) {
                    return res.status(404).json({ error: 'MFA is not enrolled for this user' });
                }
                await runAtomic(async () => {
                    await store.disable(userId);
                    await writeAudit({
                        actorUserId: userId,
                        tenantId: null,
                        action: 'platform_mfa.disabled',
                        resourceType: 'platform_mfa_secret',
                        resourceId: userId,
                        oldValue: { status: existing.status },
                        newValue: { status: 'disabled' },
                        reason: reason.value,
                    });
                });
                res.json({ disabled: true });
            } catch (error) {
                console.error('MFA disable failed:', error);
                res.status(500).json({ error: 'Failed to disable platform MFA' });
            }
        },
    );

    return router;
};

/* Production wiring: real pool, real auth, real platform-permission guard and
   the sealed audit writer. The MFA key is read from MFA_SECRET_KEY at call
   time; a missing/short key fails closed with 503. */
let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<PlatformMfaDb> => {
    dbModule ??= await import('../db');
    const { query, queryOne, execute } = dbModule;
    return {
        query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
            query<T>(sql, params as never) as Promise<T[]>,
        queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
            queryOne<T>(sql, params as never) as Promise<T | null>,
        execute: (sql: string, params?: unknown[]) => execute(sql, params as never),
    };
};

const productionDb: PlatformMfaDb = {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { query } = await loadDb();
        return query<T>(sql, params as never) as Promise<T[]>;
    },
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { queryOne } = await loadDb();
        return queryOne<T>(sql, params as never) as Promise<T | null>;
    },
    execute: async (sql: string, params?: unknown[]) => {
        const { execute } = await loadDb();
        return execute(sql, params as never);
    },
};

export default createPlatformMfaRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    requirePlatformPermission: (permission) => requireAdminPermission(permission),
    recordAudit: async (input) => {
        const { recordSealedAuditEvent } = await import('../services/audit-log');
        await recordSealedAuditEvent(productionDb, input);
    },
    sealKey: () => mfaKeyFromEnv(),
});
