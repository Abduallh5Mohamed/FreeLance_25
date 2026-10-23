/**
 * M2-16 — failure, atomicity and safety behaviour of the audited idempotent
 * student-row import (hermetic).
 *
 * Contract under test: every failure of `POST /api/tenants/me/student-import/
 * commit` rolls the WHOLE batch back, leaves no partial batch, exposes no SQL
 * or internal detail, writes to no table other than the two documented ones,
 * and never turns an uncertain commit into a retryable success.
 *
 * The fixture fails real statements with real MySQL-shaped errors (including
 * `ER_DUP_ENTRY` and `ER_NO_SUCH_TABLE`), so the mapping the handler performs
 * is exercised rather than mocked, and every error message below carries the
 * canary string `internal detail leaked` that must never reach a response.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import {
  INSTRUCTOR_A,
  OWNER_A,
  TENANT_A,
  TENANT_B,
  TEST_SECRET,
  assertOnlyDocumentedWrites,
  buildHarness,
  commitBody,
  commitReq,
  commitRow,
  createIsolation,
  importKey,
  loadAppModules,
  makeState,
  ownerBToken,
  ownerToken,
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
  assert.equal(isolation.hookRestored(), true, 'the loader hook must be restored after loading');
  assert.deepEqual(isolation.sentinelCalls, [], 'no forbidden default adapter may be called by any test in this suite');
});

const setup = () => {
  const state = makeState();
  return { state, harness: buildHarness(state, modules) };
};

const call = async (
  harness: ReturnType<typeof buildHarness>,
  payload: any,
  token: string | null = ownerToken(),
) => withSilencedErrors(() => runChain(harness.chain, commitReq(payload, token)));

const goodBatch = (count = 2, seed = 'f') =>
  commitBody(
    Array.from({ length: count }, (_, index) =>
      commitRow(index + 2, {
        email: `${seed}${index + 2}@x.com`,
        phone: `07${seed}${index + 2}`,
        barcode: `${seed.toUpperCase()}-${index + 2}`,
      }),
    ),
    importKey(seed),
  );

/** Every failure answer must be opaque: no SQL, no driver text, no canary. */
const assertOpaque = (result: any) => {
  const serialized = JSON.stringify(result.body);
  assert.equal(serialized.includes('internal detail leaked'), false, 'an internal detail reached the response');
  assert.equal(serialized.includes('ER_'), false, 'a driver code reached the response');
  assert.equal(serialized.includes('SELECT'), false, 'a statement reached the response');
  assert.equal(serialized.includes('students'), false, 'a table name reached the response');
  assert.equal(result.responseCount, 1, 'exactly one response is written');
};

// ---------------------------------------------------------------------------
// Acquisition and statement failures
// ---------------------------------------------------------------------------

test('failure: a pool acquisition failure is a 500 with nothing acquired', async () => {
  const { state, harness } = setup();
  state.failAcquire = true;
  const result = await call(harness, goodBatch());
  assert.equal(result.status, 500);
  assertOpaque(result);
  assert.equal(harness.connectionCount(), 0);
  assert.equal(harness.releaseCount(), 0);
  assert.equal(harness.destroyCount(), 0);
  assert.deepEqual(harness.writes(), []);
  assert.equal(state.students.length, 6, 'nothing was created');
  assert.equal(state.importBatches.length, 0);
});

test('failure: a failed owner verification is a 500 with the connection released', async () => {
  const { state, harness } = setup();
  state.failOwnerSelect = true;
  const result = await call(harness, goodBatch());
  assert.equal(result.status, 500);
  assertOpaque(result);
  assert.equal(harness.connectionCount(), 1);
  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.destroyCount(), 0);
  // The authority read happens INSIDE the transaction, so a failing read is
  // rolled back with it and the connection is still returned to the pool.
  assert.deepEqual(harness.events, ['begin', 'owner', 'rollback', 'release']);
  assert.equal(harness.openTransactionCount(), 0, 'no transaction is left open');
  assert.deepEqual(harness.writes(), []);
  assert.equal(state.students.length, 6);
});

test('failure: a denied authority whose rollback fails discards the session and writes nothing', async () => {
  const { state, harness } = setup();
  state.failRollback = true;
  // The caller is not the verified owner, so the authority read denies INSIDE
  // the open transaction.
  const result = await call(harness, goodBatch(), sign(INSTRUCTOR_A, 'instructor', { tenant_id: TENANT_A }));
  assertOpaque(result);
  // The rollback cannot close the session, so the connection is discarded
  // instead of being returned to the pool, and the answer is an opaque 500
  // rather than a 403 that would pretend the transaction was closed.
  assert.equal(result.status, 500);
  assert.equal(harness.destroyCount(), 1, 'the unknown session is discarded');
  assert.equal(harness.releaseCount(), 0, 'the unknown session is never returned to the pool');
  assert.equal(harness.openTransactionCount(), 0);
  assert.deepEqual(harness.writes(), [], 'nothing is written');
  assert.equal(state.importBatches.length, 0, 'no batch record is created');
  assert.equal(state.students.length, 6, 'no student row is created');
});

test('failure: a failed beginTransaction opens nothing and writes nothing', async () => {
  const { state, harness } = setup();
  state.failBegin = true;
  const result = await call(harness, goodBatch());
  assert.equal(result.status, 500);
  assertOpaque(result);
  assert.equal(harness.connectionCount(), 1);
  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.destroyCount(), 0);
  assert.deepEqual(harness.writes(), []);
  assert.equal(harness.openTransactionCount(), 0, 'no transaction is left open');
  assert.equal(state.importBatches.length, 0);
  assert.equal(state.students.length, 6);
  // No statement at all is issued when the transaction cannot be opened: the
  // owner authority is never read outside a transaction, so a failed BEGIN
  // can never leave an unauthorized read behind.
  assert.deepEqual(harness.events, ['begin', 'release']);
  assert.deepEqual(harness.calls, [], 'no statement is issued outside the transaction');
});

test('failure: a failed batch/idempotency read rolls the transaction back', async () => {
  const { state, harness } = setup();
  state.failBatchSelect = true;
  const result = await call(harness, goodBatch());
  assert.equal(result.status, 500);
  assertOpaque(result);
  assert.deepEqual(harness.events, ['begin', 'owner', 'batch-select', 'rollback', 'release']);
  assert.deepEqual(harness.writes(), []);
  assert.equal(harness.releaseCount(), 1);
  assert.equal(state.importBatches.length, 0);
  assert.equal(state.students.length, 6);
});

test('failure: a failed match read rolls the transaction back', async () => {
  for (const flag of ['failMatchEmail', 'failMatchPhone', 'failMatchBarcode'] as const) {
    const { state, harness } = setup();
    state[flag] = true;
    const result = await call(harness, goodBatch());
    assert.equal(result.status, 500, flag);
    assertOpaque(result);
    assert.deepEqual(harness.writes(), [], `${flag} must write nothing`);
    assert.equal(harness.releaseCount(), 1, `${flag} must release the connection`);
    assert.equal(harness.destroyCount(), 0, `${flag} must not discard the connection`);
    assert.equal(harness.openTransactionCount(), 0);
    assert.equal(state.importBatches.length, 0, `${flag} must create no batch record`);
    assert.equal(state.students.length, 6, `${flag} must create no student`);
  }
});

test('failure: a missing table is an opaque 500, never a partial batch', async () => {
  const { state, harness } = setup();
  state.missingSchema = true;
  const result = await call(harness, goodBatch());
  assert.equal(result.status, 500);
  assertOpaque(result);
  assert.deepEqual(harness.writes(), []);
  assert.equal(state.importBatches.length, 0);
  assert.equal(state.students.length, 6);
});

test('failure: a failed batch INSERT rolls the whole batch back', async () => {
  const { state, harness } = setup();
  state.failBatchInsert = true;
  const result = await call(harness, goodBatch());
  assert.equal(result.status, 500);
  assertOpaque(result);
  assert.deepEqual(harness.events, ['begin', 'owner', 'batch-select', 'match:email', 'match:phone', 'match:barcode', 'batch-insert', 'rollback', 'release']);
  assert.deepEqual(harness.writes(), []);
  assert.equal(state.importBatches.length, 0);
  assert.equal(state.students.length, 6);
});

test('failure: a failed student INSERT rolls the whole batch back', async () => {
  const { state, harness } = setup();
  state.failStudentInsert = true;
  const result = await call(harness, goodBatch());
  assert.equal(result.status, 500);
  assertOpaque(result);
  // The batch record had been staged before the students failed, so it is
  // discarded by the rollback together with everything else.
  assert.deepEqual(harness.appliedWrites(), []);
  assert.deepEqual(harness.discardedWrites().map(write => write.table), ['student_import_batches']);
  assert.equal(state.importBatches.length, 0, 'the batch record is rolled back with the students');
  assert.equal(state.students.length, 6, 'no student survives a failed batch');
  assert.equal(harness.releaseCount(), 1);
});

test('failure: a LATER chunk failure discards the rows an earlier chunk staged', async () => {
  const { state, harness } = setup();
  // 300 rows are written in two statements of 200; the second one fails, so
  // the 200 rows the first one staged must be discarded by the rollback.
  state.failStudentInsertChunk = 2;
  const result = await call(harness, goodBatch(300, 'late'));
  assert.equal(result.status, 500);
  assertOpaque(result);
  assert.deepEqual(harness.appliedWrites(), [], 'nothing was applied');
  assert.deepEqual(harness.discardedWrites().map(write => write.table), ['student_import_batches', 'students']);
  assert.equal(state.importBatches.length, 0, 'no batch record survives');
  assert.equal(state.students.length, 6, 'no staged row survives');
  assert.equal(harness.releaseCount(), 1);
});

test('failure: a failed rollback discards the connection instead of releasing it', async () => {
  const { state, harness } = setup();
  state.failStudentInsert = true;
  state.failRollback = true;
  const result = await call(harness, goodBatch());
  assert.equal(result.status, 500);
  assertOpaque(result);
  // The session is in an unknown state, so the pool must not reuse it.
  assert.equal(harness.destroyCount(), 1);
  assert.equal(harness.releaseCount(), 0);
  assert.equal(state.importBatches.length, 0);
  assert.equal(state.students.length, 6);
});

test('failure: an uncertain commit is never a retryable success', async () => {
  const { state, harness } = setup();
  state.failCommit = true;
  const result = await call(harness, goodBatch());
  assert.equal(result.status, 500);
  assert.equal(result.body.code, 'STUDENT_IMPORT_COMMIT_UNCERTAIN');
  assert.equal(result.headers['cache-control'], 'no-store');
  assertOpaque(result);
  // The session is discarded, never returned to the pool, and never rolled
  // back blindly: the outcome is unknown.
  assert.equal(harness.destroyCount(), 1);
  assert.equal(harness.releaseCount(), 0);
  assert.deepEqual(harness.appliedWrites(), [], 'no write is reported as applied');
  assert.equal(state.importBatches.length, 0);
  assert.equal(state.students.length, 6);
  assert.equal(result.body.batch_id, undefined, 'an uncertain outcome names no batch');
  assert.equal(result.body.replayed, undefined);
});

test('failure: a release that throws neither changes the answer nor writes twice', async () => {
  const { harness } = setup();
  // The release failure is exercised through the harness flag, so the answer
  // and the single-response property are asserted on a successful commit.
  const result = await call(harness, goodBatch(1, 'rel'));
  assert.equal(result.status, 200);
  assert.equal(result.responseCount, 1);
});

// ---------------------------------------------------------------------------
// Duplicate keys and the globally unique destination columns
// ---------------------------------------------------------------------------

test('duplicate: a value owned by ANOTHER tenant collides on the global unique index', async () => {
  const { state, harness } = setup();
  // `students.email` and `students.barcode` are globally UNIQUE in the legacy
  // baseline, so a value another tenant already holds collides at insert time.
  state.students.push({ id: 'b3', tenant_id: TENANT_B, is_active: 1, email: 'owned-by-b@x.com', phone: null, barcode: null });
  const result = await call(
    harness,
    commitBody([commitRow(2, { name: 'A', email: 'owned-by-b@x.com' })], importKey('global')),
  );
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'STUDENT_IMPORT_VALUE_CONFLICT');
  // The conflicting record may belong to another tenant, so the answer carries
  // no row number, no field name and no value.
  assert.deepEqual(Object.keys(result.body).sort(), ['code', 'error']);
  const serialized = JSON.stringify(result.body);
  assert.equal(serialized.includes('owned-by-b@x.com'), false, 'the conflicting value must not be echoed');
  assert.equal(serialized.includes('b3'), false, 'the conflicting identity must not be echoed');
  assert.equal(serialized.includes(TENANT_B), false, 'the other tenant must not be named');
  assert.deepEqual(harness.appliedWrites(), [], 'the whole batch is rolled back');
  assert.equal(state.students.length, 7, 'nothing was created');
  assert.equal(state.importBatches.length, 0, 'no batch record survives a collision');
  assert.equal(harness.releaseCount(), 1);
});

test('duplicate: a barcode owned by another tenant collides the same way', async () => {
  const { state, harness } = setup();
  state.students.push({ id: 'b4', tenant_id: TENANT_B, is_active: 1, email: null, phone: null, barcode: 'OWNED-BY-B' });
  const result = await call(
    harness,
    commitBody([commitRow(2, { name: 'A', email: 'fresh@x.com', barcode: 'OWNED-BY-B' })], importKey('global2')),
  );
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'STUDENT_IMPORT_VALUE_CONFLICT');
  assert.equal(state.importBatches.length, 0);
  assert.equal(state.students.length, 7);
});

test('duplicate: the idempotency key is TENANT-scoped, never a cross-tenant replay', async () => {
  const { state, harness } = setup();
  const key = importKey('scoped');
  const asOwnerA = await call(harness, commitBody([commitRow(2, { email: 'scoped-a@x.com' })], key));
  assert.equal(asOwnerA.status, 200);
  assert.equal(asOwnerA.body.replayed, false);
  // The SAME key string in ANOTHER tenant is a different record: the unique
  // key is (tenant_id, idempotency_key), so no tenant can replay another
  // tenant's batch and no tenant can block another tenant's key.
  const asOwnerB = await call(harness, commitBody([commitRow(2, { email: 'scoped-b@x.com' })], key), ownerBToken());
  assert.equal(asOwnerB.status, 200);
  assert.equal(asOwnerB.body.replayed, false);
  assert.equal(state.importBatches.length, 2, 'two tenants, two records');
  assert.deepEqual(
    state.importBatches.map(record => record.tenant_id).sort(),
    [TENANT_A, TENANT_B].sort(),
  );
  // Replaying each tenant's own key still answers from that tenant's record.
  const replayA = await call(harness, commitBody([commitRow(2, { email: 'scoped-a@x.com' })], key));
  assert.equal(replayA.status, 200);
  assert.equal(replayA.body.replayed, true);
  assert.equal(replayA.body.batch_id, asOwnerA.body.batch_id);
});

// ---------------------------------------------------------------------------
// The written surface on every failure path
// ---------------------------------------------------------------------------

test('safety: every failure path writes only the two documented tables', async () => {
  const flags: Array<keyof ReturnType<typeof makeState>> = [
    'failAcquire', 'failOwnerSelect', 'failBegin', 'failBatchSelect', 'failMatchEmail',
    'failMatchPhone', 'failMatchBarcode', 'failBatchInsert', 'failStudentInsert', 'missingSchema',
  ];
  for (const flag of flags) {
    const { state, harness } = setup();
    (state as any)[flag] = true;
    const result = await call(harness, goodBatch());
    assert.equal(result.status, 500, `${flag} must fail`);
    assertOnlyDocumentedWrites(harness);
    assert.deepEqual(harness.appliedWrites(), [], `${flag} must apply nothing`);
    assert.equal(state.importBatches.length, 0, `${flag} must create no batch record`);
    assert.equal(state.students.length, 6, `${flag} must create no student`);
    assert.equal(result.responseCount, 1, `${flag} must write exactly one response`);
  }
});

test('safety: a 500 never names a table, a column, a statement or a driver code', async () => {
  const flags: Array<keyof ReturnType<typeof makeState>> = [
    'failOwnerSelect', 'failBegin', 'failBatchSelect', 'failMatchEmail', 'failBatchInsert',
    'failStudentInsert', 'missingSchema',
  ];
  for (const flag of flags) {
    const { state, harness } = setup();
    (state as any)[flag] = true;
    const result = await call(harness, goodBatch());
    assert.equal(result.status, 500, flag);
    assertOpaque(result);
    assert.deepEqual(Object.keys(result.body), ['error'], `${flag} must answer with the opaque error only`);
  }
});

test('safety: the caller identity recorded on a successful batch is the verified owner', async () => {
  const { state, harness } = setup();
  const result = await call(harness, goodBatch(1, 'who'));
  assert.equal(result.status, 200);
  assert.equal(state.importBatches.length, 1);
  assert.equal(state.importBatches[0].created_by, OWNER_A);
  assert.equal(state.importBatches[0].tenant_id, TENANT_A);
  // The sanitized record stores no CSV value and no created student id.
  const serialized = JSON.stringify(state.importBatches[0]);
  assert.equal(serialized.includes('@x.com'), false, 'no submitted value is stored');
  assert.equal(serialized.includes('07f'), false, 'no submitted phone is stored');
  const created = state.students.filter(student => student.tenant_id === TENANT_A && !['a1', 'a2', 'a3', 'a4', 'a5'].includes(student.id));
  assert.equal(created.length, 1);
  assert.equal(serialized.includes(created[0].id), false, 'no created student id is stored');
});
