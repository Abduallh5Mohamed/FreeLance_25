"use strict";
/**
 * M6 P3 — purpose/channel notification consent ledger.
 *
 * Consent is an append-only log: a grant or revoke is a new event; the latest
 * event for (user, purpose, channel) wins. An explicit revoke — especially a
 * STOP / unsubscribe event — denies delivery immediately because every send
 * decision must re-read the ledger at send time (see
 * services/notification-outbox.ts dispatch), never a cached flag.
 *
 * Deny-by-default: no events means quiet defaults (in-app allowed, every
 * external channel denied), mirroring services/notification-preferences.ts.
 * Owner-asserted sources can never forge a system source: `stop_message`,
 * `unsubscribe_link` and `support` events are only ever written by the
 * provider webhook path, the signed unsubscribe link or an internal flow —
 * the authenticated owner route forces source 'account_settings'.
 *
 * Rows are keyed by (user_id, user_type) where user_type is the
 * server-derived principal namespace (never client input), mirroring
 * services/notification-preferences.ts. Persistence contract: table
 * notification_consent_events is created by the versioned migration
 * 20261018_14_notification_outbox_consent.sql and table
 * notification_unsubscribe_token_uses by 20261018_21_unsubscribe_token_use.sql
 * (never at runtime).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.effectiveConsentMap = exports.reduceConsentState = exports.fetchConsentHistory = exports.clampConsentHistoryLimit = exports.canDeliverTo = exports.consentAllows = exports.latestConsentEvent = exports.recordChannelStop = exports.recordConsent = exports.consumeUnsubscribeToken = exports.parseConsentInput = exports.defaultConsentFor = exports.isConsentAction = exports.isConsentUserType = exports.isConsentSource = exports.isConsentPurpose = exports.CONSENT_USER_TYPES = exports.UNSUBSCRIBE_SOURCE = exports.STOP_SOURCE = exports.OWNER_SOURCE = exports.CONSENT_SOURCES = exports.CONSENT_PURPOSES = void 0;
const crypto_1 = require("crypto");
const notification_preferences_1 = require("./notification-preferences");
exports.CONSENT_PURPOSES = [
    'announcements',
    'lesson_updates',
    'schedule_changes',
    'billing_reminders',
    'progress_report',
];
exports.CONSENT_SOURCES = [
    'account_settings',
    'stop_message',
    'unsubscribe_link',
    'support',
];
/** Sources an authenticated owner route is allowed to assert. */
exports.OWNER_SOURCE = 'account_settings';
/** Sources that can only be written outside the owner route (system trust). */
exports.STOP_SOURCE = 'stop_message';
exports.UNSUBSCRIBE_SOURCE = 'unsubscribe_link';
/** Principal namespaces eligible to hold consent (server-derived from role). */
exports.CONSENT_USER_TYPES = new Set(['student', 'parent', 'admin', 'instructor']);
const isConsentPurpose = (value) => typeof value === 'string' && exports.CONSENT_PURPOSES.includes(value);
exports.isConsentPurpose = isConsentPurpose;
const isConsentSource = (value) => typeof value === 'string' && exports.CONSENT_SOURCES.includes(value);
exports.isConsentSource = isConsentSource;
const isConsentUserType = (value) => typeof value === 'string' && exports.CONSENT_USER_TYPES.has(value);
exports.isConsentUserType = isConsentUserType;
const isConsentAction = (value) => value === 'grant' || value === 'revoke';
exports.isConsentAction = isConsentAction;
/** Quiet defaults mirror notification-preferences: in-app on, external off. */
const defaultConsentFor = (channel) => channel === 'in_app';
exports.defaultConsentFor = defaultConsentFor;
/**
 * Strict validation for POST bodies. purpose/channel/action must be real
 * enum members; source can only be the owner source if supplied (a client
 * claiming 'stop_message' is rejected so consent provenance stays truthful);
 * unknown fields and non-object bodies are rejected.
 */
const parseConsentInput = (body) => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, error: 'Consent body must be an object' };
    }
    const record = body;
    const allowed = new Set(['purpose', 'channel', 'action', 'source', 'note']);
    const unknown = Object.keys(record).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
        return { ok: false, error: `Unknown consent field: ${unknown[0]}` };
    }
    if (!(0, exports.isConsentPurpose)(record['purpose'])) {
        return { ok: false, error: 'Unknown consent purpose' };
    }
    if (!(0, notification_preferences_1.isNotificationChannel)(record['channel'])) {
        return { ok: false, error: 'Unknown consent channel' };
    }
    if (!(0, exports.isConsentAction)(record['action'])) {
        return { ok: false, error: 'action must be grant or revoke' };
    }
    if (record['source'] !== undefined) {
        if (!(0, exports.isConsentSource)(record['source'])) {
            return { ok: false, error: 'Unknown consent source' };
        }
        if (record['source'] !== exports.OWNER_SOURCE) {
            return { ok: false, error: 'Consent source cannot be self-asserted' };
        }
    }
    const note = record['note'] === undefined ? null : record['note'];
    if (note !== null && typeof note !== 'string') {
        return { ok: false, error: 'note must be a string' };
    }
    if (typeof note === 'string' && (note.trim().length === 0 || note.length > 200)) {
        return { ok: false, error: 'note must be 1-200 characters' };
    }
    return { ok: true, value: { purpose: record['purpose'], channel: record['channel'], action: record['action'] } };
};
exports.parseConsentInput = parseConsentInput;
const isDuplicateError = (error) => typeof error === 'object' && error !== null && error.code === 'ER_DUP_ENTRY';
/**
 * L2: single-use unsubscribe tokens. The signed token's `jti` is persisted the
 * first time it is presented; the unique primary key turns any replay into a
 * handled duplicate. Returns true on first use, false when the token was
 * already consumed, so the caller can answer a replay with a harmless
 * idempotent success and never re-apply a revoke.
 */
const consumeUnsubscribeToken = async (db, input) => {
    try {
        await db.execute(`INSERT INTO notification_unsubscribe_token_uses (jti, user_id, user_type, consumed_at)
             VALUES (?, ?, ?, ?)`, [input.jti, input.userId, input.userType, (input.now ?? (() => new Date()))()]);
        return true;
    }
    catch (error) {
        if (isDuplicateError(error))
            return false;
        throw error;
    }
};
exports.consumeUnsubscribeToken = consumeUnsubscribeToken;
const assertRecordable = (input) => {
    if (!(0, exports.isConsentPurpose)(input.purpose))
        throw new Error('recordConsent requires a known purpose');
    if (!(0, notification_preferences_1.isNotificationChannel)(input.channel))
        throw new Error('recordConsent requires a known channel');
    if (!(0, exports.isConsentAction)(input.action))
        throw new Error('recordConsent requires a grant/revoke action');
    if (!(0, exports.isConsentSource)(input.source))
        throw new Error('recordConsent requires a known source');
    if (!(0, exports.isConsentUserType)(input.userType))
        throw new Error('recordConsent requires a server-derived user type');
};
/** Appends one consent event. Never updates, never deletes (append-only). */
const recordConsent = async (db, input) => {
    assertRecordable(input);
    const event = {
        id: (0, crypto_1.randomUUID)(),
        tenant_id: input.tenantId ?? null,
        user_id: input.userId,
        user_type: input.userType,
        purpose: input.purpose,
        channel: input.channel,
        action: input.action,
        source: input.source,
        recorded_by: input.recordedBy ?? null,
        recorded_at: (input.now ?? (() => new Date()))(),
    };
    await db.execute(`INSERT INTO notification_consent_events
         (id, tenant_id, user_id, user_type, purpose, channel, action, source, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        event.id,
        event.tenant_id,
        event.user_id,
        event.user_type,
        event.purpose,
        event.channel,
        event.action,
        event.source,
        event.recorded_by,
        event.recorded_at,
    ]);
    return event;
};
exports.recordConsent = recordConsent;
/**
 * STOP semantics: one event revokes the whole channel across every purpose at
 * once. Because the ledger is latest-wins, this overrides any earlier grant and
 * canDeliverTo denies immediately — even for already-queued outbox rows, which
 * re-check consent at dispatch time.
 */
const recordChannelStop = async (db, input) => {
    assertRecordable({ ...input, purpose: exports.CONSENT_PURPOSES[0], action: 'revoke' });
    const events = [];
    for (const purpose of exports.CONSENT_PURPOSES) {
        events.push(await (0, exports.recordConsent)(db, { ...input, purpose, action: 'revoke' }));
    }
    return events;
};
exports.recordChannelStop = recordChannelStop;
/** Latest event for (user, type, purpose, channel); seq is the tie-breaker so
 * events within the same second still resolve deterministically newest-first. */
const latestConsentEvent = async (db, input) => {
    const row = await db.queryOne(`SELECT id, seq, tenant_id, user_id, user_type, purpose, channel, action, source, recorded_by, recorded_at
         FROM notification_consent_events
         WHERE user_id = ? AND user_type = ? AND purpose = ? AND channel = ?
         ORDER BY seq DESC
         LIMIT 1`, [input.userId, input.userType, input.purpose, input.channel]);
    return row ?? null;
};
exports.latestConsentEvent = latestConsentEvent;
/**
 * The single delivery gate. Latest event wins; no events means quiet defaults;
 * a revoke — of any source, including STOP — always denies.
 */
const consentAllows = (row, channel) => {
    if (!row || row.channel !== channel)
        return (0, exports.defaultConsentFor)(channel);
    return row.action === 'grant';
};
exports.consentAllows = consentAllows;
const canDeliverTo = async (db, input) => (0, exports.consentAllows)(await (0, exports.latestConsentEvent)(db, input), input.channel);
exports.canDeliverTo = canDeliverTo;
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 200;
const clampConsentHistoryLimit = (raw) => {
    if (raw === undefined || raw === '')
        return DEFAULT_HISTORY_LIMIT;
    const parsed = Array.isArray(raw) ? Number.NaN : Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1)
        return null;
    return Math.min(parsed, MAX_HISTORY_LIMIT);
};
exports.clampConsentHistoryLimit = clampConsentHistoryLimit;
/** Bounded newest-first history. Every row is the caller's own vision only. */
const fetchConsentHistory = async (db, input) => {
    if (!(0, exports.isConsentUserType)(input.userType))
        return [];
    const requested = input.limit;
    const limit = typeof requested === 'number' && Number.isInteger(requested)
        ? Math.min(Math.max(requested, 1), MAX_HISTORY_LIMIT)
        : DEFAULT_HISTORY_LIMIT;
    return db.query(`SELECT id, seq, tenant_id, user_id, user_type, purpose, channel, action, source, recorded_by, recorded_at
         FROM notification_consent_events
         WHERE user_id = ? AND user_type = ?
         ORDER BY seq DESC
         LIMIT ${limit}`, [input.userId, input.userType]);
};
exports.fetchConsentHistory = fetchConsentHistory;
/** Latest-wins reduction of a newest-first event list into effective state. */
const reduceConsentState = (eventsNewestFirst) => {
    const latestByKey = new Map();
    for (const event of eventsNewestFirst) {
        const key = `${event.purpose}:${event.channel}`;
        if (!latestByKey.has(key))
            latestByKey.set(key, event);
    }
    const state = {};
    for (const purpose of exports.CONSENT_PURPOSES) {
        for (const channel of notification_preferences_1.NOTIFICATION_CHANNELS) {
            const key = `${purpose}:${channel}`;
            state[key] = (0, exports.consentAllows)(latestByKey.get(key) ?? null, channel);
        }
    }
    return state;
};
exports.reduceConsentState = reduceConsentState;
const effectiveConsentMap = async (db, userId, userType) => (0, exports.reduceConsentState)(await (0, exports.fetchConsentHistory)(db, { userId, userType, limit: MAX_HISTORY_LIMIT }));
exports.effectiveConsentMap = effectiveConsentMap;
