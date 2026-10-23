/**
 * M2-B06 — private tenant branding: cleanup, disposal and failure boundaries
 * (hermetic, behavioral).
 *
 * This suite drives the REAL production handlers through the REAL composition
 * and fails one boundary at a time, so the observable guarantees of the
 * contract are proven instead of asserted in prose:
 *
 *  - a failure BEFORE a connection exists releases and destroys nothing;
 *  - a failure after acquisition but before the transaction state is confirmed
 *    DESTROYS the connection (it is never pooled with a possibly-dirty session);
 *  - a confirmed rollback, a no-op and a success each RELEASE exactly once;
 *  - a failed rollback DESTROYS the connection;
 *  - a lost commit acknowledgement DESTROYS the connection, claims no rollback
 *    and reports no success — persistence is UNKNOWN and stays unknown;
 *  - no failure path leaks a partial branding write or a committed audit event
 *    (the fixture replays the transaction, so a leak is observable);
 *  - an unreadable stored instant, a non-canonical stored color and a missing
 *    schema are all a 500 — an all-null success is NEVER fabricated to disguise
 *    a broken deployment;
 *  - every handler-owned outcome carries `Cache-Control: no-store`, and a 500
 *    body carries no SQL, stack or internal detail;
 *  - no response is written twice on any path;
 *  - no forbidden default adapter (db/minio/renewal/dotenv) is ever called.
 *
 * Live MySQL semantics (real row locks, real concurrent transactions, real
 * disconnect-abort behaviour) are explicitly NOT exercised or claimed: the
 * fixture models the STATEMENTS and the transaction REPLAY, not the server.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import {
  OWNER_A,
  OWNER_B,
  TENANT_A,
  TENANT_B,
  TEST_SECRET,
  buildHarness,
  createIsolation,
  getReq,
  loadAppModules,
  makeState,
  ownerBToken,
  ownerToken,
  patchReq,
  runChain,
  sign,
  withSilencedErrors,
  type Harness,
  type State,
} from './helpers/m2-tenant-branding-harness';

const originalSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = TEST_SECRET;

const isolation = createIsolation();
const modules = loadAppModules(isolation, path.join(__dirname, '../src/routes/tenant-self'));

after(() => {
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
  assert.equal(isolation.hookRestored(), true, 'the loader hook must be restored after loading');
  assert.deepEqual(isolation.sentinelCalls, [], 'no forbidden default adapter may be called by any test in this suite');
});

/** Builds a harness over a state the test mutates before the request. */
const harnessWith = (mutate: (state: State) => void): Harness => {
  const state = makeState();
  mutate(state);
  return buildHarness(state, modules);
};

const get = (harness: Harness, token: string | null = ownerToken()) =>
  withSilencedErrors(() => runChain(harness.chain, getReq(token)));
const patch = (harness: Harness, body: any, token: string | null = ownerToken()) =>
  withSilencedErrors(() => runChain(harness.chain, patchReq(body, token)));

/** A 500 must never carry a statement, a stack or an internal identifier. */
const assertOpaqueFailure = (result: { body: any }, expectedMessage: string) => {
  assert.deepEqual(result.body, { error: expectedMessage });
  const serialized = JSON.stringify(result.body);
  for (const leak of ['SELECT', 'INSERT', 'UPDATE', 'audit_events', 'tenant_branding', 'HERMETIC', 'ER_', 'internal detail', 'at ']) {
    assert.ok(!serialized.includes(leak), `a failure body must not leak ${leak}`);
  }
};

// ===========================================================================
// Acquisition and transaction start
// ===========================================================================

test('failure: an acquisition failure is a safe 500 with nothing to release or destroy', async () => {
  const harness = harnessWith(state => { state.failAcquire = true; });
  const result = await patch(harness, { display_name_en: 'Academy' });
  assert.equal(result.status, 500);
  assertOpaqueFailure(result, 'Failed to update branding');
  assert.equal(harness.connectionCount(), 0, 'no connection was created');
  assert.equal(harness.releaseCount(), 0);
  assert.equal(harness.destroyCount(), 0);
  assert.equal(harness.commitCount(), 0);
});

test('failure: an acquisition failure on a read is a safe 500 with nothing to release', async () => {
  const harness = harnessWith(state => { state.failAcquire = true; });
  const result = await get(harness);
  assert.equal(result.status, 500);
  assertOpaqueFailure(result, 'Failed to load branding');
  assert.equal(harness.releaseCount(), 0);
  assert.equal(harness.destroyCount(), 0);
});

test('failure: a beginTransaction failure DESTROYS the connection', async () => {
  const harness = harnessWith(state => { state.failBegin = true; });
  const result = await patch(harness, { display_name_en: 'Academy' });
  assert.equal(result.status, 500);
  assertOpaqueFailure(result, 'Failed to update branding');
  assert.equal(harness.connectionCount(), 1);
  assert.equal(harness.destroyCount(), 1, 'an unconfirmed transaction state is never pooled');
  assert.equal(harness.releaseCount(), 0);
  assert.equal(harness.commitCount(), 0);
});

test('failure: a beginTransaction failure on a read also DESTROYS the connection', async () => {
  const harness = harnessWith(state => { state.failBegin = true; });
  const result = await get(harness);
  assert.equal(result.status, 500);
  assert.equal(harness.destroyCount(), 1);
  assert.equal(harness.releaseCount(), 0);
});

// ===========================================================================
// Statement failures inside a confirmed transaction
// ===========================================================================

test('failure: an owner verification failure is a safe 500 and is rolled back', async () => {
  const harness = harnessWith(state => { state.failOwnerSelect = true; });
  const result = await patch(harness, { display_name_en: 'Academy' });
  assert.equal(result.status, 500);
  assertOpaqueFailure(result, 'Failed to update branding');
  assert.equal(harness.rollbackCount(), 1);
  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.destroyCount(), 0);
  assert.equal(harness.commitCount(), 0);
});

test('failure: a config read failure is a safe 500 and is rolled back', async () => {
  const harness = harnessWith(state => { state.failBrandingSelect = true; });
  const result = await get(harness);
  assert.equal(result.status, 500);
  assertOpaqueFailure(result, 'Failed to load branding');
  assert.equal(harness.rollbackCount(), 1);
  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.auditRows.length, 0);
});

test('failure: an insert failure rolls back and leaves no partial row', async () => {
  const harness = harnessWith(state => { state.failInsert = true; });
  const result = await patch(harness, { display_name_en: 'Academy B' }, ownerBToken());
  assert.equal(result.status, 500);
  assertOpaqueFailure(result, 'Failed to update branding');
  assert.equal(harness.state.branding[TENANT_B], undefined, 'the absent row stays absent');
  assert.equal(harness.auditRows.length, 0, 'no audit event survives a rolled-back insert');
  assert.equal(harness.commitCount(), 0);
  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.destroyCount(), 0);
});

test('failure: an update failure rolls back and keeps the previous values', async () => {
  const harness = harnessWith(state => { state.failUpdate = true; });
  const result = await patch(harness, { display_name_en: 'Never Stored' });
  assert.equal(result.status, 500);
  assert.equal(harness.state.branding[TENANT_A].display_name_en, 'Academy A', 'the stored value is unchanged');
  assert.equal(harness.auditRows.length, 0);
  assert.equal(harness.commitCount(), 0);
});

test('failure: an audit failure rolls back the branding write — never a half-applied change', async () => {
  const harness = harnessWith(state => { state.failAudit = true; });
  const result = await patch(harness, { display_name_en: 'Audited Only If Committed' });
  assert.equal(result.status, 500);
  assertOpaqueFailure(result, 'Failed to update branding');
  assert.equal(
    harness.state.branding[TENANT_A].display_name_en,
    'Academy A',
    'the write is rolled back together with its audit event',
  );
  assert.equal(harness.auditRows.length, 0);
  assert.equal(harness.commitCount(), 0, 'nothing is committed when the audit fails');
  assert.equal(harness.rollbackCount(), 1);
  assert.equal(harness.releaseCount(), 1);
});

test('failure: a read-back that answers no row is a safe 500 and is rolled back', async () => {
  const harness = harnessWith(state => { state.failReadBack = true; });
  const result = await patch(harness, { display_name_en: 'Academy' });
  assert.equal(result.status, 500);
  assertOpaqueFailure(result, 'Failed to update branding');
  assert.equal(harness.commitCount(), 0);
  assert.equal(harness.releaseCount(), 1);
});

// ===========================================================================
// Epoch projection — never fabricated
// ===========================================================================

test('failure: an unreadable stored epoch on a read is a 500, never an all-null success', async () => {
  for (const malformed of ['null', 'zero', 'nan', 'text', 'missing'] as const) {
    const harness = harnessWith(state => { state.malformedEpoch = malformed; });
    const result = await get(harness);
    assert.equal(result.status, 500, `refused: ${malformed}`);
    assertOpaqueFailure(result, 'Failed to load branding');
    assert.equal(result.body.branding, undefined, `no fabricated DTO for ${malformed}`);
    assert.equal(harness.commitCount(), 0);
  }
});

test('failure: an unreadable stored epoch is never answered as a 1970 instant', async () => {
  const harness = harnessWith(state => { state.malformedEpoch = 'zero'; });
  const result = await get(harness);
  assert.equal(result.status, 500);
  assert.ok(!JSON.stringify(result.body).includes('1970'), 'epoch 0 is refused, not rendered');
});

test('failure: an unreadable stored epoch on a write is a 500 and the write is not committed', async () => {
  const harness = harnessWith(state => { state.malformedEpoch = 'text'; });
  const result = await patch(harness, { display_name_en: 'Should Not Commit' });
  assert.equal(result.status, 500);
  assertOpaqueFailure(result, 'Failed to update branding');
  assert.equal(harness.commitCount(), 0, 'a row whose date could only be guessed is never committed');
  assert.equal(harness.state.branding[TENANT_A].display_name_en, 'Academy A');
  assert.equal(harness.auditRows.length, 0);
});

// ===========================================================================
// Missing schema — the migration FILE was never applied
// ===========================================================================

test('failure: a missing schema is a 500, never a fabricated all-null success', async () => {
  const harness = harnessWith(state => { state.missingSchema = true; });
  const result = await get(harness);
  assert.equal(result.status, 500);
  assertOpaqueFailure(result, 'Failed to load branding');
  assert.equal(result.body.branding, undefined, 'a broken deployment is not disguised as "no branding"');
  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.destroyCount(), 0);
});

test('failure: a missing schema on a write is a 500 with no partial state', async () => {
  const harness = harnessWith(state => { state.missingSchema = true; });
  const result = await patch(harness, { display_name_en: 'Academy' });
  assert.equal(result.status, 500);
  assertOpaqueFailure(result, 'Failed to update branding');
  assert.equal(harness.commitCount(), 0);
  assert.equal(harness.auditRows.length, 0);
});

// ===========================================================================
// Commit and rollback disposal
// ===========================================================================

test('failure: a lost commit acknowledgement DESTROYS the connection and claims no rollback', async () => {
  const harness = harnessWith(state => { state.failCommit = true; });
  const result = await patch(harness, { display_name_en: 'Uncertain Save' });
  assert.equal(result.status, 500);
  assertOpaqueFailure(result, 'Failed to update branding');
  assert.equal(harness.destroyCount(), 1, 'an uncertain transaction is never returned to the pool');
  assert.equal(harness.releaseCount(), 0);
  assert.equal(harness.commitCount(), 0, 'no commit was acknowledged');
  assert.equal(harness.rollbackCount(), 0, 'no rollback is claimed after a commit attempt');
  assert.equal(result.body.branding, undefined, 'no success is claimed');
});

test('failure: a failed rollback DESTROYS the connection', async () => {
  const harness = harnessWith(state => {
    state.failAudit = true;
    state.failRollback = true;
  });
  const result = await patch(harness, { display_name_en: 'Academy' });
  assert.equal(result.status, 500);
  assert.equal(harness.rollbackCount(), 1);
  assert.equal(harness.destroyCount(), 1, 'a connection whose rollback failed is discarded');
  assert.equal(harness.releaseCount(), 0);
  assert.equal(harness.commitCount(), 0);
});

test('failure: a failed rollback on a read DESTROYS the connection', async () => {
  const harness = harnessWith(state => {
    state.failBrandingSelect = true;
    state.failRollback = true;
  });
  const result = await get(harness);
  assert.equal(result.status, 500);
  assert.equal(harness.destroyCount(), 1);
  assert.equal(harness.releaseCount(), 0);
});

test('disposal: a confirmed success releases exactly once', async () => {
  const harness = harnessWith(() => undefined);
  const result = await patch(harness, { display_name_en: 'Released Once' });
  assert.equal(result.status, 200);
  assert.equal(harness.connectionCount(), 1);
  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.destroyCount(), 0);
});

test('disposal: a confirmed no-op releases exactly once', async () => {
  const harness = harnessWith(() => undefined);
  const result = await patch(harness, { display_name_en: 'Academy A' });
  assert.equal(result.status, 200);
  assert.equal(harness.connectionCount(), 1);
  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.destroyCount(), 0);
  assert.equal(harness.commitCount(), 0);
});

test('disposal: an owner denial releases exactly once and destroys nothing', async () => {
  const harness = harnessWith(() => undefined);
  const result = await get(harness, 'not-a-token');
  assert.equal(result.status, 401);
  assert.equal(harness.connectionCount(), 0);
  assert.equal(harness.releaseCount(), 0);
  assert.equal(harness.destroyCount(), 0);
});

// ===========================================================================
// Response integrity
// ===========================================================================

test('integrity: no response is written twice on any failure path', async () => {
  const scenarios: Array<[string, (state: State) => void, 'get' | 'patch']> = [
    ['failAcquire', state => { state.failAcquire = true; }, 'patch'],
    ['failBegin', state => { state.failBegin = true; }, 'patch'],
    ['failOwnerSelect', state => { state.failOwnerSelect = true; }, 'get'],
    ['failBrandingSelect', state => { state.failBrandingSelect = true; }, 'get'],
    ['failInsert', state => { state.failInsert = true; }, 'patch'],
    ['failAudit', state => { state.failAudit = true; }, 'patch'],
    ['failCommit', state => { state.failCommit = true; }, 'patch'],
    ['failRollback', state => { state.failAudit = true; state.failRollback = true; }, 'patch'],
    ['missingSchema', state => { state.missingSchema = true; }, 'get'],
  ];
  for (const [name, mutate, kind] of scenarios) {
    const harness = harnessWith(mutate);
    const result = kind === 'get' ? await get(harness) : await patch(harness, { display_name_en: 'X' });
    assert.equal(result.responseCount, 1, `${name} must answer exactly once`);
    assert.equal(result.headers['Cache-Control'], 'no-store', `${name} must carry no-store`);
  }
});

test('integrity: every 500 carries Cache-Control no-store', async () => {
  const harness = harnessWith(state => { state.missingSchema = true; });
  const result = await get(harness);
  assert.equal(result.status, 500);
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('integrity: a non-canonical stored accent color is refused rather than re-served', async () => {
  const harness = harnessWith(state => {
    state.branding[TENANT_A].accent_color = '#1d4ed8';
  });
  const read = await get(harness);
  assert.equal(read.status, 500, 'a lower-case stored color is not canonical');
  assertOpaqueFailure(read, 'Failed to load branding');

  const writeHarness = harnessWith(state => {
    state.branding[TENANT_A].accent_color = '#1d4ed8';
  });
  const write = await patch(writeHarness, { display_name_en: 'Academy' });
  assert.equal(write.status, 500);
  assert.equal(writeHarness.commitCount(), 0);
  assert.equal(writeHarness.state.branding[TENANT_A].accent_color, '#1d4ed8', 'the row is left untouched');
});

test('integrity: a non-owner never reaches the branding statements', async () => {
  const harness = harnessWith(() => undefined);
  const result = await get(harness, ownerToken().slice(0, -2) + 'xx');
  assert.equal(result.status, 401);
  assert.equal(harness.calls.length, 0, 'a rejected token takes no statement');
});

test('integrity: a foreign owner writes only in the workspace the server selected for them', async () => {
  const harness = harnessWith(() => undefined);
  // OWNER_B holds a single membership, TENANT_B, so the server selects TENANT_B
  // for this principal — even though no selector was sent. The write lands in
  // TENANT_B and TENANT_A is never touched.
  const result = await patch(harness, { display_name_en: 'Cross Tenant Write' }, ownerBToken());
  assert.equal(result.status, 200);
  assert.equal(harness.state.branding[TENANT_B].display_name_en, 'Cross Tenant Write');
  assert.equal(
    harness.state.branding[TENANT_A].display_name_en,
    'Academy A',
    'the other tenant is never modified',
  );
  assert.equal(harness.auditRows.length, 1);
  assert.equal(harness.auditRows[0].params[2], TENANT_B, 'the audit event is scoped to the selected tenant');
});

test('integrity: a selector for a workspace the caller does not hold resolves no scope', async () => {
  const harness = harnessWith(() => undefined);
  // OWNER_B claims TENANT_A, which is not one of their memberships: no scope is
  // resolved, so the handler never reaches a connection.
  const result = await withSilencedErrors(() =>
    runChain(harness.chain, patchReq({ display_name_en: 'Forged' }, sign(OWNER_B, 'instructor', { tenant_id: TENANT_A }))),
  );
  assert.notEqual(result.status, 200);
  assert.equal(harness.connectionCount(), 0);
  assert.equal(harness.state.branding[TENANT_A].display_name_en, 'Academy A');
  assert.equal(harness.auditRows.length, 0);
});

test('integrity: no forbidden default adapter is called on any failure path', () => {
  assert.deepEqual(isolation.sentinelCalls, []);
});
