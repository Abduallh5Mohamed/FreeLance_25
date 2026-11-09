"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPlatformMfaRouter = void 0;
const async_route_boundary_1 = require("../security/async-route-boundary");
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
 *    Re-enrolling (a new pending secret) and disabling delete every stored
 *    recovery code for the user, so previously issued codes can never remain
 *    a valid second factor across disable -> re-enroll -> re-activate.
 *  - Every mutation is audited through the injected sealed-audit writer inside
 *    an injectable transaction seam; a failed audit aborts the mutation.
 *
 * Integration point (middleware/auth.ts stays untouched): adopters wire
 * `createMfaVerifier(...)` after JWT verification to enforce mandatory
 * platform MFA, and `createRequireStepUp(...)(seconds)` around sensitive
 * routes. Both are covered by hermetic tests here.
 */
const express_1 = require("express");
const admin_permissions_1 = require("../security/admin-permissions");
const platform_mfa_1 = require("../services/platform-mfa");
const validateAuditReason = (raw) => {
    if (typeof raw !== 'string')
        return { ok: false, error: 'A reason is required' };
    const trimmed = raw.trim();
    if (trimmed.length < 8 || trimmed.length > 1000) {
        return { ok: false, error: 'The reason must be between 8 and 1000 characters' };
    }
    return { ok: true, value: trimmed };
};
/** Audit access over one connection; never carries a nested transaction. */
const auditAccessOf = (db) => ({
    query: (sql, params) => db.query(sql, params),
    queryOne: (sql, params) => db.queryOne(sql, params),
    execute: (sql, params) => db.execute(sql, params),
});
const createPlatformMfaRouter = (deps) => {
    const router = (0, express_1.Router)();
    const now = deps.now ?? (() => Date.now());
    const store = deps.store ?? (0, platform_mfa_1.createSqlPlatformMfaStore)(deps.db);
    const sealKey = deps.sealKey ?? platform_mfa_1.mfaKeyFromEnv;
    const verifier = (0, platform_mfa_1.createMfaVerifier)({ store, sealKey, now });
    const requireStepUpGuard = (0, platform_mfa_1.createRequireStepUp)({ store, sealKey, now });
    const writeAudit = deps.recordAudit;
    const readGuard = deps.requirePlatformPermission('platform_mfa.read');
    const manageGuard = deps.requirePlatformPermission('platform_mfa.manage');
    const limiters = {
        enroll: (0, platform_mfa_1.createMfaRateLimiter)({ ...platform_mfa_1.MFA_RATE_LIMITS.enroll, now }),
        verify: (0, platform_mfa_1.createMfaRateLimiter)({ ...platform_mfa_1.MFA_RATE_LIMITS.verify, now }),
        disable: (0, platform_mfa_1.createMfaRateLimiter)({ ...platform_mfa_1.MFA_RATE_LIMITS.disable, now }),
    };
    /**
     * Runs a mutation and its audit entry atomically. An explicit seam wins;
     * otherwise a router that owns the SQL store uses `db.transaction` so the
     * production path is transactional by default. An injected store must
     * provide an explicit atomic seam; never downgrade mutations to autocommit.
     */
    const runAtomic = (fn) => {
        if (deps.transaction)
            return deps.transaction(fn);
        const dbTransaction = deps.db.transaction;
        if (!deps.store && dbTransaction) {
            return deps.db.transaction((txDb) => fn({
                store: (0, platform_mfa_1.createSqlPlatformMfaStore)(txDb),
                recordAudit: (input) => writeAudit(input, txDb),
            }));
        }
        return Promise.reject(new Error('MFA transaction capability unavailable'));
    };
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache'); next(); });
    router.use((0, async_route_boundary_1.asyncRouteBoundary)(deps.authenticate));
    const userIdOf = (req, res) => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        return user.id;
    };
    const notThrottled = (tier, key, res) => {
        if (limiters[tier].tryConsume(`${key}:${tier}`))
            return true;
        res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
        return false;
    };
    // ---------------------------------------------------------------------
    // Status: enrollment state only; never secret material.
    // ---------------------------------------------------------------------
    router.get('/status', readGuard, async (req, res) => {
        try {
            const userId = userIdOf(req, res);
            if (!userId)
                return;
            const row = await store.findRow(userId);
            if (!row) {
                res.json({ enrolled: false, status: 'none', session_bound: Boolean(req.user?.sessionId) });
                return;
            }
            const status = row.status === 'active' || row.status === 'pending' ? row.status : 'none';
            const lockedUntil = row.locked_until ? new Date(row.locked_until) : null;
            const locked = lockedUntil !== null && !Number.isNaN(lockedUntil.getTime()) && lockedUntil.getTime() > now();
            res.json({ enrolled: status !== 'none', status, session_bound: Boolean(req.user?.sessionId), locked, locked_until: locked ? lockedUntil.toISOString() : null });
        }
        catch (error) {
            console.error('MFA status failed:');
            res.status(503).json({ error: 'MFA status is unavailable' });
        }
    });
    // ---------------------------------------------------------------------
    // Enroll: new pending secret (fails closed without the sealing key).
    // ---------------------------------------------------------------------
    router.post('/enroll', manageGuard, async (req, res) => {
        try {
            const userId = userIdOf(req, res);
            if (!userId)
                return;
            if (!notThrottled('enroll', userId, res))
                return;
            const reason = validateAuditReason(req.body?.reason);
            if (!reason.ok)
                return res.status(400).json({ error: reason.error });
            const key = sealKey();
            if (!key)
                return res.status(503).json({ error: 'MFA encryption is unavailable; enrollment denied' });
            const existing = await store.findRow(userId);
            if (existing && existing.status === 'active') {
                return res.status(409).json({ error: 'MFA is already active for this user' });
            }
            const secret = (0, platform_mfa_1.generateTotpSecret)(deps.rng);
            const sealed = (0, platform_mfa_1.sealValue)(secret, key);
            const applied = await runAtomic(async (tx) => {
                // Conditional on the row still not being active (row-locked in
                // the SQL store), so a concurrent activation cannot be rotated.
                const written = await tx.store.upsertPendingSecret(userId, sealed);
                if (written === 0)
                    return false;
                await tx.recordAudit({
                    actorUserId: userId,
                    tenantId: null,
                    action: 'platform_mfa.enrolled',
                    resourceType: 'platform_mfa_secret',
                    resourceId: userId,
                    newValue: { status: 'pending' },
                    reason: reason.value,
                });
                return true;
            });
            if (!applied)
                return res.status(409).json({ error: 'MFA is already active for this user' });
            res.json({
                secret,
                otpauth_uri: (0, platform_mfa_1.otpauthUri)(userId, secret),
                status: 'pending',
            });
        }
        catch (error) {
            if (error instanceof platform_mfa_1.MfaKeyUnavailableError) {
                res.status(503).json({ error: 'MFA encryption is unavailable; enrollment denied' });
                return;
            }
            console.error('MFA enrollment failed:');
            res.status(500).json({ error: 'Failed to enroll platform MFA' });
        }
    });
    // ---------------------------------------------------------------------
    // Verify: TOTP (pending -> active) or single-use recovery code; issues a
    // step-up token. Recovery codes are disclosed exactly once.
    // ---------------------------------------------------------------------
    router.post('/verify', manageGuard, async (req, res) => {
        try {
            const userId = userIdOf(req, res);
            if (!userId)
                return;
            // Do not consume an OTP/recovery code only to mint an unbound
            // step-up token. Authentication has already checked this session.
            if (!req.user?.sessionId) {
                res.set('Cache-Control', 'no-store');
                return res.status(403).json({ error: 'Sign in with a session-bound login', code: 'MFA_SESSION_REQUIRED' });
            }
            if (!notThrottled('verify', userId, res))
                return;
            const recoveryCode = typeof req.body?.recovery_code === 'string' ? req.body.recovery_code.trim() : '';
            const totpCode = (0, platform_mfa_1.normalizeTotpInput)(req.body?.code);
            if (!totpCode && !recoveryCode) {
                return res.status(400).json({ error: 'A totp code or a recovery code is required' });
            }
            // Verification, step/recovery-code consumption, activation, the
            // failure counter and the audit entry form one unit: a failed
            // audit rolls the consumption back instead of burning the code.
            const outcome = await runAtomic(async (tx) => {
                const txVerifier = (0, platform_mfa_1.createMfaVerifier)({ store: tx.store, sealKey, now });
                const verdict = recoveryCode
                    ? await txVerifier.verifyRecoveryCode(userId, recoveryCode)
                    : await txVerifier.verifyCode(userId, totpCode);
                if (!verdict.ok) {
                    if (verdict.reason === 'bad_code' || verdict.reason === 'replayed' || verdict.reason === 'stale_enrollment') {
                        await tx.store.recordFailure(userId, platform_mfa_1.LOCKOUT_SECONDS, now());
                    }
                    return { verdict, recoveryCodes: null, activated: false };
                }
                const row = await tx.store.findRow(userId);
                let recoveryCodes = null;
                let activated = false;
                if (row && row.status === 'pending') {
                    // Only the request that wins pending -> active may issue the
                    // recovery-code batch; a concurrent verify of another valid
                    // step still succeeds but never discloses a second batch.
                    const won = await tx.store.activate(userId, verdict.epoch);
                    if (won > 0) {
                        activated = true;
                        recoveryCodes = (0, platform_mfa_1.generateRecoveryCodes)(undefined, deps.rng);
                        await tx.store.saveRecoveryCodeHashes(userId, recoveryCodes.map(platform_mfa_1.recoveryCodeHash));
                    }
                }
                await tx.store.clearFailures(userId);
                await tx.recordAudit({
                    actorUserId: userId,
                    tenantId: null,
                    action: activated ? 'platform_mfa.activated' : 'platform_mfa.verified',
                    resourceType: 'platform_mfa_secret',
                    resourceId: userId,
                    newValue: activated ? { status: 'active' } : { method: recoveryCode ? 'recovery_code' : 'totp' },
                    reason: activated ? 'Platform MFA activated with a verified TOTP code' : 'Platform MFA verified',
                });
                return { verdict, recoveryCodes, activated };
            });
            if (!outcome.verdict.ok) {
                switch (outcome.verdict.reason) {
                    case 'not_enrolled':
                        return res.status(404).json({ error: 'MFA is not enrolled for this user' });
                    case 'locked':
                        return res.status(429).json({
                            error: 'MFA verification is locked',
                            code: 'MFA_LOCKED',
                            locked_until: outcome.verdict.lockedUntil ?? null,
                        });
                    case 'key_unavailable':
                        return res.status(503).json({ error: 'MFA encryption is unavailable; verification denied' });
                    case 'store_error':
                        return res.status(503).json({ error: 'MFA verification is unavailable' });
                    default:
                        return res.status(400).json({ error: 'Invalid or expired MFA code', code: 'MFA_CODE_INVALID' });
                }
            }
            const stepUpToken = await verifier.issueStepUpToken(userId, outcome.verdict.epoch, req.user?.sessionId);
            res.json({
                step_up_token: stepUpToken,
                step_up_expires_at_ms: (Number(stepUpToken.split('.')[3]) + platform_mfa_1.DEFAULT_STEPUP_MAX_AGE_SECONDS) * 1000,
                ...(outcome.recoveryCodes ? { recovery_codes: outcome.recoveryCodes } : {}),
            });
        }
        catch (error) {
            if (error instanceof platform_mfa_1.MfaKeyUnavailableError) {
                res.status(503).json({ error: 'MFA encryption is unavailable; verification denied' });
                return;
            }
            console.error('MFA verification failed:');
            res.status(500).json({ error: 'Failed to verify platform MFA' });
        }
    });
    // ---------------------------------------------------------------------
    // Disable: sensitive; requires a fresh step-up token and a reason.
    // ---------------------------------------------------------------------
    router.post('/disable', manageGuard, (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (!req.user?.sessionId) {
            res.status(403).json({ error: 'Sign in with a session-bound login', code: 'MFA_SESSION_REQUIRED' });
            return;
        }
        next();
    }, requireStepUpGuard(deps.stepUpMaxAgeSeconds ?? platform_mfa_1.DEFAULT_STEPUP_MAX_AGE_SECONDS), async (req, res) => {
        try {
            const userId = userIdOf(req, res);
            if (!userId)
                return;
            if (!notThrottled('disable', userId, res))
                return;
            const reason = validateAuditReason(req.body?.reason);
            if (!reason.ok)
                return res.status(400).json({ error: reason.error });
            const disabled = await runAtomic(async (tx) => {
                const existing = await tx.store.findRow(userId);
                if (!existing || existing.user_id !== userId || existing.status !== 'active')
                    return false;
                const rawEpoch = existing.stepup_epoch;
                if ((typeof rawEpoch !== 'number' && typeof rawEpoch !== 'string')
                    || (typeof rawEpoch === 'string' && !/^\d+$/.test(rawEpoch)))
                    return false;
                const epoch = Number(rawEpoch);
                const key = sealKey();
                if (!key || !Number.isSafeInteger(epoch) || epoch < 0)
                    return false;
                const verdict = (0, platform_mfa_1.verifyStepUpToken)(req.headers[platform_mfa_1.STEPUP_HEADER], {
                    expectedUserId: userId, currentEpoch: epoch, key, nowMs: now(),
                    maxAgeSeconds: deps.stepUpMaxAgeSeconds ?? platform_mfa_1.DEFAULT_STEPUP_MAX_AGE_SECONDS,
                    expectedPurpose: platform_mfa_1.STEPUP_PURPOSE, expectedSessionId: req.user?.sessionId,
                });
                if (!verdict.ok)
                    return false;
                // CAS fences a concurrent disable/re-enrollment after this read.
                const affected = await tx.store.disable(userId, epoch);
                if (affected === 0)
                    return false;
                if (affected !== 1)
                    throw new Error('Invalid MFA disable row count');
                await tx.recordAudit({
                    actorUserId: userId,
                    tenantId: null,
                    action: 'platform_mfa.disabled',
                    resourceType: 'platform_mfa_secret',
                    resourceId: userId,
                    oldValue: { status: existing.status },
                    newValue: { status: 'disabled' },
                    reason: reason.value,
                });
                return true;
            });
            if (!disabled)
                return res.status(403).json({ error: 'MFA enrollment changed; verify again', code: 'STEP_UP_ENROLLMENT_CHANGED' });
            res.json({ disabled: true });
        }
        catch (error) {
            console.error('MFA disable failed:');
            res.status(500).json({ error: 'Failed to disable platform MFA' });
        }
    });
    return router;
};
exports.createPlatformMfaRouter = createPlatformMfaRouter;
/* Production wiring: real pool, real auth, real platform-permission guard and
   the sealed audit writer. The MFA key is read from MFA_SECRET_KEY at call
   time; a missing/short key fails closed with 503. */
let dbModule = null;
const loadDb = async () => {
    dbModule ?? (dbModule = await Promise.resolve().then(() => __importStar(require('../db'))));
    return dbModule;
};
const productionDb = {
    query: async (sql, params) => {
        const { query } = await loadDb();
        return query(sql, params);
    },
    queryOne: async (sql, params) => {
        const { queryOne } = await loadDb();
        return queryOne(sql, params);
    },
    execute: async (sql, params) => {
        const { execute } = await loadDb();
        return execute(sql, params);
    },
    // One pooled connection per mutation: the MFA row change, the recovery-code
    // rewrite and the sealed audit append commit or roll back together.
    transaction: async (fn) => {
        const { withTransaction } = await loadDb();
        return withTransaction(async (connection) => {
            const tx = {
                query: async (sql, params) => {
                    const [rows] = await connection.query(sql, params);
                    return rows;
                },
                queryOne: async (sql, params) => {
                    const [rows] = await connection.query(sql, params);
                    return rows[0] ?? null;
                },
                execute: async (sql, params) => {
                    const [result] = await connection.execute(sql, params);
                    const header = result;
                    return { insertId: header.insertId ?? 0, affectedRows: header.affectedRows ?? 0 };
                },
            };
            return fn(tx);
        });
    },
};
exports.default = (0, exports.createPlatformMfaRouter)({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await Promise.resolve().then(() => __importStar(require('../middleware/auth')));
        return authenticateToken(req, res, next);
    },
    requirePlatformPermission: (permission) => (0, admin_permissions_1.requireAdminPermission)(permission),
    recordAudit: async (input, db) => {
        const { recordSealedAuditEvent } = await Promise.resolve().then(() => __importStar(require('../services/audit-log')));
        if (db) {
            // Inside the MFA transaction: the audit append shares the caller's
            // connection, so a failed append rolls the MFA change back.
            await recordSealedAuditEvent(auditAccessOf(db), input);
            return;
        }
        // Standalone append: one transactional connection so the audit-chain
        // head lock serializes concurrent appends.
        const { withTransaction } = await loadDb();
        await withTransaction(async (connection) => {
            await recordSealedAuditEvent({
                query: async (sql, params) => {
                    const [rows] = await connection.query(sql, params);
                    return rows;
                },
                queryOne: async (sql, params) => {
                    const [rows] = await connection.query(sql, params);
                    return rows[0] ?? null;
                },
                execute: async (sql, params) => {
                    const [result] = await connection.execute(sql, params);
                    const header = result;
                    return { insertId: header.insertId ?? 0, affectedRows: header.affectedRows ?? 0 };
                },
            }, input);
        });
    },
    sealKey: () => (0, platform_mfa_1.mfaKeyFromEnv)(),
});
