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
 *    logged, and free-text reasons have digit runs masked.
 */

import { createHmac } from 'crypto';

export interface ChannelSendRequest {
    /** Real contact (phone); consumed by the adapter, never logged. */
    contact: string;
    locale: string;
    /** Provider-approved template id; required and checked by the gate. */
    templateId: string;
    /** Rendered message body; handed to the provider, never logged. */
    bodyText: string;
}

export type ChannelSendOutcome =
    | { outcome: 'sent'; proof: Record<string, unknown> }
    | { outcome: 'failed'; reason: string }
    | { outcome: 'bounced'; reason: string };

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

const PII_KEY_PATTERN = /phone|contact|\bto\b|recipient|address|body|message|text|content/i;

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

/** Masks digit runs that look like phone numbers and collapses long text. */
export const redactPiiText = (text: string): string => {
    const masked = text.replace(/\d{6,}/g, '••••••');
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
