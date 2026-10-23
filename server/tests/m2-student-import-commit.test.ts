/**
 * M2-16 — the audited idempotent student-row import (hermetic, behavioral).
 *
 * Contract under test: `POST /api/tenants/me/student-import/commit` lets the
 * VERIFIED OWNER of the server-selected ACTIVE tenant turn ONE bounded,
 * freshly reconciled all-clear batch into tenant STUDENT ROWS plus ONE
 * sanitized batch/audit record, atomically and idempotently. The response
 * carries a batch id, a replay flag, a created count and the submitted row
 * numbers — never a created student id, a stored value or an identity.
 *
 * Composition under test is the real production order (src/index.ts): the real
 * optional-auth middleware, the real tenant-authority and student-workspace
 * boundaries, then the real `createTenantSelfRouter` with the real
 * student-import router mounted under `/student-import`. Only leaf data
 * repositories and the connection are injected fixtures. No express listener,
 * socket, fetch, DB, provider or app startup.
 *
 * The fixture is transactional: writes are staged per connection, applied or
 * discarded as a whole, and a locking read waits while another connection holds
 * an open transaction — so atomicity, rollback, commit uncertainty and
 * concurrent same-key attempts are observable instead of assumed.
 *
 * Live MySQL collation behaviour, real concurrency, real index usage and real
 * HTTP transport are explicitly NOT exercised or claimed. The collation is
 * MODELLED (`collationSuperset`) so the application-level exact comparison is
 * observable, and the migration is asserted as a FILE only: it is never applied
 * and no statement of it is ever executed.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  ADMIN,
  BILLING_ONLY,
  INSTRUCTOR_A,
  MULTI,
  NO_SCOPE,
  OWNER_A,
  OWNER_B,
  OWNER_SELECT,
  RESOLVE_PATH,
  ROLE_OWNER_MEMBER,
  STUDENT,
  TENANT_A,
  TENANT_B,
  TENANT_INACTIVE,
  TEST_SECRET,
  assertCommitEnvelope,
  assertEnvelope,
  assertOnlyDocumentedWrites,
  body,
  buildHarness,
  commitBody,
  commitReq,
  commitRow,
  createIsolation,
  importKey,
  loadAppModules,
  makeReq,
  makeState,
  ownerBToken,
  ownerToken,
  resolveReq,
  row,
  runChain,
  sign,
  squash,
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

const setup = (options?: Parameters<typeof buildHarness>[2]) => {
  const state = makeState();
  return { state, harness: buildHarness(state, modules, options) };
};

const call = async (
  harness: ReturnType<typeof buildHarness>,
  payload: any,
  token: string | null = ownerToken(),
  pathName?: string,
) => withSilencedErrors(() => runChain(harness.chain, commitReq(payload, token, pathName)));

/** A row that collides with nothing stored anywhere. */
const clearRow = (row_number: number, seed = 'n') =>
  commitRow(row_number, {
    email: `${seed}${row_number}@x.com`,
    phone: `07${seed}${row_number}`,
    barcode: `${seed.toUpperCase()}-${row_number}`,
  });

/** One well-formed batch that must succeed. */
const clearBatch = (count = 2, seed = 'n') =>
  commitBody(
    Array.from({ length: count }, (_, index) => clearRow(index + 2, seed)),
    importKey(seed),
  );

// ---------------------------------------------------------------------------
// Composition, isolation and reachability
// ---------------------------------------------------------------------------

test('isolation: the default DB, provider, renewal and dotenv modules are intercepted and never executed', () => {
  assert.ok(isolation.interceptedIds().length >= 4);
  const registered = isolation.interceptedIds();
  for (const id of isolation.interceptionLog) {
    assert.ok(registered.includes(id), `interception of an unregistered module: ${id}`);
  }
  for (const id of registered) {
    assert.equal(require.cache[id], undefined, `an intercepted module body ran: ${id}`);
  }
  assert.deepEqual(isolation.sentinelCalls, []);
});

test('composition: the documented commit path is reachable through the real tenant-self router', async () => {
  const { harness } = setup();
  const result = await call(harness, clearBatch());
  assert.equal(result.handlerReached, true);
  assert.notEqual(result.status, 0);
});

test('composition: the commit route answers only POST; a GET does not reach a handler', async () => {
  const { harness } = setup();
  const result = await withSilencedErrors(() =>
    runChain(harness.chain, makeReq({ token: ownerToken(), method: 'GET', pathName: '/student-import/commit' })),
  );
  assert.equal(result.handlerReached, false);
  assert.equal(harness.connectionCount(), 0);
});

test('composition: the reconciliation route beside it is still reachable and unchanged', async () => {
  const { harness } = setup();
  const result = await withSilencedErrors(() =>
    runChain(harness.chain, resolveReq(body([row(2, 'a@x.com')]))),
  );
  assert.equal(result.status, 200);
  assertEnvelope(result.body);
  assert.deepEqual(result.body.rows, [{ row_number: 2, matched_fields: ['email'] }]);
});

test('response: every outcome a handler produces carries Cache-Control: no-store', async () => {
  const outcomes: Array<[any, string | null]> = [
    [clearBatch(), ownerToken()],
    [{ rows: [] }, ownerToken()],
    [clearBatch(), sign(INSTRUCTOR_A, 'instructor')],
    [clearBatch(), sign(BILLING_ONLY, 'instructor')],
    [clearBatch(1, 'dup'), ownerToken()],
  ];
  for (const [payload, token] of outcomes) {
    const { harness } = setup();
    const result = await call(harness, payload, token);
    assert.equal(result.headers['cache-control'], 'no-store', `no-store missing on ${result.status}`);
  }
  // A 409 refusal and a 500 failure carry it too.
  const refused = setup();
  const conflict = await call(refused.harness, commitBody([commitRow(2, { email: 'a@x.com' })], importKey('ns')));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.headers['cache-control'], 'no-store');
});

// ---------------------------------------------------------------------------
// Schema and bounds — decided before any connection is taken
// ---------------------------------------------------------------------------

test('schema: an empty batch, an oversized batch and a non-array are refused', async () => {
  for (const rows of [[], Array.from({ length: 1001 }, (_, index) => clearRow(index + 2)), 'nope'] as any[]) {
    const { harness } = setup();
    const result = await call(harness, commitBody(rows));
    assert.equal(result.status, 400);
    assert.equal(harness.connectionCount(), 0, 'a malformed payload must not touch the database');
  }
});

test('schema: an unknown, missing or extra top-level key is refused', async () => {
  const cases: any[] = [
    { rows: [clearRow(2)] },
    { idempotency_key: importKey() },
    { idempotency_key: importKey(), rows: [clearRow(2)], extra: 1 },
    { idempotency_key: importKey(), rowz: [clearRow(2)] },
  ];
  for (const payload of cases) {
    const { harness } = setup();
    const result = await call(harness, payload);
    assert.equal(result.status, 400, JSON.stringify(payload));
    assert.equal(harness.connectionCount(), 0);
  }
});

test('schema: an idempotency key that is not an opaque bounded token is refused', async () => {
  const keys: any[] = [
    '', 'short', 'k'.repeat(15), 'k'.repeat(129), 'has space', 'has/slash', 'has.dot',
    42, null, undefined, {}, ['k'],
  ];
  for (const idempotency_key of keys) {
    const { harness } = setup();
    const result = await call(harness, { idempotency_key, rows: [clearRow(2)] });
    assert.equal(result.status, 400, String(idempotency_key));
    assert.equal(harness.connectionCount(), 0);
  }
});

test('schema: a row with a missing or extra key is refused', async () => {
  const cases: any[] = [
    { row_number: 2, name: 'A', email: 'a@x.com', phone: '', guardian_phone: '', grade: '' },
    { ...clearRow(2), selector: 'x' },
    { ...clearRow(2), status: 'active' },
    { ...clearRow(2), id: 'student-1' },
  ];
  for (const badRow of cases) {
    const { harness } = setup();
    const result = await call(harness, commitBody([badRow]));
    assert.equal(result.status, 400, JSON.stringify(badRow));
    assert.equal(harness.connectionCount(), 0);
  }
});

test('schema: a non-integer, out-of-bound or repeated row number is refused', async () => {
  const cases: any[] = [
    [commitRow(1)],
    [commitRow(1002)],
    [commitRow(2.5)],
    [commitRow('2' as any)],
    [commitRow(2), commitRow(2)],
    [commitRow(2), commitRow(3), commitRow(2)],
  ];
  for (const rows of cases) {
    const { harness } = setup();
    const result = await call(harness, commitBody(rows));
    assert.equal(result.status, 400, JSON.stringify(rows));
    assert.equal(harness.connectionCount(), 0);
  }
});

test('schema: an untrimmed value is refused instead of being normalized', async () => {
  const cases: any[] = [
    commitRow(2, { name: ' A' }),
    commitRow(2, { name: 'A ' }),
    commitRow(2, { email: ' a@x.com' }),
    commitRow(2, { phone: '0100 ' }),
    commitRow(2, { barcode: ' B1' }),
    commitRow(2, { grade: ' G1 ' }),
    commitRow(2, { guardian_phone: ' 0100' }),
  ];
  for (const badRow of cases) {
    const { harness } = setup();
    const result = await call(harness, commitBody([badRow]));
    assert.equal(result.status, 400, JSON.stringify(badRow));
  }
});

test('schema: a value beyond its destination column width is refused', async () => {
  const cases: any[] = [
    commitRow(2, { name: 'n'.repeat(256) }),
    commitRow(2, { email: `${'e'.repeat(250)}@x.com` }),
    commitRow(2, { phone: '0'.repeat(51) }),
    commitRow(2, { guardian_phone: '0'.repeat(51) }),
    commitRow(2, { grade: 'g'.repeat(101) }),
    commitRow(2, { barcode: 'b'.repeat(51) }),
  ];
  for (const badRow of cases) {
    const { harness } = setup();
    const result = await call(harness, commitBody([badRow]));
    assert.equal(result.status, 400, JSON.stringify(badRow).slice(0, 60));
    assert.equal(harness.connectionCount(), 0);
  }
});

test('schema: an empty required name is refused', async () => {
  const { harness } = setup();
  const result = await call(harness, commitBody([commitRow(2, { name: '' })]));
  assert.equal(result.status, 400);
  assert.equal(harness.connectionCount(), 0);
});

test('schema: a repeated NONBLANK email/phone/barcode inside the batch is refused', async () => {
  const first = clearRow(2, 'dup');
  const cases: any[] = [
    [first, commitRow(3, { email: first.email })],
    [first, commitRow(3, { phone: first.phone })],
    [first, commitRow(3, { barcode: first.barcode })],
    [commitRow(2, { email: 'same@x.com' }), commitRow(3, { email: 'same@x.com' })],
    [commitRow(2, { phone: '0100' }), commitRow(3, { name: 'Other', phone: '0100' })],
  ];
  for (const rows of cases) {
    const { harness } = setup();
    const result = await call(harness, commitBody(rows));
    assert.equal(result.status, 400, JSON.stringify(rows).slice(0, 90));
    assert.equal(harness.connectionCount(), 0, 'a within-file duplicate is a payload defect, not a stored match');
  }
});

test('schema: a BLANK email/phone/barcode repeated across rows is legal', async () => {
  const { state, harness } = setup();
  const result = await call(
    harness,
    commitBody([commitRow(2, { name: 'A' }), commitRow(3, { name: 'B' })]),
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.created, 2);
  const created = state.students.filter(student => student.name === 'A' || student.name === 'B');
  assert.equal(created.length, 2);
  for (const student of created) {
    assert.equal(student.email, null);
    assert.equal(student.barcode, null);
  }
});

test('schema: 1000 rows is the accepted maximum and 1000 is committed', async () => {
  const { state, harness } = setup();
  const rows = Array.from({ length: 1000 }, (_, index) => clearRow(index + 2));
  const result = await call(harness, commitBody(rows, importKey('max')));
  assert.equal(result.status, 200);
  assert.equal(result.body.created, 1000);
  assert.equal(result.body.row_numbers.length, 1000);
  assert.equal(result.body.row_numbers[0], 2);
  assert.equal(result.body.row_numbers[999], 1001);
  assert.equal(state.importBatches.length, 1);
});

// ---------------------------------------------------------------------------
// Authority and tenant isolation
// ---------------------------------------------------------------------------

test('authority: the verified owner of the selected active tenant is accepted', async () => {
  const { harness } = setup();
  const result = await call(harness, clearBatch());
  assert.equal(result.status, 200);
  assert.equal(result.body.replayed, false);
  assertCommitEnvelope(result.body);
});

test('authority: the owner of ANOTHER tenant commits into that tenant only', async () => {
  const { state, harness } = setup();
  const result = await call(harness, clearBatch(1, 'b'), ownerBToken());
  assert.equal(result.status, 200);
  const created = state.students.filter(student => student.tenant_id === TENANT_B && student.id !== 'b1');
  assert.equal(created.length, 1);
  assert.equal(state.students.filter(student => student.tenant_id === TENANT_A).length, 5, 'tenant A is untouched');
  assert.equal(state.importBatches[0].tenant_id, TENANT_B);
});

test('authority: a membership role label is not owner authority', async () => {
  const callers: Array<[string, string]> = [
    [INSTRUCTOR_A, 'instructor'],
    [ROLE_OWNER_MEMBER, 'instructor'],
    [MULTI, 'instructor'],
  ];
  for (const [caller, role] of callers) {
    const { harness } = setup();
    const token = sign(caller, role, { tenant_id: TENANT_A });
    const result = await call(harness, clearBatch(), token);
    assert.equal(result.status, 403, caller);
    assert.equal(result.body.error, 'Forbidden');
    assert.equal(harness.connectionCount(), 1, 'authority is read on the acquired connection');
    assert.equal(harness.releaseCount(), 1);
    assert.deepEqual(harness.writes(), [], `${caller} must write nothing`);
  }
});

test('authority: a caller with no selected tenant never reaches the route', async () => {
  for (const caller of [ADMIN, NO_SCOPE]) {
    const { harness } = setup();
    const result = await call(harness, clearBatch(), sign(caller, 'admin'));
    assert.equal(result.status, 404, caller);
    assert.equal(harness.connectionCount(), 0, `${caller} must not acquire a connection`);
    assert.deepEqual(harness.writes(), []);
  }
});

test('authority: a student principal is refused by the workspace boundary', async () => {
  const { harness } = setup();
  const result = await call(harness, clearBatch(), sign(STUDENT, 'student'));
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'STUDENT_SPACE_REQUIRED');
  assert.equal(harness.connectionCount(), 0);
  assert.deepEqual(harness.writes(), []);
});

test('authority: a suspended tenant is refused even for its recorded owner', async () => {
  const { harness } = setup();
  const token = sign(OWNER_A, 'instructor', { tenant_id: TENANT_INACTIVE });
  const result = await call(harness, clearBatch(), token);
  assert.equal(result.status, 404);
  assert.equal(harness.connectionCount(), 0);
  assert.deepEqual(harness.writes(), []);
});

test('authority: an inactive caller row is refused as a revoked session', async () => {
  const { state, harness } = setup();
  state.users[OWNER_A] = { is_active: 0, token_version: 0, suspension_active: 0 };
  const result = await call(harness, clearBatch());
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'SESSION_REVOKED');
  assert.equal(harness.connectionCount(), 0);
  assert.deepEqual(harness.writes(), []);
});

test('authority: a billing-only account is refused before any data access', async () => {
  const { harness } = setup();
  const result = await call(harness, clearBatch(), sign(BILLING_ONLY, 'instructor'));
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'BILLING_ONLY');
  assert.equal(harness.connectionCount(), 0, 'the denial must precede every data access');
  assert.deepEqual(harness.writes(), []);
});

test('authority: an unauthenticated request never reaches a successful handler', async () => {
  const { harness } = setup();
  const result = await call(harness, clearBatch(), null);
  assert.notEqual(result.status, 200);
  assert.equal(harness.connectionCount(), 0);
  assert.deepEqual(harness.writes(), []);
});

test('authority: no tenant selector in the header, query or body can choose a tenant', async () => {
  const { state, harness } = setup();
  const payload = { ...clearBatch(1, 'n'), tenant_id: TENANT_B, tenantId: TENANT_B };
  const result = await withSilencedErrors(() =>
    runChain(
      harness.chain,
      makeReq({
        token: ownerToken(),
        method: 'POST',
        pathName: '/student-import/commit',
        body: payload,
        query: { tenant_id: TENANT_B },
        headers: { 'x-tenant-id': TENANT_B },
      }),
    ),
  );
  // The real boundary refuses a client-supplied tenant context before the
  // route is reached, so a selector can never widen the scope. The header is
  // checked first; the body/query selector is refused by the same boundary.
  assert.equal(result.status, 400);
  assert.ok(
    ['Tenant context must not be supplied by the client', 'Tenant context is resolved from the authenticated membership'].includes(result.body.error),
    result.body.error,
  );
  assert.equal(state.importBatches.length, 0);
  assert.deepEqual(harness.writes(), []);

  // The body/query selector alone is refused by the same boundary.
  const { harness: bodyHarness } = setup();
  const byBody = await withSilencedErrors(() =>
    runChain(
      bodyHarness.chain,
      makeReq({
        token: ownerToken(),
        method: 'POST',
        pathName: '/student-import/commit',
        body: { ...clearBatch(1, 'n'), tenant_id: TENANT_B },
      }),
    ),
  );
  assert.equal(byBody.status, 400);
  assert.equal(byBody.body.error, 'Tenant context must not be supplied by the client');
  assert.equal(bodyHarness.connectionCount(), 0);
});

test('tenant isolation: a value owned only by ANOTHER tenant does not block this tenant', async () => {
  const { state, harness } = setup();
  state.students.push({ id: 'b2', tenant_id: TENANT_B, is_active: 1, email: null, phone: '0911', barcode: null });
  const result = await call(harness, commitBody([clearRow(2, 'iso')], importKey('iso')));
  assert.equal(result.status, 200);
  assert.equal(state.students.filter(student => student.tenant_id === TENANT_B && student.id === 'b2').length, 1);
});

// ---------------------------------------------------------------------------
// Transaction authority — the authorization lives INSIDE the transaction
// ---------------------------------------------------------------------------

test('transaction authority: BEGIN precedes the owner-authority SELECT on the production path', async () => {
  const { harness } = setup();
  const result = await call(harness, clearBatch(1, 'txn'));
  assert.equal(result.status, 200);
  assert.equal(harness.connectionCount(), 1, 'the whole commit runs on ONE connection');
  // The real handler opens the transaction BEFORE it reads the owner
  // authority, so the authority read and every write after it share ONE
  // transaction: an ownership change, a suspension or a caller revocation that
  // lands between the authorization and the write cannot slip through.
  assert.equal(harness.events[0], 'begin', `the transaction must open first: ${harness.events.join(',')}`);
  assert.equal(harness.events[1], 'owner', `the authority read must follow BEGIN: ${harness.events.join(',')}`);
  // The authority read is the FIRST statement of that transaction.
  assert.equal(squash(harness.calls[0].sql), OWNER_SELECT, 'the owner authority is the first statement');
  // The transaction that carried the authority read is the one that committed
  // the writes, and it is closed at the end.
  assert.equal(harness.events[harness.events.length - 2], 'commit');
  assert.equal(harness.events[harness.events.length - 1], 'release');
  assert.equal(harness.openTransactionCount(), 0, 'no transaction is left open');
});

test('transaction authority: a denied authority rolls back, releases once and writes nothing', async () => {
  const callers: Array<[string, string]> = [
    [INSTRUCTOR_A, 'instructor'],
    [ROLE_OWNER_MEMBER, 'instructor'],
    [MULTI, 'instructor'],
  ];
  for (const [caller, role] of callers) {
    const { state, harness } = setup();
    const token = sign(caller, role, { tenant_id: TENANT_A });
    const result = await call(harness, clearBatch(2, 'deny'), token);
    assert.equal(result.status, 403, caller);
    assert.equal(result.body.error, 'Forbidden');
    assert.equal(harness.connectionCount(), 1, `${caller}: one connection carries the denial`);
    // The denial is decided INSIDE the open transaction, so that transaction is
    // rolled back before the answer and the connection is released once.
    assert.deepEqual(
      harness.events,
      ['begin', 'owner', 'rollback', 'release'],
      `${caller}: the denied authority must roll the open transaction back`,
    );
    assert.equal(harness.releaseCount(), 1, `${caller}: the connection is released exactly once`);
    assert.equal(harness.destroyCount(), 0, `${caller}: a clean rollback must not discard the connection`);
    assert.equal(harness.openTransactionCount(), 0, `${caller}: no transaction is left open`);
    assert.deepEqual(harness.writes(), [], `${caller}: nothing is written`);
    assert.deepEqual(harness.appliedWrites(), [], `${caller}: nothing is applied`);
    assert.deepEqual(harness.discardedWrites(), [], `${caller}: nothing is discarded`);
    assert.equal(state.importBatches.length, 0, `${caller}: no batch record is created`);
    assert.equal(state.students.length, 6, `${caller}: no student row is created`);
  }
});

test('transaction authority: the tenant of the authority read is the server-selected one', async () => {
  const { harness } = setup();
  const result = await call(harness, clearBatch(1, 'sel'));
  assert.equal(result.status, 200);
  const authority = harness.calls[0];
  assert.equal(squash(authority.sql), OWNER_SELECT);
  assert.deepEqual(authority.params.slice(1), [TENANT_A], 'the authority read is scoped to the selected tenant');
});

// ---------------------------------------------------------------------------
// Stored exact matches — the whole batch is refused
// ---------------------------------------------------------------------------

test('existing match: an exact email/phone/barcode refuses the WHOLE batch', async () => {
  const cases: Array<[any, number[]]> = [
    [commitRow(2, { email: 'a@x.com' }), [2]],
    [commitRow(2, { phone: '007' }), [2]],
    [commitRow(2, { barcode: 'B3' }), [2]],
  ];
  for (const [badRow, expected] of cases) {
    const { state, harness } = setup();
    const result = await call(harness, commitBody([clearRow(3, 'ok'), badRow], importKey('m')));
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'STUDENT_IMPORT_EXISTING_MATCH');
    assert.deepEqual(result.body.rows.map((entry: any) => entry.row_number), expected);
    // The whole batch is refused: the refusal happens before any write, so
    // nothing was staged and nothing had to be discarded.
    assert.deepEqual(harness.appliedWrites(), []);
    assert.deepEqual(harness.discardedWrites(), []);
    assert.equal(state.students.length, 6, 'no student row was created');
    assert.equal(state.importBatches.length, 0, 'no batch record was created');
  }
});

test('existing match: the matched field names are reported in the documented order', async () => {
  const { harness } = setup();
  const result = await call(
    harness,
    commitBody([commitRow(2, { barcode: 'B1', email: 'a@x.com', phone: '0100' })], importKey('order')),
  );
  assert.equal(result.status, 409);
  assert.deepEqual(result.body.rows, [{ row_number: 2, matched_fields: ['email', 'phone', 'barcode'] }]);
});

test('existing match: a case-only difference is NOT a match, an exact one is', async () => {
  const { state, harness } = setup();
  state.collationSuperset = true;
  // `a2` stores `A@X.COM`. A case-only difference must not be reported.
  const different = await call(harness, commitBody([commitRow(2, { email: 'A@x.com' })], importKey('case')));
  assert.equal(different.status, 200, 'a case-insensitive superset must be narrowed to an exact match');
  assert.equal(state.students.some(student => student.email === 'A@x.com'), true, 'the value is stored verbatim');

  const exact = await call(harness, commitBody([commitRow(3, { email: 'A@X.COM' })], importKey('case2')));
  assert.equal(exact.status, 409);
  assert.deepEqual(exact.body.rows, [{ row_number: 3, matched_fields: ['email'] }]);
});

test('existing match: an inactive student never matches', async () => {
  const { state, harness } = setup();
  state.students.push({ id: 'a9', tenant_id: TENANT_A, is_active: 0, email: null, phone: '0999', barcode: null });
  const result = await call(harness, commitBody([clearRow(2, 'ina')], importKey('ina')));
  assert.equal(result.status, 200);
});

test('existing match: a refusal never leaks a stored value, an id or an identity', async () => {
  const { harness } = setup();
  const result = await call(harness, commitBody([commitRow(2, { email: 'a@x.com', phone: '0100', barcode: 'B1' })], importKey('leak')));
  assert.equal(result.status, 409);
  const serialized = JSON.stringify(result.body);
  for (const leaked of ['a@x.com', '0100', 'B1', 'a1', 'b1', TENANT_A]) {
    assert.equal(serialized.includes(leaked), false, `the refusal leaked ${leaked}`);
  }
  assert.deepEqual(Object.keys(result.body).sort(), ['code', 'error', 'rows']);
  for (const entry of result.body.rows) {
    assert.deepEqual(Object.keys(entry).sort(), ['matched_fields', 'row_number']);
  }
});

// ---------------------------------------------------------------------------
// The write surface
// ---------------------------------------------------------------------------

test('write: only the two documented tables are ever written', async () => {
  const { harness } = setup();
  const result = await call(harness, clearBatch(3));
  assert.equal(result.status, 200);
  assertOnlyDocumentedWrites(harness);
  // The only statement that mentions `users` is the accepted authority read.
  for (const call_ of harness.calls) {
    const statement = squash(call_.sql);
    if (statement.includes('users')) assert.equal(statement, OWNER_SELECT);
  }
});

test('write: exactly one batch record and the submitted student rows commit', async () => {
  const { state, harness } = setup();
  const result = await call(harness, clearBatch(3));
  assert.equal(result.status, 200);
  // One batch INSERT plus ONE student INSERT that carries the three rows.
  assert.equal(harness.appliedWrites().length, 2);
  assert.deepEqual(harness.appliedWrites().map(write => write.table), ['student_import_batches', 'students']);
  assert.equal(harness.appliedWrites()[1].params.length, 24, '3 rows x 8 columns in one statement');
  assert.deepEqual(harness.discardedWrites(), []);
  assert.equal(state.importBatches.length, 1);
  assert.equal(state.students.filter(student => student.tenant_id === TENANT_A && !['a1', 'a2', 'a3', 'a4', 'a5'].includes(student.id)).length, 3);
});

test('write: the batch record is written before the students, so the key serializes', async () => {
  const { harness } = setup();
  const result = await call(harness, clearBatch(1, 'ev'));
  assert.equal(result.status, 200);
  assert.equal(harness.writes()[0].table, 'student_import_batches');
  assert.deepEqual(harness.events, [
    'begin', 'owner', 'batch-select', 'match:email', 'match:phone', 'match:barcode',
    'batch-insert', 'student-insert', 'commit', 'release',
  ]);
});

test('write: the student insert uses exactly the eight documented columns', async () => {
  const { harness } = setup();
  const result = await call(harness, clearBatch(2));
  assert.equal(result.status, 200);
  for (const write of harness.writes()) {
    if (write.table !== 'students') continue;
    const statement = squash(write.sql);
    assert.ok(
      statement.startsWith('INSERT INTO students (id,tenant_id,name,email,phone,guardian_phone,grade,barcode) VALUES ('),
      statement,
    );
    assert.equal(write.params.length % 8, 0);
  }
});

test('write: ids are server-generated and the tenant is the server-selected one', async () => {
  const { state, harness } = setup();
  const result = await call(harness, clearBatch(3));
  assert.equal(result.status, 200);
  const created = state.students.filter(student => student.tenant_id === TENANT_A && !['a1', 'a2', 'a3', 'a4', 'a5'].includes(student.id));
  const ids = created.map(student => student.id);
  assert.equal(new Set(ids).size, 3, 'every row gets its own generated id');
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  // No client-supplied id, tenant or account column can appear in the write.
  for (const write of harness.writes()) {
    const statement = squash(write.sql);
    for (const forbidden of ['user_id', 'password', 'invitation', 'otp', 'enroll', 'payment', 'group_id', 'grade_id', 'approval', 'is_offline']) {
      assert.equal(statement.includes(forbidden), false, `${forbidden} must not be written`);
    }
  }
});

test('write: an absent optional value is stored as NULL, never as a blank string', async () => {
  const { state, harness } = setup();
  const result = await call(harness, commitBody([commitRow(2, { name: 'Only Name' })], importKey('null')));
  assert.equal(result.status, 200);
  const created = state.students.find(student => student.name === 'Only Name');
  assert.ok(created);
  assert.equal(created.email, null);
  assert.equal(created.phone, null);
  assert.equal(created.barcode, null);
  assert.equal(created.guardian_phone, null);
  assert.equal(created.grade, null);
});

test('write: leading zeros and case are preserved verbatim', async () => {
  const { state, harness } = setup();
  const result = await call(
    harness,
    commitBody([commitRow(2, { name: 'Pad', email: 'MiXeD@X.com', phone: '01000', barcode: '000123' })], importKey('verbatim')),
  );
  assert.equal(result.status, 200);
  const created = state.students.find(student => student.name === 'Pad');
  assert.ok(created);
  assert.equal(created.email, 'MiXeD@X.com');
  assert.equal(created.phone, '01000');
  assert.equal(created.barcode, '000123');
});

test('write: a committed batch is visible to the reconciliation route unchanged', async () => {
  const { harness } = setup();
  const committed = await call(harness, clearBatch(1, 'vis'));
  assert.equal(committed.status, 200);
  const resolved = await withSilencedErrors(() =>
    runChain(harness.chain, resolveReq(body([row(2, 'vis2@x.com')]))),
  );
  assert.equal(resolved.status, 200);
  assert.deepEqual(resolved.body.rows, [{ row_number: 2, matched_fields: ['email'] }]);
});

// ---------------------------------------------------------------------------
// Bounded chunked reads and chunked inserts
// ---------------------------------------------------------------------------

test('bounds: 1000 distinct values are read in five chunks of 200', async () => {
  const { harness } = setup();
  const rows = Array.from({ length: 1000 }, (_, index) => clearRow(index + 2));
  const result = await call(harness, commitBody(rows, importKey('chunk')));
  assert.equal(result.status, 200);
  const emailReads = harness.calls
    .map(call_ => /^SELECT email AS value FROM students/.exec(squash(call_.sql)))
    .filter(Boolean);
  assert.equal(emailReads.length, 5);
  const counts = harness.calls
    .filter(call_ => squash(call_.sql).startsWith('SELECT email AS value'))
    .map(call_ => call_.params.length - 1);
  assert.deepEqual(counts, [200, 200, 200, 200, 200]);
});

test('bounds: the read count follows the DISTINCT nonblank value count, never the row count', async () => {
  const { harness } = setup();
  // 250 rows, of which only three carry a nonblank value per field: the number
  // of statements is a function of the distinct values, not of the rows.
  const rows = Array.from({ length: 250 }, (_, index) =>
    index < 3
      ? commitRow(index + 2, { email: `distinct${index}@x.com`, phone: `08${index}`, barcode: `D${index}` })
      : commitRow(index + 2, { name: `Row ${index}` }),
  );
  const result = await call(harness, commitBody(rows, importKey('dedupe')));
  assert.equal(result.status, 200);
  const emailReads = harness.calls.filter(call_ => squash(call_.sql).startsWith('SELECT email AS value'));
  assert.equal(emailReads.length, 1, 'three distinct values fit in one chunk');
  assert.equal(emailReads[0].params.length - 1, 3);
  const phoneReads = harness.calls.filter(call_ => squash(call_.sql).startsWith('SELECT phone AS value'));
  assert.equal(phoneReads.length, 1);
  assert.equal(phoneReads[0].params.length - 1, 3);
  const barcodeReads = harness.calls.filter(call_ => squash(call_.sql).startsWith('SELECT barcode AS value'));
  assert.equal(barcodeReads.length, 1);
  assert.equal(barcodeReads[0].params.length - 1, 3);
  // There is no per-row statement anywhere: the total statement count stays a
  // small constant instead of growing with the batch.
  assert.ok(harness.calls.length < 12, `unexpected per-row statements: ${harness.calls.length}`);
});

test('bounds: 1000 rows are written in five INSERT statements of 200 tuples', async () => {
  const { harness } = setup();
  const rows = Array.from({ length: 1000 }, (_, index) => clearRow(index + 2));
  const result = await call(harness, commitBody(rows, importKey('insert')));
  assert.equal(result.status, 200);
  const inserts = harness.writes().filter(write => write.table === 'students');
  assert.equal(inserts.length, 5);
  for (const insert of inserts) {
    assert.equal(insert.params.length, 1600, '200 rows x 8 columns');
  }
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('idempotency: the same key and the same canonical payload replay without inserting', async () => {
  const { state, harness } = setup();
  const payload = clearBatch(3, 'rep');
  const first = await call(harness, payload);
  assert.equal(first.status, 200);
  assert.equal(first.body.replayed, false);
  const writesAfterFirst = harness.appliedWrites().length;
  const studentsAfterFirst = state.students.length;

  const second = await call(harness, payload);
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.batch_id, first.body.batch_id);
  assert.equal(second.body.created, first.body.created);
  assert.deepEqual(second.body.row_numbers, first.body.row_numbers);
  assert.equal(harness.appliedWrites().length, writesAfterFirst, 'a replay writes nothing');
  assert.equal(state.students.length, studentsAfterFirst, 'a replay inserts nothing');
  assert.equal(state.importBatches.length, 1, 'a replay creates no second record');
  assert.equal(harness.openTransactionCount(), 0);
});

test('idempotency: the same key with a different payload is a conflict, never a replay', async () => {
  const { state, harness } = setup();
  const key = importKey('conflict');
  const first = await call(harness, commitBody([clearRow(2, 'one')], key));
  assert.equal(first.status, 200);
  const second = await call(harness, commitBody([clearRow(3, 'two')], key));
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'STUDENT_IMPORT_IDEMPOTENCY_CONFLICT');
  assert.equal(harness.appliedWrites().length, 2, 'only the first batch wrote');
  assert.equal(state.importBatches.length, 1);
});

test('idempotency: a different key cannot bypass the existing-match refusal', async () => {
  const { state, harness } = setup();
  const first = await call(harness, commitBody([clearRow(2, 'dup')], importKey('dup')));
  assert.equal(first.status, 200);
  // The SAME payload under a DIFFERENT key: the values now exist in the tenant,
  // so the second attempt is refused as an existing match rather than inserted.
  const second = await call(harness, commitBody([clearRow(2, 'dup')], importKey('dup2')));
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'STUDENT_IMPORT_EXISTING_MATCH');
  assert.equal(state.importBatches.length, 1, 'no second batch record');
  assert.equal(state.students.filter(student => student.tenant_id === TENANT_A && !['a1', 'a2', 'a3', 'a4', 'a5'].includes(student.id)).length, 1);
});

test('idempotency: the replay returns the recorded created count and row numbers', async () => {
  const { harness } = setup();
  const payload = commitBody([clearRow(2, 'rec'), clearRow(3, 'rec')], importKey('rec'));
  const first = await call(harness, payload);
  assert.equal(first.status, 200);
  assert.equal(first.body.created, 2);
  const second = await call(harness, payload);
  assert.equal(second.status, 200);
  assert.equal(second.body.created, 2);
  assert.deepEqual(second.body.row_numbers, [2, 3]);
  const stored = harness.storedBatches()[0];
  assert.deepEqual(stored.row_numbers, [2, 3]);
  assert.equal(stored.created_count, 2);
  assert.equal(stored.tenant_id, TENANT_A);
  assert.equal(stored.created_by, OWNER_A);
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test('concurrency: two simultaneous same-key attempts produce exactly one batch', async () => {
  const { state, harness } = setup();
  const payload = clearBatch(3, 'conc');
  const [first, second] = await Promise.all([call(harness, payload), call(harness, payload)]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 200]);
  const replayed = [first, second].filter(result => result.body.replayed === true);
  const fresh = [first, second].filter(result => result.body.replayed === false);
  assert.equal(replayed.length, 1, 'exactly one attempt is answered from the stored record');
  assert.equal(fresh.length, 1, 'exactly one attempt is the first writer');
  assert.equal(fresh[0].body.batch_id, replayed[0].body.batch_id, 'both answers name the same batch');
  assert.equal(state.importBatches.length, 1, 'one key, one record');
  assert.equal(state.students.filter(student => student.tenant_id === TENANT_A && !['a1', 'a2', 'a3', 'a4', 'a5'].includes(student.id)).length, 3);
  assert.equal(harness.appliedWrites().length, 2, 'one batch record plus one three-row student insert');
  assert.equal(harness.openTransactionCount(), 0, 'no transaction is left open');
  assert.equal(harness.releaseCount(), 2, 'both connections are released');
  assert.equal(harness.destroyCount(), 0);
});

// ---------------------------------------------------------------------------
// The transactional seam
// ---------------------------------------------------------------------------

test('seam: a deployment without the transactional seam refuses the write with 503', async () => {
  const { harness } = setup({ mount: 'student-import', withCommitSeam: false });
  const result = await call(harness, clearBatch(), ownerToken(), '/commit');
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'STUDENT_IMPORT_COMMIT_UNAVAILABLE');
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(harness.connectionCount(), 0, 'the write never falls back to the read-only seam');
});

test('seam: the reconciliation route still works on the direct mount without the commit seam', async () => {
  const { harness } = setup({ mount: 'student-import', withCommitSeam: false });
  const result = await withSilencedErrors(() =>
    runChain(harness.chain, resolveReq(body([row(2, 'a@x.com')]), ownerToken(), '/resolve')),
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.rows, [{ row_number: 2, matched_fields: ['email'] }]);
});

// ---------------------------------------------------------------------------
// The migration FILE — asserted as a file, never applied
// ---------------------------------------------------------------------------

test('migration: the batch/idempotency table is defined additively and sanitized', () => {
  const file = path.join(__dirname, '../migrations/20261021_04_student_import_batches.sql');
  const source = fs.readFileSync(file, 'utf8');
  const ddl = source
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');

  assert.ok(ddl.includes('CREATE TABLE IF NOT EXISTS student_import_batches'), 'the one new table');
  assert.ok(ddl.includes('UNIQUE KEY uq_student_import_batches_tenant_key (tenant_id, idempotency_key)'));
  assert.ok(ddl.includes('payload_digest CHAR(64) NOT NULL'));
  assert.ok(ddl.includes('row_numbers JSON NOT NULL'));
  assert.ok(ddl.includes('created_count INT NOT NULL'));
  assert.ok(ddl.includes('created_by CHAR(36) NOT NULL'));
  assert.ok(ddl.includes('CONSTRAINT fk_student_import_batches_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)'));
  assert.ok(ddl.includes('CHAR_LENGTH(idempotency_key) BETWEEN 16 AND 128'));
  assert.ok(ddl.includes('CHAR_LENGTH(payload_digest) = 64'));
  assert.ok(ddl.includes('created_count BETWEEN 1 AND 1000'));
  assert.ok(ddl.includes('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'));

  // No CSV value, no created student id and no existing-record identity column.
  for (const column of ['email', 'phone', 'barcode', 'guardian', 'grade', 'name VARCHAR', 'student_id']) {
    assert.equal(ddl.includes(column), false, `the record must not store ${column}`);
  }
  // No account, access, enrollment, payment or course linkage.
  for (const column of ['user_id', 'password', 'invitation', 'otp', 'enroll', 'payment', 'group', 'course', 'branch']) {
    assert.equal(ddl.includes(column), false, `the record must not link ${column}`);
  }
  // Additive only: no ALTER/DROP/TRUNCATE and no data change.
  for (const statement of ['ALTER TABLE', 'DROP ', 'TRUNCATE', 'INSERT INTO', 'UPDATE ', 'DELETE FROM']) {
    assert.equal(ddl.includes(statement), false, `the file must not contain ${statement}`);
  }
  // Exactly one CREATE TABLE: one additive table, nothing else.
  assert.equal(ddl.match(/CREATE TABLE/g)?.length, 1);
});
