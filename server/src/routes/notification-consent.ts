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

export const createNotificationConsentRouter = (deps: ConsentRouteDeps): Router => {
    const router = Router();
    const { db } = deps;

    // Signed unsubscribe link: intentionally BEFORE the auth gate so an email
    // link works from a logged-out browser. It still authorizes via the
    // dedicated link secret and only ever appends a revoke to the signed
    // (userId, userType) scope — nothing else is reachable this way.
    router.post('/unsubscribe', async (req: AuthRequest, res: Response) => {
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
            const payload: SecureLinkPayload = verified.payload;
            if (!payload.userId || typeof payload.userId !== 'string' || !payload.userType || typeof payload.userType !== 'string') {
                return res.status(400).json({ error: 'Unsubscribe link is malformed' });
            }
            if (!isConsentUserType(payload.userType)) {
                return res.status(403).json({ error: 'Account type is not eligible for notification consent' });
            }
            const success = {
                status: 'unsubscribed' as const,
                channel: payload.channel ?? 'all',
                purpose: payload.purpose ?? 'all',
            };
            // L2: consume the token's jti exactly once. A replay (same link
            // opened twice, or a prefetch/scanner hitting it) is a harmless
            // idempotent success: the consent state was already applied on the
            // first, single use and is never re-applied.
            const firstUse = await consumeUnsubscribeToken(db, {
                jti: payload.jti,
                userId: payload.userId,
                userType: payload.userType,
                now: deps.now,
            });
            if (!firstUse) {
                return res.json(success);
            }
            if (payload.channel && isNotificationChannel(payload.channel)) {
                if (payload.purpose) {
                    await recordConsent(db, {
                        userId: payload.userId,
                        userType: payload.userType,
                        purpose: payload.purpose,
                        channel: payload.channel,
                        action: 'revoke',
                        source: UNSUBSCRIBE_SOURCE,
                        recordedBy: UNSUBSCRIBE_SOURCE,
                        now: deps.now,
                    });
                } else {
                    await recordChannelStop(db, {
                        userId: payload.userId,
                        userType: payload.userType,
                        channel: payload.channel,
                        source: UNSUBSCRIBE_SOURCE,
                        recordedBy: UNSUBSCRIBE_SOURCE,
                        now: deps.now,
                    });
                }
            } else {
                for (const channel of NOTIFICATION_CHANNELS) {
                    await recordChannelStop(db, {
                        userId: payload.userId,
                        userType: payload.userType,
                        channel,
                        source: UNSUBSCRIBE_SOURCE,
                        recordedBy: UNSUBSCRIBE_SOURCE,
                        now: deps.now,
                    });
                }
            }
            return res.json(success);
        } catch (error) {
            console.error('Unsubscribe error:', error);
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
        } catch (error) {
            console.error('Unsubscribe link error:', error);
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
        } catch (error) {
            console.error('Consent history error:', error);
            res.status(500).json({ error: 'Failed to load consent history' });
        }
    });

    router.get('/state', async (req: AuthRequest, res: Response) => {
        try {
            const scope = ownerScope(req, res);
            if (scope === null) return;
            const state = await effectiveConsentMap(db, scope.userId, scope.userType);
            return res.json({ state });
        } catch (error) {
            console.error('Consent state error:', error);
            res.status(500).json({ error: 'Failed to load consent state' });
        }
    });

    router.post('/', async (req: AuthRequest, res: Response) => {
        try {
            const scope = ownerScope(req, res);
            if (scope === null) return;
            const parsed = parseConsentInput(req.body);
            if (!parsed.ok) return res.status(400).json({ error: parsed.error });
            const event = await recordConsent(db, {
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
            const allowed = await canDeliverTo(db, {
                userId: scope.userId,
                userType: scope.userType,
                purpose: parsed.value.purpose,
                channel: parsed.value.channel,
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
        } catch (error) {
            console.error('Record consent error:', error);
            res.status(500).json({ error: 'Failed to record consent' });
        }
    });

    // Whole-channel stop (the in-app equivalent of an SMS STOP keyword): one
    // call revokes every purpose on the channel, immediately and append-only.
    router.post('/stop', async (req: AuthRequest, res: Response) => {
        try {
            const scope = ownerScope(req, res);
            if (scope === null) return;
            const parsed = parseChannelBody(req.body);
            if (!parsed.ok) return res.status(400).json({ error: parsed.error });
            const events = await recordChannelStop(db, {
                userId: scope.userId,
                userType: scope.userType,
                channel: parsed.channel,
                source: STOP_SOURCE,
                tenantId: scope.tenantId,
                recordedBy: scope.userId,
                now: deps.now,
            });
            return res.json({ status: 'stopped', channel: parsed.channel, purposes: events.length });
        } catch (error) {
            console.error('Stop channel consent error:', error);
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

export default createNotificationConsentRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    getLinkSecret: () => process.env.NOTIFICATION_LINK_SECRET,
});
