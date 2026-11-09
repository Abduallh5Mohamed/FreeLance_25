"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSqlImpersonationStore = exports.IMPERSONATION_RATE_LIMITS = exports.createImpersonationRateLimiter = exports.notifyTenantOwnerSafely = exports.noopImpersonationNotificationHook = exports.requireImpersonationWriteScope = exports.evaluateImpersonationWrite = exports.classifyProtectedAction = exports.matchImpersonationPrincipal = exports.createImpersonationVerifier = exports.checkImpersonationSignature = exports.expectedImpersonationMac = exports.parseImpersonationToken = exports.IMPERSONATION_WRITE_FLAGS = exports.signImpersonationToken = exports.resolveImpersonationSigningKey = exports.createImpersonationService = exports.validateStartInput = exports.MIN_IMPERSONATION_SIGNING_KEY_BYTES = exports.ID_PATTERN = exports.IMPERSONATION_HEADER = exports.IMPERSONATION_TOKEN_VERSION = exports.MIN_IMPERSONATION_REASON_CHARS = exports.DEFAULT_IMPERSONATION_SECONDS = exports.MAX_IMPERSONATION_SECONDS = void 0;
const crypto_1 = require("crypto");
exports.MAX_IMPERSONATION_SECONDS = 1800;
exports.DEFAULT_IMPERSONATION_SECONDS = 1800;
exports.MIN_IMPERSONATION_REASON_CHARS = 16;
exports.IMPERSONATION_TOKEN_VERSION = 'imp1';
exports.IMPERSONATION_HEADER = 'x-impersonation';
exports.ID_PATTERN = /^[\w-]{1,64}$/;
/** HMAC-SHA256 key material must carry at least 256 bits of secret. */
exports.MIN_IMPERSONATION_SIGNING_KEY_BYTES = 32;
const validateStartInput = (body) => {
    if (!body || typeof body !== 'object')
        return { ok: false, error: 'A target user, tenant and reason are required' };
    const input = body;
    const targetUserId = typeof input.target_user_id === 'string' ? input.target_user_id.trim() : '';
    if (!targetUserId || !exports.ID_PATTERN.test(targetUserId)) {
        return { ok: false, error: 'A valid target_user_id is required' };
    }
    const tenantId = typeof input.tenant_id === 'string' ? input.tenant_id.trim() : '';
    if (!tenantId || !exports.ID_PATTERN.test(tenantId)) {
        return { ok: false, error: 'A valid tenant_id is required' };
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < exports.MIN_IMPERSONATION_REASON_CHARS || reason.length > 1000) {
        return { ok: false, error: `The reason must be between ${exports.MIN_IMPERSONATION_REASON_CHARS} and 1000 characters` };
    }
    const rawScope = typeof input.scope === 'string' ? input.scope.trim().toLowerCase() : 'read';
    if (rawScope !== 'read' && rawScope !== 'write') {
        return { ok: false, error: 'scope must be read or write' };
    }
    const rawSeconds = input.duration_seconds;
    let durationSeconds = exports.DEFAULT_IMPERSONATION_SECONDS;
    if (rawSeconds !== undefined && rawSeconds !== null && rawSeconds !== '') {
        if (typeof rawSeconds !== 'number' || !Number.isInteger(rawSeconds)) {
            return { ok: false, error: 'duration_seconds must be an integer number of seconds' };
        }
        if (rawSeconds < 1 || rawSeconds > exports.MAX_IMPERSONATION_SECONDS) {
            return { ok: false, error: `duration_seconds must be between 1 and ${exports.MAX_IMPERSONATION_SECONDS}` };
        }
        durationSeconds = rawSeconds;
    }
    return {
        ok: true,
        value: { targetUserId, tenantId, reason, scope: rawScope, durationSeconds },
    };
};
exports.validateStartInput = validateStartInput;
const createImpersonationService = (deps) => {
    const idFactory = deps.idFactory ?? crypto_1.randomUUID;
    const buildRow = (input, starterId, expiresAt) => ({
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
        start: async (starterId, input) => {
            try {
                return await deps.transaction(async (tx) => {
                    // A support actor may never open a session against their OWN
                    // identity: the bearer of the context must be the actor and
                    // the effective principal the target, so a self-target row
                    // would make the two indistinguishable. Denied before the
                    // lock so no phantom pending row is written.
                    if (String(starterId) === String(input.targetUserId)) {
                        return { ok: false, reason: 'self_target' };
                    }
                    const lockedTarget = await tx.lockTargetUser(input.targetUserId);
                    if (!lockedTarget)
                        return { ok: false, reason: 'target_not_lockable' };
                    const active = await tx.countActiveForTargetUser(input.targetUserId);
                    if (active > 0)
                        return { ok: false, reason: 'target_active_session' };
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
                    return { ok: true, session: row };
                });
            }
            catch (error) {
                console.error('Impersonation start failed:', error);
                return { ok: false, reason: 'store_error' };
            }
        },
        /**
         * Activation by a DIFFERENT admin inside one transaction: locked read,
         * guarded transition and sealed audit commit or roll back together.
         * The expiry is clamped to <= 30 minutes.
         */
        approve: async (sessionId, approverId) => {
            try {
                return await deps.transaction(async (tx) => {
                    const row = await tx.lockSession(sessionId);
                    if (!row)
                        return { ok: false, reason: 'not_found' };
                    if (row.status !== 'pending_approval')
                        return { ok: false, reason: 'not_pending' };
                    if (String(row.started_by) === String(approverId))
                        return { ok: false, reason: 'self_approval' };
                    const requested = Number(row.requested_seconds ?? exports.DEFAULT_IMPERSONATION_SECONDS);
                    const seconds = Number.isFinite(requested) && requested > 0
                        ? Math.min(requested, exports.MAX_IMPERSONATION_SECONDS)
                        : exports.DEFAULT_IMPERSONATION_SECONDS;
                    const now = deps.now();
                    const requestedExpiry = new Date(now.getTime() + seconds * 1000);
                    const existingExpiry = row.expires_at ? new Date(row.expires_at) : null;
                    const bounded = existingExpiry && !Number.isNaN(existingExpiry.getTime())
                        && existingExpiry.getTime() < requestedExpiry.getTime()
                        ? existingExpiry
                        : requestedExpiry;
                    const moved = await tx.transitionToActive(sessionId, approverId, bounded, now);
                    if (moved !== 1)
                        return { ok: false, reason: 'besides_transition' };
                    const session = await tx.findSession(sessionId);
                    // Impossible with a locked, just-updated primary key; throw so
                    // the transaction rolls the activation back rather than
                    // committing a session we cannot read.
                    if (!session)
                        throw new Error('The activated impersonation session could not be re-read');
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
                    return { ok: true, session, expiresAt: bounded };
                });
            }
            catch (error) {
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
        revoke: async (sessionId, revokedBy) => {
            try {
                return await deps.transaction(async (tx) => {
                    const row = await tx.lockSession(sessionId);
                    if (!row)
                        return { ok: false, reason: 'not_found' };
                    if (row.status !== 'active' && row.status !== 'pending_approval') {
                        return { ok: false, reason: 'not_revocable' };
                    }
                    const now = deps.now();
                    const moved = await tx.transitionToRevoked(sessionId, revokedBy, now);
                    if (moved !== 1)
                        return { ok: false, reason: 'besides_transition' };
                    const session = await tx.findSession(sessionId);
                    // Impossible with a locked, just-updated primary key; throw so
                    // the transaction rolls the revocation back rather than
                    // committing a session we cannot read.
                    if (!session)
                        throw new Error('The revoked impersonation session could not be re-read');
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
                    return { ok: true, session };
                });
            }
            catch (error) {
                console.error('Impersonation revoke failed:', error);
                return { ok: false, reason: 'store_error' };
            }
        },
        getSession: (sessionId) => deps.store.findSession(sessionId),
        listForActor: (actorUserId, limit) => deps.store.listRecentForActor(actorUserId, limit),
    };
};
exports.createImpersonationService = createImpersonationService;
/* ----------------------------------------------------------------------- */
/* Issued context token: HMAC-signed, banner facts included, short-lived.   */
/* ----------------------------------------------------------------------- */
const toB64Url = (value) => Buffer.from(value, 'utf8').toString('base64url');
const fromB64Url = (value) => Buffer.from(value, 'base64url').toString('utf8');
/**
 * Fail-closed signing prerequisite. The provider is the ONLY source of key
 * material; it must return at least 32 bytes and must not be the shared JWT
 * secret (a compromised session token must not be able to mint impersonation
 * contexts). A throwing provider is treated as missing, never as success.
 */
const resolveImpersonationSigningKey = async (provider, options = {}) => {
    let candidate;
    try {
        candidate = await provider();
    }
    catch {
        return { ok: false, reason: 'missing' };
    }
    if (!candidate)
        return { ok: false, reason: 'missing' };
    if (!Buffer.isBuffer(candidate) || candidate.length < exports.MIN_IMPERSONATION_SIGNING_KEY_BYTES) {
        return { ok: false, reason: 'invalid' };
    }
    const jwtSecret = options.jwtSecret;
    if (jwtSecret && jwtSecret.length > 0 && candidate.equals(Buffer.from(jwtSecret, 'utf8'))) {
        return { ok: false, reason: 'invalid' };
    }
    return { ok: true, key: candidate };
};
exports.resolveImpersonationSigningKey = resolveImpersonationSigningKey;
const signImpersonationToken = (session, writeScope, key, nowMs) => {
    if (!Buffer.isBuffer(key) || key.length < exports.MIN_IMPERSONATION_SIGNING_KEY_BYTES) {
        throw new Error('An impersonation signing key of at least 32 bytes is required');
    }
    const parts = [
        exports.IMPERSONATION_TOKEN_VERSION,
        toB64Url(session.id),
        toB64Url(String(session.started_by)),
        toB64Url(String(session.target_user_id)),
        toB64Url(String(session.tenant_id)),
        writeScope ? 'w1' : 'w0',
        String(Math.floor(nowMs / 1000)),
    ];
    const mac = (0, crypto_1.createHmac)('sha256', key).update(parts.join('|'), 'utf8').digest('base64url');
    return [...parts, mac].join('.');
};
exports.signImpersonationToken = signImpersonationToken;
exports.IMPERSONATION_WRITE_FLAGS = { read: 'w0', write: 'w1' };
const parseImpersonationToken = (token) => {
    if (typeof token !== 'string')
        return null;
    const parts = token.split('.');
    if (parts.length !== 8 || parts[0] !== exports.IMPERSONATION_TOKEN_VERSION)
        return null;
    try {
        const scope = parts[5] === exports.IMPERSONATION_WRITE_FLAGS.write ? 'write' : 'read';
        return {
            sessionId: fromB64Url(parts[1]),
            actorUserId: fromB64Url(parts[2]),
            targetUserId: fromB64Url(parts[3]),
            tenantId: fromB64Url(parts[4]),
            scope: scope,
            banner: { impersonated: true, sessionId: fromB64Url(parts[1]), tenantId: fromB64Url(parts[4]), scope: scope },
        };
    }
    catch {
        return null;
    }
};
exports.parseImpersonationToken = parseImpersonationToken;
const contextMacPayload = (parts) => parts.join('|');
const expectedImpersonationMac = (token, key) => {
    const parts = token.split('.');
    return (0, crypto_1.createHmac)('sha256', key).update(contextMacPayload(parts.slice(0, 7)), 'utf8').digest('base64url');
};
exports.expectedImpersonationMac = expectedImpersonationMac;
const checkImpersonationSignature = (token, key) => {
    const parts = token.split('.');
    if (parts.length !== 8 || parts[0] !== exports.IMPERSONATION_TOKEN_VERSION)
        return false;
    const expected = Buffer.from((0, exports.expectedImpersonationMac)(token, key), 'utf8');
    const supplied = Buffer.from(parts[7], 'utf8');
    if (supplied.length !== expected.length)
        return false;
    return (0, crypto_1.timingSafeEqual)(supplied, expected);
};
exports.checkImpersonationSignature = checkImpersonationSignature;
/**
 * Verification seam the shared auth middleware can adopt later. Deny-by-
 * default: signature, expiry and then the LIVE session row (immediate
 * revocation, scope/expiry/tenant consistency) before a context is issued.
 * The signed context's scope flag must equal the live row's scope (the row
 * is authoritative — a write-flagged context over a read row, or the
 * reverse, is a `row_mismatch`), and the live row's `expires_at` is the
 * only expiry authority; the signed field records the issue time only.
 */
const createImpersonationVerifier = (deps) => async (token) => {
    try {
        if (typeof token !== 'string' || token.length > 4096)
            return { ok: false, reason: 'malformed' };
        const context = (0, exports.parseImpersonationToken)(token);
        if (!context)
            return { ok: false, reason: 'malformed' };
        const key = await deps.tokenKey();
        if (!key)
            return { ok: false, reason: 'store_error' };
        if (!(0, exports.checkImpersonationSignature)(token, key)) {
            return { ok: false, reason: 'signature' };
        }
        const row = await deps.store.findSession(context.sessionId);
        if (!row)
            return { ok: false, reason: 'not_active' };
        if (row.status !== 'active')
            return { ok: false, reason: 'not_active' };
        const expires = row.expires_at ? new Date(row.expires_at).getTime() : 0;
        if (!expires || Number.isNaN(expires) || deps.now().getTime() >= expires) {
            return { ok: false, reason: 'expired' };
        }
        if (String(row.started_by) !== context.actorUserId ||
            String(row.target_user_id) !== context.targetUserId ||
            String(row.tenant_id) !== context.tenantId ||
            String(row.scope) !== context.scope) {
            return { ok: false, reason: 'row_mismatch' };
        }
        return { ok: true, context };
    }
    catch (error) {
        console.error('Impersonation verification failed:', error);
        return { ok: false, reason: 'store_error' };
    }
};
exports.createImpersonationVerifier = createImpersonationVerifier;
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
const matchImpersonationPrincipal = (context, principal) => {
    if (!principal || !principal.userId)
        return { ok: false, reason: 'unauthenticated' };
    if (String(principal.userId) !== context.actorUserId)
        return { ok: false, reason: 'actor_mismatch' };
    if (principal.tenantId != null && String(principal.tenantId) !== context.tenantId) {
        return { ok: false, reason: 'tenant_mismatch' };
    }
    return { ok: true };
};
exports.matchImpersonationPrincipal = matchImpersonationPrincipal;
const ACTION_TOKENS = {
    password_change: ['password', 'passwd', 'credentialexchange'],
    mfa_change: ['mfa', 'totp', 'twofactor', '2fa', 'recoverycode', 'recovery', 'stepup'],
    money_movement: ['wallet', 'withdraw', 'withdrawal', 'payout', 'refund', 'topup', 'topuprequest', 'invoice', 'billing'],
    data_delete: ['delete', 'destroy', 'purge', 'permanenterase', 'harddelete'],
};
const tokenizeAction = (action) => action.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0);
const classifyProtectedAction = (action) => {
    const tokens = new Set(tokenizeAction(action));
    const kinds = ['password_change', 'mfa_change', 'money_movement', 'data_delete'];
    for (const kind of kinds) {
        for (const token of ACTION_TOKENS[kind]) {
            if (tokens.has(token) || tokens.has(`${token}s`) || tokens.has(`${token}d`) || tokens.has(`${token}ed`)) {
                return kind;
            }
        }
    }
    return null;
};
exports.classifyProtectedAction = classifyProtectedAction;
/**
 * Deny helper adopters call before any mutation. Protected actions are
 * blocked even with an explicit write scope, and a read scope allows NO
 * mutations at all — every mutating action is denied with the `read_only`
 * protection, so the documented read-only guarantee holds regardless of
 * whether the adopter also calls `requireImpersonationWriteScope`.
 */
const evaluateImpersonationWrite = (context, action) => {
    if (!context)
        return { blocked: false };
    const protection = (0, exports.classifyProtectedAction)(action);
    if (protection)
        return { blocked: true, protection };
    if (context.scope === 'read')
        return { blocked: true, protection: 'read_only' };
    return { blocked: false };
};
exports.evaluateImpersonationWrite = evaluateImpersonationWrite;
const requireImpersonationWriteScope = (context) => context.scope === 'write' ? { ok: true } : { ok: false, error: 'Impersonation session is read-only' };
exports.requireImpersonationWriteScope = requireImpersonationWriteScope;
const noopImpersonationNotificationHook = async () => undefined;
exports.noopImpersonationNotificationHook = noopImpersonationNotificationHook;
const notifyTenantOwnerSafely = async (hook, event) => {
    try {
        await hook(event);
    }
    catch (error) {
        console.error('Impersonation tenant-owner notification failed:', error);
    }
};
exports.notifyTenantOwnerSafely = notifyTenantOwnerSafely;
const createImpersonationRateLimiter = (options) => {
    const buckets = new Map();
    return {
        tryConsume: (key) => {
            const nowMs = options.now().getTime();
            const bucket = buckets.get(key);
            if (!bucket || nowMs - bucket.windowStart >= options.windowMs) {
                buckets.set(key, { windowStart: nowMs, count: 1 });
                return true;
            }
            if (bucket.count >= options.max)
                return false;
            bucket.count += 1;
            return true;
        },
    };
};
exports.createImpersonationRateLimiter = createImpersonationRateLimiter;
exports.IMPERSONATION_RATE_LIMITS = {
    start: { max: 5, windowMs: 10 * 60000 },
    approve: { max: 10, windowMs: 10 * 60000 },
};
/* ----------------------------------------------------------------------- */
/* SQL store implementation (wired in the production route module).         */
/* ----------------------------------------------------------------------- */
const createSqlImpersonationStore = (db) => ({
    insertSession: async (row) => {
        await db.execute(`INSERT INTO impersonation_sessions
             (id, started_by, approved_by, target_user_id, tenant_id, reason, scope,
              status, requested_seconds, expires_at, revoked_at, revoked_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            row.id, row.started_by, row.approved_by, row.target_user_id, row.tenant_id,
            row.reason, row.scope, row.status, row.requested_seconds ?? null,
            row.expires_at ?? null, row.revoked_at ?? null, row.revoked_by ?? null,
        ]);
    },
    findSession: async (sessionId) => {
        if (!sessionId || sessionId.length > 64)
            return null;
        return db.queryOne(`SELECT id, started_by, approved_by, target_user_id, tenant_id, reason, scope,
                    status, requested_seconds, expires_at, revoked_at, revoked_by, created_at
             FROM impersonation_sessions WHERE id = ? LIMIT 1`, [sessionId]);
    },
    lockSession: async (sessionId) => {
        if (!sessionId || sessionId.length > 64)
            return null;
        // Callers must already be inside the approval transaction; MySQL keeps
        // the row lock until that transaction commits or rolls back.
        return db.queryOne(`SELECT id, started_by, approved_by, target_user_id, tenant_id, reason, scope,
                    status, requested_seconds, expires_at, revoked_at, revoked_by, created_at
             FROM impersonation_sessions WHERE id = ? LIMIT 1 FOR UPDATE`, [sessionId]);
    },
    lockTargetUser: async (targetUserId) => {
        if (!targetUserId || targetUserId.length > 64)
            return null;
        // Serializes concurrent starts for the same target: the row lock is
        // held until the surrounding start transaction commits or rolls back,
        // so the count-then-insert dedupe cannot be raced by a second start
        // for the same target. The caller must already be inside that
        // transaction.
        return db.queryOne(`SELECT id FROM users WHERE id = ? LIMIT 1 FOR UPDATE`, [targetUserId]);
    },
    transitionToActive: async (sessionId, approverId, expiresAt, now) => {
        // `expires_at` is bound as a Date, exactly like `insertSession` does
        // for the same column: the driver formats it with the pool's
        // `timezone` and decodes the column with the same offset, so the
        // instant survives the write/read pair. Pre-formatting it here (a UTC
        // wall-clock string, as this once did) used the opposite convention
        // and stored an expiry two hours in the past, which made every
        // activated session unusable.
        const result = await db.execute(`UPDATE impersonation_sessions
             SET approved_by = ?, status = 'active', expires_at = ?, updated_at = ?
             WHERE id = ? AND status = 'pending_approval' AND started_by <> ?`, [approverId, expiresAt, rowStamp(now), sessionId, approverId]);
        return result.affectedRows ?? 0;
    },
    transitionToRevoked: async (sessionId, revokedBy, now) => {
        const result = await db.execute(`UPDATE impersonation_sessions
             SET status = 'revoked', revoked_at = ?, revoked_by = ?, updated_at = ?
             WHERE id = ? AND status IN ('pending_approval', 'active')`, [rowStamp(now), revokedBy, rowStamp(now), sessionId]);
        return result.affectedRows ?? 0;
    },
    listRecentForActor: async (actorUserId, limit) => {
        const bounded = Math.max(1, Math.min(100, Number(limit) || 50));
        return db.query(`SELECT id, started_by, approved_by, target_user_id, tenant_id, reason, scope,
                    status, requested_seconds, expires_at, revoked_at, revoked_by, created_at
             FROM impersonation_sessions
             WHERE started_by = ? OR approved_by = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ${bounded}`, [actorUserId, actorUserId]);
    },
    countActiveForTargetUser: async (targetUserId) => {
        const rows = await db.query(`SELECT COUNT(*) AS total FROM impersonation_sessions
             WHERE target_user_id = ? AND status IN ('active', 'pending_approval')`, [targetUserId]);
        return Number(rows[0]?.total ?? 0);
    },
});
exports.createSqlImpersonationStore = createSqlImpersonationStore;
const rowStamp = (now) => now.toISOString().slice(0, 19).replace('T', ' ');
