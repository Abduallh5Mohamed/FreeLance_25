"use strict";
/**
 * M6 P5 — WhatsApp/SMS channel adapters as injected interfaces only.
 *
 * No provider, network or SDK contact happens here: a production channel
 * adapter is injected by the deployer (deferred, see
 * docs/streams/server/M6-P3-P7-DELIVERY.md). This module owns the policy
 * every adapter must pass before its `send` is reachable:
 *
 *  - A message is refused unless (a) the recipient number is verified,
 *    (b) the recipient is opted in on that channel (consent gate evaluated
 *    server-side — a STOP wins), and (c) the template id is approved for
 *    the channel. All three are fail-closed: any doubt denies.
 *  - Delivery logs and receipts must never carry PII: contacts are only
 *    ever recorded as HMAC refs or last-4 masks, message bodies are never
 *    logged, and free-text reasons are masked (digit runs, emails, credentials
 *    and quoted payloads) before they reach a log or a receipt.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveContactForSend = exports.createDeferredChannelAdapter = exports.DEFERRED_CHANNEL_REASON = exports.createSmsAdapter = exports.createEmailAdapter = exports.sanitizeDeliveryLog = exports.redactPiiText = exports.REDACTION_MASK = exports.sanitizeProof = exports.maskPhone = exports.contactRef = exports.gateChannelSend = void 0;
const crypto_1 = require("crypto");
const notification_consent_1 = require("./notification-consent");
/** Refuse to send unless verified number + opt-in + approved template. */
const gateChannelSend = async (deps, input) => {
    if (!deps)
        return { ok: false, reason: 'phone-not-verified' };
    if (typeof input.phone !== 'string' || input.phone.trim().length === 0) {
        return { ok: false, reason: 'phone-missing' };
    }
    if (!input.optIn)
        return { ok: false, reason: 'channel-not-opted-in' };
    const verified = await deps.isPhoneVerified({
        tenantId: input.tenantId,
        userId: input.userId,
        userType: input.userType,
        phone: input.phone,
    });
    if (!verified)
        return { ok: false, reason: 'phone-not-verified' };
    const approved = await deps.isTemplateApproved(input.templateId);
    if (!approved)
        return { ok: false, reason: 'template-not-approved' };
    return { ok: true };
};
exports.gateChannelSend = gateChannelSend;
/** HMAC ref for a contact; the ref cannot be reversed to the phone/email. */
const contactRef = (contact, hmacKey) => `ref:${(0, crypto_1.createHmac)('sha256', hmacKey).update(contact).digest('hex').slice(0, 24)}`;
exports.contactRef = contactRef;
/** Last-4 mask: keeps a human-recognizable suffix, hides the number. */
const maskPhone = (phone) => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length <= 4)
        return '••••';
    return `••••${digits.slice(-4)}`;
};
exports.maskPhone = maskPhone;
const PII_KEY_PATTERN = /phone|contact|\bto\b|recipient|address|body|message|text|content|otp|\btoken\b|secret|password|\bpin\b/i;
/** Proof records keep only outcome-shaped, non-PII fields. */
const sanitizeProof = (proof) => {
    if (proof === null || typeof proof !== 'object' || Array.isArray(proof))
        return {};
    const safe = {};
    for (const [key, value] of Object.entries(proof)) {
        if (value === undefined)
            continue;
        if (key === 'message_id' || key === 'msgid' || key === 'provider_status') {
            safe[key] = typeof value === 'string' ? value.slice(0, 120) : typeof value === 'number' || typeof value === 'boolean' ? value : String(value).slice(0, 120);
            continue;
        }
        if (PII_KEY_PATTERN.test(key))
            continue;
        if (typeof value === 'string') {
            safe[key] = (0, exports.redactPiiText)(value.slice(0, 120));
        }
        else if (typeof value === 'number' || typeof value === 'boolean') {
            safe[key] = value;
        }
    }
    return safe;
};
exports.sanitizeProof = sanitizeProof;
/** The single mask token every redaction path emits. */
exports.REDACTION_MASK = '••••••';
/** Email-shaped address; the local part and domain are both identifying. */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/**
 * A credential leaked in `key=value` / `key: value` form. Only the explicit
 * separator is matched: masking a bare keyword followed by a word would eat
 * ordinary diagnostics ("authorization failed") without protecting anything.
 */
const SECRET_ASSIGNMENT_PATTERN = /\b(token|otp|passcode|password|secret|pin|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer)\b\s*[=:]\s*[^\s,;"']+/gi;
/** `Authorization: Bearer <credential>` without an equals sign. */
const BEARER_TOKEN_PATTERN = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/**
 * A quoted fragment. Adapters and providers echo the rendered body back inside
 * quotes ("..."), so any quoted payload is treated as opaque and masked: a
 * message body must never be loggable, and the worker cannot tell a benign
 * quote from a body echo. Single quotes are deliberately excluded — apostrophes
 * in ordinary English text would match and corrupt the diagnostic.
 */
const QUOTED_FRAGMENT_PATTERN = /"[^"]*"/g;
/** Long digit runs: phone numbers, OTPs, national ids, card fragments. */
const DIGIT_RUN_PATTERN = /\d{6,}/g;
/**
 * Masks every PII/secret shape this codebase can observe in free text — email
 * addresses, `key=value` credentials, bearer tokens, quoted payloads (message
 * bodies) and digit runs — then collapses whitespace and bounds the length.
 *
 * This is the single redaction point for adapter reasons, provider errors,
 * `last_error` values, receipt details and log lines. It is intentionally
 * lossy: when a fragment cannot be proven non-PII it is masked.
 */
const redactPiiText = (text) => {
    const masked = text
        .replace(EMAIL_PATTERN, exports.REDACTION_MASK)
        .replace(BEARER_TOKEN_PATTERN, `$1 ${exports.REDACTION_MASK}`)
        .replace(SECRET_ASSIGNMENT_PATTERN, `$1=${exports.REDACTION_MASK}`)
        .replace(QUOTED_FRAGMENT_PATTERN, `"${exports.REDACTION_MASK}"`)
        .replace(DIGIT_RUN_PATTERN, exports.REDACTION_MASK);
    return masked.replace(/\s+/g, ' ').slice(0, 200);
};
exports.redactPiiText = redactPiiText;
/**
 * Turns a raw delivery observation into a loggable shape: the contact is
 * replaced by its HMAC ref, the message body is never carried into logs
 * and free-text reasons are digit-masked so a provider echo cannot leak PII.
 */
const sanitizeDeliveryLog = (entry, hmacKey) => ({
    outboxId: entry.outboxId,
    channel: entry.channel,
    eventType: entry.eventType,
    outcome: entry.outcome,
    contactRef: entry.contact ? (0, exports.contactRef)(entry.contact, hmacKey) : 'ref:none',
    reason: entry.reason ? (0, exports.redactPiiText)(entry.reason) : null,
});
exports.sanitizeDeliveryLog = sanitizeDeliveryLog;
const sendThroughTransport = async (channel, transport, request) => {
    if (!transport)
        return { outcome: 'unavailable', reason: 'no-provider-configured' };
    if (typeof request.contact !== 'string' || request.contact.trim().length === 0) {
        return { outcome: 'failed', reason: 'contact-missing', permanent: true };
    }
    if (typeof request.templateId !== 'string' || request.templateId.trim().length === 0) {
        return { outcome: 'failed', reason: 'template-not-approved', permanent: true };
    }
    let result;
    try {
        result = await transport.send({
            channel,
            contact: request.contact,
            locale: request.locale,
            templateId: request.templateId,
            subject: request.subject ?? null,
            bodyText: request.bodyText,
            bodyHtml: request.bodyHtml ?? null,
        });
    }
    catch {
        // The request may already be on the wire: the outcome is unknown, not
        // a failure, and the reason never carries the transport's message
        // (which can echo the contact).
        return { outcome: 'unknown', reason: 'transport-error' };
    }
    if (!result.ok) {
        const reason = (0, exports.redactPiiText)(result.error);
        return result.retryable
            ? { outcome: 'failed', reason }
            : { outcome: 'failed', reason, permanent: true };
    }
    if (typeof result.messageId !== 'string' || result.messageId.trim().length === 0) {
        return { outcome: 'unknown', reason: 'provider-receipt-missing' };
    }
    const proof = { message_id: result.messageId };
    if (typeof result.providerStatus === 'string' && result.providerStatus.length > 0) {
        proof.provider_status = result.providerStatus;
    }
    return { outcome: 'sent', proof };
};
/** Email adapter. Without a transport every send is `unavailable`. */
const createEmailAdapter = (config = {}) => ({
    channel: 'email',
    readiness: () => (config.transport ? { ready: true } : { ready: false, reason: 'no-provider-configured' }),
    send: (request) => sendThroughTransport('email', config.transport, request),
});
exports.createEmailAdapter = createEmailAdapter;
/**
 * SMS adapter. Without a transport every send is `unavailable`; an empty
 * template id is refused before the provider is touched (no free-text SMS).
 */
const createSmsAdapter = (config = {}) => ({
    channel: 'sms',
    readiness: () => (config.transport ? { ready: true } : { ready: false, reason: 'no-provider-configured' }),
    send: (request) => sendThroughTransport('sms', config.transport, request),
});
exports.createSmsAdapter = createSmsAdapter;
/** The exact reason a channel deferred by the owner reports. */
exports.DEFERRED_CHANNEL_REASON = 'channel-deferred-by-owner';
/**
 * W9-R3 — a channel whose provider was deferred by the owner (OTP/SMS/WhatsApp)
 * is registered explicitly **unready** with an exact, operator-visible reason.
 *
 * This is the safe refusal made structural: the registration can never be
 * claimed by the worker (an unready registration is filtered out of the claim),
 * `send` can never reach a provider, and an accidental send reports
 * `unavailable` — never `sent` and never a fabricated message id. It exists so
 * a future wiring cannot leave the channel silently absent (which would show up
 * only as `no-adapter` retries) or, worse, substitute a fake success.
 */
const createDeferredChannelAdapter = (channel, reason = exports.DEFERRED_CHANNEL_REASON) => ({
    channel,
    readiness: () => ({ ready: false, reason }),
    send: async () => ({ outcome: 'unavailable', reason }),
});
exports.createDeferredChannelAdapter = createDeferredChannelAdapter;
const EXTERNAL_CHANNELS = ['email', 'whatsapp', 'sms'];
/**
 * Resolves the contact for one outbound send. Fail-closed: an in-app channel,
 * an unknown purpose (not a real consent purpose) or an empty contact all deny
 * before any adapter is reachable.
 */
const resolveContactForSend = async (store, query) => {
    if (!EXTERNAL_CHANNELS.includes(query.channel))
        return { ok: false, reason: 'channel-not-external' };
    if (!(0, notification_consent_1.isConsentPurpose)(query.purpose))
        return { ok: false, reason: 'unknown-purpose' };
    const found = await store.findContactForPurpose({
        tenantId: query.tenantId,
        userId: query.userId,
        userType: query.userType,
        channel: query.channel,
        purpose: query.purpose,
    });
    if (!found || typeof found.contact !== 'string' || found.contact.trim().length === 0) {
        return { ok: false, reason: 'contact-missing' };
    }
    return { ok: true, contact: found.contact, verified: found.verified === true };
};
exports.resolveContactForSend = resolveContactForSend;
