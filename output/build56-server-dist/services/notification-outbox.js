"use strict";
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
 * A claim is a lease, not a promise: `recoverStaleSendingRows` flags rows whose
 * 'sending' claim outlived the lease (a crash, or an adapter response lost
 * after the provider accepted the message). It never re-sends and never
 * resolves the row as sent/failed, because without a provider idempotency key
 * an unknown outcome cannot be retried safely — it is marked for
 * reconciliation instead of being silently wedged or double-delivered.
 *
 * B2-W9 adds three things on top of that model, without a second state machine:
 *  - an `unknown` adapter outcome is quarantined (status stays 'sending',
 *    `last_error` = UNKNOWN_OUTCOME_MARKER) and never retried as unsent;
 *  - an `unavailable` outcome (no provider) is a pre-send result: bounded
 *    retry, never a fake `sent`;
 *  - every claim and every state write is fenced. The claim UPDATE bumps
 *    `attempts`; the terminal write carries `AND attempts = ?`, so a
 *    dispatcher whose lease was superseded cannot resolve the row.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.reconcileQuarantinedOutboxRow = exports.RECONCILED_RELEASED_MARKER = exports.enqueueAcademicEventNotification = exports.MAX_PRODUCER_RECIPIENTS = exports.PRODUCER_CHANNELS = exports.producerPolicyFor = exports.NOTIFICATION_PRODUCER_POLICY = exports.outboxRowRenderer = exports.enqueueParentReportDelivery = exports.buildParentReportVars = exports.isParentReportField = exports.PARENT_REPORT_FIELDS = exports.recoverStaleSendingRows = exports.STALE_SENDING_LEASE_MS_DEFAULT = exports.STALE_SENDING_MARKER = exports.claimDueOutboxIdsInScope = exports.claimDueOutboxIds = exports.dispatchOutboxRow = exports.verifySecureLink = exports.signSecureLink = exports.unsubscribeLinkTtlSecondsDefault = exports.linkTtlSecondsDefault = exports.resolveLinkSecret = exports.LinkSecretMissingError = exports.LINK_SECRET_MIN_BYTES = exports.renderOutboxTemplate = exports.isOutboxTemplateEvent = exports.enqueueOutboxRow = exports.validateEnqueueInput = exports.isOutboxLocale = exports.UNKNOWN_OUTCOME_MARKER = exports.outboxBackoffSeconds = exports.OUTBOX_STATUSES = exports.OUTBOX_LOCALES = void 0;
const crypto_1 = require("crypto");
const notification_preferences_1 = require("./notification-preferences");
const notification_consent_1 = require("./notification-consent");
const delivery_channels_1 = require("./delivery-channels");
exports.OUTBOX_LOCALES = ['ar', 'en'];
exports.OUTBOX_STATUSES = [
    'pending',
    'sending',
    'sent',
    'failed',
    'bounced',
    'cancelled',
];
const MIN_BACKOFF_SECONDS = 60;
/** Bounded backoff ladder: 60s, 300s, 1800s, 7200s, capped at 86400s. */
const outboxBackoffSeconds = (attempt) => {
    if (!Number.isSafeInteger(attempt) || attempt < 1)
        return MIN_BACKOFF_SECONDS;
    const ladder = [60, 300, 1800, 7200, 86400];
    const index = Math.min(attempt - 1, ladder.length - 1);
    return ladder[index];
};
exports.outboxBackoffSeconds = outboxBackoffSeconds;
const MAX_ATTEMPTS_DEFAULT = 5;
const MAX_ATTEMPTS_CEILING = 10;
const MAX_EVENT_LENGTH = 60;
const MAX_PURPOSE_LENGTH = 50;
/** Pre-adapter failures leave no external trace, so the claim is released. */
const CONSENT_CHECK_ERROR = 'consent-check-failed';
const RENDER_ERROR = 'render-failed';
/** A persisted terminal state whose audit receipt could not be stored. */
const RECEIPT_PERSIST_ERROR = 'receipt-persist-failed';
/** The row changed state underneath a dispatcher; its write was not applied. */
const TRANSITION_REJECTED = 'state-transition-rejected';
/**
 * Durable marker for a quarantined ambiguous send. The row keeps status
 * 'sending' (so no dispatcher can claim it and no age-based sweep may resolve
 * it) and this exact reason, which an operator reconciles against the provider.
 * No schema column was added: the outbox ENUM has no 'unknown' member and this
 * batch is forbidden from writing migrations.
 */
exports.UNKNOWN_OUTCOME_MARKER = 'provider-outcome-unknown';
const isDuplicateError = (error) => typeof error === 'object' && error !== null && error.code === 'ER_DUP_ENTRY';
const isOutboxLocale = (value) => typeof value === 'string' && exports.OUTBOX_LOCALES.includes(value);
exports.isOutboxLocale = isOutboxLocale;
/** Strict queue-time validation: a bad row never reaches the outbox table. */
const validateEnqueueInput = (input) => {
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
    if (!(0, notification_preferences_1.isNotificationChannel)(input.channel)) {
        return { ok: false, error: 'Unknown delivery channel' };
    }
    if (!(0, exports.isOutboxLocale)(input.locale)) {
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
exports.validateEnqueueInput = validateEnqueueInput;
/** Idempotent enqueue: an existing row is returned instead of duplicated. */
const enqueueOutboxRow = async (db, input) => {
    const validation = (0, exports.validateEnqueueInput)(input);
    if (!validation.ok)
        return validation;
    const existing = await db.queryOne('SELECT id FROM notification_outbox WHERE idempotency_key = ? LIMIT 1', [input.idempotencyKey]);
    if (existing)
        return { ok: true, id: existing.id, duplicate: true };
    const id = (0, crypto_1.randomUUID)();
    const now = (input.now ?? (() => new Date()))();
    try {
        await db.execute(`INSERT INTO notification_outbox
             (id, idempotency_key, tenant_id, event_type, purpose, recipient_user_id, recipient_user_type,
              channel, locale, template_id, payload, status, attempts, max_attempts, next_attempt_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`, [
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
        ]);
    }
    catch (error) {
        // L4: two concurrent enqueues of the same key can both pass the
        // pre-check; the unique key then rejects the loser. That is the
        // idempotent outcome, not a failure: return the winning row.
        if (isDuplicateError(error)) {
            const raced = await db.queryOne('SELECT id FROM notification_outbox WHERE idempotency_key = ? LIMIT 1', [input.idempotencyKey]);
            if (raced)
                return { ok: true, id: raced.id, duplicate: true };
        }
        throw error;
    }
    return { ok: true, id, duplicate: false };
};
exports.enqueueOutboxRow = enqueueOutboxRow;
// ---------------------------------------------------------------------------
// Locale templates (ar/en) with escaped variables
// ---------------------------------------------------------------------------
const escapeHtml = (value) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
/** Plain-text variable: control characters are neutralized, not HTML-escaped. */
const escapeText = (value) => value.replace(/[\u0000-\u001f\u007f]/g, ' ');
const SUBSCRIBE_LABEL_AR = 'إلغاء الاشتراك';
const SUBSCRIBE_LABEL_EN = 'Unsubscribe';
const TEMPLATES = {
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
    /**
     * W9-R2 — academic publication events. Copy is deliberately neutral: it
     * names the resource and its server-formatted instants, and carries no
     * grade, result, ranking or progress claim. A results/grade message needs
     * the results-release policy, which is not settled (see
     * NOTIFICATION_PRODUCER_POLICY).
     */
    assignment_published: {
        ar: {
            subject: 'واجب جديد: {assignment_title}',
            bodyText: 'واجب جديد في {course_name}: {assignment_title}. آخر موعد للتسليم {due_at}.',
            bodyHtml: '<p>واجب جديد في {course_name}.</p><p>{assignment_title}</p><p>آخر موعد للتسليم: {due_at}</p>{close}',
            placeholders: ['assignment_title', 'course_name', 'due_at', 'unsubscribe_link'],
        },
        en: {
            subject: 'New assignment: {assignment_title}',
            bodyText: 'New assignment in {course_name}: {assignment_title}. Due {due_at}.',
            bodyHtml: '<p>New assignment in {course_name}.</p><p>{assignment_title}</p><p>Due: {due_at}</p>{close}',
            placeholders: ['assignment_title', 'course_name', 'due_at', 'unsubscribe_link'],
        },
    },
    exam_published: {
        ar: {
            subject: 'امتحان جديد: {exam_title}',
            bodyText: 'امتحان جديد في {course_name}: {exam_title}. يفتح {opens_at} وينتهي {closes_at}.',
            bodyHtml: '<p>امتحان جديد في {course_name}.</p><p>{exam_title}</p><p>يفتح: {opens_at}</p><p>ينتهي: {closes_at}</p>{close}',
            placeholders: ['exam_title', 'course_name', 'opens_at', 'closes_at', 'unsubscribe_link'],
        },
        en: {
            subject: 'New exam: {exam_title}',
            bodyText: 'New exam in {course_name}: {exam_title}. Opens {opens_at}, closes {closes_at}.',
            bodyHtml: '<p>New exam in {course_name}.</p><p>{exam_title}</p><p>Opens: {opens_at}</p><p>Closes: {closes_at}</p>{close}',
            placeholders: ['exam_title', 'course_name', 'opens_at', 'closes_at', 'unsubscribe_link'],
        },
    },
};
const isOutboxTemplateEvent = (eventType) => Object.prototype.hasOwnProperty.call(TEMPLATES, eventType);
exports.isOutboxTemplateEvent = isOutboxTemplateEvent;
const substitute = (template, vars) => template.replace(/\{(\w+)\}/g, (match, key) => vars.get(key) ?? match);
/**
 * Renders a locale template with strict variable handling: every supplied
 * variable must be a known placeholder (extra variables rejected), every
 * placeholder (including unsubscribe_link) must be supplied, and text values
 * are HTML-escaped in HTML output / control-char neutralized in text output so
 * a hostile variable can never inject markup.
 */
const renderOutboxTemplate = (eventType, locale, variables) => {
    if (!(0, exports.isOutboxTemplateEvent)(eventType)) {
        return { ok: false, error: `Unknown template event: ${eventType}` };
    }
    if (!(0, exports.isOutboxLocale)(locale)) {
        return { ok: false, error: 'locale must be ar or en' };
    }
    if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) {
        return { ok: false, error: 'Template variables must be an object' };
    }
    const spec = TEMPLATES[eventType][locale];
    const given = variables;
    const unknown = Object.keys(given).filter((key) => !spec.placeholders.includes(key));
    if (unknown.length > 0) {
        return { ok: false, error: `Unknown template variable: ${unknown[0]}` };
    }
    const htmlVars = new Map();
    const textVars = new Map();
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
    if (leaked)
        return { ok: false, error: 'Template rendered with unsubstituted variables' };
    return { ok: true, value: { subject, bodyText, bodyHtml } };
};
exports.renderOutboxTemplate = renderOutboxTemplate;
// ---------------------------------------------------------------------------
// Signed, expiring links on a dedicated secret
// ---------------------------------------------------------------------------
exports.LINK_SECRET_MIN_BYTES = 32;
class LinkSecretMissingError extends Error {
    constructor() {
        super('NOTIFICATION_LINK_SECRET is missing or shorter than 32 bytes; refusing to sign or verify links');
        this.name = 'LinkSecretMissingError';
    }
}
exports.LinkSecretMissingError = LinkSecretMissingError;
/** Fails closed: a missing/short secret can never silently be skipped. */
const resolveLinkSecret = (secret) => {
    if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < exports.LINK_SECRET_MIN_BYTES) {
        throw new LinkSecretMissingError();
    }
    return secret;
};
exports.resolveLinkSecret = resolveLinkSecret;
const base64Url = (value) => Buffer.from(value, 'utf8').toString('base64url');
const fromBase64Url = (value) => Buffer.from(value, 'base64url').toString('utf8');
const linkSignature = (encoded, secret) => (0, crypto_1.createHmac)('sha256', secret).update(encoded).digest('base64url');
exports.linkTtlSecondsDefault = 7 * 24 * 3600;
/**
 * L2: unsubscribe links are bearer tokens, so they default to a short 24h
 * lifetime and are single-use (the `jti` is consumed on first presentation).
 * Report links keep the longer default; only the destructive unsubscribe
 * surface is shortened.
 */
exports.unsubscribeLinkTtlSecondsDefault = 24 * 3600;
/**
 * Signs a link payload: base64url(json).hmac. A random jti plus expiry bound
 * the token in time; the payload itself is verified on read (never trusted).
 */
const signSecureLink = (input, secret, options = {}) => {
    const resolved = (0, exports.resolveLinkSecret)(secret);
    const now = (options.now ?? (() => new Date()))();
    const ttl = options.ttlSeconds ?? exports.linkTtlSecondsDefault;
    if (!Number.isSafeInteger(ttl) || ttl < 1)
        throw new Error('Link TTL must be a positive integer of seconds');
    const payload = {
        ...input,
        exp: now.getTime() + ttl * 1000,
        jti: (0, crypto_1.randomUUID)(),
    };
    const encoded = base64Url(JSON.stringify(payload));
    return `${encoded}.${linkSignature(encoded, resolved)}`;
};
exports.signSecureLink = signSecureLink;
/** Fails closed on malformed, tampered or expired tokens. */
const verifySecureLink = (token, secret, now = () => new Date()) => {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 2)
        return { ok: false, reason: 'malformed' };
    const [encoded, signature] = parts;
    const resolved = (0, exports.resolveLinkSecret)(secret);
    const expected = linkSignature(encoded, resolved);
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const givenBuffer = Buffer.from(signature, 'utf8');
    if (expectedBuffer.length !== givenBuffer.length || !(0, crypto_1.timingSafeEqual)(expectedBuffer, givenBuffer)) {
        return { ok: false, reason: 'signature-mismatch' };
    }
    let payload;
    try {
        payload = JSON.parse(fromBase64Url(encoded));
    }
    catch {
        return { ok: false, reason: 'malformed' };
    }
    const record = payload;
    if (!record || typeof record !== 'object')
        return { ok: false, reason: 'malformed' };
    if (record['kind'] !== 'report' && record['kind'] !== 'unsubscribe')
        return { ok: false, reason: 'malformed' };
    if (typeof record['ref'] !== 'string')
        return { ok: false, reason: 'malformed' };
    if (typeof record['exp'] !== 'number' || !Number.isFinite(record['exp'])) {
        return { ok: false, reason: 'malformed' };
    }
    if (typeof record['jti'] !== 'string' || record['jti'].length === 0) {
        return { ok: false, reason: 'malformed' };
    }
    if (record['exp'] <= now().getTime())
        return { ok: false, reason: 'expired' };
    return { ok: true, payload: payload };
};
exports.verifySecureLink = verifySecureLink;
const parseRowPayload = (row) => {
    if (typeof row.payload === 'string') {
        try {
            const parsed = JSON.parse(row.payload);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        }
        catch {
            return {};
        }
    }
    if (row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)) {
        return row.payload;
    }
    return {};
};
const writeReceipt = async (db, row, outcome, proof, reason, contact, hmacKey) => {
    const receipt = {
        id: (0, crypto_1.randomUUID)(),
        outboxId: row.id,
        outcome,
        reason,
    };
    const safeProof = (0, delivery_channels_1.sanitizeProof)(proof);
    await db.execute(`INSERT INTO notification_delivery_receipts
         (id, outbox_id, tenant_id, channel, outcome, proof, detail, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`, [
        receipt.id,
        row.id,
        row.tenant_id,
        row.channel,
        outcome,
        JSON.stringify({ ...safeProof, contact_ref: contact ? (0, delivery_channels_1.contactRef)(contact, hmacKey) : 'ref:none' }),
        reason === null ? null : (0, delivery_channels_1.redactPiiText)(reason).slice(0, 200),
    ]);
    return receipt;
};
const logDispatch = (options, hmacKey, entry) => {
    const sanitized = (0, delivery_channels_1.sanitizeDeliveryLog)(entry, hmacKey);
    const emit = options.log ?? ((value) => console.info(value));
    emit(sanitized);
};
const finishRow = async (db, row, status, nextAttemptAt, lastError, 
/** B2-W9 fence: the attempt number this dispatcher's claim produced. */
expectedAttempts) => {
    const maskedError = lastError === null ? null : (0, delivery_channels_1.redactPiiText)(lastError);
    // next_attempt_at is TIMESTAMP(3) NOT NULL (migration 20261018_14). Writing
    // NULL there is rejected by strict MySQL *after* the adapter already sent,
    // which would wedge the row in 'sending' and invite a duplicate resend. A
    // terminal state therefore keeps the last scheduled time.
    //
    // The `attempts = ?` predicate is the lease fence: the claim UPDATE bumped
    // `attempts`, so a dispatcher whose claim was superseded (or whose row was
    // re-claimed after a quarantine) cannot overwrite the authoritative state.
    const update = await db.execute(`UPDATE notification_outbox SET status = ?, next_attempt_at = COALESCE(?, next_attempt_at), last_error = ?,
         delivered_at = CASE WHEN ? = 'sent' THEN UTC_TIMESTAMP() ELSE delivered_at END
         WHERE id = ? AND status = 'sending' AND attempts = ?`, [status, nextAttemptAt, maskedError, status, row.id, expectedAttempts]);
    return (update.affectedRows ?? 0) === 1;
};
const errorMessage = (error) => error instanceof Error && error.message.length > 0 ? error.message : 'unknown-error';
/**
 * Receipts are the audit proof, not the delivery state. Once a terminal state
 * is persisted a receipt failure must never be rethrown: the caller would
 * treat a delivered message as undelivered and the row could be re-sent.
 * The loss is surfaced as a sanitized log line instead.
 */
const writeReceiptSafely = async (db, row, outcome, proof, reason, contact, hmacKey, options) => {
    try {
        await writeReceipt(db, row, outcome, proof, reason, contact, hmacKey);
        return true;
    }
    catch (error) {
        logDispatch(options, hmacKey, {
            outboxId: row.id,
            channel: row.channel,
            eventType: row.event_type,
            outcome,
            reason: `${RECEIPT_PERSIST_ERROR}: ${errorMessage(error)}`,
        });
        return false;
    }
};
const dispatchOutboxRow = async (db, rowId, adapters, options, hmacKey) => {
    const scoped = options.tenantScope !== undefined;
    const fetched = await db.queryOne(scoped
        ? 'SELECT * FROM notification_outbox WHERE id = ? AND tenant_id = ? LIMIT 1'
        : 'SELECT * FROM notification_outbox WHERE id = ? LIMIT 1', scoped ? [rowId, options.tenantScope] : [rowId]);
    // Treat the fetch as an immutable snapshot: the claim UPDATE below bumps
    // attempts in the database, never in the fetched copy.
    const row = fetched ? { ...fetched } : null;
    if (!row) {
        if (scoped) {
            // Distinguish "not this tenant" from "gone" so the worker can
            // report an exact denial instead of a generic skip.
            const foreign = await db.queryOne('SELECT id FROM notification_outbox WHERE id = ? LIMIT 1', [rowId]);
            if (foreign)
                return { dispatched: false, outcome: 'skipped', reason: 'tenant-mismatch' };
        }
        return { dispatched: false, outcome: 'skipped' };
    }
    if (row.status !== 'pending')
        return { dispatched: false, outcome: 'skipped' };
    const now = options.now ?? (() => new Date());
    const claim = await db.execute(scoped
        ? `UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1
               WHERE id = ? AND status = 'pending' AND next_attempt_at <= ? AND tenant_id = ?`
        : `UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1
               WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?`, scoped ? [rowId, now(), options.tenantScope] : [rowId, now()]);
    if ((claim.affectedRows ?? 0) === 0)
        return { dispatched: false, outcome: 'skipped' };
    const attempts = row.attempts < 0 ? 0 : row.attempts;
    const maxAttempts = row.max_attempts > 0 ? row.max_attempts : MAX_ATTEMPTS_DEFAULT;
    // The claim already counted this attempt in the database; the resulting
    // value is also this dispatcher's fence for every later state write.
    const cappedAttempts = attempts + 1;
    const retryAt = () => new Date(now().getTime() + (0, exports.outboxBackoffSeconds)(cappedAttempts) * 1000);
    /**
     * A failure reached before the adapter has no external effect, so the
     * claim can be released for a bounded retry instead of wedging the row in
     * 'sending'. At the attempt cap the row is terminally failed — still a
     * truthful outcome, because nothing was sent.
     */
    const releasePreSendFailure = async (reason) => {
        if (cappedAttempts >= maxAttempts) {
            await finishRow(db, row, 'failed', null, reason, cappedAttempts);
            await writeReceiptSafely(db, row, 'failed', {}, reason, null, hmacKey, options);
            return { dispatched: true, outcome: 'failed' };
        }
        await finishRow(db, row, 'pending', retryAt(), reason, cappedAttempts);
        return { dispatched: true, outcome: 'retry' };
    };
    let consent;
    try {
        consent = await options.consent.canDeliver({
            userId: row.recipient_user_id,
            userType: row.recipient_user_type,
            purpose: row.purpose,
            channel: row.channel,
        });
    }
    catch (error) {
        // Fail closed: an unreadable consent ledger must never fall through to
        // a send, and must not leave the claim dangling.
        const reason = `${CONSENT_CHECK_ERROR}: ${errorMessage(error)}`;
        const released = await releasePreSendFailure(reason);
        logDispatch(options, hmacKey, {
            outboxId: row.id, channel: row.channel, eventType: row.event_type, outcome: released.outcome, reason,
        });
        return released;
    }
    if (!consent) {
        await finishRow(db, row, 'cancelled', null, 'consent-revoked', cappedAttempts);
        await writeReceiptSafely(db, row, 'cancelled', {}, 'consent-revoked', null, hmacKey, options);
        logDispatch(options, hmacKey, {
            outboxId: row.id, channel: row.channel, eventType: row.event_type, outcome: 'cancelled', reason: 'consent-revoked',
        });
        return { dispatched: true, outcome: 'cancelled' };
    }
    if (attempts >= maxAttempts) {
        await finishRow(db, row, 'failed', null, 'attempt-cap-reached', cappedAttempts);
        await writeReceiptSafely(db, row, 'failed', {}, 'attempt-cap-reached', null, hmacKey, options);
        return { dispatched: true, outcome: 'failed' };
    }
    const adapter = adapters.find((candidate) => candidate.channel === row.channel);
    if (!adapter) {
        // No adapter configured for this channel: fail closed and retry later.
        if (cappedAttempts >= maxAttempts) {
            await finishRow(db, row, 'failed', null, 'no-adapter', cappedAttempts);
            logDispatch(options, hmacKey, {
                outboxId: row.id, channel: row.channel, eventType: row.event_type, outcome: 'failed', reason: 'no-adapter',
            });
            return { dispatched: true, outcome: 'failed' };
        }
        await finishRow(db, row, 'pending', retryAt(), 'no-adapter', cappedAttempts);
        return { dispatched: true, outcome: 'retry' };
    }
    let rendered;
    try {
        rendered = options.render(row);
    }
    catch (error) {
        const reason = `${RENDER_ERROR}: ${errorMessage(error)}`;
        const released = await releasePreSendFailure(reason);
        logDispatch(options, hmacKey, {
            outboxId: row.id, channel: row.channel, eventType: row.event_type, outcome: released.outcome, reason,
        });
        return released;
    }
    if (!rendered.ok) {
        if (cappedAttempts >= maxAttempts) {
            await finishRow(db, row, 'failed', null, rendered.error, cappedAttempts);
            await writeReceiptSafely(db, row, 'failed', {}, rendered.error, null, hmacKey, options);
            return { dispatched: true, outcome: 'failed' };
        }
        await finishRow(db, row, 'pending', retryAt(), rendered.error, cappedAttempts);
        return { dispatched: true, outcome: 'retry' };
    }
    let outcome;
    try {
        outcome = await adapter.deliver({
            row,
            subject: rendered.value.subject,
            bodyText: rendered.value.bodyText,
            bodyHtml: rendered.value.bodyHtml,
            templateId: row.template_id,
        });
    }
    catch (error) {
        // Legacy direct-dispatch seam: an adapter that throws instead of
        // reporting is treated as a pre-send failure here. The worker wraps
        // every adapter and upgrades a throw to `unknown` before it reaches
        // this path, so production sends are never replayed on a maybe-sent
        // request (see services/notification-worker.ts).
        outcome = { outcome: 'failed', reason: error instanceof Error ? error.message : 'delivery-threw' };
    }
    /**
     * Records an outcome the adapter actually reported. The receipt is written
     * even if the state transition is rejected by a concurrent state change:
     * the channel evidence is real, and losing it would hide a real send.
     */
    const applyTerminalOutcome = async (status, proof, reason) => {
        const applied = await finishRow(db, row, status, null, status === 'sent' ? null : reason, cappedAttempts);
        if (!applied) {
            logDispatch(options, hmacKey, {
                outboxId: row.id, channel: row.channel, eventType: row.event_type,
                outcome: 'skipped', reason: TRANSITION_REJECTED,
            });
        }
        await writeReceiptSafely(db, row, status, proof, reason, null, hmacKey, options);
        logDispatch(options, hmacKey, {
            outboxId: row.id, channel: row.channel, eventType: row.event_type, outcome: status, reason,
        });
    };
    if (outcome.outcome === 'sent') {
        await applyTerminalOutcome('sent', outcome.proof, null);
        return { dispatched: true, outcome: 'sent' };
    }
    if (outcome.outcome === 'bounced') {
        await applyTerminalOutcome('bounced', {}, outcome.reason);
        return { dispatched: true, outcome: 'bounced' };
    }
    if (outcome.outcome === 'unknown') {
        // The provider may have accepted the message. Quarantine: keep the row
        // unclaimable ('sending' + exact marker) so no later pass can replay it
        // as if it were definitely unsent. Reconciliation resolves it.
        const applied = await finishRow(db, row, 'sending', null, exports.UNKNOWN_OUTCOME_MARKER, cappedAttempts);
        if (!applied) {
            logDispatch(options, hmacKey, {
                outboxId: row.id, channel: row.channel, eventType: row.event_type,
                outcome: 'skipped', reason: TRANSITION_REJECTED,
            });
        }
        await writeReceiptSafely(db, row, 'unknown', {}, outcome.reason, null, hmacKey, options);
        logDispatch(options, hmacKey, {
            outboxId: row.id, channel: row.channel, eventType: row.event_type, outcome: 'unknown', reason: outcome.reason,
        });
        return { dispatched: true, outcome: 'unknown' };
    }
    if (outcome.outcome === 'unavailable') {
        // No provider is configured: nothing was transmitted, so this is a
        // pre-send failure with a bounded retry — never a fabricated `sent`.
        if (cappedAttempts >= maxAttempts) {
            await applyTerminalOutcome('failed', {}, outcome.reason);
            return { dispatched: true, outcome: 'failed' };
        }
        await finishRow(db, row, 'pending', retryAt(), outcome.reason, cappedAttempts);
        logDispatch(options, hmacKey, {
            outboxId: row.id, channel: row.channel, eventType: row.event_type, outcome: 'unavailable', reason: outcome.reason,
        });
        return { dispatched: true, outcome: 'unavailable' };
    }
    if (outcome.permanent === true) {
        await applyTerminalOutcome('failed', {}, outcome.reason);
        return { dispatched: true, outcome: 'failed' };
    }
    if (cappedAttempts >= maxAttempts) {
        await applyTerminalOutcome('failed', {}, outcome.reason);
        return { dispatched: true, outcome: 'failed' };
    }
    await finishRow(db, row, 'pending', retryAt(), outcome.reason, cappedAttempts);
    await writeReceiptSafely(db, row, 'failed', {}, outcome.reason, null, hmacKey, options);
    logDispatch(options, hmacKey, {
        outboxId: row.id, channel: row.channel, eventType: row.event_type, outcome: 'retry', reason: outcome.reason,
    });
    return { dispatched: true, outcome: 'retry' };
};
exports.dispatchOutboxRow = dispatchOutboxRow;
/** Bounded claim loop: up to limit pending rows whose next attempt is due. */
const claimDueOutboxIds = async (db, limit, now = () => new Date()) => {
    const bound = typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 ? Math.min(limit, 100) : 25;
    const rows = await db.query(`SELECT id FROM notification_outbox WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC LIMIT ${bound}`, [now()]);
    return rows.map((row) => row.id);
};
exports.claimDueOutboxIds = claimDueOutboxIds;
/**
 * B2-W9: tenant-scoped, channel-filtered claim. The tenant predicate is part
 * of the SQL, not a post-filter, so a foreign row is never even read into a
 * dispatch decision. An empty/absent tenant fails closed with no rows.
 */
const claimDueOutboxIdsInScope = async (db, input) => {
    if (typeof input.tenantId !== 'string' || input.tenantId.length === 0)
        return [];
    const bound = typeof input.limit === 'number' && Number.isSafeInteger(input.limit) && input.limit >= 1
        ? Math.min(input.limit, 100)
        : 25;
    const channels = (input.channels ?? []).filter((channel) => typeof channel === 'string' && channel.length > 0);
    const channelClause = channels.length > 0 ? ` AND channel IN (${channels.map(() => '?').join(', ')})` : '';
    const rows = await db.query(`SELECT id FROM notification_outbox
         WHERE status = 'pending' AND next_attempt_at <= ? AND tenant_id = ?${channelClause}
         ORDER BY next_attempt_at ASC LIMIT ${bound}`, [(input.now ?? (() => new Date()))(), input.tenantId, ...channels]);
    return rows.map((row) => row.id);
};
exports.claimDueOutboxIdsInScope = claimDueOutboxIdsInScope;
// ---------------------------------------------------------------------------
// Stale claim recovery (dispatcher crash / lost adapter response)
// ---------------------------------------------------------------------------
/**
 * Durable marker written to `last_error` on a 'sending' row whose claim
 * outlived the lease. The status is deliberately left at 'sending': without a
 * provider idempotency key the external outcome is unknown, so the row must
 * neither be retried (duplicate message) nor closed as sent/failed (false
 * delivery record). The marker is what stops the row from being silently
 * wedged — it is queryable, survives restarts and is cleared by an
 * authoritative late result.
 */
exports.STALE_SENDING_MARKER = 'stale-claim-unconfirmed';
/** Must exceed the slowest adapter timeout; 15 minutes by default. */
exports.STALE_SENDING_LEASE_MS_DEFAULT = 15 * 60 * 1000;
const STALE_SENDING_LEASE_MS_MIN = 60 * 1000;
const STALE_SENDING_LEASE_MS_MAX = 24 * 60 * 60 * 1000;
const STALE_SENDING_SCAN_DEFAULT = 25;
const STALE_SENDING_SCAN_MAX = 100;
const clampStaleLeaseMs = (raw) => {
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw))
        return exports.STALE_SENDING_LEASE_MS_DEFAULT;
    return Math.min(Math.max(raw, STALE_SENDING_LEASE_MS_MIN), STALE_SENDING_LEASE_MS_MAX);
};
/**
 * Detects abandoned claims and flags them once, without touching `status` and
 * without calling any adapter. `updated_at` is bumped by the claim UPDATE, so
 * it is the claim timestamp; a fresh claim is never flagged. Already flagged
 * rows are excluded from the scan (they can only be resolved by an operator or
 * an authoritative late result — never by another sweep), so bounded pages keep
 * making progress past a flagged backlog. The flag itself is still a
 * compare-and-set on `last_error`, so concurrent sweeps record exactly one
 * flag per abandoned claim.
 *
 * A dispatcher that is merely slow is unaffected: when its adapter result
 * arrives, `finishRow` writes the authoritative state and clears the marker.
 */
const recoverStaleSendingRows = async (db, options = {}) => {
    const now = options.now ?? (() => new Date());
    const leaseMs = clampStaleLeaseMs(options.olderThanMs);
    const limit = typeof options.limit === 'number' && Number.isSafeInteger(options.limit) && options.limit >= 1
        ? Math.min(options.limit, STALE_SENDING_SCAN_MAX)
        : STALE_SENDING_SCAN_DEFAULT;
    const emit = options.log ?? ((entry) => console.warn(entry));
    const cutoff = new Date(now().getTime() - leaseMs);
    const tenantScope = typeof options.tenantId === 'string' && options.tenantId.length > 0 ? options.tenantId : null;
    // Rows already carrying a quarantine marker are deliberately excluded from
    // the SELECT, not just from the flag CAS: a flagged row stays 'sending'
    // until an operator reconciles it, so without this predicate a backlog of
    // flagged rows larger than `limit` could fill every sweep page and starve
    // newer abandoned claims behind them (bounded scan with no progress past
    // the first page). The CAS below remains for concurrent sweeps: if another
    // sweep flags the row between this SELECT and the write, affectedRows = 0
    // and it is counted as alreadyFlagged, exactly once overall.
    const rows = await db.query(`SELECT id, idempotency_key, tenant_id, event_type, purpose, recipient_user_id, recipient_user_type,
                channel, locale, template_id, payload, status, attempts, max_attempts, next_attempt_at, last_error, delivered_at
         FROM notification_outbox
         WHERE status = 'sending' AND updated_at <= ?
           AND (last_error IS NULL OR (last_error <> ? AND last_error <> ?))${tenantScope === null ? '' : ' AND tenant_id = ?'}
         ORDER BY updated_at ASC
         LIMIT ${limit}`, tenantScope === null
        ? [cutoff, exports.STALE_SENDING_MARKER, exports.UNKNOWN_OUTCOME_MARKER]
        : [cutoff, exports.STALE_SENDING_MARKER, exports.UNKNOWN_OUTCOME_MARKER, tenantScope]);
    const flagged = [];
    let alreadyFlagged = 0;
    for (const row of rows) {
        const marked = await db.execute(`UPDATE notification_outbox SET last_error = ?
             WHERE id = ? AND status = 'sending' AND (last_error IS NULL OR (last_error <> ? AND last_error <> ?))`, [exports.STALE_SENDING_MARKER, row.id, exports.STALE_SENDING_MARKER, exports.UNKNOWN_OUTCOME_MARKER]);
        if ((marked.affectedRows ?? 0) !== 1) {
            alreadyFlagged += 1;
            continue;
        }
        const observation = {
            outboxId: row.id,
            channel: row.channel,
            eventType: row.event_type,
            attempts: row.attempts,
        };
        flagged.push(observation);
        emit({ ...observation, outcome: 'reconcile-required', reason: exports.STALE_SENDING_MARKER });
    }
    return { scanned: rows.length, flagged, alreadyFlagged };
};
exports.recoverStaleSendingRows = recoverStaleSendingRows;
// ---------------------------------------------------------------------------
// P7 — parent report delivery over verified links
// ---------------------------------------------------------------------------
/** Only these summary fields can ever appear in a parent report message. */
exports.PARENT_REPORT_FIELDS = [
    'student_name',
    'attendance_summary',
    'grade_summary',
    'progress_summary',
];
const isParentReportField = (value) => typeof value === 'string' && exports.PARENT_REPORT_FIELDS.includes(value);
exports.isParentReportField = isParentReportField;
const buildParentReportVars = (configuredFields, summary, baseUrl) => {
    if (typeof baseUrl !== 'string' || baseUrl.length === 0 || baseUrl.length > 300) {
        return { ok: false, error: 'Report base URL is required' };
    }
    if (!Array.isArray(configuredFields)) {
        return { ok: false, error: 'Configured report fields must be an array' };
    }
    const seen = new Set();
    for (const field of configuredFields) {
        if (!(0, exports.isParentReportField)(field))
            return { ok: false, error: `Unsupported report field: ${String(field)}` };
        seen.add(field);
    }
    const studentName = summary.fields['student_name'];
    if (!(0, exports.isParentReportField)('student_name') || typeof studentName !== 'string' || studentName.length === 0) {
        return { ok: false, error: 'Student name is required' };
    }
    if (typeof summary.period !== 'string' || summary.period.length === 0 || summary.period.length > 60) {
        return { ok: false, error: 'Report period must be 1-60 characters' };
    }
    const parts = [];
    for (const field of ['attendance_summary', 'grade_summary', 'progress_summary']) {
        if (!seen.has(field))
            continue;
        const value = summary.fields[field];
        if (typeof value !== 'string' || value.length === 0 || value.length > 500) {
            return { ok: false, error: `Configured field ${field} must be a 1-500 character summary value` };
        }
        parts.push(value);
    }
    if (parts.length === 0)
        return { ok: false, error: 'No configured report fields resolve to a summary value' };
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
exports.buildParentReportVars = buildParentReportVars;
/**
 * P7 funnel: a report is only queued when the parent is verified-linked to the
 * child (via the injected checker — parent linking logic is never imported
 * here) AND the parent's consent allows this channel/purpose. The queued
 * message contains ONLY the configured, allow-listed summary fields, and its
 * report/unsubscribe links are signed, expiring tokens minted from the
 * dedicated link secret. Nothing is written for denied or invalid paths.
 */
const enqueueParentReportDelivery = async (db, linkChecker, consent, input) => {
    if (!(0, notification_preferences_1.isNotificationChannel)(input.channel)) {
        return { ok: false, reason: 'validation-failed', error: 'Unknown delivery channel' };
    }
    if (!(0, exports.isOutboxLocale)(input.summary.locale)) {
        return { ok: false, reason: 'validation-failed', error: 'locale must be ar or en' };
    }
    const linked = await linkChecker.isVerifiedLinkedParent({
        tenantId: input.tenantId,
        parentUserId: input.parentUserId,
        studentEnrollmentId: input.studentEnrollmentId,
    });
    if (!linked)
        return { ok: false, reason: 'parent-not-linked' };
    const allowed = await consent.canDeliver({
        userId: input.parentUserId,
        userType: 'parent',
        purpose: 'progress_report',
        channel: input.channel,
    });
    if (!allowed)
        return { ok: false, reason: 'consent-revoked' };
    const vars = (0, exports.buildParentReportVars)(input.configuredFields, input.summary, input.baseUrl);
    if (!vars.ok)
        return { ok: false, reason: 'validation-failed', error: vars.error };
    let reportLink;
    let unsubscribeLink;
    try {
        const reportRef = `${input.tenantId}:${input.studentEnrollmentId}:${input.summary.period}`;
        const reportToken = (0, exports.signSecureLink)({ kind: 'report', ref: reportRef, userId: input.parentUserId, userType: 'parent', purpose: 'progress_report', channel: input.channel }, input.linkSecret, { ttlSeconds: input.reportTtlSeconds, now: input.now });
        const unsubscribeToken = (0, exports.signSecureLink)({ kind: 'unsubscribe', ref: reportRef, userId: input.parentUserId, userType: 'parent', purpose: 'progress_report', channel: input.channel }, input.linkSecret, { ttlSeconds: input.unsubscribeTtlSeconds ?? exports.unsubscribeLinkTtlSecondsDefault, now: input.now });
        reportLink = `?e=${reportToken}`;
        unsubscribeLink = `?u=${unsubscribeToken}`;
    }
    catch (error) {
        return { ok: false, reason: 'validation-failed', error: error instanceof Error ? error.message : 'link-signing-failed' };
    }
    const payload = {
        ...vars.value,
        report_link: `${input.baseUrl.endsWith('/') ? input.baseUrl : `${input.baseUrl}/`}${reportLink}`,
        unsubscribe_link: `${input.baseUrl.endsWith('/') ? input.baseUrl : `${input.baseUrl}/`}${unsubscribeLink}`,
    };
    // The key is a bounded digest, not a plain-text join: the old key was
    // `parent-report:{tenantId}:{parentUserId}:{studentEnrollmentId}:{period}:{channel}{suffix}`,
    // which with realistic CHAR(36)/VARCHAR(64) uuid identifiers and a common
    // period measured ~140 characters — past the module's own 120-character
    // validation cap (and the VARCHAR(160) column), so every realistic parent
    // report was rejected as validation-failed before any row was written. The
    // digest keeps the idempotency semantics exactly: same components ⇒ same
    // key ⇒ duplicate enqueue collapses, and the key always fits the cap.
    const parentKey = parentReportIdempotencyKey([
        input.tenantId,
        input.parentUserId,
        input.studentEnrollmentId,
        input.summary.period,
        input.channel,
        typeof input.idempotencyKeySuffix === 'string' ? input.idempotencyKeySuffix : '',
    ]);
    const queued = await (0, exports.enqueueOutboxRow)(db, {
        idempotencyKey: parentKey,
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
    if (!queued.ok)
        return { ok: false, reason: 'validation-failed', error: queued.error };
    return { ok: true, outboxId: queued.id, duplicate: queued.duplicate };
};
exports.enqueueParentReportDelivery = enqueueParentReportDelivery;
/**
 * Canonical renderer for a queued row: payload variables + the row's locale
 * through the strict template renderer.
 */
const outboxRowRenderer = () => (row) => {
    const payload = parseRowPayload(row);
    return (0, exports.renderOutboxTemplate)(row.event_type, row.locale, payload);
};
exports.outboxRowRenderer = outboxRowRenderer;
exports.NOTIFICATION_PRODUCER_POLICY = [
    {
        eventType: 'assignment_published',
        purpose: 'lesson_updates',
        templateEvent: 'assignment_published',
        status: 'settled',
        heldReason: null,
        publicationSource: "assignments.status = 'published'",
    },
    {
        eventType: 'exam_published',
        purpose: 'lesson_updates',
        templateEvent: 'exam_published',
        status: 'settled',
        heldReason: null,
        publicationSource: "exam_versions.status = 'published' (published_at set)",
    },
    {
        eventType: 'schedule_change',
        purpose: 'schedule_changes',
        templateEvent: null,
        status: 'policy-held',
        heldReason: 'schedule-change-policy-unsettled',
        publicationSource: null,
    },
    {
        eventType: 'results_available',
        purpose: null,
        templateEvent: null,
        status: 'policy-held',
        heldReason: 'results-release-policy-unsettled',
        publicationSource: null,
    },
];
const producerPolicyFor = (event) => exports.NOTIFICATION_PRODUCER_POLICY.find((entry) => entry.eventType === event) ?? null;
exports.producerPolicyFor = producerPolicyFor;
/** Channels a producer may queue. `in_app` is the feed's, not the outbox's. */
exports.PRODUCER_CHANNELS = ['email', 'whatsapp', 'sms'];
/** One call is bounded; a larger audience must be chunked by the caller. */
exports.MAX_PRODUCER_RECIPIENTS = 500;
const producerIdempotencyKey = (parts) => `acad:${(0, crypto_1.createHash)('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40)}`;
/** Bounded deterministic key for P7 parent-report rows (see the call site). */
const parentReportIdempotencyKey = (parts) => `parent-report:${(0, crypto_1.createHash)('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40)}`;
/**
 * Queues one published academic resource to its server-derived audience.
 *
 * Order of authority (all fail-closed, all before the first write):
 *  1. the event's policy must be **settled** — a held event refuses with its
 *     exact `heldReason` and writes nothing;
 *  2. the tenant must be present (never inferred);
 *  3. the owning domain's publication state must say `published` with a past
 *     `publishedAt` (a future instant means "not visible yet");
 *  4. recipients must be real consent namespaces, deduped and bounded;
 *  5. channels must be external (in-app rows belong to the feed);
 *  6. the template must render with the supplied variables;
 *  7. consent is read for every (recipient, channel) **before** any row is
 *     written, so a revoked recipient never produces an outbox row at all.
 *
 * The worker re-checks consent again at send time; this pre-check exists so a
 * revoked recipient does not sit in the queue as noise, not to replace it.
 */
const enqueueAcademicEventNotification = async (db, consent, authority, input) => {
    const policy = (0, exports.producerPolicyFor)(input.event);
    if (policy === null)
        return { ok: false, reason: 'unknown-event' };
    if (policy.status !== 'settled' || policy.templateEvent === null || policy.purpose === null) {
        return { ok: false, reason: 'event-policy-held', heldReason: policy.heldReason ?? 'policy-unsettled' };
    }
    const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
    if (tenantId.length === 0)
        return { ok: false, reason: 'tenant-required' };
    if (typeof input.resourceId !== 'string' || input.resourceId.length === 0 || input.resourceId.length > 64) {
        return { ok: false, reason: 'validation-failed', error: 'resourceId must be 1-64 characters' };
    }
    if (!(0, exports.isOutboxLocale)(input.locale)) {
        return { ok: false, reason: 'validation-failed', error: 'locale must be ar or en' };
    }
    if (typeof input.baseUrl !== 'string' || input.baseUrl.length === 0 || input.baseUrl.length > 300) {
        return { ok: false, reason: 'validation-failed', error: 'baseUrl is required' };
    }
    const channels = [...new Set(input.channels)];
    if (channels.length === 0)
        return { ok: false, reason: 'no-external-channel' };
    for (const channel of channels) {
        if (!(0, notification_preferences_1.isNotificationChannel)(channel) || !exports.PRODUCER_CHANNELS.includes(channel)) {
            return { ok: false, reason: 'validation-failed', error: `Channel ${String(channel)} is not an external channel` };
        }
    }
    const recipients = [];
    const seen = new Set();
    for (const candidate of input.recipients ?? []) {
        const userId = typeof candidate?.userId === 'string' ? candidate.userId : '';
        const userType = typeof candidate?.userType === 'string' ? candidate.userType : '';
        if (userId.length === 0 || userId.length > 64)
            return { ok: false, reason: 'invalid-recipient' };
        if (!notification_consent_1.CONSENT_USER_TYPES.has(userType))
            return { ok: false, reason: 'invalid-recipient' };
        const key = `${userType}:${userId}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        recipients.push({ userId, userType });
    }
    if (recipients.length === 0)
        return { ok: false, reason: 'no-recipients' };
    if (recipients.length > exports.MAX_PRODUCER_RECIPIENTS)
        return { ok: false, reason: 'recipient-limit-exceeded' };
    // Publication policy — read from the owning domain, never asserted by the caller.
    let publication;
    try {
        publication = await authority.readPublication({ tenantId, event: input.event, resourceId: input.resourceId });
    }
    catch {
        // An unreadable publication state is "not published", never "send anyway".
        return { ok: false, reason: 'not-published' };
    }
    if (!publication || publication.published !== true)
        return { ok: false, reason: 'not-published' };
    const publishedAt = publication.publishedAt === null ? null : new Date(publication.publishedAt);
    if (publishedAt === null || Number.isNaN(publishedAt.getTime()))
        return { ok: false, reason: 'not-published' };
    const now = (input.now ?? (() => new Date()))();
    if (publishedAt.getTime() > now.getTime())
        return { ok: false, reason: 'publication-in-future' };
    const templateEvent = policy.templateEvent;
    const purpose = policy.purpose;
    const base = input.baseUrl.endsWith('/') ? input.baseUrl : `${input.baseUrl}/`;
    // Validate the variable shape before any consent read or write.
    const probe = (0, exports.renderOutboxTemplate)(templateEvent, input.locale, {
        ...input.variables,
        unsubscribe_link: `${base}?u=probe`,
    });
    if (!probe.ok)
        return { ok: false, reason: 'template-render-failed', error: probe.error };
    // Phase 1 — consent for every pair, before the first row exists.
    const decisions = [];
    for (const recipient of recipients) {
        for (const channel of channels) {
            let allowed;
            try {
                allowed = await consent.canDeliver({
                    userId: recipient.userId,
                    userType: recipient.userType,
                    purpose,
                    channel,
                });
            }
            catch {
                return { ok: false, reason: 'consent-check-failed' };
            }
            decisions.push({ recipient, channel, allowed });
        }
    }
    // Phase 2 — one idempotent row per allowed pair, each with its own signed,
    // expiring, single-use unsubscribe link.
    let queued = 0;
    let duplicates = 0;
    let consentDenied = 0;
    const publishedEpoch = String(publishedAt.getTime());
    for (const decision of decisions) {
        if (!decision.allowed) {
            consentDenied += 1;
            continue;
        }
        let unsubscribeLink;
        try {
            const token = (0, exports.signSecureLink)({
                kind: 'unsubscribe',
                ref: `${input.event}:${input.resourceId}`,
                userId: decision.recipient.userId,
                userType: decision.recipient.userType,
                purpose,
                channel: decision.channel,
            }, input.linkSecret, { ttlSeconds: input.unsubscribeTtlSeconds ?? exports.unsubscribeLinkTtlSecondsDefault, now: input.now });
            unsubscribeLink = `${base}?u=${token}`;
        }
        catch {
            return { ok: false, reason: 'validation-failed', error: 'link-signing-failed', queued, duplicates, consentDenied };
        }
        const payload = { ...input.variables, unsubscribe_link: unsubscribeLink };
        const rendered = (0, exports.renderOutboxTemplate)(templateEvent, input.locale, payload);
        if (!rendered.ok) {
            return { ok: false, reason: 'template-render-failed', error: rendered.error, queued, duplicates, consentDenied };
        }
        const enqueued = await (0, exports.enqueueOutboxRow)(db, {
            idempotencyKey: producerIdempotencyKey([
                tenantId,
                input.event,
                input.resourceId,
                decision.recipient.userId,
                decision.recipient.userType,
                decision.channel,
                publishedEpoch,
            ]),
            tenantId,
            eventType: templateEvent,
            purpose,
            recipientUserId: decision.recipient.userId,
            recipientUserType: decision.recipient.userType,
            channel: decision.channel,
            locale: input.locale,
            payload,
            now: input.now,
        });
        if (!enqueued.ok) {
            return { ok: false, reason: 'validation-failed', error: enqueued.error, queued, duplicates, consentDenied };
        }
        if (enqueued.duplicate)
            duplicates += 1;
        else
            queued += 1;
    }
    return { ok: true, queued, duplicates, consentDenied };
};
exports.enqueueAcademicEventNotification = enqueueAcademicEventNotification;
// ---------------------------------------------------------------------------
// W9-R1 — explicit reconciliation of a quarantined (unknown) outcome
// ---------------------------------------------------------------------------
/** `last_error` written when an operator releases a quarantined row to retry. */
exports.RECONCILED_RELEASED_MARKER = 'reconciled-not-delivered';
/**
 * Resolves ONE quarantined row (`sending` + `provider-outcome-unknown` or
 * `stale-claim-unconfirmed`) from an authoritative provider result. This is the
 * manual reconciliation the contract (§5, §12.3) leaves to an operator; it is
 * not automatic and there is no poller.
 *
 * Guarantees:
 *  - tenant-scoped read and write (`id AND tenant_id`), so a foreign row is
 *    unreachable and reported as `not-found`;
 *  - only a row that is actually quarantined can be resolved;
 *  - every write is fenced by `attempts`, so a concurrent claim invalidates it;
 *  - releasing to `pending` is refused at the attempt cap instead of silently
 *    burning the row (the operator must decide explicitly);
 *  - the resolution is receipted, and the actor is only ever a user id in a log.
 */
const reconcileQuarantinedOutboxRow = async (db, input) => {
    const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
    if (tenantId.length === 0)
        return { ok: false, reason: 'tenant-required' };
    const actorId = typeof input.actorId === 'string' ? input.actorId.trim() : '';
    if (actorId.length === 0)
        return { ok: false, reason: 'actor-required' };
    if (input.resolution !== 'provider-delivered' && input.resolution !== 'provider-not-delivered') {
        return { ok: false, reason: 'not-quarantined' };
    }
    const row = await db.queryOne('SELECT * FROM notification_outbox WHERE id = ? AND tenant_id = ? LIMIT 1', [input.outboxId, tenantId]);
    if (!row)
        return { ok: false, reason: 'not-found' };
    const quarantined = row.status === 'sending'
        && (row.last_error === exports.UNKNOWN_OUTCOME_MARKER || row.last_error === exports.STALE_SENDING_MARKER);
    if (!quarantined)
        return { ok: false, reason: 'not-quarantined' };
    const now = (input.now ?? (() => new Date()))();
    const emit = input.log ?? (() => undefined);
    if (input.resolution === 'provider-delivered') {
        const applied = await finishRow(db, row, 'sent', null, null, row.attempts);
        if (!applied)
            return { ok: false, reason: 'transition-rejected' };
        await writeReceiptSafely(db, row, 'sent', input.proof ?? {}, null, null, input.hmacKey, { consent: { canDeliver: async () => false }, render: (0, exports.outboxRowRenderer)(), linkSecret: '', log: emit });
        emit({ outboxId: row.id, outcome: 'reconciled', resolution: input.resolution, actorId });
        return { ok: true, outcome: 'sent' };
    }
    const maxAttempts = row.max_attempts > 0 ? row.max_attempts : MAX_ATTEMPTS_DEFAULT;
    if (row.attempts >= maxAttempts)
        return { ok: false, reason: 'attempt-cap-reached' };
    const applied = await finishRow(db, row, 'pending', now, exports.RECONCILED_RELEASED_MARKER, row.attempts);
    if (!applied)
        return { ok: false, reason: 'transition-rejected' };
    await writeReceiptSafely(db, row, 'failed', {}, exports.RECONCILED_RELEASED_MARKER, null, input.hmacKey, { consent: { canDeliver: async () => false }, render: (0, exports.outboxRowRenderer)(), linkSecret: '', log: emit });
    emit({ outboxId: row.id, outcome: 'reconciled', resolution: input.resolution, actorId });
    return { ok: true, outcome: 'released' };
};
exports.reconcileQuarantinedOutboxRow = reconcileQuarantinedOutboxRow;
