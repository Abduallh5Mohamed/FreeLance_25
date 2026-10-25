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

import { randomUUID } from 'crypto';
import {
    NOTIFICATION_CHANNELS,
    isNotificationChannel,
    type NotificationChannel,
} from './notification-preferences';

export interface NotificationDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
    transaction?: <T>(fn: (tx: NotificationDataAccess) => Promise<T>) => Promise<T>;
}

export const CONSENT_PURPOSES = [
    'announcements',
    'lesson_updates',
    'schedule_changes',
    'billing_reminders',
    'progress_report',
] as const;

export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const CONSENT_SOURCES = [
    'account_settings',
    'stop_message',
    'unsubscribe_link',
    'support',
] as const;

export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/** Sources an authenticated owner route is allowed to assert. */
export const OWNER_SOURCE: ConsentSource = 'account_settings';

/** Sources that can only be written outside the owner route (system trust). */
export const STOP_SOURCE: ConsentSource = 'stop_message';
export const UNSUBSCRIBE_SOURCE: ConsentSource = 'unsubscribe_link';

/** Principal namespaces eligible to hold consent (server-derived from role). */
export const CONSENT_USER_TYPES = new Set(['student', 'parent', 'admin', 'instructor']);

export type ConsentAction = 'grant' | 'revoke';

export interface ConsentEventRow {
    id: string;
    seq?: number;
    tenant_id: string | null;
    user_id: string;
    user_type: string;
    purpose: string;
    channel: string;
    action: string;
    source: string;
    recorded_by: string | null;
    recorded_at: string | Date;
}

export interface ConsentDecisionInput {
    userId: string;
    userType: string;
    purpose: string;
    channel: string;
}

export interface ConsentRecordInput {
    userId: string;
    userType: string;
    purpose: string;
    channel: string;
    action: ConsentAction;
    source: ConsentSource;
    tenantId?: string | null;
    recordedBy?: string | null;
    now?: () => Date;
}

export interface ConsentParseOk {
    ok: true;
    value: { purpose: ConsentPurpose; channel: NotificationChannel; action: ConsentAction };
}

export interface ConsentParseFail {
    ok: false;
    error: string;
}

export type ConsentParseResult = ConsentParseOk | ConsentParseFail;

export const isConsentPurpose = (value: unknown): value is ConsentPurpose =>
    typeof value === 'string' && (CONSENT_PURPOSES as readonly string[]).includes(value);

export const isConsentSource = (value: unknown): value is ConsentSource =>
    typeof value === 'string' && (CONSENT_SOURCES as readonly string[]).includes(value);

export const isConsentUserType = (value: unknown): boolean =>
    typeof value === 'string' && CONSENT_USER_TYPES.has(value);

export const isConsentAction = (value: unknown): value is ConsentAction =>
    value === 'grant' || value === 'revoke';

/** Quiet defaults mirror notification-preferences: in-app on, external off. */
export const defaultConsentFor = (channel: string): boolean => channel === 'in_app';

/**
 * Strict validation for POST bodies. purpose/channel/action must be real
 * enum members; source can only be the owner source if supplied (a client
 * claiming 'stop_message' is rejected so consent provenance stays truthful);
 * unknown fields and non-object bodies are rejected.
 */
export const parseConsentInput = (body: unknown): ConsentParseResult => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, error: 'Consent body must be an object' };
    }
    const record = body as Record<string, unknown>;
    const allowed = new Set(['purpose', 'channel', 'action', 'source', 'note']);
    const unknown = Object.keys(record).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
        return { ok: false, error: `Unknown consent field: ${unknown[0]}` };
    }
    if (!isConsentPurpose(record['purpose'])) {
        return { ok: false, error: 'Unknown consent purpose' };
    }
    if (!isNotificationChannel(record['channel'])) {
        return { ok: false, error: 'Unknown consent channel' };
    }
    if (!isConsentAction(record['action'])) {
        return { ok: false, error: 'action must be grant or revoke' };
    }
    if (record['source'] !== undefined) {
        if (!isConsentSource(record['source'])) {
            return { ok: false, error: 'Unknown consent source' };
        }
        if (record['source'] !== OWNER_SOURCE) {
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

const isDuplicateError = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ER_DUP_ENTRY';

export interface ConsumeUnsubscribeTokenInput {
    jti: string;
    userId: string;
    userType: string;
    now?: () => Date;
}

/**
 * L2: single-use unsubscribe tokens. The signed token's `jti` is persisted the
 * first time it is presented; the unique primary key turns any replay into a
 * handled duplicate. Returns true on first use, false when the token was
 * already consumed, so the caller can answer a replay with a harmless
 * idempotent success and never re-apply a revoke.
 */
export const consumeUnsubscribeToken = async (
    db: NotificationDataAccess,
    input: ConsumeUnsubscribeTokenInput,
): Promise<boolean> => {
    try {
        await db.execute(
            `INSERT INTO notification_unsubscribe_token_uses (jti, user_id, user_type, consumed_at)
             VALUES (?, ?, ?, ?)`,
            [input.jti, input.userId, input.userType, (input.now ?? (() => new Date()))()],
        );
        return true;
    } catch (error) {
        if (isDuplicateError(error)) return false;
        throw error;
    }
};

const assertRecordable = (input: ConsentRecordInput): void => {
    if (!isConsentPurpose(input.purpose)) throw new Error('recordConsent requires a known purpose');
    if (!isNotificationChannel(input.channel)) throw new Error('recordConsent requires a known channel');
    if (!isConsentAction(input.action)) throw new Error('recordConsent requires a grant/revoke action');
    if (!isConsentSource(input.source)) throw new Error('recordConsent requires a known source');
    if (!isConsentUserType(input.userType)) throw new Error('recordConsent requires a server-derived user type');
};

/** Appends one consent event. Never updates, never deletes (append-only). */
export const recordConsent = async (
    db: NotificationDataAccess,
    input: ConsentRecordInput,
): Promise<ConsentEventRow> => {
    assertRecordable(input);
    const event: ConsentEventRow = {
        id: randomUUID(),
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
    await db.execute(
        `INSERT INTO notification_consent_events
         (id, tenant_id, user_id, user_type, purpose, channel, action, source, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
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
        ],
    );
    return event;
};

/**
 * STOP semantics: one event revokes the whole channel across every purpose at
 * once. Because the ledger is latest-wins, this overrides any earlier grant and
 * canDeliverTo denies immediately — even for already-queued outbox rows, which
 * re-check consent at dispatch time.
 */
export const recordChannelStop = async (
    db: NotificationDataAccess,
    input: Omit<ConsentRecordInput, 'purpose' | 'action'>,
): Promise<ConsentEventRow[]> => {
    assertRecordable({ ...input, purpose: CONSENT_PURPOSES[0], action: 'revoke' });
    const events: ConsentEventRow[] = [];
    for (const purpose of CONSENT_PURPOSES) {
        events.push(await recordConsent(db, { ...input, purpose, action: 'revoke' }));
    }
    return events;
};

/** Latest event for (user, type, purpose, channel); seq is the tie-breaker so
 * events within the same second still resolve deterministically newest-first. */
export const latestConsentEvent = async (
    db: NotificationDataAccess,
    input: ConsentDecisionInput,
): Promise<ConsentEventRow | null> => {
    const row = await db.queryOne<ConsentEventRow>(
        `SELECT id, seq, tenant_id, user_id, user_type, purpose, channel, action, source, recorded_by, recorded_at
         FROM notification_consent_events
         WHERE user_id = ? AND user_type = ? AND purpose = ? AND channel = ?
         ORDER BY seq DESC
         LIMIT 1`,
        [input.userId, input.userType, input.purpose, input.channel],
    );
    return row ?? null;
};

/**
 * The single delivery gate. Latest event wins; no events means quiet defaults;
 * a revoke — of any source, including STOP — always denies.
 */
export const consentAllows = (row: ConsentEventRow | null, channel: string): boolean => {
    if (!row || row.channel !== channel) return defaultConsentFor(channel);
    return row.action === 'grant';
};

export const canDeliverTo = async (
    db: NotificationDataAccess,
    input: ConsentDecisionInput,
): Promise<boolean> => consentAllows(await latestConsentEvent(db, input), input.channel);

export interface ConsentHistoryInput {
    userId: string;
    userType: string;
    limit?: number;
}

const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 200;

export const clampConsentHistoryLimit = (raw: unknown): number | null => {
    if (raw === undefined || raw === '') return DEFAULT_HISTORY_LIMIT;
    const parsed = Array.isArray(raw) ? Number.NaN : Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) return null;
    return Math.min(parsed, MAX_HISTORY_LIMIT);
};

/** Bounded newest-first history. Every row is the caller's own vision only. */
export const fetchConsentHistory = async (
    db: NotificationDataAccess,
    input: ConsentHistoryInput,
): Promise<ConsentEventRow[]> => {
    if (!isConsentUserType(input.userType)) return [];
    const requested = input.limit;
    const limit = typeof requested === 'number' && Number.isInteger(requested)
        ? Math.min(Math.max(requested, 1), MAX_HISTORY_LIMIT)
        : DEFAULT_HISTORY_LIMIT;
    return db.query<ConsentEventRow>(
        `SELECT id, seq, tenant_id, user_id, user_type, purpose, channel, action, source, recorded_by, recorded_at
         FROM notification_consent_events
         WHERE user_id = ? AND user_type = ?
         ORDER BY seq DESC
         LIMIT ${limit}`,
        [input.userId, input.userType],
    );
};

/** Latest-wins reduction of a newest-first event list into effective state. */
export const reduceConsentState = (
    eventsNewestFirst: ConsentEventRow[],
): Record<string, boolean> => {
    const latestByKey = new Map<string, ConsentEventRow>();
    for (const event of eventsNewestFirst) {
        const key = `${event.purpose}:${event.channel}`;
        if (!latestByKey.has(key)) latestByKey.set(key, event);
    }
    const state: Record<string, boolean> = {};
    for (const purpose of CONSENT_PURPOSES) {
        for (const channel of NOTIFICATION_CHANNELS) {
            const key = `${purpose}:${channel}`;
            state[key] = consentAllows(latestByKey.get(key) ?? null, channel);
        }
    }
    return state;
};

export const effectiveConsentMap = async (
    db: NotificationDataAccess,
    userId: string,
    userType: string,
): Promise<Record<string, boolean>> => reduceConsentState(await fetchConsentHistory(db, { userId, userType, limit: MAX_HISTORY_LIMIT }));
