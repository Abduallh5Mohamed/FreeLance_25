/**
 * W10-R2 — recording ingest suite.
 *
 * Drives the REAL ingest service over the REAL in-memory ledger and library.
 * The properties proven here are the ones the delivery claims:
 *
 *  - nothing is ingested from an unverified payload;
 *  - the tenant always comes from the session row, never from the callback —
 *    including the audit partition: an unresolved callback writes a GLOBAL
 *    security event and cannot choose which tenant receives it;
 *  - both dedupe keys work (callback replay AND a second event naming the same
 *    recording);
 *  - a recording lands unpublished with a `deny` access policy — ingest never
 *    publishes;
 *  - a metering gap is reported as `deferred`/`unconfigured`, never as a
 *    successful measurement, and never blocks the library write.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    MAX_RECORDING_SECONDS,
    createInMemoryRecordingIngestStore,
    createInMemoryRecordingLibrary,
    createRecordingIngestService,
    planRecordingAsset,
    type InMemoryRecordingIngestStore,
    type InMemoryRecordingLibrary,
    type RecordingCallbackInput,
    type RecordingIngestService,
    type RecordingIngestStore,
    type RecordingLibraryPort,
    type RecordingMeteringOutcome,
    type RecordingStorageMeterPort,
} from '../src/services/live-recording-ingest';

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const ENDED_AT = 1_000_000;

interface Harness {
    store: InMemoryRecordingIngestStore;
    library: InMemoryRecordingLibrary;
    service: RecordingIngestService;
    meterCalls: Array<{ tenantId: unknown; assetId: unknown; bytes: unknown; operationId: unknown }>;
    setVerified(value: boolean): void;
    setMeter(result: 'recorded' | 'deduplicated' | 'error' | 'throw'): void;
}

function harness(options: {
    verified?: boolean;
    library?: boolean;
    meter?: boolean;
    graceSeconds?: number;
} = {}): Harness {
    const store = createInMemoryRecordingIngestStore();
    store.seedSession({
        id: 'session-1',
        tenantId: TENANT,
        title: 'Algebra live',
        state: 'ended',
        endedAtMs: ENDED_AT,
        provider: 'acme',
        providerRoomId: 'room-1',
    });
    const library = createInMemoryRecordingLibrary((() => {
        let n = 0;
        return () => `asset-${++n}`;
    })());
    let verified = options.verified ?? true;
    let meterMode: 'recorded' | 'deduplicated' | 'error' | 'throw' = 'recorded';
    const meterCalls: Harness['meterCalls'] = [];

    const meterStorage: RecordingStorageMeterPort = {
        recordVerifiedBytes: async (input) => {
            meterCalls.push({
                tenantId: input.tenantId,
                assetId: input.assetId,
                bytes: input.resultingBytes,
                operationId: input.operationId,
            });
            if (meterMode === 'throw') throw new Error('meter unavailable');
            if (meterMode === 'error') return { error: 'the meter store cannot open a transaction; refusing to write' };
            return { recorded: meterMode === 'recorded', deduplicated: meterMode === 'deduplicated' };
        },
    };

    const service = createRecordingIngestService({
        store,
        library: options.library === false ? undefined : library,
        meterStorage: options.meter === false ? undefined : meterStorage,
        verifyCallbackSignature: () => verified,
        now: () => ENDED_AT + 1_000,
        idFactory: (() => {
            let n = 0;
            return () => `ingest-${++n}`;
        })(),
        graceSeconds: options.graceSeconds ?? 3_600,
    });

    return {
        store,
        library,
        service,
        meterCalls,
        setVerified: (value) => { verified = value; },
        setMeter: (result) => { meterMode = result; },
    };
}

const callback = (overrides: Partial<RecordingCallbackInput> = {}): RecordingCallbackInput => ({
    provider: 'acme',
    eventId: 'evt-rec-1',
    signature: 'sig',
    providerRoomId: 'room-1',
    providerRecordingId: 'rec-1',
    durationSeconds: 600,
    storageBytes: 1_048_576,
    occurredAtMs: ENDED_AT,
    ...overrides,
});

test('an unverified recording callback is ignored and the ledger stays empty', async () => {
    const h = harness({ verified: false });
    assert.deepEqual(await h.service.ingest(callback()), { status: 'ignored', reason: 'unverified-signature' });
    assert.equal(h.store.rows.length, 0);
    assert.equal(h.library.assets.length, 0);
    assert.ok(h.store.audits.some((entry) => entry.reason === 'unverified_signature'));
});

test('the tenant comes from the session row, not from the callback', async () => {
    const h = harness();
    assert.deepEqual(
        await h.service.ingest(callback({ tenantId: OTHER_TENANT })),
        { status: 'rejected', reason: 'cross-tenant' },
    );
    assert.equal(h.library.assets.length, 0);

    const unknownRoom = await h.service.ingest(callback({ providerRoomId: 'room-x' }));
    assert.deepEqual(unknownRoom, { status: 'ignored', reason: 'unknown-session' });

    const malformed = await h.service.ingest(callback({ providerRecordingId: '' }));
    assert.deepEqual(malformed, { status: 'ignored', reason: 'malformed' });
});

test('a verified recording is ingested unpublished with a deny policy and metered once', async () => {
    const h = harness();
    const result = await h.service.ingest(callback());
    assert.deepEqual(result, {
        status: 'ingested',
        assetId: 'asset-1',
        metering: 'recorded',
        library: 'created',
        visibility: 'unpublished',
    });

    assert.equal(h.library.assets.length, 1);
    const asset = h.library.assets[0];
    assert.equal(asset.tenantId, TENANT);
    assert.equal(asset.sessionId, 'session-1');
    assert.equal(asset.visibility, 'unpublished');
    assert.equal(asset.accessPolicy, 'deny');
    assert.equal(asset.publishable, false);
    assert.equal(asset.durationSeconds, 600);
    assert.equal(asset.storageBytes, 1_048_576);

    assert.equal(h.meterCalls.length, 1);
    assert.deepEqual(h.meterCalls[0], {
        tenantId: TENANT,
        // Provider-scoped and legal for the meter's ASSET_ID_RE (no colon):
        // `rec-<provider>-<sha256(provider NUL recording)[0..32]>`.
        assetId: 'rec-acme-50508b5e916f4239d7ce79900c6a1659',
        bytes: 1_048_576,
        // Provider-qualified so two providers' `evt-rec-1` cannot share a key.
        operationId: 'acme:evt-rec-1',
    });
});

test('both dedupe keys hold: a replayed event and a second event for the same recording', async () => {
    const h = harness();
    assert.equal((await h.service.ingest(callback())).status, 'ingested');

    assert.deepEqual(await h.service.ingest(callback()), { status: 'duplicate', reason: 'event-replay' });
    assert.deepEqual(
        await h.service.ingest(callback({ eventId: 'evt-rec-2' })),
        { status: 'duplicate', reason: 'recording-exists' },
    );
    assert.equal(h.library.assets.length, 1);
    assert.equal(h.meterCalls.length, 1, 'a duplicate never reaches the meter');
});

test('a recording callback outside the grace window is ignored, not filed', async () => {
    const h = harness({ graceSeconds: 60 });
    const result = await h.service.ingest(callback({ occurredAtMs: ENDED_AT + 61_000 }));
    assert.deepEqual(result, { status: 'ignored', reason: 'outside-grace' });
    assert.equal(h.store.rows.length, 0);
    assert.ok(h.store.audits.some((entry) => entry.reason === 'outside_grace'));
});

test('a metering failure is deferred and never blocks the library write', async () => {
    const h = harness();
    h.setMeter('error');
    const result = await h.service.ingest(callback());
    assert.equal(result.status, 'ingested');
    if (result.status !== 'ingested') throw new Error('expected ingest');
    assert.equal(result.metering, 'deferred');
    assert.equal(result.library, 'created');
    assert.ok(h.store.audits.some((entry) => entry.action === 'live.recording.metering_deferred'));

    const thrown = harness();
    thrown.setMeter('throw');
    const second = await thrown.service.ingest(callback());
    assert.equal(second.status, 'ingested');
    if (second.status !== 'ingested') throw new Error('expected ingest');
    assert.equal(second.metering, 'deferred');
});

test('an unconfigured meter or library is reported, never faked', async () => {
    const noLibrary = harness({ library: false });
    const first = await noLibrary.service.ingest(callback());
    // The required sink is absent: the marker must stay repairable instead of
    // being terminalised as a success (D1).
    assert.deepEqual(first, { status: 'deferred', reason: 'library-unconfigured' });
    assert.equal(noLibrary.store.rows.length, 1);
    assert.equal(noLibrary.store.rows[0].outcome, 'pending', 'an absent required sink never settles the marker');
    assert.ok(noLibrary.store.audits.some((entry) => entry.action === 'live.recording.deferred'));

    const noMeter = harness({ meter: false });
    const second = await noMeter.service.ingest(callback());
    assert.equal(second.status, 'ingested');
    if (second.status !== 'ingested') throw new Error('expected ingest');
    assert.equal(second.metering, 'unconfigured');
    assert.ok(noMeter.store.audits.some((entry) => entry.action === 'live.recording.metering_unconfigured'));
});

test('the descriptor planner refuses what it cannot represent', () => {
    const session = { id: 'session-1', tenantId: TENANT, title: 'Live', state: 'ended' as const, endedAtMs: ENDED_AT };
    const base = {
        session,
        provider: 'acme',
        providerRecordingId: 'rec-1',
        sourceEventId: 'evt-1',
        recordedAtMs: ENDED_AT,
    };

    assert.deepEqual(planRecordingAsset({ ...base, durationSeconds: 0, storageBytes: 10 }), { ok: false, reason: 'invalid-duration' });
    assert.deepEqual(
        planRecordingAsset({ ...base, durationSeconds: MAX_RECORDING_SECONDS + 1, storageBytes: 10 }),
        { ok: false, reason: 'duration-cap' },
    );
    assert.deepEqual(planRecordingAsset({ ...base, durationSeconds: 10, storageBytes: -1 }), { ok: false, reason: 'invalid-bytes' });
    assert.deepEqual(
        planRecordingAsset({ ...base, session: { ...session, state: 'cancelled' }, durationSeconds: 10, storageBytes: 10 }),
        { ok: false, reason: 'session-not-ingestible' },
    );

    const planned = planRecordingAsset({ ...base, durationSeconds: 10, storageBytes: 10 });
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error('expected a descriptor');
    assert.equal(planned.descriptor.accessPolicy, 'deny');
    assert.equal(planned.descriptor.visibility, 'unpublished');
    assert.equal(planned.descriptor.publishable, false);
    assert.equal(planned.descriptor.kind, 'live-recording');
});

test('metering outcome types stay explicit', () => {
    const outcomes: RecordingMeteringOutcome[] = ['recorded', 'deduplicated', 'deferred', 'unconfigured'];
    assert.equal(new Set(outcomes).size, 4);
});

test('a failed library leaves a repairable pending marker that a replay finishes', async () => {
    const store = createInMemoryRecordingIngestStore();
    store.seedSession({
        id: 'session-1',
        tenantId: TENANT,
        title: 'Algebra live',
        state: 'ended',
        endedAtMs: ENDED_AT,
        provider: 'acme',
        providerRoomId: 'room-1',
    });
    // A library that is down for the first delivery and healthy afterwards.
    const assets: string[] = [];
    let healthy = false;
    const library: RecordingLibraryPort = {
        createRecordingAsset: async () => {
            if (!healthy) throw new Error('library unavailable');
            assets.push('asset-1');
            return { created: true, assetId: 'asset-1' };
        },
    };
    const meterCalls: Array<{ operationId: unknown }> = [];
    const meterStorage: RecordingStorageMeterPort = {
        recordVerifiedBytes: async (input) => {
            meterCalls.push({ operationId: input.operationId });
            return { recorded: true, deduplicated: false };
        },
    };
    const service = createRecordingIngestService({
        store,
        library,
        meterStorage,
        verifyCallbackSignature: () => true,
        now: () => ENDED_AT + 1_000,
        graceSeconds: 3_600,
    });

    const first = await service.ingest(callback());
    assert.deepEqual(first, { status: 'deferred', reason: 'library-error' });
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0].outcome, 'pending', 'a deferred library keeps the marker repairable');
    assert.equal(assets.length, 0);
    const firstAudit = store.audits.find((entry) => entry.action === 'live.recording.deferred');
    assert.ok(firstAudit, 'the attempt is audited');
    assert.equal(
        (firstAudit.newValue as Record<string, unknown>).ledger_outcome,
        'pending',
        'the audit states the marker is still pending, not that it settled',
    );
    assert.equal(
        store.audits.some((entry) => entry.action === 'live.recording.ingested'),
        false,
        'a non-terminal outcome never writes the terminal-success action',
    );

    // The provider redelivers the same event: a pending marker is resumable,
    // not a duplicate, so the recording is not lost.
    healthy = true;
    const replay = await service.ingest(callback());
    assert.equal(replay.status, 'ingested');
    if (replay.status !== 'ingested') throw new Error('expected ingest');
    assert.equal(replay.library, 'created');
    assert.equal(assets.length, 1);
    assert.equal(store.rows.length, 1, 'the replay reuses the row instead of inserting a second one');
    assert.equal(store.rows[0].outcome, 'ingested');
    assert.equal(meterCalls.length, 2);
    assert.deepEqual(
        meterCalls.map((call) => call.operationId),
        ['acme:evt-rec-1', 'acme:evt-rec-1'],
        'the meter sees the same provider-qualified operation id, so the retry is absorbed there too',
    );

    // Once the marker is settled, a third delivery is a real duplicate.
    assert.deepEqual(await service.ingest(callback()), { status: 'duplicate', reason: 'event-replay' });
    assert.equal(assets.length, 1);
});

test('a store without a transaction unit refuses the callback and writes nothing', async () => {
    const full = createInMemoryRecordingIngestStore();
    full.seedSession({
        id: 'session-1',
        tenantId: TENANT,
        title: 'Algebra live',
        state: 'ended',
        endedAtMs: ENDED_AT,
        provider: 'acme',
        providerRoomId: 'room-1',
    });
    // Same adapter, no unit: the marker must not be written outside one.
    const noUnit: RecordingIngestStore = {
        findSessionByProviderRoom: full.findSessionByProviderRoom,
        findIngest: full.findIngest,
        insertIngest: full.insertIngest,
        finalizeIngest: full.finalizeIngest,
        recordAudit: full.recordAudit,
    };
    const library = createInMemoryRecordingLibrary();
    const service = createRecordingIngestService({
        store: noUnit,
        library,
        verifyCallbackSignature: () => true,
        now: () => ENDED_AT + 1_000,
        graceSeconds: 3_600,
    });

    assert.deepEqual(await service.ingest(callback()), { status: 'rejected', reason: 'transaction-required' });
    assert.equal(full.rows.length, 0);
    assert.equal(library.assets.length, 0);
});

test('an unresolved recording callback cannot choose the audit partition', async () => {
    const h = harness({ verified: false });

    // 1. Unverified signature, attacker-chosen claim.
    assert.deepEqual(
        await h.service.ingest(callback({ tenantId: OTHER_TENANT })),
        { status: 'ignored', reason: 'unverified-signature' },
    );
    assert.equal(h.store.audits[0].tenantId, null, 'unverified audit is a global security event');

    // 2. Malformed envelope, same claim.
    h.setVerified(true);
    assert.deepEqual(
        await h.service.ingest(callback({ providerRecordingId: '', tenantId: OTHER_TENANT })),
        { status: 'ignored', reason: 'malformed' },
    );
    assert.equal(h.store.audits[1].tenantId, null);

    // 3. Unknown session, same claim.
    assert.deepEqual(
        await h.service.ingest(callback({ providerRoomId: 'room-x', tenantId: OTHER_TENANT })),
        { status: 'ignored', reason: 'unknown-session' },
    );
    assert.equal(h.store.audits[2].tenantId, null);

    // 4. Verified claim that disagrees with the trusted row: the row tenant wins.
    assert.deepEqual(
        await h.service.ingest(callback({ tenantId: OTHER_TENANT })),
        { status: 'rejected', reason: 'cross-tenant' },
    );
    assert.equal(h.store.audits[3].tenantId, TENANT);

    // No audit anywhere in this sequence was written into the attacker's tenant.
    assert.equal(h.store.audits.filter((entry) => entry.tenantId === OTHER_TENANT).length, 0);
    assert.deepEqual(h.store.audits[0].newValue, { tenant_claim: OTHER_TENANT });
    assert.equal(h.store.rows.length, 0, 'no ledger row from an unresolved callback');
    assert.equal(h.library.assets.length, 0);
});
