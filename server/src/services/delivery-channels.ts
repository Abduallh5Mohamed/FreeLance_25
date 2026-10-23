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

import { createHmac } from 'crypto';
import { isConsentPurpose } from './notification-consent';

export interface ChannelSendRequest {
    /** Real contact (phone/email); consumed by the adapter, never logged. */
    contact: string;
    locale: string;
    /** Provider-approved template id; required and checked by the gate. */
    templateId: string;
    /** Rendered message body; handed to the provider, never logged. */
    bodyText: string;
    /** Optional email subject; ignored by SMS. */
    subject?: string | null;
    /** Optional HTML alternative; ignored by SMS. */
    bodyHtml?: string | null;
}

/**
 * The five outcomes a channel adapter may report. `unknown` and `unavailable`
 * are first-class so no adapter ever has to fake a success or a failure:
 *
 *  - `sent`        the provider accepted the message and returned a receipt id.
 *  - `failed`      the provider (or the pre-send gate) refused it. `permanent`
 *                  marks a failure that must not be retried.
 *  - `bounced`     the provider reported an undeliverable recipient.
 *  - `unknown`     the request may or may not have been accepted (timeout after
 *                  write, transport error, receipt without an external id).
 *                  The outbox quarantines it for reconciliation; it is never
 *                  retried as if it were definitely unsent.
 *  - `unavailable` no provider is configured. Nothing was transmitted, so the
 *                  row is never marked sent and no receipt is invented.
 */
export type ChannelSendOutcome =
    | { outcome: 'sent'; proof: Record<string, unknown> }
    | { outcome: 'failed'; reason: string; permanent?: boolean }
    | { outcome: 'bounced'; reason: string }
    | { outcome: 'unknown'; reason: string }
    | { outcome: 'unavailable'; reason: string };

export interface SmsChannelAdapter {
    readonly channel: 'sms';
    send(request: ChannelSendRequest): Promise<ChannelSendOutcome>;
}

export interface WhatsAppChannelAdapter {
    readonly channel: 'whatsapp';
    send(request: ChannelSendRequest): Promise<ChannelSendOutcome>;
}

/** Injected verified-number check (server rows only; never client input). */
export interface VerifiedNumberChecker {
    isPhoneVerified(input: { tenantId: string | null; userId: string; userType: string; phone: string }): Promise<boolean>;
}

/** Injected approved-template registry per channel. */
export interface ApprovedTemplateChecker {
    isTemplateApproved(templateId: string): Promise<boolean>;
}

export interface ChannelGateInput {
    tenantId: string | null;
    userId: string;
    userType: string;
    phone: string;
    templateId: string;
    /** Result of the server-side consent check for this exact recipient. */
    optIn: boolean;
}

export type ChannelGateResult =
    | { ok: true }
    | { ok: false; reason: 'phone-missing' | 'phone-not-verified' | 'channel-not-opted-in' | 'template-not-approved' };

export type ChannelGateDeps = VerifiedNumberChecker & ApprovedTemplateChecker;

/** Refuse to send unless verified number + opt-in + approved template. */
export const gateChannelSend = async (
    deps: ChannelGateDeps | null,
    input: ChannelGateInput,
): Promise<ChannelGateResult> => {
    if (!deps) return { ok: false, reason: 'phone-not-verified' };
    if (typeof input.phone !== 'string' || input.phone.trim().length === 0) {
        return { ok: false, reason: 'phone-missing' };
    }
    if (!input.optIn) return { ok: false, reason: 'channel-not-opted-in' };
    const verified = await deps.isPhoneVerified({
        tenantId: input.tenantId,
        userId: input.userId,
        userType: input.userType,
        phone: input.phone,
    });
    if (!verified) return { ok: false, reason: 'phone-not-verified' };
    const approved = await deps.isTemplateApproved(input.templateId);
    if (!approved) return { ok: false, reason: 'template-not-approved' };
    return { ok: true };
};

/** HMAC ref for a contact; the ref cannot be reversed to the phone/email. */
export const contactRef = (contact: string, hmacKey: string): string =>
    `ref:${createHmac('sha256', hmacKey).update(contact).digest('hex').slice(0, 24)}`;

/** Last-4 mask: keeps a human-recognizable suffix, hides the number. */
export const maskPhone = (phone: string): string => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length <= 4) return '••••';
    return `••••${digits.slice(-4)}`;
};

const PII_KEY_PATTERN = /phone|contact|\bto\b|recipient|address|body|message|text|content|otp|\btoken\b|secret|password|\bpin\b/i;

/** Proof records keep only outcome-shaped, non-PII fields. */
export const sanitizeProof = (proof: unknown): Record<string, string | number | boolean> => {
    if (proof === null || typeof proof !== 'object' || Array.isArray(proof)) return {};
    const safe: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(proof as Record<string, unknown>)) {
        if (value === undefined) continue;
        if (key === 'message_id' || key === 'msgid' || key === 'provider_status') {
            safe[key] = typeof value === 'string' ? value.slice(0, 120) : typeof value === 'number' || typeof value === 'boolean' ? value : String(value).slice(0, 120);
            continue;
        }
        if (PII_KEY_PATTERN.test(key)) continue;
        if (typeof value === 'string') {
            safe[key] = redactPiiText(value.slice(0, 120));
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            safe[key] = value;
        }
    }
    return safe;
};

/** The single mask token every redaction path emits. */
export const REDACTION_MASK = '••••••';

/** Email-shaped address; the local part and domain are both identifying. */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/**
 * A credential leaked in `key=value` / `key: value` form. Only the explicit
 * separator is matched: masking a bare keyword followed by a word would eat
 * ordinary diagnostics ("authorization failed") without protecting anything.
 */
const SECRET_ASSIGNMENT_PATTERN =
    /\b(token|otp|passcode|password|secret|pin|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer)\b\s*[=:]\s*[^\s,;"']+/gi;
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
export const redactPiiText = (text: string): string => {
    const masked = text
        .replace(EMAIL_PATTERN, REDACTION_MASK)
        .replace(SECRET_ASSIGNMENT_PATTERN, `$1=${REDACTION_MASK}`)
        .replace(BEARER_TOKEN_PATTERN, `$1 ${REDACTION_MASK}`)
        .replace(QUOTED_FRAGMENT_PATTERN, `"${REDACTION_MASK}"`)
        .replace(DIGIT_RUN_PATTERN, REDACTION_MASK);
    return masked.replace(/\s+/g, ' ').slice(0, 200);
};

export interface SanitizedDeliveryLog {
    outboxId: string;
    channel: string;
    eventType: string;
    outcome: string;
    contactRef: string;
    reason: string | null;
}

export interface RawDeliveryLogEntry {
    outboxId: string;
    channel: string;
    eventType: string;
    outcome: string;
    reason?: string | null;
    contact?: string | null;
    body?: string | null;
}

/**
 * Turns a raw delivery observation into a loggable shape: the contact is
 * replaced by its HMAC ref, the message body is never carried into logs
 * and free-text reasons are digit-masked so a provider echo cannot leak PII.
 */
export const sanitizeDeliveryLog = (
    entry: RawDeliveryLogEntry,
    hmacKey: string,
): SanitizedDeliveryLog => ({
    outboxId: entry.outboxId,
    channel: entry.channel,
    eventType: entry.eventType,
    outcome: entry.outcome,
    contactRef: entry.contact ? contactRef(entry.contact, hmacKey) : 'ref:none',
    reason: entry.reason ? redactPiiText(entry.reason) : null,
});

// ---------------------------------------------------------------------------
// Provider-backed adapters: explicit readiness, explicit unavailability
// ---------------------------------------------------------------------------

export type AdapterReadiness = { ready: true } | { ready: false; reason: string };

export interface ProviderSendRequest {
    channel: 'email' | 'sms';
    /** Real contact; handed to the provider, never logged by this module. */
    contact: string;
    locale: string;
    templateId: string;
    subject: string | null;
    bodyText: string;
    bodyHtml: string | null;
}

/**
 * A provider response. `ok: true` MUST carry the provider's external message
 * id; an accepted send without one is ambiguous and is treated as `unknown`
 * rather than papered over with a fabricated id.
 */
export type ProviderSendResult =
    | { ok: true; messageId: string; providerStatus?: string }
    | { ok: false; error: string; retryable: boolean };

/** The injected transport. No SDK, socket or credential lives in this module. */
export interface ProviderTransport {
    send(request: ProviderSendRequest): Promise<ProviderSendResult>;
}

export interface ConfiguredChannelAdapter {
    /**
     * `whatsapp` is part of the union so a deferred channel can be registered
     * as explicitly unready instead of being silently absent (W9-R3).
     */
    readonly channel: 'email' | 'sms' | 'whatsapp';
    /** Explicit readiness signal: a channel is only claimable when ready. */
    readiness(): AdapterReadiness;
    send(request: ChannelSendRequest): Promise<ChannelSendOutcome>;
}

export interface ChannelAdapterConfig {
    /** Absent/null means "no provider configured" — never a silent success. */
    transport?: ProviderTransport | null;
}

const sendThroughTransport = async (
    channel: 'email' | 'sms',
    transport: ProviderTransport | null | undefined,
    request: ChannelSendRequest,
): Promise<ChannelSendOutcome> => {
    if (!transport) return { outcome: 'unavailable', reason: 'no-provider-configured' };
    if (typeof request.contact !== 'string' || request.contact.trim().length === 0) {
        return { outcome: 'failed', reason: 'contact-missing', permanent: true };
    }
    if (typeof request.templateId !== 'string' || request.templateId.trim().length === 0) {
        return { outcome: 'failed', reason: 'template-not-approved', permanent: true };
    }
    let result: ProviderSendResult;
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
    } catch {
        // The request may already be on the wire: the outcome is unknown, not
        // a failure, and the reason never carries the transport's message
        // (which can echo the contact).
        return { outcome: 'unknown', reason: 'transport-error' };
    }
    if (!result.ok) {
        const reason = redactPiiText(result.error);
        return result.retryable
            ? { outcome: 'failed', reason }
            : { outcome: 'failed', reason, permanent: true };
    }
    if (typeof result.messageId !== 'string' || result.messageId.trim().length === 0) {
        return { outcome: 'unknown', reason: 'provider-receipt-missing' };
    }
    const proof: Record<string, unknown> = { message_id: result.messageId };
    if (typeof result.providerStatus === 'string' && result.providerStatus.length > 0) {
        proof.provider_status = result.providerStatus;
    }
    return { outcome: 'sent', proof };
};

/** Email adapter. Without a transport every send is `unavailable`. */
export const createEmailAdapter = (config: ChannelAdapterConfig = {}): ConfiguredChannelAdapter => ({
    channel: 'email',
    readiness: () => (config.transport ? { ready: true } : { ready: false, reason: 'no-provider-configured' }),
    send: (request) => sendThroughTransport('email', config.transport, request),
});

/**
 * SMS adapter. Without a transport every send is `unavailable`; an empty
 * template id is refused before the provider is touched (no free-text SMS).
 */
export const createSmsAdapter = (config: ChannelAdapterConfig = {}): ConfiguredChannelAdapter => ({
    channel: 'sms',
    readiness: () => (config.transport ? { ready: true } : { ready: false, reason: 'no-provider-configured' }),
    send: (request) => sendThroughTransport('sms', config.transport, request),
});

/** The exact reason a channel deferred by the owner reports. */
export const DEFERRED_CHANNEL_REASON = 'channel-deferred-by-owner';

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
export const createDeferredChannelAdapter = (
    channel: 'sms' | 'whatsapp',
    reason: string = DEFERRED_CHANNEL_REASON,
): ConfiguredChannelAdapter => ({
    channel,
    readiness: () => ({ ready: false, reason }),
    send: async () => ({ outcome: 'unavailable', reason }),
});

// ---------------------------------------------------------------------------
// Send-time contact authority (purpose-scoped, never "any contact on file")
// ---------------------------------------------------------------------------

export interface PurposeContactQuery {
    tenantId: string | null;
    userId: string;
    userType: string;
    channel: string;
    /** Purpose of THIS notification; a generic lookup is not allowed. */
    purpose: string;
}

export interface StoredContact {
    contact: string;
    /** Server-side verified flag (phone/email verification), never client input. */
    verified: boolean;
}

/**
 * Contact source for outbound channels. The store is queried with the
 * notification's purpose and MUST scope the answer to it — returning a generic
 * "any contact on file" row violates this contract and is what the purpose
 * parameter exists to prevent.
 */
export interface PurposeContactStore {
    findContactForPurpose(query: PurposeContactQuery): Promise<StoredContact | null>;
}

export type ContactResolution =
    | { ok: true; contact: string; verified: boolean }
    | { ok: false; reason: 'channel-not-external' | 'unknown-purpose' | 'contact-missing' };

const EXTERNAL_CHANNELS: readonly string[] = ['email', 'whatsapp', 'sms'];

/**
 * Resolves the contact for one outbound send. Fail-closed: an in-app channel,
 * an unknown purpose (not a real consent purpose) or an empty contact all deny
 * before any adapter is reachable.
 */
export const resolveContactForSend = async (
    store: PurposeContactStore,
    query: PurposeContactQuery,
): Promise<ContactResolution> => {
    if (!EXTERNAL_CHANNELS.includes(query.channel)) return { ok: false, reason: 'channel-not-external' };
    if (!isConsentPurpose(query.purpose)) return { ok: false, reason: 'unknown-purpose' };
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
