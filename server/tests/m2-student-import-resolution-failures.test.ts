/**
 * M2-14 / M2-B08 — private READ-ONLY student-import reconciliation: failure,
 * cleanup and "never fabricate a clear answer" behaviour.
 *
 * Every case here drives the REAL production handler through the REAL
 * composition (optional auth -> tenant-authority boundary -> student-workspace
 * boundary -> real tenant-self router -> real student-import router) with only
 * the read connection injected as a fixture.
 *
 * The properties pinned in this file are the ones a read-only endpoint must
 * never get wrong:
 *  - a failed acquisition, owner read or match read answers 500 and NEVER a
 *    `{ rows, summary }` envelope, so a broken reconciliation can never be
 *    mistaken for "nothing exists in the platform";
 *  - a failure is not a partial answer: a request whose SECOND field read fails
 *    still returns no rows at all;
 *  - the read connection is released EXACTLY once on every path that acquired
 *    one, is never destroyed (no transaction exists to discard) and a failing
 *    release neither changes the answer nor writes a second response;
 *  - no failure path issues a mutation, an audit insert or a transaction;
 *  - no failure body leaks SQL, a table name, a stack or an internal detail.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import {
  BILLING_ONLY,
  INSTRUCTOR_A,
  TEST_SECRET,
  body,
  buildHarness,
  createIsolation,
  loadAppModules,
  makeState,
  ownerToken,
  resolveReq,
  row,
  runChain,
  sign,
  withSilencedErrors,
} from './helpers/m2-student-import-resolution-harness';

const originalSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = TEST_SECRET;

const isolation = createIsolation();
const modules = loadAppModules(isolation, path.join(__dirname, '../src/routes/tenant-self'));

after(() => {
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
  assert.equal(isolation.hookRestored(), true);
  assert.deepEqual(isolation.sentinelCalls, [], 'no forbidden default adapter may be called');
});

const setup = () => {
  const state = makeState();
  return { state, harness: buildHarness(state, modules) };
};

const call = async (
  harness: ReturnType<typeof buildHarness>,
  payload: any,
  token: string | null = ownerToken(),
) => withSilencedErrors(() => runChain(harness.chain, resolveReq(payload, token)));

/** The generic failure body: no SQL, no table name, no stack, no detail. */
const assertOpaqueFailure = (result: { status: number; body: any }) => {
  assert.equal(result.status, 500);
  assert.deepEqual(Object.keys(result.body), ['error']);
  assert.equal(result.body.error, 'Failed to resolve student import rows');
  const serialized = JSON.stringify(result.body);
  for (const leak of ['students', 'ER_', 'SELECT', 'internal detail', 'stack', 'tenant-a']) {
    assert.equal(serialized.includes(leak), false, `the failure body must not contain ${leak}`);
  }
  // The decisive property: no fabricated "everything is clear" answer.
  assert.equal(result.body.rows, undefined);
  assert.equal(result.body.summary, undefined);
};

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

test('failure: an unavailable pool connection answers an opaque 500 without fabricating a clear result', async () => {
  const { state, harness } = setup();
  state.failAcquire = true;
  const result = await call(harness, body([row(2, 'a@x.com')]));
  assertOpaqueFailure(result);
  // Nothing was acquired, so nothing may be released or destroyed.
  assert.equal(harness.connectionCount(), 0);
  assert.equal(harness.releaseCount(), 0);
  assert.equal(harness.destroyCount(), 0);
});

test('failure: an acquisition failure issues no statement at all', async () => {
  const { state, harness } = setup();
  state.failAcquire = true;
  await call(harness, body([row(2, 'a@x.com', '0100', 'B1')]));
  assert.deepEqual(harness.calls, []);
});

test('failure: a failed acquisition still carries no-store', async () => {
  const { state, harness } = setup();
  state.failAcquire = true;
  const result = await call(harness, body([row(2, 'a@x.com')]));
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

// ---------------------------------------------------------------------------
// Owner verification
// ---------------------------------------------------------------------------

test('failure: a failed owner read answers an opaque 500 and releases exactly once', async () => {
  const { state, harness } = setup();
  state.failOwnerSelect = true;
  const result = await call(harness, body([row(2, 'a@x.com')]));
  assertOpaqueFailure(result);
  assert.equal(harness.connectionCount(), 1);
  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.destroyCount(), 0);
});

test('failure: a failed owner read never reaches a match read', async () => {
  const { state, harness } = setup();
  state.failOwnerSelect = true;
  await call(harness, body([row(2, 'a@x.com', '0100', 'B1')]));
  assert.deepEqual(harness.events, ['owner', 'release']);
});

test('failure: an unapplied schema (missing students table) answers an opaque 500', async () => {
  const { state, harness } = setup();
  state.missingSchema = true;
  const result = await call(harness, body([row(2, 'a@x.com')]));
  assertOpaqueFailure(result);
  assert.equal(harness.releaseCount(), 1);
});

// ---------------------------------------------------------------------------
// Match reads: no partial answer, no fabricated clear
// ---------------------------------------------------------------------------

test('failure: a failed FIRST field read answers 500 and never a partial envelope', async () => {
  const { state, harness } = setup();
  state.failMatchEmail = true;
  const result = await call(harness, body([row(2, 'a@x.com', '0100', 'B1')]));
  assertOpaqueFailure(result);
  assert.deepEqual(harness.events, ['owner', 'match:email', 'release']);
  assert.equal(harness.releaseCount(), 1);
});

test('failure: a failed SECOND field read discards the already-read first field', async () => {
  const { state, harness } = setup();
  state.failMatchPhone = true;
  // The email of row 2 DOES exist, so a partial implementation would be tempted
  // to answer it. It must answer nothing at all.
  const result = await call(harness, body([row(2, 'a@x.com', '0100', '')]));
  assertOpaqueFailure(result);
  assert.deepEqual(harness.events, ['owner', 'match:email', 'match:phone', 'release']);
  assert.equal(result.body.rows, undefined);
});

test('failure: a failed THIRD field read also discards everything', async () => {
  const { state, harness } = setup();
  state.failMatchBarcode = true;
  const result = await call(harness, body([row(2, 'a@x.com', '0100', 'B1')]));
  assertOpaqueFailure(result);
  assert.deepEqual(harness.events, ['owner', 'match:email', 'match:phone', 'match:barcode', 'release']);
});

test('failure: a failed read in a LATER chunk discards the earlier chunk', async () => {
  const { state, harness } = setup();
  state.failMatchEmail = true;
  const rows = Array.from({ length: 250 }, (_, index) => row(index + 2, `s${index}@x.com`));
  const result = await call(harness, body(rows));
  assertOpaqueFailure(result);
  // One chunk would have been issued before the failure; no chunk result leaks.
  assert.equal(result.body.summary, undefined);
});

test('failure: every failure path issues zero mutation and zero transaction statements', async () => {
  const switches: Array<keyof ReturnType<typeof makeState>> = [
    'failAcquire', 'failOwnerSelect', 'failMatchEmail', 'failMatchPhone', 'failMatchBarcode', 'missingSchema',
  ];
  for (const flag of switches) {
    const { state, harness } = setup();
    (state as any)[flag] = true;
    const result = await call(harness, body([row(2, 'a@x.com', '0100', 'B1')]));
    assert.equal(result.status, 500, `${flag} must fail`);
    assert.deepEqual(harness.mutations(), [], `${flag} must not write anything`);
    assert.equal(harness.destroyCount(), 0, `${flag} must not discard a read connection`);
    assert.equal(result.responseCount, 1, `${flag} must write exactly one response`);
  }
});

// ---------------------------------------------------------------------------
// Release hygiene
// ---------------------------------------------------------------------------

test('cleanup: a failing release neither changes the answer nor writes a second response', async () => {
  const { state, harness } = setup();
  state.failRelease = true;
  const result = await call(harness, body([row(2, 'a@x.com')]));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.rows, [{ row_number: 2, matched_fields: ['email'] }]);
  assert.equal(result.responseCount, 1);
  assert.equal(harness.releaseCount(), 1);
});

test('cleanup: the connection is released exactly once even when the answer is a 400', async () => {
  const { harness } = setup();
  const result = await call(harness, body([]));
  assert.equal(result.status, 400);
  // A 400 is decided BEFORE acquisition, so no connection exists to release.
  assert.equal(harness.connectionCount(), 0);
  assert.equal(harness.releaseCount(), 0);
});

test('cleanup: a billing-only denial releases nothing because nothing was acquired', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'a@x.com')]), sign(BILLING_ONLY, 'instructor'));
  assert.equal(result.status, 403);
  assert.equal(harness.connectionCount(), 0);
  assert.equal(harness.releaseCount(), 0);
});

test('cleanup: a non-owner request releases the connection it did acquire', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'a@x.com')]), sign(INSTRUCTOR_A, 'instructor'));
  assert.equal(result.status, 403);
  assert.equal(harness.connectionCount(), 1);
  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.destroyCount(), 0);
});

test('cleanup: a successful request never destroys its connection', async () => {
  const { harness } = setup();
  await call(harness, body([row(2, 'a@x.com', '0100', 'B1')]));
  assert.equal(harness.destroyCount(), 0);
  assert.equal(harness.releaseCount(), 1);
});

// ---------------------------------------------------------------------------
// Malformed requests never reach the data layer
// ---------------------------------------------------------------------------

test('failure: no malformed payload can reach the data layer', async () => {
  const payloads: any[] = [
    null,
    [],
    {},
    { rows: [] },
    { rows: [row(1, 'a@x.com')] },
    { rows: [row(2, 'a@x.com'), row(2, 'b@x.com')] },
    { rows: [{ row_number: 2, email: 'a@x.com', phone: '', barcode: '', name: 'Ali' }] },
    { rows: [row(2, ' a@x.com')] },
    { rows: [{ row_number: 2, email: 7, phone: '', barcode: '' }] },
    { rows: [row(2, '', '', '')] },
  ];
  for (const payload of payloads) {
    const { harness } = setup();
    const result = await call(harness, payload);
    assert.equal(result.status, 400, `payload ${JSON.stringify(payload)} must be refused`);
    assert.equal(harness.connectionCount(), 0, 'a malformed payload must not open a connection');
    assert.deepEqual(harness.calls, []);
    assert.equal(result.responseCount, 1);
  }
});
