import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiRequestError } from '../lib/api-http';
import { createLinkWrite, linkRecoveryStore, parseLinkMarker, parseLinkReceipt, parseLinkPage, parseLinkReview, parseLinkAvailability, readLinkAvailability, type LinkMarker, type LinkWriteState } from '../features/enrollment/account-link';
test('availability is server state only and anonymous discovery sends no credentials', async () => {
    assert.equal(parseLinkAvailability({ state: 'deferred' }), 'deferred');
    assert.equal(parseLinkAvailability({ state: 'verification_required' }), 'verification_required');
    for (const x of [{ enabled: true }, { state: 'ready' }, { state: 'deferred', enabled: true }])
        assert.throws(() => parseLinkAvailability(x));
    const previous = globalThis.fetch;
    let observed: RequestInit | undefined;
    try {
        globalThis.fetch = async (_url, init) => { observed = init; return new Response(JSON.stringify({ state: 'deferred' })); };
        assert.equal(await readLinkAvailability('student', new AbortController().signal), 'deferred');
        assert.equal(observed?.credentials, 'omit');
        assert.equal(new Headers(observed?.headers).has('Authorization'), false);
    }
    finally {
        globalThis.fetch = previous;
    }
});
const id = (n: number) => `b5200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const marker: LinkMarker = { kind: 'owner', operation_id: id(1), request_id: id(2), student_id: id(3) };
const raw = { operation: { operation_id: id(1), request_id: id(2), student_id: id(3), state: 'account_linked' } };
function fixture() {
    const memory = new Map<string, string>();
    let principal: string | null = 'A', event = () => { }, state: LinkWriteState;
    const calls: string[] = [];
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); }, removeItem: (k: string) => { memory.delete(k); } };
    const store = linkRecoveryStore(storage, 'account', 'owner');
    const deps = { store, principal: () => principal, subscribe: (fn: () => void) => { event = fn; return () => { }; }, post: async () => { calls.push('POST'); return raw; }, get: async () => { calls.push('GET'); return raw; } };
    const create = () => { const c = createLinkWrite(deps); c.subscribe(s => state = s); return c; };
    return { store, storage, memory, deps, calls, create, state: () => state!, end: () => { principal = 'B'; event(); } };
}
test('strict markers and receipts exclude phones, invitation secrets, OTP and foreign results', () => {
    assert.deepEqual(parseLinkMarker(marker), marker);
    assert.throws(() => parseLinkMarker({ ...marker, phone: 'private' }));
    assert.throws(() => parseLinkReceipt({ operation: { ...raw.operation, student_id: id(9) } }, marker));
    assert.throws(() => parseLinkReceipt({ operation: { ...raw.operation, password: 'private' } }, marker));
    assert.throws(() => parseLinkMarker({ kind: 'student', action: 'request', operation_id: 'undefined' }));
    assert.throws(() => parseLinkPage({ items: [{ id: id(2), name: 'A', phone: 'private' }], next_cursor: null }));
    assert.throws(() => parseLinkReview({ student: { id: id(3), name: 'Student' }, request: { id: id(2), name: 'Account' }, effect: 'course_granted', review_token: 'a'.repeat(64) }, id(3), id(2)));
});
test('lost ACK persists only IDs and recovers after recreation with GET rather than duplicate POST', async () => {
    const h = fixture(), c = h.create();
    h.deps.post = async () => { h.calls.push('POST'); throw Error('lost ACK'); };
    await c.apply(marker, { review_token: 'private-review' });
    assert.equal(h.state().phase, 'uncertain');
    assert.equal([...h.memory.values()][0].includes('review_token'), false);
    c.dispose();
    const reopened = h.create();
    await reopened.apply(marker, {});
    await reopened.recover();
    assert.deepEqual(h.calls, ['POST', 'GET']);
    assert.equal(h.state().phase, 'saved');
    assert.equal(h.memory.size, 0);
    reopened.dispose();
});
test('storage refusal prevents POST; account and action namespaces remain isolated', async () => {
    const h = fixture();
    h.store.write = () => { throw Error('full'); };
    const c = h.create();
    await c.apply(marker, {});
    assert.deepEqual(h.calls, []);
    assert.equal(h.state().phase, 'idle');
    c.dispose();
    const s = fixture();
    s.store.write(marker);
    assert.equal(linkRecoveryStore(s.storage, 'other', 'owner').read(), null);
    assert.equal(linkRecoveryStore(s.storage, 'account', 'student').read(), null);
});
test('confirmed save remains visible and locked if marker cleanup fails and GET later fails', async () => {
    const h = fixture();
    h.store.clear = () => { throw Error('denied'); };
    const c = h.create();
    await c.apply(marker, {});
    assert.equal(h.state().receipt?.state, 'account_linked');
    assert.equal(h.state().phase, 'uncertain');
    h.deps.get = async () => { throw Error('offline'); };
    await c.recover();
    await c.apply(marker, {});
    assert.deepEqual(h.calls, ['POST']);
    assert.equal(h.state().receipt?.state, 'account_linked');
    c.dispose();
});
test('missing or foreign receipt never clears intent; definite denial clears only when cleanup works', async () => {
    for (const answer of [{ operation: null }, { operation: { ...raw.operation, request_id: id(8) } }]) {
        const h = fixture();
        h.store.write(marker);
        h.deps.get = async () => answer as any;
        const c = h.create();
        await c.recover();
        assert.equal(h.state().phase, 'uncertain');
        assert.equal(h.memory.size, 1);
        c.dispose();
    }
    const h = fixture(), c = h.create();
    h.deps.post = async () => { throw new ApiRequestError('denied', 409); };
    await c.apply(marker, {});
    assert.equal(h.state().phase, 'idle');
    assert.equal(h.memory.size, 0);
    c.dispose();
});
test('a withdrawal GET that still says pending cannot masquerade as successful withdrawal', () => {
    const student: LinkMarker = { kind: 'student', action: 'withdraw', operation_id: id(1) };
    assert.throws(() => parseLinkReceipt({ request: { id: id(1), state: 'pending' } }, student));
    assert.equal(parseLinkReceipt({ request: { id: id(1), state: 'withdrawn' } }, student)?.state, 'withdrawn');
});
test('principal replacement fences late success and keeps original recovery intent', async () => {
    const h = fixture(), c = h.create();
    let resolve!: (x: typeof raw) => void;
    h.deps.post = () => new Promise(r => resolve = r);
    const work = c.apply(marker, {});
    h.end();
    resolve(raw);
    await work;
    assert.equal(h.state().phase, 'ended');
    assert.equal(h.state().receipt, null);
    assert.equal(h.memory.size, 1);
    c.dispose();
});
test('deadline never accepts a late ACK or clears intent until an explicit receipt read', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = fixture(), c = h.create();
    let resolve!: (x: typeof raw) => void;
    h.deps.post = () => new Promise(r => resolve = r);
    const work = c.apply(marker, {});
    t.mock.timers.tick(25000);
    assert.equal(h.state().phase, 'uncertain');
    resolve(raw);
    await work;
    assert.equal(h.state().receipt, null);
    await c.recover();
    assert.equal(h.state().phase, 'saved');
    c.dispose();
});
