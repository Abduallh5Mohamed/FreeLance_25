/**
 * M2-B07 — private academic-period catalog: cleanup, disposal and failure
 * boundaries (hermetic, behavioral).
 *
 * This suite drives the REAL production handlers through the REAL composition
 * and fails one boundary at a time, so the observable guarantees of the
 * contract are proven instead of asserted in prose:
 *
 *  - a failure BEFORE a connection exists releases and destroys nothing;
 *  - a failure after acquisition but before the transaction state is confirmed
 *    DESTROYS the connection (it is never pooled with a possibly-dirty session);
 *  - a confirmed rollback, a no-op and a success each RELEASE exactly once;
 *  - a failed rollback DESTROYS the connection and never releases it;
 *  - a lost commit acknowledgement DESTROYS the connection, claims no rollback
 *    and reports no success — persistence is UNKNOWN and stays unknown;
 *  - no failure path leaks a partial period write or a committed audit event
 *    (the fixture replays the transaction, so a leak is observable);
 *  - an unreadable stored instant, an impossible stored date and a missing
 *    schema are all a 500 — an empty catalog is NEVER fabricated to disguise a
 *    broken deployment;
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
  BILLING_ONLY,
  INSTRUCTOR_A,
  OWNER_A,
  PERIOD_AUTUMN,
  PERIOD_OTHER_TENANT,
  PERIOD_SUMMER,
  TENANT_A,
  TEST_SECRET,
  buildHarness,
  createIsolation,
  getReq,
  loadAppModules,
  makeState,
  ownerToken,
  patchReq,
  postReq,
  runChain,
  sign,
  withSilencedErrors,
  type Harness,
} from './helpers/m2-academic-periods-harness';

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

const harnessFor = () => buildHarness(makeState(), modules);
const harnessWith = (mutate: (state: ReturnType<typeof makeState>) => void): Harness => {
  const state = makeState();
  mutate(state);
  return buildHarness(state, modules);
};

const getList = (harness: Harness, token: string | null = ownerToken(), query: any = {}) =>
  runChain(harness.chain, getReq(token, query));
const create = (harness: Harness, body: any = { name: 'فصل جديد', starts_on: '2027-03-01', ends_on: '2027-03-31' }) =>
  runChain(harness.chain, postReq(body));
const update = (harness: Harness, id: string, body: any) =>
  runChain(harness.chain, patchReq(id, body));

/** Every path must leave the connection in exactly ONE disposal state. */
const assertSingleDisposal = (harness: Harness) => {
  const released = harness.releaseCount();
  const destroyed = harness.destroyCount();
  assert.ok(released + destroyed <= 1, `at most one disposal (released ${released}, destroyed ${destroyed})`);
  assert.equal(released * destroyed, 0, 'a connection is never both released and destroyed');
};

/** A 500 body must never leak SQL, a stack or an internal identifier. */
const assertOpaque500 = (result: { status: number; body: any }) => {
  assert.equal(result.status, 500);
  const serialized = JSON.stringify(result.body);
  for (const forbidden of ['SELECT', 'INSERT', 'UPDATE', 'academic_periods', 'audit_events', 'ER_', 'Error:', 'at ', 'internal detail', 'stack']) {
    assert.equal(serialized.includes(forbidden), false, `the 500 body must not contain ${JSON.stringify(forbidden)}`);
  }
};

// ===========================================================================
// Acquisition and transaction start
// ===========================================================================

test('disposal: a failed acquisition releases and destroys nothing', async () => {
  const harness = harnessWith(state => { state.failAcquire = true; });
  const result = await withSilencedErrors(() => getList(harness));
  assert.equal(result.status, 500);
  assert.equal(harness.connectionCount(), 0);
  assert.equal(harness.releaseCount(), 0, 'a connection that was never acquired is never released');
  assert.equal(harness.destroyCount(), 0);
  assert.equal(harness.calls.length, 0, 'no statement is issued');
});

test('disposal: a failed beginTransaction destroys the unconfirmed connection', async () => {
  const harness = harnessWith(state => { state.failBegin = true; });
  const result = await withSilencedErrors(() => getList(harness));
  assert.equal(result.status, 500);
  assert.equal(harness.connectionCount(), 1);
  assert.equal(harness.releaseCount(), 0, 'a possibly-dirty session is never pooled');
  assert.equal(harness.destroyCount(), 1);
  assertSingleDisposal(harness);
});

test('disposal: a failed begin on a write destroys and writes nothing', async () => {
  const harness = harnessWith(state => { state.failBegin = true; });
  const before = harness.state.periods.length;
  const result = await withSilencedErrors(() => create(harness));
  assert.equal(result.status, 500);
  assert.equal(harness.destroyCount(), 1);
  assert.equal(harness.releaseCount(), 0);
  assert.equal(harness.state.periods.length, before, 'no row is written');
  assert.equal(harness.auditRows.length, 0);
});

// ===========================================================================
// Statement failures after the transaction started
// ===========================================================================

test('disposal: an owner-verification failure rolls back and releases exactly once', async () => {
  const harness = harnessWith(state => { state.failOwnerSelect = true; });
  const result = await withSilencedErrors(() => getList(harness));
  assert.equal(result.status, 500);
  assert.equal(harness.rollbackCount(), 1);
  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.destroyCount(), 0);
  assertSingleDisposal(harness);
});

test('disposal: a list failure rolls back, releases once and serves no partial page', async () => {
  const harness = harnessWith(state => { state.failList = true; });
  const result = await withSilencedErrors(() => getList(harness));
  assert.equal(result.status, 500);
  assert.equal(result.body.periods, undefined, 'no partial page is served');
  assert.equal(harness.rollbackCount(), 1);
  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.destroyCount(), 0);
  assertSingleDisposal(harness);
});

test('disposal: a locked-read failure on update rolls back and releases once', async () => {
  const harness = harnessWith(state => { state.failLockSelect = true; });
  const result = await withSilencedErrors(() => update(harness, PERIOD_AUTUMN, { name: 'x' }));
  assert.equal(result.status, 500);
  assert.equal(harness.rollbackCount(), 1);
  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.destroyCount(), 0);
  assertSingleDisposal(harness);
});

test('disposal: an insert failure rolls back, releases once and leaks no row or audit', async () => {
  const harness = harnessWith(state => { state.failInsert = true; });
  const before = harness.state.periods.length;
  const result = await withSilencedErrors(() => create(harness));
  assert.equal(result.status, 500);
  assert.equal(harness.state.periods.length, before, 'no partial insert survives');
  assert.equal(harness.auditRows.length, 0, 'no committed audit event');
  assert.equal(harness.commitCount(), 0);
  assert.equal(harness.rollbackCount(), 1);
  assert.equal(harness.releaseCount(), 1);
  assertSingleDisposal(harness);
});

test('disposal: an update failure rolls back and restores the stored row', async () => {
  const harness = harnessWith(state => { state.failUpdate = true; });
  const result = await withSilencedErrors(() => update(harness, PERIOD_AUTUMN, { name: 'اسم جديد' }));
  assert.equal(result.status, 500);
  const stored = harness.state.periods.find(p => p.id === PERIOD_AUTUMN)!;
  assert.equal(stored.name, 'الفصل الخريفي', 'the original row is restored by the rollback');
  assert.equal(harness.auditRows.length, 0);
  assert.equal(harness.commitCount(), 0);
  assert.equal(harness.rollbackCount(), 1);
  assertSingleDisposal(harness);
});

test('disposal: an audit failure on create rolls back the row it already inserted', async () => {
  const harness = harnessWith(state => { state.failAudit = true; });
  const before = harness.state.periods.length;
  const result = await withSilencedErrors(() => create(harness));
  assert.equal(result.status, 500);
  assert.equal(harness.state.periods.length, before, 'the insert is rolled back with its audit');
  assert.equal(harness.auditRows.length, 0);
  assert.equal(harness.commitCount(), 0);
  assert.equal(harness.rollbackCount(), 1);
  assert.equal(harness.releaseCount(), 1);
});

test('disposal: an audit failure on update restores the row', async () => {
  const harness = harnessWith(state => { state.failAudit = true; });
  const result = await withSilencedErrors(() => update(harness, PERIOD_AUTUMN, { name: 'اسم جديد' }));
  assert.equal(result.status, 500);
  assert.equal(harness.state.periods.find(p => p.id === PERIOD_AUTUMN)!.name, 'الفصل الخريفي');
  assert.equal(harness.commitCount(), 0);
  assertSingleDisposal(harness);
});

// ===========================================================================
// Read-back consistency
// ===========================================================================

test('read-back: a missing row after an insert is a 500 and the insert is rolled back', async () => {
  const harness = harnessWith(state => { state.failReadBack = true; });
  const before = harness.state.periods.length;
  const result = await withSilencedErrors(() => create(harness));
  assert.equal(result.status, 500);
  assert.equal(result.body.period, undefined, 'no success is reported');
  assert.equal(harness.state.periods.length, before);
  assert.equal(harness.commitCount(), 0);
  assert.equal(harness.rollbackCount(), 1);
  assert.equal(harness.releaseCount(), 1);
});

test('read-back: a missing row after an update is a 500 and the update is rolled back', async () => {
  const harness = harnessWith(state => { state.failReadBack = true; });
  const result = await withSilencedErrors(() => update(harness, PERIOD_AUTUMN, { name: 'اسم جديد' }));
  assert.equal(result.status, 500);
  assert.equal(result.body.period, undefined);
  assert.equal(harness.state.periods.find(p => p.id === PERIOD_AUTUMN)!.name, 'الفصل الخريفي');
  assert.equal(harness.commitCount(), 0);
});

test('read-back: an unreadable instant on the read-back fails the write before the commit', async () => {
  for (const variant of ['null', 'zero', 'nan', 'text', 'missing'] as const) {
    const harness = harnessWith(state => { state.readBackMalformedEpoch = variant; });
    const result = await withSilencedErrors(() => create(harness));
    assert.equal(result.status, 500, `read-back epoch=${variant} must fail the write`);
    assert.equal(harness.commitCount(), 0, 'nothing is committed with a guessed instant');
    assert.equal(harness.rollbackCount(), 1);
    assertSingleDisposal(harness);
  }
});

test('read-back: an impossible date on the read-back fails the write before the commit', async () => {
  for (const variant of ['impossible', 'shifted-object', 'missing', 'reversed'] as const) {
    const harness = harnessWith(state => { state.readBackMalformedDate = variant; });
    const result = await withSilencedErrors(() => create(harness));
    assert.equal(result.status, 500, `read-back date=${variant} must fail the write`);
    assert.equal(harness.commitCount(), 0);
  }
});

test('read-back: a stored instant that cannot be read refuses the write, not just the read', async () => {
  const harness = harnessWith(state => { state.malformedEpoch = 'text'; });
  const result = await withSilencedErrors(() => update(harness, PERIOD_AUTUMN, { name: 'اسم جديد' }));
  assert.equal(result.status, 500);
  assert.equal(harness.commitCount(), 0);
  assert.ok(!harness.events.includes('update'), 'no UPDATE is issued when the current row is unreadable');
});

// ===========================================================================
// Commit acknowledgement lost
// ===========================================================================

test('commit: a lost acknowledgement destroys the connection and claims no rollback', async () => {
  const harness = harnessWith(state => { state.failCommit = true; });
  const result = await withSilencedErrors(() => create(harness));
  assert.equal(result.status, 500, 'a lost ack is never a success');
  assert.equal(result.body.period, undefined);
  assert.equal(harness.destroyCount(), 1, 'the connection is discarded');
  assert.equal(harness.releaseCount(), 0, 'it is never pooled');
  // Whether the write persisted is UNKNOWN. The fixture cannot answer that, so
  // this test deliberately asserts NOTHING about the stored row: claiming
  // either outcome would be a fabricated result.
  assert.equal(harness.rollbackCount(), 0, 'no rollback is claimed for a lost ack');
  assertSingleDisposal(harness);
});

test('commit: a lost acknowledgement on an update also destroys and claims nothing', async () => {
  const harness = harnessWith(state => { state.failCommit = true; });
  const result = await withSilencedErrors(() => update(harness, PERIOD_AUTUMN, { name: 'اسم جديد' }));
  assert.equal(result.status, 500);
  assert.equal(result.body.period, undefined);
  assert.equal(harness.destroyCount(), 1);
  assert.equal(harness.releaseCount(), 0);
  assert.equal(harness.rollbackCount(), 0);
});

test('commit: a lost acknowledgement is never retried automatically', async () => {
  const harness = harnessWith(state => { state.failCommit = true; });
  await withSilencedErrors(() => create(harness));
  // One connection, one commit attempt: no second attempt, no second request.
  assert.equal(harness.connectionCount(), 1, 'the write is not retried');
  assert.equal(harness.commitCount(), 0, 'the fixture never acknowledged the commit');
});

// ===========================================================================
// Rollback failure
// ===========================================================================

test('disposal: a failed rollback destroys the connection and never releases it', async () => {
  const harness = harnessWith(state => { state.failRollback = true; });
  const result = await withSilencedErrors(() => getList(harness, sign(INSTRUCTOR_A, 'instructor')));
  // The owner denial rolls back; the rollback itself fails.
  assert.equal(result.status, 403, 'the real denial answer is still returned');
  assert.equal(harness.rollbackCount(), 1);
  assert.equal(harness.destroyCount(), 1, 'a failed rollback discards the connection');
  assert.equal(harness.releaseCount(), 0);
  assertSingleDisposal(harness);
});

test('disposal: a failed rollback after a statement failure destroys the connection', async () => {
  const harness = harnessWith(state => { state.failList = true; state.failRollback = true; });
  const result = await withSilencedErrors(() => getList(harness));
  assert.equal(result.status, 500);
  assert.equal(harness.destroyCount(), 1);
  assert.equal(harness.releaseCount(), 0);
  assertSingleDisposal(harness);
});

// ===========================================================================
// Success and no-op disposal
// ===========================================================================

test('disposal: a success commits and releases exactly once', async () => {
  const harness = harnessFor();
  const result = await create(harness);
  assert.equal(result.status, 201);
  assert.equal(harness.commitCount(), 1);
  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.destroyCount(), 0);
  assert.equal(harness.rollbackCount(), 0);
  assertSingleDisposal(harness);
});

test('disposal: a no-op rolls back and releases exactly once, and commits nothing', async () => {
  const harness = harnessFor();
  const result = await update(harness, PERIOD_SUMMER, { is_archived: true });
  assert.equal(result.status, 200);
  assert.equal(harness.commitCount(), 0);
  assert.equal(harness.rollbackCount(), 1);
  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.destroyCount(), 0);
  assertSingleDisposal(harness);
});

test('disposal: a not-found rolls back and releases exactly once', async () => {
  const harness = harnessFor();
  const result = await withSilencedErrors(() => update(harness, PERIOD_OTHER_TENANT, { name: 'x' }));
  assert.equal(result.status, 404);
  assert.equal(harness.rollbackCount(), 1);
  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.destroyCount(), 0);
  assertSingleDisposal(harness);
});

// ===========================================================================
// Response hygiene
// ===========================================================================

test('response: no path writes a response twice', async () => {
  const paths: Array<[string, () => Promise<{ responseCount: number }>]> = [
    ['list success', () => getList(harnessFor())],
    ['list denied', () => getList(harnessFor(), sign(INSTRUCTOR_A, 'instructor'))],
    ['list billing', () => getList(harnessFor(), sign(BILLING_ONLY, 'instructor'))],
    ['list invalid query', () => getList(harnessFor(), ownerToken(), { limit: '0' })],
    ['list statement failure', () => getList(harnessWith(state => { state.failList = true; }))],
    ['list commit-lost', () => getList(harnessWith(state => { state.failCommit = true; }))],
    ['create success', () => create(harnessFor())],
    ['create invalid', () => create(harnessFor(), {})],
    ['create insert failure', () => create(harnessWith(state => { state.failInsert = true; }))],
    ['update success', () => update(harnessFor(), PERIOD_AUTUMN, { name: 'اسم جديد' })],
    ['update not found', () => update(harnessFor(), PERIOD_OTHER_TENANT, { name: 'x' })],
    ['update no-op', () => update(harnessFor(), PERIOD_AUTUMN, { name: 'الفصل الخريفي' })],
    ['update rollback failure', () => update(harnessWith(state => { state.failRollback = true; state.failUpdate = true; }), PERIOD_AUTUMN, { name: 'x' })],
  ];
  for (const [label, run] of paths) {
    const result = await withSilencedErrors(run as () => Promise<{ responseCount: number }>);
    assert.equal(result.responseCount, 1, `${label} must answer exactly once`);
  }
});

test('response: a 500 body leaks no SQL, stack or internal detail', async () => {
  const failures: Array<() => Promise<{ status: number; body: any }>> = [
    () => getList(harnessWith(state => { state.failAcquire = true; })),
    () => getList(harnessWith(state => { state.failBegin = true; })),
    () => getList(harnessWith(state => { state.failOwnerSelect = true; })),
    () => getList(harnessWith(state => { state.failList = true; })),
    () => create(harnessWith(state => { state.failInsert = true; })),
    () => create(harnessWith(state => { state.failAudit = true; })),
    () => update(harnessWith(state => { state.failUpdate = true; }), PERIOD_AUTUMN, { name: 'x' }),
    () => create(harnessWith(state => { state.failCommit = true; })),
    () => getList(harnessWith(state => { state.missingSchema = true; })),
    () => create(harnessWith(state => { state.missingSchema = true; })),
    () => update(harnessWith(state => { state.missingSchema = true; }), PERIOD_AUTUMN, { name: 'x' }),
  ];
  for (const run of failures) {
    const result = await withSilencedErrors(run);
    assertOpaque500(result);
  }
});

test('response: every handler-owned outcome carries Cache-Control no-store', async () => {
  const outcomes: Array<[string, () => Promise<{ headers: Record<string, string>; status: number }>]> = [
    ['list 200', () => getList(harnessFor())],
    ['list 400', () => getList(harnessFor(), ownerToken(), { limit: 'abc' })],
    ['list 403', () => getList(harnessFor(), sign(INSTRUCTOR_A, 'instructor'))],
    ['list 500', () => getList(harnessWith(state => { state.failList = true; }))],
    ['create 201', () => create(harnessFor())],
    ['create 400', () => create(harnessFor(), { name: '' })],
    ['create 500', () => create(harnessWith(state => { state.failInsert = true; }))],
    ['update 200', () => update(harnessFor(), PERIOD_AUTUMN, { name: 'اسم جديد' })],
    ['update 400', () => update(harnessFor(), PERIOD_AUTUMN, {})],
    ['update 404', () => update(harnessFor(), PERIOD_OTHER_TENANT, { name: 'x' })],
    ['update 500', () => update(harnessWith(state => { state.failUpdate = true; }), PERIOD_AUTUMN, { name: 'x' })],
  ];
  for (const [label, run] of outcomes) {
    const result = await withSilencedErrors(run as () => Promise<{ headers: Record<string, string>; status: number }>);
    assert.equal(result.headers['Cache-Control'], 'no-store', `${label} must carry no-store`);
  }
});

// ===========================================================================
// Missing schema is never a fabricated success
// ===========================================================================

test('schema: a missing table never produces an empty catalog', async () => {
  const harness = harnessWith(state => { state.missingSchema = true; });
  const result = await withSilencedErrors(() => getList(harness));
  assert.equal(result.status, 500);
  assert.equal(result.body.periods, undefined);
  assert.equal(result.body.pagination, undefined, 'no pagination envelope is fabricated either');
});

test('schema: a missing table never produces a created period', async () => {
  const harness = harnessWith(state => { state.missingSchema = true; });
  const result = await withSilencedErrors(() => create(harness));
  assert.equal(result.status, 500);
  assert.equal(result.body.period, undefined);
  assert.equal(harness.commitCount(), 0);
  assert.equal(harness.auditRows.length, 0);
});

test('schema: a missing table never produces an updated period', async () => {
  const harness = harnessWith(state => { state.missingSchema = true; });
  const result = await withSilencedErrors(() => update(harness, PERIOD_AUTUMN, { name: 'x' }));
  assert.equal(result.status, 500);
  assert.equal(result.body.period, undefined);
  assert.equal(harness.commitCount(), 0);
});

// ===========================================================================
// Cross-tenant integrity
// ===========================================================================

test('integrity: a write never lands in another tenant', async () => {
  const harness = harnessFor();
  const before = harness.state.periods.filter(p => p.tenant_id === TENANT_A).length;
  // PERIOD_OTHER_TENANT belongs to TENANT_B; OWNER_A selects TENANT_A.
  const result = await withSilencedErrors(() => update(harness, PERIOD_OTHER_TENANT, { is_archived: true }));
  assert.equal(result.status, 404);
  assert.equal(harness.state.periods.filter(p => p.tenant_id === TENANT_A).length, before);
  const other = harness.state.periods.find(p => p.id === PERIOD_OTHER_TENANT)!;
  assert.equal(other.is_archived, 0, 'the other tenant row is untouched');
  assert.equal(harness.commitCount(), 0);
  assert.equal(harness.auditRows.length, 0);
});

test('integrity: a create always lands in the server-selected tenant', async () => {
  const harness = harnessFor();
  const result = await create(harness);
  assert.equal(result.status, 201);
  const inserted = harness.state.periods.find(p => p.id === result.body.period.id)!;
  assert.equal(inserted.tenant_id, TENANT_A);
  assert.equal(harness.auditRows[0].params[2], TENANT_A);
  assert.equal(harness.auditRows[0].params[1], OWNER_A);
});

// ===========================================================================
// No forbidden adapter
// ===========================================================================

test('isolation: no forbidden default adapter is ever called by a failure path', async () => {
  const harness = harnessWith(state => {
    state.failList = true;
    state.failInsert = true;
    state.failAudit = true;
    state.missingSchema = true;
  });
  await withSilencedErrors(() => getList(harness));
  await withSilencedErrors(() => create(harness));
  await withSilencedErrors(() => update(harness, PERIOD_AUTUMN, { name: 'x' }));
  assert.deepEqual(isolation.sentinelCalls, [], 'db/minio/renewal/dotenv are never called');
});
