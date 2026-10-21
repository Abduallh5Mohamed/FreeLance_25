/**
 * B2-W9 — delivery channel adapters and send-time contact authority.
 *
 * Hermetic: the provider transport is an injected recording fake; nothing here
 * opens a socket. Covers the "no provider ⇒ unavailable, never sent" rule, the
 * receipt/external-id mapping, ambiguous transport outcomes, permanent vs
 * transient provider errors, the approved-template gate for SMS, and the
 * purpose-scoped contact resolver.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createEmailAdapter,
    createSmsAdapter,
    gateChannelSend,
    redactPiiText,
    resolveContactForSend,
    sanitizeProof,
    type ProviderTransport,
    type PurposeContactStore,
} from '../src/services/delivery-channels';

const CONTACT = '+201000000123';

const okTransport = (messageId: string, providerStatus?: string): ProviderTransport => ({
    send: async () => ({ ok: true, messageId, ...(providerStatus ? { providerStatus } : {}) }),
});

test('an email adapter with no provider answers unavailable, never sent', async () => {
    const adapter = createEmailAdapter();
    assert.deepEqual(adapter.readiness(), { ready: false, reason: 'no-provider-configured' });
    assert.deepEqual(
        await adapter.send({ contact: CONTACT, locale: 'en', templateId: 'tpl_1', bodyText: 'hello' }),
        { outcome: 'unavailable', reason: 'no-provider-configured' },
    );
});

test('an SMS adapter with no provider answers unavailable, never sent', async () => {
    const adapter = createSmsAdapter({ transport: null });
    assert.equal(adapter.readiness().ready, false);
    const result = await adapter.send({ contact: CONTACT, locale: 'ar', templateId: 'tpl_1', bodyText: 'hello' });
    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.outcome === 'sent', false);
});

test('a configured email adapter reports the provider receipt id and status', async () => {
    const adapter = createEmailAdapter({ transport: okTransport('msg-77', 'ACCEPTED') });
    assert.deepEqual(adapter.readiness(), { ready: true });
    assert.deepEqual(
        await adapter.send({ contact: CONTACT, locale: 'en', templateId: 'tpl_1', bodyText: 'hello' }),
        { outcome: 'sent', proof: { message_id: 'msg-77', provider_status: 'ACCEPTED' } },
    );
});

test('a provider receipt without an external id is ambiguous, not a fabricated message id', async () => {
    const adapter = createEmailAdapter({ transport: okTransport('') });
    const result = await adapter.send({ contact: CONTACT, locale: 'en', templateId: 'tpl_1', bodyText: 'hello' });
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.outcome === 'sent', false);
});

test('a retryable provider error stays retryable, a permanent one does not', async () => {
    const retryable = createEmailAdapter({
        transport: { send: async () => ({ ok: false, error: 'upstream 503', retryable: true }) },
    });
    assert.deepEqual(
        await retryable.send({ contact: CONTACT, locale: 'en', templateId: 'tpl_1', bodyText: 'hello' }),
        { outcome: 'failed', reason: 'upstream 503' },
    );

    const permanent = createEmailAdapter({
        transport: { send: async () => ({ ok: false, error: 'mailbox does not exist', retryable: false }) },
    });
    const result = await permanent.send({ contact: CONTACT, locale: 'en', templateId: 'tpl_1', bodyText: 'hello' });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.outcome === 'failed' ? result.permanent : undefined, true);
});

test('a transport exception is an ambiguous outcome, not a definite failure', async () => {
    const adapter = createEmailAdapter({
        transport: { send: async () => { throw new Error(`socket reset while sending to ${CONTACT}`); } },
    });
    const result = await adapter.send({ contact: CONTACT, locale: 'en', templateId: 'tpl_1', bodyText: 'hello' });
    assert.equal(result.outcome, 'unknown');
    assert.equal(JSON.stringify(result).includes(CONTACT), false, 'a transport error must not leak the contact');
});

test('SMS refuses to send without an approved template id', async () => {
    let sends = 0;
    const adapter = createSmsAdapter({
        transport: {
            send: async () => {
                sends += 1;
                return { ok: true, messageId: 'msg-1' };
            },
        },
    });
    const result = await adapter.send({ contact: CONTACT, locale: 'en', templateId: '', bodyText: 'hello' });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.outcome === 'failed' ? result.permanent : undefined, true);
    assert.equal(sends, 0, 'the provider must never be called without an approved template');
});

test('the channel gate still denies unverified, opted-out and unapproved sends', async () => {
    const deps = {
        isPhoneVerified: async (input: { phone: string }) => input.phone === CONTACT,
        isTemplateApproved: async (templateId: string) => templateId === 'tpl_approved',
    };
    const base = { tenantId: 'tenant-a', userId: 'p1', userType: 'parent', phone: CONTACT, templateId: 'tpl_approved', optIn: true };
    assert.deepEqual(await gateChannelSend(deps, base), { ok: true });
    assert.deepEqual(await gateChannelSend(deps, { ...base, optIn: false }), { ok: false, reason: 'channel-not-opted-in' });
    assert.deepEqual(await gateChannelSend(deps, { ...base, templateId: 'other' }), { ok: false, reason: 'template-not-approved' });
    assert.deepEqual(await gateChannelSend(null, base), { ok: false, reason: 'phone-not-verified' });
});

// ---------------------------------------------------------------------------
// Purpose-scoped contact resolution
// ---------------------------------------------------------------------------

const purposeStore = (contact: string | null): PurposeContactStore => ({
    findContactForPurpose: async () => (contact === null ? null : { contact, verified: true }),
});

test('the contact resolver asks for the notification purpose and refuses unknown purposes', async () => {
    const asked: string[] = [];
    const store: PurposeContactStore = {
        findContactForPurpose: async (query) => {
            asked.push(`${query.purpose}:${query.channel}`);
            return { contact: 'parent@example.test', verified: true };
        },
    };
    const resolved = await resolveContactForSend(store, {
        tenantId: 'tenant-a', userId: 'parent-1', userType: 'parent',
        channel: 'email', purpose: 'progress_report',
    });
    assert.deepEqual(resolved, { ok: true, contact: 'parent@example.test', verified: true });
    assert.deepEqual(asked, ['progress_report:email'], 'the purpose travels with the lookup');

    const unknownPurpose = await resolveContactForSend(store, {
        tenantId: 'tenant-a', userId: 'parent-1', userType: 'parent',
        channel: 'email', purpose: 'marketing_blasts',
    });
    assert.deepEqual(unknownPurpose, { ok: false, reason: 'unknown-purpose' });
    assert.deepEqual(asked, ['progress_report:email'], 'an unknown purpose never reaches the store');
});

test('the contact resolver refuses in-app channels and missing contacts', async () => {
    const inApp = await resolveContactForSend(purposeStore('x@example.test'), {
        tenantId: 'tenant-a', userId: 'parent-1', userType: 'parent', channel: 'in_app', purpose: 'progress_report',
    });
    assert.deepEqual(inApp, { ok: false, reason: 'channel-not-external' });

    const missing = await resolveContactForSend(purposeStore(null), {
        tenantId: 'tenant-a', userId: 'parent-1', userType: 'parent', channel: 'sms', purpose: 'progress_report',
    });
    assert.deepEqual(missing, { ok: false, reason: 'contact-missing' });
});

test('a contact carrying a phone-shaped string is never echoed into a proof record', () => {
    const proof = sanitizeProof({ message_id: 'm1', phone: CONTACT, to: 'parent@example.test', body: 'hi', otp: '123456' });
    assert.deepEqual(proof, { message_id: 'm1' });
    assert.equal(JSON.stringify(proof).includes(CONTACT), false);
});

// ---------------------------------------------------------------------------
// Free-text redaction: every PII/secret shape, without over-redacting codes
// ---------------------------------------------------------------------------

test('redaction masks emails, credentials, bearer tokens and quoted payloads', () => {
    const email = redactPiiText('delivery to parent@example.test failed');
    assert.equal(email.includes('parent@example.test'), false, 'an email address must never survive');
    assert.ok(email.includes('••••••'));

    const credential = redactPiiText('rejected token=abc123 otp:987654 pin = 4321');
    assert.equal(credential.includes('abc123'), false, 'a token assignment must be masked');
    assert.equal(credential.includes('987654'), false, 'an otp assignment must be masked');
    assert.equal(credential.includes('4321'), false, 'a spaced pin assignment must be masked');
    assert.equal(credential.includes('token=••••••'), true, 'the key stays readable for operators');

    const bearer = redactPiiText('upstream said Bearer abcdefghijklmnop expired');
    assert.equal(bearer.includes('abcdefghijklmnop'), false, 'a bearer credential must be masked');

    const quoted = redactPiiText('provider echoed "Sami progress ok" back');
    assert.equal(quoted.includes('Sami progress ok'), false, 'a quoted message body must be masked');
    assert.equal(quoted, 'provider echoed "••••••" back');
});

test('redaction keeps short diagnostics that carry no PII', () => {
    assert.equal(redactPiiText('upstream 503'), 'upstream 503', 'a three-digit status is not a phone number');
    assert.equal(redactPiiText('mailbox does not exist'), 'mailbox does not exist');
    assert.equal(redactPiiText('authorization failed'), 'authorization failed', 'a bare keyword is not a credential');
});
