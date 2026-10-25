/**
 * M6 P3 — notification consent routes (purpose/channel opt-in and STOP).
 *
 * Owner rules:
 *  - The principal namespace (user_type) is the server-derived role, never a
 *    client value; roles outside the eligible set are denied.
 *  - A caller can only ever read or write their OWN consent rows; every SQL
 *    statement is bound to (user_id, user_type) from the token.
 *  - A client can only assert source 'account_settings' — provenance for
 *    'stop_message'/'unsubscribe_link'/'support' events stays system-owned.
 *  - The signed unsubscribe link is the one unauthenticated surface: it
 *    verifies against the dedicated NOTIFICATION_LINK_SECRET and appends a
 *    revoke (source 'unsubscribe_link') whose effect is immediate because the
 *    delivery path re-checks the ledger at send time. Unsubscribe links are
 *    short-lived (24h default) and single-use: the token's jti is consumed on
 *    first presentation, so a replay returns an idempotent success without
 *    re-applying any revoke.
 *
 * This module exports `createNotificationConsentRouter(deps)`; production
 * wiring (real pool + real auth) is the default export at the bottom. No
 * runtime DDL.
 */

import { Router, RequestHandler, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import {
    canDeliverTo,
    clampConsentHistoryLimit,
    consumeUnsubscribeToken,
    effectiveConsentMap,
    fetchConsentHistory,
    isConsentPurpose,
    isConsentUserType,
    OWNER_SOURCE,
    parseConsentInput,
    recordChannelStop,
    recordConsent,
    STOP_SOURCE,
    UNSUBSCRIBE_SOURCE,
    type ConsentPurpose,
    type NotificationDataAccess,
} from '../services/notification-consent';
import {
    isNotificationChannel,
    NOTIFICATION_CHANNELS,
    type NotificationChannel,
} from '../services/notification-preferences';
import {
    LinkSecretMissingError,
    resolveLinkSecret,
    signSecureLink,
    unsubscribeLinkTtlSecondsDefault,
    verifySecureLink,
    type SecureLinkPayload,
} from '../services/notification-outbox';

export interface ConsentRouteDeps {
    db: NotificationDataAccess;
    authenticate: RequestHandler;
    now?: () => Date;
    /** Dedicated link secret store; a missing/short secret fails closed. */
    getLinkSecret: () => string | undefined;
    /** Optional atomic seam (production: pooled transaction). */
    transaction?: <T>(fn: (tx: NotificationDataAccess) => Promise<T>) => Promise<T>;
    /** Alias for the atomic seam, mirroring other route families. */
    withTransaction?: <T>(fn: (tx: NotificationDataAccess) => Promise<T>) => Promise<T>;
}

interface ChannelBody {
    ok: true;
    channel: NotificationChannel;
    purpose?: string;
}

const parseChannelBody = (body: unknown): ChannelBody | { ok: false; error: string } => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, error: 'Body must be an object' };
    }
    const record = body as Record<string, unknown>;
    const allowed = new Set(['channel', 'purpose', 'note']);
    const unknown = Object.keys(record).filter((key) => !allowed.has(key));
    if (unknown.length > 0) return { ok: false, error: `Unknown field: ${unknown[0]}` };
    if (!isNotificationChannel(record['channel'])) return { ok: false, error: 'Unknown channel' };
    let purpose: string | undefined;
    if (record['purpose'] !== undefined) {
        if (!isConsentPurpose(record['purpose'])) return { ok: false, error: 'Unknown consent purpose' };
        purpose = record['purpose'];
    }
    const note = record['note'] === undefined ? null : record['note'];
    if (note !== null && (typeof note !== 'string' || note.length === 0 || note.length > 200)) {
        return { ok: false, error: 'note must be 1-200 characters' };
    }
    return { ok: true, channel: record['channel'], purpose };
};

const principalUserType = (req: AuthRequest, res: Response): string | null => {
    const user = req.user;
    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return null;
    }
    if (!isConsentUserType(user.role)) {
        res.status(403).json({ error: 'Account type is not eligible for notification consent' });
        return null;
    }
    return user.role;
};

interface OwnerScope {
    userId: string;
    userType: string;
    tenantId: string | null;
}

/** Server-derived, token-bound scope: nobody else's rows are reachable. */
const ownerScope = (req: AuthRequest, res: Response): OwnerScope | null => {
    const userType = principalUserType(req, res);
    if (userType === null) return null;
    const user = req.user!;
    return { userId: user.id, userType, tenantId: user.tenantId ?? null };
};

const resolveUnsubscribeSecret = (deps: ConsentRouteDeps, res: Response): string | null => {
    try {
        return resolveLinkSecret(deps.getLinkSecret());
    } catch (error) {
        if (error instanceof LinkSecretMissingError) {
            res.status(503).json({ error: 'Unsubscribe links are unavailable' });
            return null;
        }
        throw error;
    }
};

interface UnsubscribeTarget {
    userId: string;
    userType: string;
    channel: NotificationChannel | null;
    purpose: ConsentPurpose | null;
}

const parseUnsubscribeTarget = (
    payload: SecureLinkPayload,
): { ok: true; value: UnsubscribeTarget } | { ok: false; error: string } => {
    if (payload.kind !== 'unsubscribe') {
        return { ok: false, error: 'Link is not an unsubscribe link' };
    }
    if (typeof payload.userId !== 'string' || payload.userId.trim().length === 0) {
        return { ok: false, error: 'Unsubscribe link is malformed' };
    }
    if (typeof payload.userType !== 'string' || payload.userType.trim().length === 0) {
        return { ok: false, error: 'Unsubscribe link is malformed' };
    }
    let channel: NotificationChannel | null = null;
    if (payload.channel !== null) {
        if (!isNotificationChannel(payload.channel)) {
            return { ok: false, error: 'Unsubscribe link has an unknown channel' };
        }
        channel = payload.channel;
    }
    let purpose: ConsentPurpose | null = null;
    if (payload.purpose !== null) {
        if (!isConsentPurpose(payload.purpose)) {
            return { ok: false, error: 'Unsubscribe link has an unknown purpose' };
        }
        purpose = payload.purpose;
    }
    if (purpose !== null && channel === null) {
        return { ok: false, error: 'Unsubscribe link purpose requires a channel' };
    }
    return {
        ok: true,
        value: {
            userId: payload.userId,
            userType: payload.userType,
            channel,
            purpose,
        },
    };
};

export const createNotificationConsentRouter = (deps: ConsentRouteDeps): Router => {
    const router = Router();
    const { db } = deps;

    const hasAtomic = () => typeof deps.transaction === 'function'
        || typeof deps.withTransaction === 'function' || typeof db.transaction === 'function';
    const runAtomic = <T>(fn: (tx: NotificationDataAccess) => Promise<T>): Promise<T> => {
        // Preserve receiver binding and never downgrade a mutation to autocommit.
        if (typeof deps.transaction === 'function') return deps.transaction(fn);
        if (typeof deps.withTransaction === 'function') return deps.withTransaction(fn);
        if (typeof db.transaction === 'function') return db.transaction(fn);
        return Promise.reject(new Error('Notification consent transaction unavailable'));
    };
    const requireAtomic: RequestHandler = (_req, res, next) => {
        if (!hasAtomic()) {
            res.status(503).json({ error: 'Consent updates are temporarily unavailable', code: 'CONSENT_TRANSACTION_UNAVAILABLE' });
            return;
        }
        next();
    };

    // Signed unsubscribe link: intentionally BEFORE the auth gate so an email
    // link works from a logged-out browser. It still authorizes via the
    // dedicated link secret and only ever appends a revoke to the signed
    // (userId, userType) scope — nothing else is reachable this way.
    router.post('/unsubscribe', requireAtomic, async (req: AuthRequest, res: Response) => {
        try {
            const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
            if (typeof body['token'] !== 'string' || body['token'].length === 0) {
                return res.status(400).json({ error: 'token is required' });
            }
            const secret = resolveUnsubscribeSecret(deps, res);
            if (secret === null) return;
            const verified = verifySecureLink(body['token'], secret, deps.now);
            if (!verified.ok) {
                return res.status(403).json({ error: 'Unsubscribe link is invalid or expired' });
            }
            const parsed = parseUnsubscribeTarget(verified.payload);
            if (!parsed.ok) {
                return res.status(400).json({ error: parsed.error });
            }
            const { userId, userType, channel, purpose } = parsed.value;
            if (!isConsentUserType(userType)) {
                return res.status(403).json({ error: 'Account type is not eligible for notification consent' });
            }
            const success = {
                status: 'unsubscribed' as const,
                channel: channel ?? 'all',
                purpose: purpose ?? 'all',
            };
            // L2: consume the token's jti exactly once, in the SAME transaction
            // as the consent writes. A replay is an idempotent success; a failed
            // ledger write rolls back the token consumption so the token stays
            // reusable. The signed token's tenant/global semantics are preserved:
            // no tenant is guessed from request/client input and a global
            // unsubscribe is never narrowed.
            await runAtomic(async (tx) => {
                const firstUse = await consumeUnsubscribeToken(tx, {
                    jti: verified.payload.jti,
                    userId,
                    userType,
                    now: deps.now,
                });
                if (!firstUse) return false;
                if (channel && purpose) {
                    await recordConsent(tx, {
                        userId,
                        userType,
                        purpose,
                        channel,
                        action: 'revoke',
                        source: UNSUBSCRIBE_SOURCE,
                        recordedBy: UNSUBSCRIBE_SOURCE,
                        now: deps.now,
                    });
                } else if (channel) {
                    await recordChannelStop(tx, {
                        userId,
                        userType,
                        channel,
                        source: UNSUBSCRIBE_SOURCE,
                        recordedBy: UNSUBSCRIBE_SOURCE,
                        now: deps.now,
                    });
                } else {
                    for (const ch of NOTIFICATION_CHANNELS) {
                        await recordChannelStop(tx, {
                            userId,
                            userType,
                            channel: ch,
                            source: UNSUBSCRIBE_SOURCE,
                            recordedBy: UNSUBSCRIBE_SOURCE,
                            now: deps.now,
                        });
                    }
                }
                return true;
            });
            return res.json(success);
        } catch {
            console.error('Unsubscribe error');
            res.status(500).json({ error: 'Failed to process unsubscribe' });
        }
    });

    router.use(deps.authenticate);

    router.post('/unsubscribe-link', async (req: AuthRequest, res: Response) => {
        try {
            const scope = ownerScope(req, res);
            if (scope === null) return;
            const parsed = parseChannelBody(req.body);
            if (!parsed.ok) return res.status(400).json({ error: parsed.error });
            const secret = resolveUnsubscribeSecret(deps, res);
            if (secret === null) return;
            const token = signSecureLink(
                {
                    kind: 'unsubscribe',
                    ref: 'unsubscribe',
                    userId: scope.userId,
                    userType: scope.userType,
                    purpose: parsed.purpose ?? null,
                    channel: parsed.channel,
                },
                secret,
                { ttlSeconds: unsubscribeLinkTtlSecondsDefault, now: deps.now },
            );
            return res.json({ token });
        } catch {
            console.error('Unsubscribe link error');
            res.status(500).json({ error: 'Failed to create unsubscribe link' });
        }
    });

    router.get('/', async (req: AuthRequest, res: Response) => {
        try {
            const scope = ownerScope(req, res);
            if (scope === null) return;
            const limit = clampConsentHistoryLimit(req.query['limit']);
            if (limit === null) return res.status(400).json({ error: 'limit must be a positive integer' });
            const history = await fetchConsentHistory(db, { userId: scope.userId, userType: scope.userType, limit });
            return res.json(history);
        } catch {
            console.error('Consent history error');
            res.status(500).json({ error: 'Failed to load consent history' });
        }
    });

    router.get('/state', async (req: AuthRequest, res: Response) => {
        try {
            const scope = ownerScope(req, res);
            if (scope === null) return;
            const state = await effectiveConsentMap(db, scope.userId, scope.userType);
            return res.json({ state });
        } catch {
            console.error('Consent state error');
            res.status(500).json({ error: 'Failed to load consent state' });
        }
    });

    router.post('/', requireAtomic, async (req: AuthRequest, res: Response) => {
        try {
            const scope = ownerScope(req, res);
            if (scope === null) return;
            const parsed = parseConsentInput(req.body);
            if (!parsed.ok) return res.status(400).json({ error: parsed.error });
            const { event, allowed } = await runAtomic(async (tx) => {
                const recorded = await recordConsent(tx, {
                    userId: scope.userId,
                    userType: scope.userType,
                    purpose: parsed.value.purpose,
                    channel: parsed.value.channel,
                    action: parsed.value.action,
                    source: OWNER_SOURCE,
                    tenantId: scope.tenantId,
                    recordedBy: scope.userId,
                    now: deps.now,
                });
                const resolved = await canDeliverTo(tx, {
                    userId: scope.userId,
                    userType: scope.userType,
                    purpose: parsed.value.purpose,
                    channel: parsed.value.channel,
                });
                return { event: recorded, allowed: resolved };
            });
            return res.status(201).json({
                id: event.id,
                purpose: event.purpose,
                channel: event.channel,
                action: event.action,
                source: event.source,
                recorded_at: event.recorded_at,
                resolved_state: allowed ? 'allowed' : 'denied',
            });
        } catch {
            console.error('Record consent error');
            res.status(500).json({ error: 'Failed to record consent' });
        }
    });

    // Whole-channel stop (the in-app equivalent of an SMS STOP keyword): one
    // call revokes every purpose on the channel, immediately and append-only.
    router.post('/stop', requireAtomic, async (req: AuthRequest, res: Response) => {
        try {
            const scope = ownerScope(req, res);
            if (scope === null) return;
            const parsed = parseChannelBody(req.body);
            if (!parsed.ok) return res.status(400).json({ error: parsed.error });
            const events = await runAtomic((tx) => recordChannelStop(tx, {
                userId: scope.userId,
                userType: scope.userType,
                channel: parsed.channel,
                source: STOP_SOURCE,
                tenantId: scope.tenantId,
                recordedBy: scope.userId,
                now: deps.now,
            }));
            return res.json({ status: 'stopped', channel: parsed.channel, purposes: events.length });
        } catch {
            console.error('Stop channel consent error');
            res.status(500).json({ error: 'Failed to stop channel' });
        }
    });

    return router;
};

/* Production wiring: real pool, real auth, real link-secret lookup. */

let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

const productionDb: NotificationDataAccess = {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { query } = await loadDb();
        return query<T>(sql, params as never);
    },
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { queryOne } = await loadDb();
        return queryOne<T>(sql, params as never);
    },
    execute: async (sql: string, params?: unknown[]) => {
        const { execute } = await loadDb();
        return execute(sql, params as never);
    },
};

const productionTransaction = async <T>(fn: (tx: NotificationDataAccess) => Promise<T>): Promise<T> => {
    const { withTransaction } = await loadDb();
    return withTransaction((connection) => fn({
        query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
            const [rows] = await connection.query(sql, params as never);
            return rows as R[];
        },
        queryOne: async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
            const [rows] = await connection.query(sql, params as never);
            return (rows as R[])[0] ?? null;
        },
        execute: async (sql: string, params?: unknown[]) => {
            const [result] = await connection.execute(sql, params as never);
            const header = result as { insertId?: number; affectedRows?: number };
            return { insertId: header.insertId ?? 0, affectedRows: header.affectedRows ?? 0 };
        },
    }));
};

export default createNotificationConsentRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    getLinkSecret: () => process.env.NOTIFICATION_LINK_SECRET,
    transaction: productionTransaction,
});
