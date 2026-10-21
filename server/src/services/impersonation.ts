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
 *    `middleware/impersonation-context.ts` mounts on the `x-impersonation`
 *    header: it re-checks the signature, expiry and the LIVE session row on
 *    every call, so revoke is immediate.
 *  - Protected actions are always blocked while impersonating — password
 *    changes, MFA changes, money movement and destructive data actions — with
 *    `classifyProtectedAction` + `assertImpersonationPermits` as the deny
 *    helpers adopters call before their own handlers. A read scope denies
 *    every mutation through `evaluateImpersonationWrite` (`read_only`
 *    protection), independent of `requireImpersonationWriteScope`.
 *  - Tenant-owner notification is an injected, best-effort, PII-free hook
 *    (ids + scope + expiry only) fired on activation and on revoke; a failing
 *    hook never fails the session change.
 *  - Approval is the only privilege-granting mutation, so it is performed as
 *    ONE unit of work on a caller-supplied transaction: the row is read with
 *    a lock (`SELECT ... FOR UPDATE` in the SQL store), the pending -> active
 *    UPDATE is guarded by `affectedRows === 1`, and the sealed audit append
 *    runs on the SAME transaction. A failed audit therefore rolls the
 *    activation back instead of leaving an active, unaudited session.
 *  - Start and revoke run on the same one-transaction seam: the insert and
 *    the locked guarded transition each commit or roll back together with
 *    their sealed audit, so a failing audit sink can never leave a phantom
 *    `pending_approval` session (unaudited request) or a revoked, unaudited
 *    row behind.
 *  - Concurrent starts are serialized on the stable verified target row: a
 *    count+insert pair alone lets two transactions both count zero and both
 *    insert, so `start` locks the target `users` row (FOR UPDATE) before it
 *    counts, on the same connection, and fails closed when that row cannot
 *    be locked.
 *  - The dedicated signing key is resolved and validated by the caller BEFORE
 *    that transaction, so a missing/invalid key never activates a session
 *    that could not mint a context token (no null-token success path).
 *
 * No `any`, no ts-ignore, no runtime DDL, no network, no PII in logs.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type { SealedAuditRecordInput } from './audit-log';

export const MAX_IMPERSONATION_SECONDS = 1800;
export const DEFAULT_IMPERSONATION_SECONDS = 1800;
export const MIN_IMPERSONATION_REASON_CHARS = 16;
export const IMPERSONATION_TOKEN_VERSION = 'imp1';
export const IMPERSONATION_HEADER = 'x-impersonation';
export const ID_PATTERN = /^[\w-]{1,64}$/;
/** HMAC-SHA256 key material must carry at least 256 bits of secret. */
export const MIN_IMPERSONATION_SIGNING_KEY_BYTES = 32;

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
     * Row-locking read (`SELECT ... FOR UPDATE`) used only inside the approval
     * transaction; callers outside a transaction must not use it.
     */
    lockSession(sessionId: string): Promise<ImpersonationSessionRow | null>;
    /**
     * Row lock on the stable, verified target row used to serialize
     * concurrent starts for the SAME target: the SQL store issues
     * `SELECT id FROM users WHERE id = ? FOR UPDATE`. A count alone cannot
     * dedupe starts (two transactions can both count zero and both insert),
     * so `start` takes this lock BEFORE counting. Callers must already be
     * inside the start transaction; MySQL holds the lock until it commits or
     * rolls back. A null result means the verified target row is gone and the
     * start fails closed.
     */
    lockTargetUser(targetUserId: string): Promise<{ id: string } | null>;
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

/**
 * The transaction-scoped surface EVERY mutating unit of work (start, approve,
 * revoke) runs against: the whole store plus the sealed audit, all bound by
 * the production adapter to ONE database connection, so the mutation, its
 * guarded transition and the audit commit or roll back together.
 */
export interface ImpersonationTransaction extends ImpersonationStore {
    recordAudit(input: SealedAuditRecordInput): Promise<void>;
}

export type ImpersonationTransactionRunner = <T>(
    work: (tx: ImpersonationTransaction) => Promise<T>,
) => Promise<T>;

/* ----------------------------------------------------------------------- */
/* Session lifecycle service (store-driven).                                */
/* ----------------------------------------------------------------------- */

export interface ImpersonationServiceDeps {
    store: ImpersonationStore;
    now: () => Date;
    idFactory?: () => string;
    /**
     * Required: start, approve and revoke must never run outside a transaction
     * that also holds the audit append. There is deliberately no
     * non-transactional fallback for any of the three mutations.
     */
    transaction: ImpersonationTransactionRunner;
}

export type StartDenyReason = 'invalid' | 'self_target' | 'target_active_session' | 'target_not_lockable' | 'store_error';

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
        /**
         * Dedupe + insert + audit as ONE unit of work: the pending session and
         * its audit record commit or roll back together, so a failing audit
         * sink can never leave a phantom (unaudited) `pending_approval` row
         * behind. Caller resolves the target row first.
         *
         * Concurrency: the count+insert pair alone cannot dedupe — two
         * transactions can both count zero live sessions and both insert for
         * the same target. The start therefore takes a row lock on the stable
         * verified target row (`lockTargetUser`) BEFORE counting, so a second
         * start for the same target blocks on that lock, counts the session
         * the winner inserted, and is refused. A target row that cannot be
         * locked (deleted between resolution and transaction) fails closed.
         */
        start: async (starterId: string, input: StartImpersonationInput): Promise<StartResult> => {
            try {
                return await deps.transaction(async (tx) => {
                    // A support actor may never open a session against their OWN
                    // identity: the bearer of the context must be the actor and
                    // the effective principal the target, so a self-target row
                    // would make the two indistinguishable. Denied before the
                    // lock so no phantom pending row is written.
                    if (String(starterId) === String(input.targetUserId)) {
                        return { ok: false, reason: 'self_target' } as const;
                    }
                    const lockedTarget = await tx.lockTargetUser(input.targetUserId);
                    if (!lockedTarget) return { ok: false, reason: 'target_not_lockable' } as const;
                    const active = await tx.countActiveForTargetUser(input.targetUserId);
                    if (active > 0) return { ok: false, reason: 'target_active_session' } as const;
                    const row = buildRow(input, starterId, deps.now());
                    await tx.insertSession(row);
                    await tx.recordAudit({
                        actorUserId: starterId,
                        tenantId: input.tenantId,
                        action: 'impersonation.session_requested',
                        resourceType: 'impersonation_session',
                        resourceId: row.id,
                        newValue: {
                            session_id: row.id,
                            target_user_id: input.targetUserId,
                            tenant_id: input.tenantId,
                            scope: input.scope,
                            requested_seconds: input.durationSeconds,
                        },
                        reason: input.reason,
                    });
                    return { ok: true, session: row } as const;
                });
            } catch (error) {
                console.error('Impersonation start failed:', error);
                return { ok: false, reason: 'store_error' };
            }
        },

        /**
         * Activation by a DIFFERENT admin inside one transaction: locked read,
         * guarded transition and sealed audit commit or roll back together.
         * The expiry is clamped to <= 30 minutes.
         */
        approve: async (sessionId: string, approverId: string): Promise<ApproveResult> => {
            try {
                return await deps.transaction(async (tx) => {
                    const row = await tx.lockSession(sessionId);
                    if (!row) return { ok: false, reason: 'not_found' } as const;
                    if (row.status !== 'pending_approval') return { ok: false, reason: 'not_pending' } as const;
                    if (String(row.started_by) === String(approverId)) return { ok: false, reason: 'self_approval' } as const;
                    const requested = Number(row.requested_seconds ?? DEFAULT_IMPERSONATION_SECONDS);
                    const seconds = Number.isFinite(requested) && requested > 0
                        ? Math.min(requested, MAX_IMPERSONATION_SECONDS)
                        : DEFAULT_IMPERSONATION_SECONDS;
                    const now = deps.now();
                    const requestedExpiry = new Date(now.getTime() + seconds * 1000);
                    const existingExpiry = row.expires_at ? new Date(row.expires_at) : null;
                    const bounded = existingExpiry && !Number.isNaN(existingExpiry.getTime())
                        && existingExpiry.getTime() < requestedExpiry.getTime()
                        ? existingExpiry
                        : requestedExpiry;
                    const moved = await tx.transitionToActive(sessionId, approverId, bounded, now);
                    if (moved !== 1) return { ok: false, reason: 'besides_transition' } as const;
                    const session = await tx.findSession(sessionId);
                    // Impossible with a locked, just-updated primary key; throw so
                    // the transaction rolls the activation back rather than
                    // committing a session we cannot read.
                    if (!session) throw new Error('The activated impersonation session could not be re-read');
                    await tx.recordAudit({
                        actorUserId: approverId,
                        tenantId: session.tenant_id,
                        action: 'impersonation.session_approved',
                        resourceType: 'impersonation_session',
                        resourceId: session.id,
                        newValue: {
                            session_id: session.id,
                            approved_by: approverId,
                            scope: session.scope,
                            expires_at: bounded.toISOString(),
                        },
                        reason: session.reason,
                    });
                    return { ok: true, session, expiresAt: bounded } as const;
                });
            } catch (error) {
                console.error('Impersonation approval failed:', error);
                return { ok: false, reason: 'store_error' };
            }
        },

        /**
         * Revocation as ONE unit of work: the row is locked, the conditional
         * UPDATE is guarded by `affectedRows === 1` and the sealed audit runs
         * on the same connection, so a failed audit rolls the revocation back
         * (the session stays active and the caller retries) instead of leaving
         * a revoked, unaudited row. A racing revoker loses the guard (0 rows ->
         * `besides_transition`), a repeat revoke of a terminal row is
         * `not_revocable`, so revocation stays applied exactly once.
         */
        revoke: async (sessionId: string, revokedBy: string): Promise<RevokeResult> => {
            try {
                return await deps.transaction(async (tx) => {
                    const row = await tx.lockSession(sessionId);
                    if (!row) return { ok: false, reason: 'not_found' } as const;
                    if (row.status !== 'active' && row.status !== 'pending_approval') {
                        return { ok: false, reason: 'not_revocable' } as const;
                    }
                    const now = deps.now();
                    const moved = await tx.transitionToRevoked(sessionId, revokedBy, now);
                    if (moved !== 1) return { ok: false, reason: 'besides_transition' } as const;
                    const session = await tx.findSession(sessionId);
                    // Impossible with a locked, just-updated primary key; throw so
                    // the transaction rolls the revocation back rather than
                    // committing a session we cannot read.
                    if (!session) throw new Error('The revoked impersonation session could not be re-read');
                    await tx.recordAudit({
                        actorUserId: revokedBy,
                        tenantId: session.tenant_id,
                        action: 'impersonation.session_revoked',
                        resourceType: 'impersonation_session',
                        resourceId: session.id,
                        oldValue: { status: row.status, revoked_by: row.revoked_by ?? null },
                        newValue: { session_id: session.id, revoked_by: revokedBy },
                        reason: session.reason,
                    });
                    return { ok: true, session } as const;
                });
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

export type ImpersonationSigningKeyResult =
    | { ok: true; key: Buffer }
    | { ok: false; reason: 'missing' | 'invalid' };

/**
 * Fail-closed signing prerequisite. The provider is the ONLY source of key
 * material; it must return at least 32 bytes and must not be the shared JWT
 * secret (a compromised session token must not be able to mint impersonation
 * contexts). A throwing provider is treated as missing, never as success.
 */
export const resolveImpersonationSigningKey = async (
    provider: () => Buffer | null | Promise<Buffer | null>,
    options: { jwtSecret?: string | null } = {},
): Promise<ImpersonationSigningKeyResult> => {
    let candidate: Buffer | null;
    try {
        candidate = await provider();
    } catch {
        return { ok: false, reason: 'missing' };
    }
    if (!candidate) return { ok: false, reason: 'missing' };
    if (!Buffer.isBuffer(candidate) || candidate.length < MIN_IMPERSONATION_SIGNING_KEY_BYTES) {
        return { ok: false, reason: 'invalid' };
    }
    const jwtSecret = options.jwtSecret;
    if (jwtSecret && jwtSecret.length > 0 && candidate.equals(Buffer.from(jwtSecret, 'utf8'))) {
        return { ok: false, reason: 'invalid' };
    }
    return { ok: true, key: candidate };
};

export const signImpersonationToken = (
    session: ImpersonationSessionRow,
    writeScope: boolean,
    key: Buffer,
    nowMs: number,
): string => {
    if (!Buffer.isBuffer(key) || key.length < MIN_IMPERSONATION_SIGNING_KEY_BYTES) {
        throw new Error('An impersonation signing key of at least 32 bytes is required');
    }
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
 * The signed context's scope flag must equal the live row's scope (the row
 * is authoritative — a write-flagged context over a read row, or the
 * reverse, is a `row_mismatch`), and the live row's `expires_at` is the
 * only expiry authority; the signed field records the issue time only.
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
                String(row.tenant_id) !== context.tenantId ||
                String(row.scope) !== context.scope
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
/* Binding the verified context to the request principal.                   */
/* ----------------------------------------------------------------------- */

export interface ImpersonationRequestPrincipal {
    userId: string;
    tenantId?: string | null;
}

export type ImpersonationPrincipalDenyReason = 'unauthenticated' | 'actor_mismatch' | 'tenant_mismatch';

export type ImpersonationPrincipalVerdict =
    | { ok: true }
    | { ok: false; reason: ImpersonationPrincipalDenyReason };

/**
 * The request carrying `x-impersonation` must be authenticated as the
 * session's ACTOR — the separately authenticated support principal recorded
 * as `started_by` — NOT as the target. The actor is bound twice: the signed
 * token carries `actorUserId` and the verifier re-checks it against the live
 * row, and this binding re-checks it against the authenticated bearer, so
 * neither a token minted for another actor nor one stolen from the target
 * ("target credentials") can be replayed. A bearer that is the TARGET user
 * (or any third principal) is refused: support impersonation authenticates
 * the support actor and resolves the effective target identity server-side
 * (middleware/impersonation-context.ts), so no target credentials are ever
 * required or accepted.
 */
export const matchImpersonationPrincipal = (
    context: ImpersonationContext,
    principal: ImpersonationRequestPrincipal | null,
): ImpersonationPrincipalVerdict => {
    if (!principal || !principal.userId) return { ok: false, reason: 'unauthenticated' };
    if (String(principal.userId) !== context.actorUserId) return { ok: false, reason: 'actor_mismatch' };
    if (principal.tenantId != null && String(principal.tenantId) !== context.tenantId) {
        return { ok: false, reason: 'tenant_mismatch' };
    }
    return { ok: true };
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

export type ImpersonationProtectionKind = ProtectedActionKind | 'read_only';

export type ImpersonationActionVerdict =
    | { blocked: false }
    | { blocked: true; protection: ImpersonationProtectionKind };

/**
 * Deny helper adopters call before any mutation. Protected actions are
 * blocked even with an explicit write scope, and a read scope allows NO
 * mutations at all — every mutating action is denied with the `read_only`
 * protection, so the documented read-only guarantee holds regardless of
 * whether the adopter also calls `requireImpersonationWriteScope`.
 */
export const evaluateImpersonationWrite = (
    context: ImpersonationContext | null,
    action: string,
): ImpersonationActionVerdict => {
    if (!context) return { blocked: false };
    const protection = classifyProtectedAction(action);
    if (protection) return { blocked: true, protection };
    if (context.scope === 'read') return { blocked: true, protection: 'read_only' };
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
    lockSession: async (sessionId) => {
        if (!sessionId || sessionId.length > 64) return null;
        // Callers must already be inside the approval transaction; MySQL keeps
        // the row lock until that transaction commits or rolls back.
        return db.queryOne<ImpersonationSessionRow>(
            `SELECT id, started_by, approved_by, target_user_id, tenant_id, reason, scope,
                    status, requested_seconds, expires_at, revoked_at, revoked_by, created_at
             FROM impersonation_sessions WHERE id = ? LIMIT 1 FOR UPDATE`,
            [sessionId],
        );
    },
    lockTargetUser: async (targetUserId) => {
        if (!targetUserId || targetUserId.length > 64) return null;
        // Serializes concurrent starts for the same target: the row lock is
        // held until the surrounding start transaction commits or rolls back,
        // so the count-then-insert dedupe cannot be raced by a second start
        // for the same target. The caller must already be inside that
        // transaction.
        return db.queryOne<{ id: string }>(
            `SELECT id FROM users WHERE id = ? LIMIT 1 FOR UPDATE`,
            [targetUserId],
        );
    },
    transitionToActive: async (sessionId, approverId, expiresAt, now) => {
        // `expires_at` is bound as a Date, exactly like `insertSession` does
        // for the same column: the driver formats it with the pool's
        // `timezone` and decodes the column with the same offset, so the
        // instant survives the write/read pair. Pre-formatting it here (a UTC
        // wall-clock string, as this once did) used the opposite convention
        // and stored an expiry two hours in the past, which made every
        // activated session unusable.
        const result = await db.execute(
            `UPDATE impersonation_sessions
             SET approved_by = ?, status = 'active', expires_at = ?, updated_at = ?
             WHERE id = ? AND status = 'pending_approval' AND started_by <> ?`,
            [approverId, expiresAt, rowStamp(now), sessionId, approverId],
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
