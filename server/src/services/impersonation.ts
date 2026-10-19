/**
 * M7 O6 — platform support impersonation.
 *
 * Model:
 *  - A platform support principal with the VERIFIED platform permission
 *    `impersonation.start` opens a session for a TARGET USER inside a tenant.
 *    A mandatory written reason (min length), a bounded duration
 *    (default/maximum 30 minutes) and an explicit scope are recorded; the
 *    scope is `read` by default and `write` only when explicitly requested.
 *  - A SECOND, different platform admin holding `impersonation.approve` must
 *    activate the session (self-approval is denied); activation is a
 *    conditional transition from `pending_approval`, so racing or late
 *    approvals cannot revive an expired/cancelled request.
 *  - The issued context is a short HMAC token
 *    `imp1.<sessionId>.<actor>.<target>.<tenant>.<write?>.<exp>.<mac>` carrying
 *    the banner facts. `createImpersonationVerifier` is the verification seam
 *    the shared auth middleware can adopt later (middleware/auth.ts is NOT
 *    edited in this batch): it re-checks the signature, expiry and the LIVE
 *    session row on every call, so revoke is immediate.
 *  - Protected actions are always blocked while impersonating — password
 *    changes, MFA changes, money movement and destructive data actions — with
 *    `classifyProtectedAction` + `assertImpersonationPermits` as the deny
 *    helpers adopters call before their own handlers.
 *  - Tenant-owner notification is an injected, best-effort, PII-free hook
 *    (ids + scope + expiry only) fired on activation and on revoke; a failing
 *    hook never fails the session change.
 *  - Every session mutation is audited through the injected sealed writer
 *    inside an injectable transaction seam; a failed audit aborts the write.
 *
 * No `any`, no ts-ignore, no runtime DDL, no network, no PII in logs.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

export const MAX_IMPERSONATION_SECONDS = 1800;
export const DEFAULT_IMPERSONATION_SECONDS = 1800;
export const MIN_IMPERSONATION_REASON_CHARS = 16;
export const IMPERSONATION_TOKEN_VERSION = 'imp1';
export const IMPERSONATION_HEADER = 'x-impersonation';
export const ID_PATTERN = /^[\w-]{1,64}$/;

export interface ImpersonationDb {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

/* ----------------------------------------------------------------------- */
/* Input validation.                                                        */
/* ----------------------------------------------------------------------- */

export type ImpersonationScope = 'read' | 'write';

export interface StartImpersonationInput {
    targetUserId: string;
    tenantId: string;
    reason: string;
    scope: ImpersonationScope;
    durationSeconds: number;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const validateStartInput = (body: unknown): ValidationResult<StartImpersonationInput> => {
    if (!body || typeof body !== 'object') return { ok: false, error: 'A target user, tenant and reason are required' };
    const input = body as Record<string, unknown>;
    const targetUserId = typeof input.target_user_id === 'string' ? input.target_user_id.trim() : '';
    if (!targetUserId || !ID_PATTERN.test(targetUserId)) {
        return { ok: false, error: 'A valid target_user_id is required' };
    }
    const tenantId = typeof input.tenant_id === 'string' ? input.tenant_id.trim() : '';
    if (!tenantId || !ID_PATTERN.test(tenantId)) {
        return { ok: false, error: 'A valid tenant_id is required' };
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < MIN_IMPERSONATION_REASON_CHARS || reason.length > 1000) {
        return { ok: false, error: `The reason must be between ${MIN_IMPERSONATION_REASON_CHARS} and 1000 characters` };
    }
    const rawScope = typeof input.scope === 'string' ? input.scope.trim().toLowerCase() : 'read';
    if (rawScope !== 'read' && rawScope !== 'write') {
        return { ok: false, error: 'scope must be read or write' };
    }
    const rawSeconds = input.duration_seconds;
    let durationSeconds = DEFAULT_IMPERSONATION_SECONDS;
    if (rawSeconds !== undefined && rawSeconds !== null && rawSeconds !== '') {
        if (typeof rawSeconds !== 'number' || !Number.isInteger(rawSeconds)) {
            return { ok: false, error: 'duration_seconds must be an integer number of seconds' };
        }
        if (rawSeconds < 1 || rawSeconds > MAX_IMPERSONATION_SECONDS) {
            return { ok: false, error: `duration_seconds must be between 1 and ${MAX_IMPERSONATION_SECONDS}` };
        }
        durationSeconds = rawSeconds;
    }
    return {
        ok: true,
        value: { targetUserId, tenantId, reason, scope: rawScope as ImpersonationScope, durationSeconds },
    };
};

/* ----------------------------------------------------------------------- */
/* Row + store seam.                                                        */
/* ----------------------------------------------------------------------- */

export interface ImpersonationSessionRow {
    id: string;
    started_by: string;
    approved_by: string | null;
    target_user_id: string;
    tenant_id: string;
    reason: string;
    scope: string;
    status: string | null;
    requested_seconds: number | string | null;
    expires_at: string | Date | null;
    revoked_at: string | Date | null;
    revoked_by: string | null;
    created_at?: string | Date;
}

export type ImpersonationStatus = 'pending_approval' | 'active' | 'revoked' | 'expired';

export interface ImpersonationStore {
    insertSession(row: ImpersonationSessionRow): Promise<void>;
    findSession(sessionId: string): Promise<ImpersonationSessionRow | null>;
    /**
     * Conditional pending -> active move; a second approver and the new
     * expiry are sealed together. Returns affected rows (0 => race/late).
     */
    transitionToActive(sessionId: string, approverId: string, expiresAt: Date, now: Date): Promise<number>;
    /** Conditional cancellation/revocation; returns affected rows. */
    transitionToRevoked(sessionId: string, revokedBy: string, now: Date): Promise<number>;
    listRecentForActor(actorUserId: string, limit: number): Promise<ImpersonationSessionRow[]>;
    countActiveForTargetUser(targetUserId: string): Promise<number>;
}

/* ----------------------------------------------------------------------- */
/* Session lifecycle service (store-driven).                                */
/* ----------------------------------------------------------------------- */

export interface ImpersonationServiceDeps {
    store: ImpersonationStore;
    now: () => Date;
    idFactory?: () => string;
}

export type StartDenyReason = 'invalid' | 'target_active_session' | 'store_error';

export type StartResult =
    | { ok: true; session: ImpersonationSessionRow }
    | { ok: false; reason: StartDenyReason; error?: string };

export type ApproveDenyReason = 'not_found' | 'not_pending' | 'self_approval' | 'besides_transition' | 'store_error';

export type ApproveResult =
    | { ok: true; session: ImpersonationSessionRow; expiresAt: Date }
    | { ok: false; reason: ApproveDenyReason };

export type RevokeDenyReason = 'not_found' | 'not_revocable' | 'besides_transition' | 'store_error';

export type RevokeResult =
    | { ok: true; session: ImpersonationSessionRow }
    | { ok: false; reason: RevokeDenyReason };


export const createImpersonationService = (deps: ImpersonationServiceDeps) => {
    const idFactory = deps.idFactory ?? randomUUID;

    const buildRow = (input: StartImpersonationInput, starterId: string, expiresAt: Date): ImpersonationSessionRow => ({
        id: idFactory(),
        started_by: starterId,
        approved_by: null,
        target_user_id: input.targetUserId,
        tenant_id: input.tenantId,
        reason: input.reason,
        scope: input.scope,
        status: 'pending_approval',
        requested_seconds: input.durationSeconds,
        expires_at: null,
        revoked_at: null,
        revoked_by: null,
    });

    return {
        /** Validation + dedupe + insert; caller resolves the target row first. */
        start: async (starterId: string, input: StartImpersonationInput): Promise<StartResult> => {
            try {
                const active = await deps.store.countActiveForTargetUser(input.targetUserId);
                if (active > 0) return { ok: false, reason: 'target_active_session' };
                const row = buildRow(input, starterId, deps.now());
                await deps.store.insertSession(row);
                return { ok: true, session: row };
            } catch (error) {
                console.error('Impersonation start failed:', error);
                return { ok: false, reason: 'store_error' };
            }
        },

        /** Activation by a DIFFERENT admin; clamps the expiry to <= 30 minutes. */
        approve: async (sessionId: string, approverId: string): Promise<ApproveResult> => {
            try {
                const row = await deps.store.findSession(sessionId);
                if (!row) return { ok: false, reason: 'not_found' };
                if (row.status !== 'pending_approval') return { ok: false, reason: 'not_pending' };
                if (String(row.started_by) === String(approverId)) return { ok: false, reason: 'self_approval' };
                const requested = Number(row.requested_seconds ?? DEFAULT_IMPERSONATION_SECONDS);
                const seconds = Number.isFinite(requested) && requested > 0
                    ? Math.min(requested, MAX_IMPERSONATION_SECONDS)
                    : DEFAULT_IMPERSONATION_SECONDS;
                const now = deps.now();
                const expiresAt = new Date(now.getTime() + Math.min(seconds, MAX_IMPERSONATION_SECONDS) * 1000);
                const approveExpiration = row.expires_at ? new Date(row.expires_at) : null;
                const fallbackAt = approveExpiration && !Number.isNaN(approveExpiration.getTime())
                    ? approveExpiration
                    : expiresAt;
                const bounded = fallbackAt.getTime() < expiresAt.getTime() ? fallbackAt : expiresAt;
                const moved = await deps.store.transitionToActive(sessionId, approverId, bounded, now);
                if (moved === 0) return { ok: false, reason: 'besides_transition' };
                const session = await deps.store.findSession(sessionId);
                if (!session) return { ok: false, reason: 'not_found' };
                return { ok: true, session, expiresAt: bounded };
            } catch (error) {
                console.error('Impersonation approval failed:', error);
                return { ok: false, reason: 'store_error' };
            }
        },

        revoke: async (sessionId: string, revokedBy: string): Promise<RevokeResult> => {
            try {
                const row = await deps.store.findSession(sessionId);
                if (!row) return { ok: false, reason: 'not_found' };
                if (row.status !== 'active' && row.status !== 'pending_approval') {
                    return { ok: false, reason: 'not_revocable' };
                }
                const now = deps.now();
                const moved = await deps.store.transitionToRevoked(sessionId, revokedBy, now);
                if (moved === 0) return { ok: false, reason: 'besides_transition' };
                const session = await deps.store.findSession(sessionId);
                if (!session) return { ok: false, reason: 'not_found' };
                return { ok: true, session };
            } catch (error) {
                console.error('Impersonation revoke failed:', error);
                return { ok: false, reason: 'store_error' };
            }
        },

        getSession: (sessionId: string) => deps.store.findSession(sessionId),
        listForActor: (actorUserId: string, limit: number) =>
            deps.store.listRecentForActor(actorUserId, limit),
    };
};

/* ----------------------------------------------------------------------- */
/* Issued context token: HMAC-signed, banner facts included, short-lived.   */
/* ----------------------------------------------------------------------- */

const toB64Url = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');
const fromB64Url = (value: string): string => Buffer.from(value, 'base64url').toString('utf8');

export const signImpersonationToken = (
    session: ImpersonationSessionRow,
    writeScope: boolean,
    key: Buffer,
    nowMs: number,
): string => {
    const parts = [
        IMPERSONATION_TOKEN_VERSION,
        toB64Url(session.id),
        toB64Url(String(session.started_by)),
        toB64Url(String(session.target_user_id)),
        toB64Url(String(session.tenant_id)),
        writeScope ? 'w1' : 'w0',
        String(Math.floor(nowMs / 1000)),
    ];
    const mac = createHmac('sha256', key).update(parts.join('|'), 'utf8').digest('base64url');
    return [...parts, mac].join('.');
};

export const IMPERSONATION_WRITE_FLAGS = { read: 'w0', write: 'w1' } as const;

export interface ImpersonationContext {
    sessionId: string;
    actorUserId: string;
    targetUserId: string;
    tenantId: string;
    scope: ImpersonationScope;
    /** The banner flag surfaced to every issued context consumer. */
    banner: {
        impersonated: true;
        sessionId: string;
        tenantId: string;
        scope: ImpersonationScope;
    };
}

export const parseImpersonationToken = (token: unknown): ImpersonationContext | null => {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 8 || parts[0] !== IMPERSONATION_TOKEN_VERSION) return null;
    try {
        const scope = parts[5] === IMPERSONATION_WRITE_FLAGS.write ? 'write' : 'read';
        return {
            sessionId: fromB64Url(parts[1]),
            actorUserId: fromB64Url(parts[2]),
            targetUserId: fromB64Url(parts[3]),
            tenantId: fromB64Url(parts[4]),
            scope: scope as ImpersonationScope,
            banner: { impersonated: true, sessionId: fromB64Url(parts[1]), tenantId: fromB64Url(parts[4]), scope: scope as ImpersonationScope },
        };
    } catch {
        return null;
    }
};

const contextMacPayload = (parts: string[]): string => parts.join('|');

export const expectedImpersonationMac = (token: string, key: Buffer): string => {
    const parts = token.split('.');
    return createHmac('sha256', key).update(contextMacPayload(parts.slice(0, 7)), 'utf8').digest('base64url');
};

export const checkImpersonationSignature = (token: string, key: Buffer): boolean => {
    const parts = token.split('.');
    if (parts.length !== 8 || parts[0] !== IMPERSONATION_TOKEN_VERSION) return false;
    const expected = Buffer.from(expectedImpersonationMac(token, key), 'utf8');
    const supplied = Buffer.from(parts[7], 'utf8');
    if (supplied.length !== expected.length) return false;
    return timingSafeEqual(supplied, expected);
};

export type ImpersonationVerifyDenyReason =
    | 'malformed'
    | 'signature'
    | 'expired'
    | 'not_active'
    | 'row_mismatch'
    | 'store_error';

export type ImpersonationVerifyResult =
    | { ok: true; context: ImpersonationContext }
    | { ok: false; reason: ImpersonationVerifyDenyReason };

export interface ImpersonationVerifierDeps {
    store: ImpersonationStore;
    tokenKey: () => Buffer | null | Promise<Buffer | null>;
    now: () => Date;
}

/**
 * Verification seam the shared auth middleware can adopt later. Deny-by-
 * default: signature, expiry and then the LIVE session row (immediate
 * revocation, scope/expiry/tenant consistency) before a context is issued.
 */
export const createImpersonationVerifier = (deps: ImpersonationVerifierDeps) =>
    async (token: unknown): Promise<ImpersonationVerifyResult> => {
        try {
            if (typeof token !== 'string' || token.length > 4096) return { ok: false, reason: 'malformed' };
            const context = parseImpersonationToken(token);
            if (!context) return { ok: false, reason: 'malformed' };
            const key = await deps.tokenKey();
            if (!key) return { ok: false, reason: 'store_error' };
            if (!checkImpersonationSignature(token, key)) {
                return { ok: false, reason: 'signature' };
            }
            const row = await deps.store.findSession(context.sessionId);
            if (!row) return { ok: false, reason: 'not_active' };
            if (row.status !== 'active') return { ok: false, reason: 'not_active' };
            const expires = row.expires_at ? new Date(row.expires_at).getTime() : 0;
            if (!expires || Number.isNaN(expires) || deps.now().getTime() >= expires) {
                return { ok: false, reason: 'expired' };
            }
            if (
                String(row.started_by) !== context.actorUserId ||
                String(row.target_user_id) !== context.targetUserId ||
                String(row.tenant_id) !== context.tenantId
            ) {
                return { ok: false, reason: 'row_mismatch' };
            }
            return { ok: true, context };
        } catch (error) {
            console.error('Impersonation verification failed:', error);
            return { ok: false, reason: 'store_error' };
        }
    };

/* ----------------------------------------------------------------------- */
/* Protected actions: always blocked while impersonating.                   */
/* ----------------------------------------------------------------------- */

export type ProtectedActionKind = 'password_change' | 'mfa_change' | 'money_movement' | 'data_delete';

const ACTION_TOKENS: Record<ProtectedActionKind, string[]> = {
    password_change: ['password', 'passwd', 'credentialexchange'],
    mfa_change: ['mfa', 'totp', 'twofactor', '2fa', 'recoverycode', 'recovery', 'stepup'],
    money_movement: ['wallet', 'withdraw', 'withdrawal', 'payout', 'refund', 'topup', 'topuprequest', 'invoice', 'billing'],
    data_delete: ['delete', 'destroy', 'purge', 'permanenterase', 'harddelete'],
};

const tokenizeAction = (action: string): string[] =>
    action.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0);

export const classifyProtectedAction = (action: string): ProtectedActionKind | null => {
    const tokens = new Set(tokenizeAction(action));
    const kinds: ProtectedActionKind[] = ['password_change', 'mfa_change', 'money_movement', 'data_delete'];
    for (const kind of kinds) {
        for (const token of ACTION_TOKENS[kind]) {
            if (tokens.has(token) || tokens.has(`${token}s`) || tokens.has(`${token}d`) || tokens.has(`${token}ed`)) {
                return kind;
            }
        }
    }
    return null;
};

export type ImpersonationActionVerdict =
    | { blocked: false }
    | { blocked: true; protection: ProtectedActionKind };

/**
 * Deny helper adopters call before a protected mutation. Blocked even with an
 * explicit write scope; read scope additionally allows no mutations at all.
 */
export const evaluateImpersonationWrite = (
    context: ImpersonationContext | null,
    action: string,
): ImpersonationActionVerdict => {
    if (!context) return { blocked: false };
    const protection = classifyProtectedAction(action);
    if (protection) return { blocked: true, protection };
    return { blocked: false };
};

export const requireImpersonationWriteScope = (context: ImpersonationContext): { ok: true } | { ok: false; error: string } =>
    context.scope === 'write' ? { ok: true } : { ok: false, error: 'Impersonation session is read-only' };

/* ----------------------------------------------------------------------- */
/* Tenant-owner notification hook (injected, best-effort, PII-free).        */
/* ----------------------------------------------------------------------- */

export interface ImpersonationNotificationEvent {
    kind: 'session_started' | 'session_ended';
    sessionId: string;
    tenantId: string;
    actorUserId: string;
    approverUserId: string | null;
    targetUserId: string;
    scope: ImpersonationScope;
    expiresAt: string | null;
}

export type ImpersonationNotificationHook = (event: ImpersonationNotificationEvent) => Promise<void>;

export const noopImpersonationNotificationHook: ImpersonationNotificationHook = async () => undefined;

export const notifyTenantOwnerSafely = async (
    hook: ImpersonationNotificationHook,
    event: ImpersonationNotificationEvent,
): Promise<void> => {
    try {
        await hook(event);
    } catch (error) {
        console.error('Impersonation tenant-owner notification failed:', error);
    }
};

/* ----------------------------------------------------------------------- */
/* Per-actor fixed-window rate limiter (clock injectable).                  */
/* ----------------------------------------------------------------------- */

export interface ImpersonationRateLimiter {
    tryConsume(key: string): boolean;
}

export const createImpersonationRateLimiter = (options: { max: number; windowMs: number; now: () => Date }): ImpersonationRateLimiter => {
    const buckets = new Map<string, { windowStart: number; count: number }>();
    return {
        tryConsume: (key: string): boolean => {
            const nowMs = options.now().getTime();
            const bucket = buckets.get(key);
            if (!bucket || nowMs - bucket.windowStart >= options.windowMs) {
                buckets.set(key, { windowStart: nowMs, count: 1 });
                return true;
            }
            if (bucket.count >= options.max) return false;
            bucket.count += 1;
            return true;
        },
    };
};

export const IMPERSONATION_RATE_LIMITS = {
    start: { max: 5, windowMs: 10 * 60_000 },
    approve: { max: 10, windowMs: 10 * 60_000 },
} as const;

/* ----------------------------------------------------------------------- */
/* SQL store implementation (wired in the production route module).         */
/* ----------------------------------------------------------------------- */

export const createSqlImpersonationStore = (db: ImpersonationDb): ImpersonationStore => ({
    insertSession: async (row) => {
        await db.execute(
            `INSERT INTO impersonation_sessions
             (id, started_by, approved_by, target_user_id, tenant_id, reason, scope,
              status, requested_seconds, expires_at, revoked_at, revoked_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                row.id, row.started_by, row.approved_by, row.target_user_id, row.tenant_id,
                row.reason, row.scope, row.status, row.requested_seconds ?? null,
                row.expires_at ?? null, row.revoked_at ?? null, row.revoked_by ?? null,
            ],
        );
    },
    findSession: async (sessionId) => {
        if (!sessionId || sessionId.length > 64) return null;
        return db.queryOne<ImpersonationSessionRow>(
            `SELECT id, started_by, approved_by, target_user_id, tenant_id, reason, scope,
                    status, requested_seconds, expires_at, revoked_at, revoked_by, created_at
             FROM impersonation_sessions WHERE id = ? LIMIT 1`,
            [sessionId],
        );
    },
    transitionToActive: async (sessionId, approverId, expiresAt, now) => {
        const result = await db.execute(
            `UPDATE impersonation_sessions
             SET approved_by = ?, status = 'active', expires_at = ?, updated_at = ?
             WHERE id = ? AND status = 'pending_approval' AND started_by <> ?`,
            [approverId, expiresAt.toISOString().slice(0, 19).replace('T', ' '),
             rowStamp(now), sessionId, approverId],
        );
        return result.affectedRows ?? 0;
    },
    transitionToRevoked: async (sessionId, revokedBy, now) => {
        const result = await db.execute(
            `UPDATE impersonation_sessions
             SET status = 'revoked', revoked_at = ?, revoked_by = ?, updated_at = ?
             WHERE id = ? AND status IN ('pending_approval', 'active')`,
            [rowStamp(now), revokedBy, rowStamp(now), sessionId],
        );
        return result.affectedRows ?? 0;
    },
    listRecentForActor: async (actorUserId, limit) => {
        const bounded = Math.max(1, Math.min(100, Number(limit) || 50));
        return db.query<ImpersonationSessionRow>(
            `SELECT id, started_by, approved_by, target_user_id, tenant_id, reason, scope,
                    status, requested_seconds, expires_at, revoked_at, revoked_by, created_at
             FROM impersonation_sessions
             WHERE started_by = ? OR approved_by = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ${bounded}`,
            [actorUserId, actorUserId],
        );
    },
    countActiveForTargetUser: async (targetUserId) => {
        const rows = await db.query<{ total: number }>(
            `SELECT COUNT(*) AS total FROM impersonation_sessions
             WHERE target_user_id = ? AND status IN ('active', 'pending_approval')`,
            [targetUserId],
        );
        return Number(rows[0]?.total ?? 0);
    },
});

const rowStamp = (now: Date): string => now.toISOString().slice(0, 19).replace('T', ' ');
