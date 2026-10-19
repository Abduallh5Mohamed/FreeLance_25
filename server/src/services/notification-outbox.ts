/**
 * M6 P4 — event outbox and in-app/email delivery, plus P7 parent report flow.
 *
 * Outbox rows are the durable record of one delivery attempt stream: every row
 * is keyed by a caller-supplied idempotency key (a duplicate enqueue never
 * queues twice), holds its locale template variables and moves through
 * pending → sending → sent | retried-pending | failed | bounced | cancelled.
 *
 * Retries are bounded: a failed send schedules the next attempt at a bounded
 * backoff (60s→300s…) and only up to max attempts, idempotently guarded by a
 * conditional claim UPDATE so two concurrent dispatchers cannot both claim.
 *
 * STOP/consent is honored immediately: every dispatch re-checks consent right
 * before the adapter fires, so a revoke cancels even already-queued rows.
 *
 * Links embedded in messages are signed with a dedicated
 * NOTIFICATION_LINK_SECRET (>= 32 bytes; missing/short secret fails closed)
 * and expire by construction — the verify path refuses expired/tampered tokens.
 *
 * Delivery adapters are injected (no provider/network inside this module) and
 * every outcome — including channel proof and failure reasons — is written as
 * a sanitized receipt/log entry that carries no PII.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { isNotificationChannel, type NotificationChannel } from './notification-preferences';
import type { NotificationDataAccess } from './notification-consent';
import {
    sanitizeDeliveryLog,
    sanitizeProof,
    contactRef,
    redactPiiText,
    type ChannelSendOutcome,
    type RawDeliveryLogEntry,
} from './delivery-channels';

export type OutboxLocale = 'ar' | 'en';

export const OUTBOX_LOCALES: readonly OutboxLocale[] = ['ar', 'en'];

export const OUTBOX_STATUSES = [
    'pending',
    'sending',
    'sent',
    'failed',
    'bounced',
    'cancelled',
] as const;

export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export interface OutboxRow {
    id: string;
    idempotency_key: string;
    tenant_id: string | null;
    event_type: string;
    purpose: string;
    recipient_user_id: string;
    recipient_user_type: string;
    channel: string;
    locale: string;
    template_id: string | null;
    payload: string | Record<string, unknown>;
    status: string;
    attempts: number;
    max_attempts: number;
    next_attempt_at: string | Date;
    last_error: string | null;
    delivered_at: string | Date | null;
}

export interface EnqueueOutboxInput {
    idempotencyKey: string;
    tenantId: string | null;
    eventType: string;
    purpose: string;
    recipientUserId: string;
    recipientUserType: string;
    channel: string;
    locale: string;
    templateId?: string | null;
    payload: Record<string, unknown>;
    maxAttempts?: number;
    now?: () => Date;
}

export interface ReceiptRow {
    id: string;
    outbox_id: string;
    tenant_id: string | null;
    channel: string;
    outcome: string;
    proof: string | null;
    detail: string | null;
    recorded_at: string | Date;
}

const MIN_BACKOFF_SECONDS = 60;

/** Bounded backoff ladder: 60s, 300s, 1800s, 7200s, capped at 86400s. */
export const outboxBackoffSeconds = (attempt: number): number => {
    if (!Number.isSafeInteger(attempt) || attempt < 1) return MIN_BACKOFF_SECONDS;
    const ladder = [60, 300, 1800, 7200, 86400];
    const index = Math.min(attempt - 1, ladder.length - 1);
    return ladder[index];
};

const MAX_ATTEMPTS_DEFAULT = 5;
const MAX_ATTEMPTS_CEILING = 10;
const MAX_EVENT_LENGTH = 60;
const MAX_PURPOSE_LENGTH = 50;

export interface EnqueueOk {
    ok: true;
}

export interface EnqueueFail {
    ok: false;
    error: string;
}

export type EnqueueValidation = EnqueueOk | EnqueueFail;

export const isOutboxLocale = (value: unknown): value is OutboxLocale =>
    typeof value === 'string' && (OUTBOX_LOCALES as readonly string[]).includes(value);

/** Strict queue-time validation: a bad row never reaches the outbox table. */
export const validateEnqueueInput = (input: EnqueueOutboxInput): EnqueueValidation => {
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0 || input.idempotencyKey.length > 120) {
        return { ok: false, error: 'idempotencyKey must be 1-120 characters' };
    }
    if (typeof input.eventType !== 'string' || input.eventType.length === 0 || input.eventType.length > MAX_EVENT_LENGTH) {
        return { ok: false, error: 'eventType must be 1-60 characters' };
    }
    if (typeof input.purpose !== 'string' || input.purpose.length === 0 || input.purpose.length > MAX_PURPOSE_LENGTH) {
        return { ok: false, error: 'purpose must be 1-50 characters' };
    }
    if (typeof input.recipientUserId !== 'string' || input.recipientUserId.length === 0 || input.recipientUserId.length > 64) {
        return { ok: false, error: 'recipientUserId must be 1-64 characters' };
    }
    if (typeof input.recipientUserType !== 'string' || input.recipientUserType.length === 0 || input.recipientUserType.length > 30) {
        return { ok: false, error: 'recipientUserType must be 1-30 characters' };
    }
    if (!isNotificationChannel(input.channel)) {
        return { ok: false, error: 'Unknown delivery channel' };
    }
    if (!isOutboxLocale(input.locale)) {
        return { ok: false, error: 'locale must be ar or en' };
    }
    if (input.payload === null || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
        return { ok: false, error: 'payload must be an object' };
    }
    if (input.maxAttempts !== undefined) {
        if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > MAX_ATTEMPTS_CEILING) {
            return { ok: false, error: `maxAttempts must be 1-${MAX_ATTEMPTS_CEILING}` };
        }
    }
    return { ok: true };
};

/** Idempotent enqueue: an existing row is returned instead of duplicated. */
export const enqueueOutboxRow = async (
    db: NotificationDataAccess,
    input: EnqueueOutboxInput,
): Promise<{ ok: true; id: string; duplicate: boolean } | { ok: false; error: string }> => {
    const validation = validateEnqueueInput(input);
    if (!validation.ok) return validation;
    const existing = await db.queryOne<{ id: string }>(
        'SELECT id FROM notification_outbox WHERE idempotency_key = ? LIMIT 1',
        [input.idempotencyKey],
    );
    if (existing) return { ok: true, id: existing.id, duplicate: true };
    const id = randomUUID();
    const now = (input.now ?? (() => new Date()))();
    await db.execute(
        `INSERT INTO notification_outbox
         (id, idempotency_key, tenant_id, event_type, purpose, recipient_user_id, recipient_user_type,
          channel, locale, template_id, payload, status, attempts, max_attempts, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        [
            id,
            input.idempotencyKey,
            input.tenantId,
            input.eventType,
            input.purpose,
            input.recipientUserId,
            input.recipientUserType,
            input.channel,
            input.locale,
            input.templateId ?? null,
            JSON.stringify(input.payload),
            input.maxAttempts ?? MAX_ATTEMPTS_DEFAULT,
            now,
        ],
    );
    return { ok: true, id, duplicate: false };
};

// ---------------------------------------------------------------------------
// Locale templates (ar/en) with escaped variables
// ---------------------------------------------------------------------------

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

/** Plain-text variable: control characters are neutralized, not HTML-escaped. */
const escapeText = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, ' ');

interface TemplateSpec {
    subject: string;
    bodyText: string;
    bodyHtml: string;
    placeholders: readonly string[];
}

const SUBSCRIBE_LABEL_AR = 'إلغاء الاشتراك';
const SUBSCRIBE_LABEL_EN = 'Unsubscribe';

const TEMPLATES: Record<string, Record<OutboxLocale, TemplateSpec>> = {
    progress_report: {
        ar: {
            subject: 'تقرير التقدّم لـ {student_name}',
            bodyText: 'تقرير التقدّم لـ {student_name} عن {period}: {summary_text}. التفاصيل: {report_link}',
            bodyHtml: '<p>تقرير التقدّم لـ {student_name} عن {period}.</p><p>{summary_text}</p><p><a href="{report_link}">عرض التقرير</a>{close}</p>',
            placeholders: ['student_name', 'period', 'summary_text', 'report_link', 'unsubscribe_link'],
        },
        en: {
            subject: 'Progress report for {student_name}',
            bodyText: 'Progress report for {student_name} ({period}): {summary_text}. Details: {report_link}',
            bodyHtml: '<p>Progress report for {student_name} ({period}).</p><p>{summary_text}</p><p><a href="{report_link}">View report</a>{close}</p>',
            placeholders: ['student_name', 'period', 'summary_text', 'report_link', 'unsubscribe_link'],
        },
    },
    grade_alert: {
        ar: {
            subject: 'تنبيه درجات لـ {student_name}',
            bodyText: 'تحديث درجات لـ {student_name}: {summary_text}',
            bodyHtml: '<p>تحديث درجات لـ {student_name}.</p><p>{summary_text}</p>{close}',
            placeholders: ['student_name', 'summary_text', 'unsubscribe_link'],
        },
        en: {
            subject: 'Grade update for {student_name}',
            bodyText: 'Grade update for {student_name}: {summary_text}',
            bodyHtml: '<p>Grade update for {student_name}.</p><p>{summary_text}</p>{close}',
            placeholders: ['student_name', 'summary_text', 'unsubscribe_link'],
        },
    },
    attendance_alert: {
        ar: {
            subject: 'تنبيه حضور',
            bodyText: 'تنبيه حضور لـ {student_name}: {summary_text}',
            bodyHtml: '<p>تنبيه حضور لـ {student_name}.</p><p>{summary_text}</p>{close}',
            placeholders: ['student_name', 'summary_text', 'unsubscribe_link'],
        },
        en: {
            subject: 'Attendance alert',
            bodyText: 'Attendance alert for {student_name}: {summary_text}',
            bodyHtml: '<p>Attendance alert for {student_name}.</p><p>{summary_text}</p>{close}',
            placeholders: ['student_name', 'summary_text', 'unsubscribe_link'],
        },
    },
    announcement: {
        ar: {
            subject: '{title}',
            bodyText: '{body_text}',
            bodyHtml: '<p>{body_html}</p>{close}',
            placeholders: ['title', 'body_text', 'body_html', 'unsubscribe_link'],
        },
        en: {
            subject: '{title}',
            bodyText: '{body_text}',
            bodyHtml: '<p>{body_html}</p>{close}',
            placeholders: ['title', 'body_text', 'body_html', 'unsubscribe_link'],
        },
    },
};

export const isOutboxTemplateEvent = (eventType: string): boolean =>
    Object.prototype.hasOwnProperty.call(TEMPLATES, eventType);

export interface TemplateRenderOk {
    ok: true;
    value: { subject: string; bodyText: string; bodyHtml: string };
}

export interface TemplateRenderFail {
    ok: false;
    error: string;
}

export type TemplateRenderResult = TemplateRenderOk | TemplateRenderFail;

const substitute = (template: string, vars: Map<string, string>): string =>
    template.replace(/\{(\w+)\}/g, (match, key: string) => vars.get(key) ?? match);

/**
 * Renders a locale template with strict variable handling: every supplied
 * variable must be a known placeholder (extra variables rejected), every
 * placeholder (including unsubscribe_link) must be supplied, and text values
 * are HTML-escaped in HTML output / control-char neutralized in text output so
 * a hostile variable can never inject markup.
 */
export const renderOutboxTemplate = (
    eventType: string,
    locale: string,
    variables: Record<string, unknown>,
): TemplateRenderResult => {
    if (!isOutboxTemplateEvent(eventType)) {
        return { ok: false, error: `Unknown template event: ${eventType}` };
    }
    if (!isOutboxLocale(locale)) {
        return { ok: false, error: 'locale must be ar or en' };
    }
    if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) {
        return { ok: false, error: 'Template variables must be an object' };
    }
    const spec = TEMPLATES[eventType][locale];
    const given = variables as Record<string, unknown>;
    const unknown = Object.keys(given).filter((key) => !spec.placeholders.includes(key));
    if (unknown.length > 0) {
        return { ok: false, error: `Unknown template variable: ${unknown[0]}` };
    }
    const htmlVars = new Map<string, string>();
    const textVars = new Map<string, string>();
    for (const placeholder of spec.placeholders) {
        const raw = given[placeholder] ?? null;
        if (raw === null || raw === undefined) {
            return { ok: false, error: `Missing template variable: ${placeholder}` };
        }
        const value = typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : null;
        if (value === null || value.length === 0 || value.length > 2000) {
            return { ok: false, error: `Template variable ${placeholder} must be a scalar of 1-2000 characters` };
        }
        htmlVars.set(placeholder, escapeHtml(value));
        textVars.set(placeholder, escapeText(value));
    }
    const close = locale === 'ar'
        ? `<a href="${htmlVars.get('unsubscribe_link') ?? ''}">${SUBSCRIBE_LABEL_AR}</a>`
        : `<a href="${htmlVars.get('unsubscribe_link') ?? ''}">${SUBSCRIBE_LABEL_EN}</a>`;
    const subject = substitute(spec.subject, textVars);
    const bodyText = substitute(spec.bodyText, textVars);
    const bodyHtml = substitute(spec.bodyHtml, htmlVars).replace('{close}', close);
    const leaked = [subject, bodyText, bodyHtml].find((part) => /\{\w+\}/.test(part));
    if (leaked) return { ok: false, error: 'Template rendered with unsubstituted variables' };
    return { ok: true, value: { subject, bodyText, bodyHtml } };
};

// ---------------------------------------------------------------------------
// Signed, expiring links on a dedicated secret
// ---------------------------------------------------------------------------

export const LINK_SECRET_MIN_BYTES = 32;

export class LinkSecretMissingError extends Error {
    constructor() {
        super('NOTIFICATION_LINK_SECRET is missing or shorter than 32 bytes; refusing to sign or verify links');
        this.name = 'LinkSecretMissingError';
    }
}

/** Fails closed: a missing/short secret can never silently be skipped. */
export const resolveLinkSecret = (secret: unknown): string => {
    if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < LINK_SECRET_MIN_BYTES) {
        throw new LinkSecretMissingError();
    }
    return secret;
};

export interface SecureLinkPayload {
    kind: 'report' | 'unsubscribe';
    ref: string;
    userId: string | null;
    userType: string | null;
    purpose: string | null;
    channel: NotificationChannel | null;
    exp: number;
    jti: string;
}

const base64Url = (value: string): string =>
    Buffer.from(value, 'utf8').toString('base64url');

const fromBase64Url = (value: string): string =>
    Buffer.from(value, 'base64url').toString('utf8');

const linkSignature = (encoded: string, secret: string): string =>
    createHmac('sha256', secret).update(encoded).digest('base64url');

export const linkTtlSecondsDefault = 7 * 24 * 3600;

/**
 * Signs a link payload: base64url(json).hmac. A random jti plus expiry bound
 * the token in time; the payload itself is verified on read (never trusted).
 */
export const signSecureLink = (
    input: Omit<SecureLinkPayload, 'exp' | 'jti'>,
    secret: string,
    options: { ttlSeconds?: number; now?: () => Date } = {},
): string => {
    const resolved = resolveLinkSecret(secret);
    const now = (options.now ?? (() => new Date()))();
    const ttl = options.ttlSeconds ?? linkTtlSecondsDefault;
    if (!Number.isSafeInteger(ttl) || ttl < 1) throw new Error('Link TTL must be a positive integer of seconds');
    const payload: SecureLinkPayload = {
        ...input,
        exp: now.getTime() + ttl * 1000,
        jti: randomUUID(),
    };
    const encoded = base64Url(JSON.stringify(payload));
    return `${encoded}.${linkSignature(encoded, resolved)}`;
};

export type SecureLinkVerifyResult =
    | { ok: true; payload: SecureLinkPayload }
    | { ok: false; reason: 'malformed' | 'signature-mismatch' | 'expired' };

/** Fails closed on malformed, tampered or expired tokens. */
export const verifySecureLink = (
    token: string,
    secret: string,
    now: () => Date = () => new Date(),
): SecureLinkVerifyResult => {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 2) return { ok: false, reason: 'malformed' };
    const [encoded, signature] = parts;
    const resolved = resolveLinkSecret(secret);
    const expected = linkSignature(encoded, resolved);
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const givenBuffer = Buffer.from(signature, 'utf8');
    if (expectedBuffer.length !== givenBuffer.length || !timingSafeEqual(expectedBuffer, givenBuffer)) {
        return { ok: false, reason: 'signature-mismatch' };
    }
    let payload: unknown;
    try {
        payload = JSON.parse(fromBase64Url(encoded));
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    const record = payload as Record<string, unknown> | null;
    if (!record || typeof record !== 'object') return { ok: false, reason: 'malformed' };
    if (record['kind'] !== 'report' && record['kind'] !== 'unsubscribe') return { ok: false, reason: 'malformed' };
    if (typeof record['ref'] !== 'string') return { ok: false, reason: 'malformed' };
    if (typeof record['exp'] !== 'number' || !Number.isFinite(record['exp'])) {
        return { ok: false, reason: 'malformed' };
    }
    if (record['exp'] <= now().getTime()) return { ok: false, reason: 'expired' };
    return { ok: true, payload: payload as SecureLinkPayload };
};

// ---------------------------------------------------------------------------
// Dispatch: claim → consent → adapter → terminal state + receipt
// ---------------------------------------------------------------------------

export interface DeliveryAdapter {
    readonly channel: NotificationChannel;
    /** Bounded number of pending rows doled out per tick. */
    deliver(message: { row: OutboxRow; subject: string; bodyText: string; bodyHtml: string; templateId: string | null }): Promise<ChannelSendOutcome>;
}

export interface OutboxConsentGate {
    canDeliver(input: { userId: string; userType: string; purpose: string; channel: string }): Promise<boolean>;
}

export interface DispatchOptions {
    consent: OutboxConsentGate;
    /** Maps rendered template variables per row; MUST include the message body. */
    render: (row: OutboxRow) => TemplateRenderResult;
    /** The dedicated link secret, only reachable via a verified secret store. */
    linkSecret: string;
    now?: () => Date;
    /** Injected logger; production wires console, tests capture (PII-sanitized). */
    log?: (entry: unknown) => void;
}

export interface OutboxReceipt {
    id: string;
    outboxId: string;
    outcome: string;
    reason: string | null;
}

const parseRowPayload = (row: OutboxRow): Record<string, unknown> => {
    if (typeof row.payload === 'string') {
        try {
            const parsed: unknown = JSON.parse(row.payload);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
        } catch {
            return {};
        }
    }
    if (row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)) {
        return row.payload as Record<string, unknown>;
    }
    return {};
};

const writeReceipt = async (
    db: NotificationDataAccess,
    row: OutboxRow,
    outcome: string,
    proof: Record<string, unknown>,
    reason: string | null,
    contact: string | null,
    hmacKey: string,
): Promise<OutboxReceipt> => {
    const receipt: OutboxReceipt = {
        id: randomUUID(),
        outboxId: row.id,
        outcome,
        reason,
    };
    const safeProof = sanitizeProof(proof);
    await db.execute(
        `INSERT INTO notification_delivery_receipts
         (id, outbox_id, tenant_id, channel, outcome, proof, detail, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
        [
            receipt.id,
            row.id,
            row.tenant_id,
            row.channel,
            outcome,
            JSON.stringify({ ...safeProof, contact_ref: contact ? contactRef(contact, hmacKey) : 'ref:none' }),
            reason === null ? null : redactPiiText(reason).slice(0, 200),
        ],
    );
    return receipt;
};

const logDispatch = (options: DispatchOptions, hmacKey: string, entry: RawDeliveryLogEntry): void => {
    const sanitized = sanitizeDeliveryLog(entry, hmacKey);
    const emit = options.log ?? ((value: unknown) => console.info(value));
    emit(sanitized);
};

const finishRow = async (
    db: NotificationDataAccess,
    row: OutboxRow,
    status: OutboxStatus,
    nextAttemptAt: Date | null,
    lastError: string | null,
): Promise<boolean> => {
    const maskedError = lastError === null ? null : redactPiiText(lastError);
    const update = await db.execute(
        `UPDATE notification_outbox SET status = ?, next_attempt_at = ?, last_error = ?,
         delivered_at = CASE WHEN ? = 'sent' THEN UTC_TIMESTAMP() ELSE delivered_at END
         WHERE id = ? AND status = 'sending'`,
        [status, nextAttemptAt, maskedError, status, row.id],
    );
    return (update.affectedRows ?? 0) === 1;
};

/**
 * Idempotent per-row dispatch. The row is claimed with a conditional UPDATE
 * (status pending → sending), consent is re-checked at send time (a STOP
 * cancels the row without touching the adapter), and exactly one adapter send
 * is attempted per call. Any state other than a claimed pending row leaves the
 * row untouched.
 */
export const dispatchOutboxRow = async (
    db: NotificationDataAccess,
    rowId: string,
    adapters: readonly DeliveryAdapter[],
    options: DispatchOptions,
    hmacKey: string,
): Promise<{ dispatched: boolean; outcome: 'sent' | 'retry' | 'failed' | 'bounced' | 'cancelled' | 'skipped' }> => {
    const fetched = await db.queryOne<OutboxRow>(
        'SELECT * FROM notification_outbox WHERE id = ? LIMIT 1',
        [rowId],
    );
    // Treat the fetch as an immutable snapshot: the claim UPDATE below bumps
    // attempts in the database, never in the fetched copy.
    const row: OutboxRow | null = fetched ? { ...fetched } : null;
    if (!row || row.status !== 'pending') return { dispatched: false, outcome: 'skipped' };
    const now = options.now ?? (() => new Date());
    const claim = await db.execute(
        `UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1
         WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?`,
        [rowId, now()],
    );
    if ((claim.affectedRows ?? 0) === 0) return { dispatched: false, outcome: 'skipped' };

    const consent = await options.consent.canDeliver({
        userId: row.recipient_user_id,
        userType: row.recipient_user_type,
        purpose: row.purpose,
        channel: row.channel,
    });
    if (!consent) {
        await finishRow(db, row, 'cancelled', null, 'consent-revoked');
        await writeReceipt(db, row, 'cancelled', {}, 'consent-revoked', null, hmacKey);
        logDispatch(options, hmacKey, {
            outboxId: row.id, channel: row.channel, eventType: row.event_type, outcome: 'cancelled', reason: 'consent-revoked',
        });
        return { dispatched: true, outcome: 'cancelled' };
    }

    const attempts = row.attempts < 0 ? 0 : row.attempts;
    const maxAttempts = row.max_attempts > 0 ? row.max_attempts : MAX_ATTEMPTS_DEFAULT;
    if (attempts >= maxAttempts) {
        await finishRow(db, row, 'failed', null, 'attempt-cap-reached');
        await writeReceipt(db, row, 'failed', {}, 'attempt-cap-reached', null, hmacKey);
        return { dispatched: true, outcome: 'failed' };
    }

    const adapter = adapters.find((candidate) => candidate.channel === row.channel);
    if (!adapter) {
        // No adapter configured for this channel: fail closed and retry later.
        const retryAt = new Date(now().getTime() + outboxBackoffSeconds(attempts + 1) * 1000);
        const cappedAttempts = attempts + 1;
        if (cappedAttempts >= maxAttempts) {
            await finishRow(db, row, 'failed', null, 'no-adapter');
            logDispatch(options, hmacKey, {
                outboxId: row.id, channel: row.channel, eventType: row.event_type, outcome: 'failed', reason: 'no-adapter',
            });
            return { dispatched: true, outcome: 'failed' };
        }
        await finishRow(db, row, 'pending', retryAt, 'no-adapter');
        return { dispatched: true, outcome: 'retry' };
    }

    const payload = parseRowPayload(row);
    const rendered = options.render(row);
    if (!rendered.ok) {
        const cappedAttempts = attempts + 1;
        if (cappedAttempts >= maxAttempts) {
            await finishRow(db, row, 'failed', null, rendered.error);
            await writeReceipt(db, row, 'failed', {}, rendered.error, null, hmacKey);
            return { dispatched: true, outcome: 'failed' };
        }
        const retryAt = new Date(now().getTime() + outboxBackoffSeconds(cappedAttempts) * 1000);
        await finishRow(db, row, 'pending', retryAt, rendered.error);
        return { dispatched: true, outcome: 'retry' };
    }

    let outcome: ChannelSendOutcome;
    try {
        outcome = await adapter.deliver({
            row,
            subject: rendered.value.subject,
            bodyText: rendered.value.bodyText,
            bodyHtml: rendered.value.bodyHtml,
            templateId: row.template_id,
        });
    } catch (error) {
        outcome = { outcome: 'failed', reason: error instanceof Error ? error.message : 'delivery-threw' };
    }

    if (outcome.outcome === 'sent') {
        await finishRow(db, row, 'sent', null, null);
        await writeReceipt(db, row, 'sent', outcome.proof, null, null, hmacKey);
        logDispatch(options, hmacKey, {
            outboxId: row.id, channel: row.channel, eventType: row.event_type, outcome: 'sent', contact: null,
        });
        return { dispatched: true, outcome: 'sent' };
    }

    if (outcome.outcome === 'bounced') {
        await finishRow(db, row, 'bounced', null, outcome.reason);
        await writeReceipt(db, row, 'bounced', {}, outcome.reason, null, hmacKey);
        logDispatch(options, hmacKey, {
            outboxId: row.id, channel: row.channel, eventType: row.event_type, outcome: 'bounced', reason: outcome.reason,
        });
        return { dispatched: true, outcome: 'bounced' };
    }

    const cappedAttempts = attempts + 1;
    if (cappedAttempts >= maxAttempts) {
        await finishRow(db, row, 'failed', null, outcome.reason);
        await writeReceipt(db, row, 'failed', {}, outcome.reason, null, hmacKey);
        logDispatch(options, hmacKey, {
            outboxId: row.id, channel: row.channel, eventType: row.event_type, outcome: 'failed', reason: outcome.reason,
        });
        return { dispatched: true, outcome: 'failed' };
    }
    const retryAt = new Date(now().getTime() + outboxBackoffSeconds(cappedAttempts) * 1000);
    await finishRow(db, row, 'pending', retryAt, outcome.reason);
    await writeReceipt(db, row, 'failed', {}, outcome.reason, null, hmacKey);
    logDispatch(options, hmacKey, {
        outboxId: row.id, channel: row.channel, eventType: row.event_type, outcome: 'retry', reason: outcome.reason,
    });
    return { dispatched: true, outcome: 'retry' };
};

/** Bounded claim loop: up to limit pending rows whose next attempt is due. */
export const claimDueOutboxIds = async (
    db: NotificationDataAccess,
    limit: unknown,
    now: () => Date = () => new Date(),
): Promise<string[]> => {
    const bound = typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 ? Math.min(limit, 100) : 25;
    const rows = await db.query<{ id: string }>(
        `SELECT id FROM notification_outbox WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC LIMIT ${bound}`,
        [now()],
    );
    return rows.map((row) => row.id);
};

// ---------------------------------------------------------------------------
// P7 — parent report delivery over verified links
// ---------------------------------------------------------------------------

/** Only these summary fields can ever appear in a parent report message. */
export const PARENT_REPORT_FIELDS = [
    'student_name',
    'attendance_summary',
    'grade_summary',
    'progress_summary',
] as const;

export type ParentReportField = (typeof PARENT_REPORT_FIELDS)[number];

export const isParentReportField = (value: unknown): value is ParentReportField =>
    typeof value === 'string' && (PARENT_REPORT_FIELDS as readonly string[]).includes(value);

export interface ParentLinkChecker {
    /** Verifies (server rows only) that this parent is linked to this child. */
    isVerifiedLinkedParent(input: { tenantId: string; parentUserId: string; studentEnrollmentId: string }): Promise<boolean>;
}

export interface ParentReportSummary {
    period: string;
    locale: string;
    fields: Record<string, unknown>;
}

export interface ParentReportDeliveryInput {
    tenantId: string;
    parentUserId: string;
    /** The child enrollment the link was verified against. */
    studentEnrollmentId: string;
    channel: string;
    configuredFields: readonly string[];
    summary: ParentReportSummary;
    linkSecret: string;
    idempotencyKeySuffix?: string;
    now?: () => Date;
}

export interface ParentReportConfigOk {
    ok: true;
    value: Record<string, string>;
}

export const buildParentReportVars = (
    configuredFields: readonly string[],
    summary: ParentReportSummary,
    baseUrl: string,
): ParentReportConfigOk | { ok: false; error: string } => {
    if (typeof baseUrl !== 'string' || baseUrl.length === 0 || baseUrl.length > 300) {
        return { ok: false, error: 'Report base URL is required' };
    }
    if (!Array.isArray(configuredFields)) {
        return { ok: false, error: 'Configured report fields must be an array' };
    }
    const seen = new Set<string>();
    for (const field of configuredFields) {
        if (!isParentReportField(field)) return { ok: false, error: `Unsupported report field: ${String(field)}` };
        seen.add(field);
    }
    const studentName = summary.fields['student_name'];
    if (!isParentReportField('student_name') || typeof studentName !== 'string' || studentName.length === 0) {
        return { ok: false, error: 'Student name is required' };
    }
    if (typeof summary.period !== 'string' || summary.period.length === 0 || summary.period.length > 60) {
        return { ok: false, error: 'Report period must be 1-60 characters' };
    }
    const parts: string[] = [];
    for (const field of ['attendance_summary', 'grade_summary', 'progress_summary'] as const) {
        if (!seen.has(field)) continue;
        const value = summary.fields[field];
        if (typeof value !== 'string' || value.length === 0 || value.length > 500) {
            return { ok: false, error: `Configured field ${field} must be a 1-500 character summary value` };
        }
        parts.push(value);
    }
    if (parts.length === 0) return { ok: false, error: 'No configured report fields resolve to a summary value' };
    return {
        ok: true,
        value: {
            student_name: studentName,
            period: summary.period,
            summary_text: parts.join(' | '),
            report_link: '',
            unsubscribe_link: '',
        },
    };
};

export interface ParentReportDeliveryResult {
    ok: boolean;
    reason?: 'parent-not-linked' | 'consent-revoked' | 'validation-failed';
    error?: string;
    outboxId?: string;
    duplicate?: boolean;
}

export interface ParentReportDeliveryInput {
    tenantId: string;
    parentUserId: string;
    /** The child enrollment the link was verified against. */
    studentEnrollmentId: string;
    channel: string;
    configuredFields: readonly string[];
    summary: ParentReportSummary;
    /** Dedicated link secret (resolved by resolveLinkSecret; fails closed). */
    linkSecret: string;
    baseUrl: string;
    reportTtlSeconds?: number;
    idempotencyKeySuffix?: string;
    now?: () => Date;
}

/**
 * P7 funnel: a report is only queued when the parent is verified-linked to the
 * child (via the injected checker — parent linking logic is never imported
 * here) AND the parent's consent allows this channel/purpose. The queued
 * message contains ONLY the configured, allow-listed summary fields, and its
 * report/unsubscribe links are signed, expiring tokens minted from the
 * dedicated link secret. Nothing is written for denied or invalid paths.
 */
export const enqueueParentReportDelivery = async (
    db: NotificationDataAccess,
    linkChecker: ParentLinkChecker,
    consent: OutboxConsentGate,
    input: ParentReportDeliveryInput,
): Promise<ParentReportDeliveryResult> => {
    if (!isNotificationChannel(input.channel)) {
        return { ok: false, reason: 'validation-failed', error: 'Unknown delivery channel' };
    }
    if (!isOutboxLocale(input.summary.locale)) {
        return { ok: false, reason: 'validation-failed', error: 'locale must be ar or en' };
    }
    const linked = await linkChecker.isVerifiedLinkedParent({
        tenantId: input.tenantId,
        parentUserId: input.parentUserId,
        studentEnrollmentId: input.studentEnrollmentId,
    });
    if (!linked) return { ok: false, reason: 'parent-not-linked' };
    const allowed = await consent.canDeliver({
        userId: input.parentUserId,
        userType: 'parent',
        purpose: 'progress_report',
        channel: input.channel,
    });
    if (!allowed) return { ok: false, reason: 'consent-revoked' };
    const vars = buildParentReportVars(input.configuredFields, input.summary, input.baseUrl);
    if (!vars.ok) return { ok: false, reason: 'validation-failed', error: vars.error };
    let reportLink: string;
    let unsubscribeLink: string;
    try {
        const reportRef = `${input.tenantId}:${input.studentEnrollmentId}:${input.summary.period}`;
        const reportToken = signSecureLink(
            { kind: 'report', ref: reportRef, userId: input.parentUserId, userType: 'parent', purpose: 'progress_report', channel: input.channel },
            input.linkSecret,
            { ttlSeconds: input.reportTtlSeconds, now: input.now },
        );
        const unsubscribeToken = signSecureLink(
            { kind: 'unsubscribe', ref: reportRef, userId: input.parentUserId, userType: 'parent', purpose: 'progress_report', channel: input.channel },
            input.linkSecret,
            { ttlSeconds: input.reportTtlSeconds, now: input.now },
        );
        reportLink = `?e=${reportToken}`;
        unsubscribeLink = `?u=${unsubscribeToken}`;
    } catch (error) {
        return { ok: false, reason: 'validation-failed', error: error instanceof Error ? error.message : 'link-signing-failed' };
    }
    const payload = {
        ...vars.value,
        report_link: `${input.baseUrl.endsWith('/') ? input.baseUrl : `${input.baseUrl}/`}${reportLink}`,
        unsubscribe_link: `${input.baseUrl.endsWith('/') ? input.baseUrl : `${input.baseUrl}/`}${unsubscribeLink}`,
    };
    const suffix = typeof input.idempotencyKeySuffix === 'string' ? `:${input.idempotencyKeySuffix}` : '';
    const queued = await enqueueOutboxRow(db, {
        idempotencyKey: `parent-report:${input.tenantId}:${input.parentUserId}:${input.studentEnrollmentId}:${input.summary.period}:${input.channel}${suffix}`,
        tenantId: input.tenantId,
        eventType: 'progress_report',
        purpose: 'progress_report',
        recipientUserId: input.parentUserId,
        recipientUserType: 'parent',
        channel: input.channel,
        locale: input.summary.locale,
        payload,
        now: input.now,
    });
    if (!queued.ok) return { ok: false, reason: 'validation-failed', error: queued.error };
    return { ok: true, outboxId: queued.id, duplicate: queued.duplicate };
};

/**
 * Canonical renderer for a queued row: payload variables + the row's locale
 * through the strict template renderer.
 */
export const outboxRowRenderer = (): (row: OutboxRow) => TemplateRenderResult =>
    (row: OutboxRow) => {
        const payload = parseRowPayload(row);
        return renderOutboxTemplate(row.event_type, row.locale, payload);
    };
