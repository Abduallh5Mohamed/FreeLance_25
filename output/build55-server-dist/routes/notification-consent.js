"use strict";
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
exports.createNotificationConsentRouter = void 0;
const express_1 = require("express");
const notification_consent_1 = require("../services/notification-consent");
const notification_preferences_1 = require("../services/notification-preferences");
const notification_outbox_1 = require("../services/notification-outbox");
const parseChannelBody = (body) => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, error: 'Body must be an object' };
    }
    const record = body;
    const allowed = new Set(['channel', 'purpose', 'note']);
    const unknown = Object.keys(record).filter((key) => !allowed.has(key));
    if (unknown.length > 0)
        return { ok: false, error: `Unknown field: ${unknown[0]}` };
    if (!(0, notification_preferences_1.isNotificationChannel)(record['channel']))
        return { ok: false, error: 'Unknown channel' };
    let purpose;
    if (record['purpose'] !== undefined) {
        if (!(0, notification_consent_1.isConsentPurpose)(record['purpose']))
            return { ok: false, error: 'Unknown consent purpose' };
        purpose = record['purpose'];
    }
    const note = record['note'] === undefined ? null : record['note'];
    if (note !== null && (typeof note !== 'string' || note.length === 0 || note.length > 200)) {
        return { ok: false, error: 'note must be 1-200 characters' };
    }
    return { ok: true, channel: record['channel'], purpose };
};
const principalUserType = (req, res) => {
    const user = req.user;
    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return null;
    }
    if (!(0, notification_consent_1.isConsentUserType)(user.role)) {
        res.status(403).json({ error: 'Account type is not eligible for notification consent' });
        return null;
    }
    return user.role;
};
/** Server-derived, token-bound scope: nobody else's rows are reachable. */
const ownerScope = (req, res) => {
    const userType = principalUserType(req, res);
    if (userType === null)
        return null;
    const user = req.user;
    return { userId: user.id, userType, tenantId: user.tenantId ?? null };
};
const resolveUnsubscribeSecret = (deps, res) => {
    try {
        return (0, notification_outbox_1.resolveLinkSecret)(deps.getLinkSecret());
    }
    catch (error) {
        if (error instanceof notification_outbox_1.LinkSecretMissingError) {
            res.status(503).json({ error: 'Unsubscribe links are unavailable' });
            return null;
        }
        throw error;
    }
};
const parseUnsubscribeTarget = (payload) => {
    if (payload.kind !== 'unsubscribe') {
        return { ok: false, error: 'Link is not an unsubscribe link' };
    }
    if (typeof payload.userId !== 'string' || payload.userId.trim().length === 0) {
        return { ok: false, error: 'Unsubscribe link is malformed' };
    }
    if (typeof payload.userType !== 'string' || payload.userType.trim().length === 0) {
        return { ok: false, error: 'Unsubscribe link is malformed' };
    }
    let channel = null;
    if (payload.channel !== null) {
        if (!(0, notification_preferences_1.isNotificationChannel)(payload.channel)) {
            return { ok: false, error: 'Unsubscribe link has an unknown channel' };
        }
        channel = payload.channel;
    }
    let purpose = null;
    if (payload.purpose !== null) {
        if (!(0, notification_consent_1.isConsentPurpose)(payload.purpose)) {
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
const createNotificationConsentRouter = (deps) => {
    const router = (0, express_1.Router)();
    const { db } = deps;
    const hasAtomic = () => typeof deps.transaction === 'function'
        || typeof deps.withTransaction === 'function' || typeof db.transaction === 'function';
    const runAtomic = (fn) => {
        // Preserve receiver binding and never downgrade a mutation to autocommit.
        if (typeof deps.transaction === 'function')
            return deps.transaction(fn);
        if (typeof deps.withTransaction === 'function')
            return deps.withTransaction(fn);
        if (typeof db.transaction === 'function')
            return db.transaction(fn);
        return Promise.reject(new Error('Notification consent transaction unavailable'));
    };
    const requireAtomic = (_req, res, next) => {
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
    router.post('/unsubscribe', requireAtomic, async (req, res) => {
        try {
            const body = (typeof req.body === 'object' && req.body !== null ? req.body : {});
            if (typeof body['token'] !== 'string' || body['token'].length === 0) {
                return res.status(400).json({ error: 'token is required' });
            }
            const secret = resolveUnsubscribeSecret(deps, res);
            if (secret === null)
                return;
            const verified = (0, notification_outbox_1.verifySecureLink)(body['token'], secret, deps.now);
            if (!verified.ok) {
                return res.status(403).json({ error: 'Unsubscribe link is invalid or expired' });
            }
            const parsed = parseUnsubscribeTarget(verified.payload);
            if (!parsed.ok) {
                return res.status(400).json({ error: parsed.error });
            }
            const { userId, userType, channel, purpose } = parsed.value;
            if (!(0, notification_consent_1.isConsentUserType)(userType)) {
                return res.status(403).json({ error: 'Account type is not eligible for notification consent' });
            }
            const success = {
                status: 'unsubscribed',
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
                const firstUse = await (0, notification_consent_1.consumeUnsubscribeToken)(tx, {
                    jti: verified.payload.jti,
                    userId,
                    userType,
                    now: deps.now,
                });
                if (!firstUse)
                    return false;
                if (channel && purpose) {
                    await (0, notification_consent_1.recordConsent)(tx, {
                        userId,
                        userType,
                        purpose,
                        channel,
                        action: 'revoke',
                        source: notification_consent_1.UNSUBSCRIBE_SOURCE,
                        recordedBy: notification_consent_1.UNSUBSCRIBE_SOURCE,
                        now: deps.now,
                    });
                }
                else if (channel) {
                    await (0, notification_consent_1.recordChannelStop)(tx, {
                        userId,
                        userType,
                        channel,
                        source: notification_consent_1.UNSUBSCRIBE_SOURCE,
                        recordedBy: notification_consent_1.UNSUBSCRIBE_SOURCE,
                        now: deps.now,
                    });
                }
                else {
                    for (const ch of notification_preferences_1.NOTIFICATION_CHANNELS) {
                        await (0, notification_consent_1.recordChannelStop)(tx, {
                            userId,
                            userType,
                            channel: ch,
                            source: notification_consent_1.UNSUBSCRIBE_SOURCE,
                            recordedBy: notification_consent_1.UNSUBSCRIBE_SOURCE,
                            now: deps.now,
                        });
                    }
                }
                return true;
            });
            return res.json(success);
        }
        catch {
            console.error('Unsubscribe error');
            res.status(500).json({ error: 'Failed to process unsubscribe' });
        }
    });
    router.use(deps.authenticate);
    router.post('/unsubscribe-link', async (req, res) => {
        try {
            const scope = ownerScope(req, res);
            if (scope === null)
                return;
            const parsed = parseChannelBody(req.body);
            if (!parsed.ok)
                return res.status(400).json({ error: parsed.error });
            const secret = resolveUnsubscribeSecret(deps, res);
            if (secret === null)
                return;
            const token = (0, notification_outbox_1.signSecureLink)({
                kind: 'unsubscribe',
                ref: 'unsubscribe',
                userId: scope.userId,
                userType: scope.userType,
                purpose: parsed.purpose ?? null,
                channel: parsed.channel,
            }, secret, { ttlSeconds: notification_outbox_1.unsubscribeLinkTtlSecondsDefault, now: deps.now });
            return res.json({ token });
        }
        catch {
            console.error('Unsubscribe link error');
            res.status(500).json({ error: 'Failed to create unsubscribe link' });
        }
    });
    router.get('/', async (req, res) => {
        try {
            const scope = ownerScope(req, res);
            if (scope === null)
                return;
            const limit = (0, notification_consent_1.clampConsentHistoryLimit)(req.query['limit']);
            if (limit === null)
                return res.status(400).json({ error: 'limit must be a positive integer' });
            const history = await (0, notification_consent_1.fetchConsentHistory)(db, { userId: scope.userId, userType: scope.userType, limit });
            return res.json(history);
        }
        catch {
            console.error('Consent history error');
            res.status(500).json({ error: 'Failed to load consent history' });
        }
    });
    router.get('/state', async (req, res) => {
        try {
            const scope = ownerScope(req, res);
            if (scope === null)
                return;
            const state = await (0, notification_consent_1.effectiveConsentMap)(db, scope.userId, scope.userType);
            return res.json({ state });
        }
        catch {
            console.error('Consent state error');
            res.status(500).json({ error: 'Failed to load consent state' });
        }
    });
    router.post('/', requireAtomic, async (req, res) => {
        try {
            const scope = ownerScope(req, res);
            if (scope === null)
                return;
            const parsed = (0, notification_consent_1.parseConsentInput)(req.body);
            if (!parsed.ok)
                return res.status(400).json({ error: parsed.error });
            const { event, allowed } = await runAtomic(async (tx) => {
                const recorded = await (0, notification_consent_1.recordConsent)(tx, {
                    userId: scope.userId,
                    userType: scope.userType,
                    purpose: parsed.value.purpose,
                    channel: parsed.value.channel,
                    action: parsed.value.action,
                    source: notification_consent_1.OWNER_SOURCE,
                    tenantId: scope.tenantId,
                    recordedBy: scope.userId,
                    now: deps.now,
                });
                const resolved = await (0, notification_consent_1.canDeliverTo)(tx, {
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
        }
        catch {
            console.error('Record consent error');
            res.status(500).json({ error: 'Failed to record consent' });
        }
    });
    // Whole-channel stop (the in-app equivalent of an SMS STOP keyword): one
    // call revokes every purpose on the channel, immediately and append-only.
    router.post('/stop', requireAtomic, async (req, res) => {
        try {
            const scope = ownerScope(req, res);
            if (scope === null)
                return;
            const parsed = parseChannelBody(req.body);
            if (!parsed.ok)
                return res.status(400).json({ error: parsed.error });
            const events = await runAtomic((tx) => (0, notification_consent_1.recordChannelStop)(tx, {
                userId: scope.userId,
                userType: scope.userType,
                channel: parsed.channel,
                source: notification_consent_1.STOP_SOURCE,
                tenantId: scope.tenantId,
                recordedBy: scope.userId,
                now: deps.now,
            }));
            return res.json({ status: 'stopped', channel: parsed.channel, purposes: events.length });
        }
        catch {
            console.error('Stop channel consent error');
            res.status(500).json({ error: 'Failed to stop channel' });
        }
    });
    return router;
};
exports.createNotificationConsentRouter = createNotificationConsentRouter;
/* Production wiring: real pool, real auth, real link-secret lookup. */
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
};
const productionTransaction = async (fn) => {
    const { withTransaction } = await loadDb();
    return withTransaction((connection) => fn({
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
    }));
};
exports.default = (0, exports.createNotificationConsentRouter)({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await Promise.resolve().then(() => __importStar(require('../middleware/auth')));
        return authenticateToken(req, res, next);
    },
    getLinkSecret: () => process.env.NOTIFICATION_LINK_SECRET,
    transaction: productionTransaction,
});
