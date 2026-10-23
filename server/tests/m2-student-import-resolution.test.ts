/**
 * M2-14 / M2-B08 — private READ-ONLY student-import reconciliation (hermetic,
 * behavioral).
 *
 * Contract under test: `POST /api/tenants/me/student-import/resolve` answers,
 * for the VERIFIED OWNER of the server-selected ACTIVE tenant only, which of
 * the submitted rows carry an email / phone / barcode that ALREADY exists among
 * that tenant's ACTIVE students. The response carries a row number and the
 * NAMES of the matched fields — never an existing student id, user id, name or
 * stored contact value — and the request performs READS ONLY.
 *
 * Composition under test is the real production order (src/index.ts): the real
 * optional-auth middleware, the real tenant-authority and student-workspace
 * boundaries, then the real `createTenantSelfRouter` with the real
 * student-import router mounted under `/student-import`. Only leaf data
 * repositories and the read connection are injected fixtures. No express
 * listener, socket, fetch, DB, provider or app startup.
 *
 * Import isolation is proven positively: the `src/db`, `src/services/minio`,
 * `src/services/subscription-renewal` and `dotenv` module bodies are intercepted
 * in the CommonJS loader before any app module loads, stay out of
 * `require.cache`, need no dummy env and are re-checked in `after`.
 *
 * Live MySQL collation behaviour, real concurrency, real index usage and real
 * HTTP transport are explicitly NOT exercised or claimed. The collation is
 * MODELLED (`collationSuperset`) so the application-level exact comparison is
 * observable instead of assumed.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import {
  ADMIN,
  BILLING_ONLY,
  INSTRUCTOR_A,
  MULTI,
  NO_SCOPE,
  OWNER_A,
  OWNER_B,
  RESOLVE_PATH,
  ROLE_OWNER_MEMBER,
  STUDENT,
  TENANT_A,
  TENANT_B,
  TENANT_INACTIVE,
  TEST_SECRET,
  assertEnvelope,
  body,
  buildHarness,
  createIsolation,
  loadAppModules,
  makeReq,
  makeState,
  matchSql,
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

const setup = () => {
  const state = makeState();
  return { state, harness: buildHarness(state, modules) };
};

const call = async (
  harness: ReturnType<typeof buildHarness>,
  payload: any,
  token: string | null = ownerToken(),
) => withSilencedErrors(() => runChain(harness.chain, resolveReq(payload, token)));

// ---------------------------------------------------------------------------
// Composition, isolation and reachability
// ---------------------------------------------------------------------------

test('isolation: the default DB, provider, renewal and dotenv modules are intercepted and never executed', () => {
  assert.ok(isolation.interceptedIds().length >= 4);
  const registered = isolation.interceptedIds();
  for (const id of isolation.interceptionLog) {
    assert.ok(registered.includes(id), `interception of an unregistered module: ${id}`);
  }
  // The intercepted bodies never ran: a module body that executed would either
  // call a sentinel or leave an entry in the require cache.
  for (const id of registered) {
    assert.equal(require.cache[id], undefined, `an intercepted module body ran: ${id}`);
  }
  assert.deepEqual(isolation.sentinelCalls, []);
});

test('composition: the documented path is reachable through the real tenant-self router', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'a@x.com')]));
  assert.equal(result.handlerReached, true);
  assert.notEqual(result.status, 0);
});

test('composition: the router answers only POST; a GET does not reach a handler', async () => {
  const { harness } = setup();
  const result = await withSilencedErrors(() =>
    runChain(harness.chain, makeReq({ token: ownerToken(), method: 'GET', pathName: RESOLVE_PATH })),
  );
  assert.equal(result.handlerReached, false);
  assert.equal(harness.connectionCount(), 0);
});

// ---------------------------------------------------------------------------
// Authority and tenant isolation
// ---------------------------------------------------------------------------

test('authority: the verified owner of the selected active tenant is accepted', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'a@x.com')]));
  assert.equal(result.status, 200);
  assertEnvelope(result.body);
});

test('authority: an instructor membership is refused with 403 and no match read', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'a@x.com')]), sign(INSTRUCTOR_A, 'instructor'));
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'Forbidden');
  assert.deepEqual(harness.events.filter(event => event.startsWith('match')), []);
});

test('authority: a membership labelled owner is still refused (only the owner row counts)', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'a@x.com')]), sign(ROLE_OWNER_MEMBER, 'instructor'));
  assert.equal(result.status, 403);
});

test('authority: an admin principal without tenant authority is refused before any data access', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'a@x.com')]), sign(ADMIN, 'admin'));
  // The real tenant-authority boundary answers 404 for a principal with no
  // server-owned authority in a selected tenant: no membership is disclosed.
  assert.equal(result.status, 404);
  assert.equal(harness.connectionCount(), 0);
});

test('authority: a student principal is refused by the student-workspace boundary', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'a@x.com')]), sign(STUDENT, 'student'));
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'STUDENT_SPACE_REQUIRED');
  assert.equal(harness.connectionCount(), 0);
});

test('authority: a principal with no selected tenant is refused', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'a@x.com')]), sign(NO_SCOPE, 'instructor'));
  assert.equal(result.status, 404);
  assert.equal(harness.connectionCount(), 0);
});

test('authority: a suspended tenant is refused even for its recorded owner', async () => {
  const { harness } = setup();
  const token = sign(OWNER_A, 'instructor', { tenant_id: TENANT_INACTIVE });
  const result = await call(harness, body([row(2, 'a@x.com')]), token);
  assert.equal(result.status, 404);
  assert.equal(harness.connectionCount(), 0);
  assert.deepEqual(harness.events.filter(event => event.startsWith('match')), []);
});

test('authority: an inactive caller row is refused as a revoked session', async () => {
  const { state, harness } = setup();
  state.users[OWNER_A] = { is_active: 0, token_version: 0, suspension_active: 0 };
  const result = await call(harness, body([row(2, 'a@x.com')]));
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'SESSION_REVOKED');
  assert.equal(harness.connectionCount(), 0);
});

test('authority: a billing-only principal is refused BEFORE any connection is acquired', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'a@x.com')]), sign(BILLING_ONLY, 'instructor'));
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'BILLING_ONLY');
  assert.match(result.body.error, /billing and support/);
  assert.equal(harness.connectionCount(), 0, 'the denial must precede every data access');
});

test('tenant: two tenants sharing the same values never see each other', async () => {
  const { state, harness } = setup();
  // A value that exists ONLY in tenant B.
  state.students.push({ id: 'b2', tenant_id: TENANT_B, is_active: 1, email: 'only-b@x.com', phone: null, barcode: null });

  const asOwnerA = await call(harness, body([row(2, 'only-b@x.com')]));
  assert.equal(asOwnerA.status, 200);
  assert.deepEqual(asOwnerA.body.rows[0].matched_fields, [], 'tenant B data must not be visible to tenant A');
  assert.deepEqual(asOwnerA.body.summary, { checked: 1, matched: 0, clear: 1 });

  const harnessB = buildHarness(state, modules);
  const asOwnerB = await call(harnessB, body([row(2, 'only-b@x.com')]), ownerBToken());
  assert.equal(asOwnerB.status, 200);
  assert.deepEqual(asOwnerB.body.rows[0].matched_fields, ['email']);
});

test('tenant: a client-supplied tenant selector is refused by the real boundary', async () => {
  const { harness } = setup();
  const byQuery = await withSilencedErrors(() =>
    runChain(harness.chain, makeReq({
      token: ownerToken(),
      method: 'POST',
      pathName: RESOLVE_PATH,
      body: body([row(2, 'a@x.com')]),
      query: { tenant_id: TENANT_B },
    })),
  );
  assert.equal(byQuery.status, 400);
  assert.equal(byQuery.body.error, 'Tenant context must not be supplied by the client');

  const byHeader = await withSilencedErrors(() =>
    runChain(harness.chain, makeReq({
      token: ownerToken(),
      method: 'POST',
      pathName: RESOLVE_PATH,
      body: body([row(2, 'a@x.com')]),
      headers: { 'x-tenant-id': TENANT_B },
    })),
  );
  assert.equal(byHeader.status, 400);
  assert.equal(byHeader.body.error, 'Tenant context is resolved from the authenticated membership');

  // Neither refusal took a connection, and neither could change the scope.
  assert.equal(harness.connectionCount(), 0);
});

test('tenant: a multi-tenant instructor membership grants nothing in either tenant', async () => {
  const { state, harness } = setup();
  state.students.push({ id: 'b2', tenant_id: TENANT_B, is_active: 1, email: 'only-b@x.com', phone: null, barcode: null });

  const asA = await call(harness, body([row(2, 'only-b@x.com')]), sign(MULTI, 'instructor', { tenant_id: TENANT_A }));
  assert.equal(asA.status, 403);
  assert.equal(asA.body.error, 'Forbidden');

  const harnessB = buildHarness(state, modules);
  const asB = await call(harnessB, body([row(2, 'only-b@x.com')]), sign(MULTI, 'instructor', { tenant_id: TENANT_B }));
  assert.equal(asB.status, 403);

  // A membership in two tenants is still not the verified owner of either.
  assert.deepEqual(harness.events.filter(event => event.startsWith('match')), []);
  assert.deepEqual(harnessB.events.filter(event => event.startsWith('match')), []);
});

// ---------------------------------------------------------------------------
// Request schema and bounds (all 400, all before any connection)
// ---------------------------------------------------------------------------

const expectRejected = async (payload: any, label: string) => {
  const { harness } = setup();
  const result = await call(harness, payload);
  assert.equal(result.status, 400, `${label} must be a 400`);
  assert.equal(result.body.error, 'Invalid student import resolution payload');
  assert.equal(result.body.rows, undefined, `${label} must not answer a partial result`);
  assert.equal(result.body.summary, undefined);
  assert.equal(harness.connectionCount(), 0, `${label} must be rejected before any data access`);
};

test('schema: a non-object body is refused', async () => {
  await expectRejected(null, 'null body');
  await expectRejected('rows', 'string body');
  await expectRejected([{ row_number: 2 }], 'array body');
  await expectRejected(7, 'number body');
});

test('schema: an extra top-level key is refused', async () => {
  await expectRejected({ rows: [row(2, 'a@x.com')], confirm: true }, 'confirmation key');
  await expectRejected({ rows: [row(2, 'a@x.com')], archived: false }, 'unrelated key');
});

test('schema: a tenant selector inside the body is refused before the handler runs', async () => {
  const { harness } = setup();
  const result = await call(harness, { rows: [row(2, 'a@x.com')], tenant_id: TENANT_B });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Tenant context must not be supplied by the client');
  assert.equal(harness.connectionCount(), 0);
});

test('schema: a missing or non-array rows value is refused', async () => {
  await expectRejected({}, 'no rows');
  await expectRejected({ rows: null }, 'null rows');
  await expectRejected({ rows: {} }, 'object rows');
  await expectRejected({ rows: 'x' }, 'string rows');
});

test('schema: an empty rows array is refused', async () => {
  await expectRejected(body([]), 'empty rows');
});

test('schema: more than 1000 rows is refused', async () => {
  const rows = Array.from({ length: 1001 }, (_, index) => row(index + 2, `s${index}@x.com`));
  await expectRejected(body(rows), 'over-bound rows');
});

test('schema: a row with a missing key is refused', async () => {
  await expectRejected(body([{ row_number: 2, email: 'a@x.com', phone: '' }]), 'missing barcode');
  await expectRejected(body([{ email: 'a@x.com', phone: '', barcode: '' }]), 'missing row_number');
});

test('schema: a row with an extra key is refused', async () => {
  await expectRejected(body([{ ...row(2, 'a@x.com'), name: 'Ali' }]), 'name key');
  await expectRejected(body([{ ...row(2, 'a@x.com'), guardian_phone: '0100' }]), 'guardian key');
  await expectRejected(body([{ ...row(2, 'a@x.com'), grade: '3' }]), 'grade key');
  await expectRejected(body([{ ...row(2, 'a@x.com'), id: 'x' }]), 'id key');
});

test('schema: a non-object row is refused', async () => {
  await expectRejected(body(['row']), 'string row');
  await expectRejected(body([[2, 'a@x.com', '', '']]), 'array row');
  await expectRejected(body([null]), 'null row');
});

test('schema: an out-of-bound or non-integer row number is refused', async () => {
  await expectRejected(body([row(1, 'a@x.com')]), 'row 1 (the header line)');
  await expectRejected(body([row(0, 'a@x.com')]), 'row 0');
  await expectRejected(body([row(-3, 'a@x.com')]), 'negative row');
  await expectRejected(body([row(1002, 'a@x.com')]), 'row past the bound');
  await expectRejected(body([row(2.5, 'a@x.com')]), 'fractional row');
  await expectRejected(body([{ row_number: '2', email: 'a@x.com', phone: '', barcode: '' }]), 'string row number');
});

test('schema: a repeated row number is refused', async () => {
  await expectRejected(body([row(2, 'a@x.com'), row(2, 'b@x.com')]), 'duplicate row number');
});

test('schema: a non-string value is refused', async () => {
  await expectRejected(body([{ row_number: 2, email: 5, phone: '', barcode: '' }]), 'number email');
  await expectRejected(body([{ row_number: 2, email: null, phone: '', barcode: '' }]), 'null email');
  await expectRejected(body([{ row_number: 2, email: 'a@x.com', phone: ['0100'], barcode: '' }]), 'array phone');
});

test('schema: a value longer than the documented bound is refused', async () => {
  await expectRejected(body([row(2, `${'x'.repeat(4097)}@x.com`)]), '4097-character value');
});

test('schema: an untrimmed value is refused rather than silently normalized', async () => {
  await expectRejected(body([row(2, ' a@x.com')]), 'leading space');
  await expectRejected(body([row(2, 'a@x.com ')]), 'trailing space');
  await expectRejected(body([{ row_number: 2, email: '', phone: '  ', barcode: '' }]), 'whitespace-only value');
});

test('schema: a row with no nonblank value is refused', async () => {
  await expectRejected(body([row(2, '', '', '')]), 'all blank');
});

test('schema: the explicit total character bound is enforced', async () => {
  // 600 rows x 3500 characters = 2,100,000 > 2 Mi characters, while every
  // individual value is inside its own bound.
  const rows = Array.from({ length: 600 }, (_, index) => row(index + 2, 'y'.repeat(3500)));
  await expectRejected(body(rows), 'over the total bound');
});

test('schema: a value exactly at the per-value bound is accepted', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'z'.repeat(4096))]));
  assert.equal(result.status, 200);
  assertEnvelope(result.body);
});

// ---------------------------------------------------------------------------
// Matching semantics
// ---------------------------------------------------------------------------

test('matching: an exact stored email is reported', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'a@x.com')]));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.rows, [{ row_number: 2, matched_fields: ['email'] }]);
});

test('matching: an exact stored phone and barcode are reported', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, '', '0100', ''), row(3, '', '', 'B1')]));
  assert.deepEqual(result.body.rows, [
    { row_number: 2, matched_fields: ['phone'] },
    { row_number: 3, matched_fields: ['barcode'] },
  ]);
});

test('matching: the matched fields follow the documented email, phone, barcode order', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'a@x.com', '0100', 'B1')]));
  assert.deepEqual(result.body.rows[0].matched_fields, ['email', 'phone', 'barcode']);
});

test('matching: a collation superset is narrowed to EXACT equality', async () => {
  const { state, harness } = setup();
  state.collationSuperset = true;

  // `a@x.com` is stored exactly as `a1.email`, so it matches.
  const exact = await call(harness, body([row(2, 'a@x.com')]));
  assert.deepEqual(exact.body.rows[0].matched_fields, ['email']);

  // `A@x.com` exists only as `A@X.COM` and `a@x.com`: the SQL filter returns
  // both, but NEITHER is an exact match, so nothing is reported.
  const supersetOnly = await call(harness, body([row(3, 'A@x.com')]));
  assert.deepEqual(supersetOnly.body.rows[0].matched_fields, [], 'a case-folded candidate is not a match');

  // `A@X.COM` is stored exactly as `a2.email`, so it DOES match.
  const exactUpper = await call(harness, body([row(4, 'A@X.COM')]));
  assert.deepEqual(exactUpper.body.rows[0].matched_fields, ['email']);
});

test('matching: leading zeros and plus signs are preserved, never normalized', async () => {
  const { harness } = setup();
  const exact = await call(harness, body([row(2, '', '007', '')]));
  assert.deepEqual(exact.body.rows[0].matched_fields, ['phone']);

  const normalized = await call(harness, body([row(3, '', '7', '')]));
  assert.deepEqual(normalized.body.rows[0].matched_fields, [], '7 must not match the stored 007');

  const plus = await call(harness, body([row(4, '', '+200100', '')]));
  assert.deepEqual(plus.body.rows[0].matched_fields, []);
});

test('matching: an inactive student never matches', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'gone@x.com', '0400', 'B4')]));
  assert.deepEqual(result.body.rows[0].matched_fields, []);
  assert.deepEqual(result.body.summary, { checked: 1, matched: 0, clear: 1 });
});

test('matching: a NULL stored cell is skipped without a false match', async () => {
  const { harness } = setup();
  // a5 stores NULL email and NULL barcode but a real phone.
  const result = await call(harness, body([row(2, '', '0500', '')]));
  assert.deepEqual(result.body.rows[0].matched_fields, ['phone']);

  const none = await call(harness, body([row(3, 'null@x.com', '', 'NULLBARCODE')]));
  assert.deepEqual(none.body.rows[0].matched_fields, []);
});

test('matching: a blank submitted value never matches anything', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, '', '0100', '')]));
  assert.deepEqual(result.body.rows[0].matched_fields, ['phone']);
});

test('matching: a clear row is reported as clear, not omitted', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'nobody@x.com', '9999', 'NOPE')]));
  assert.deepEqual(result.body.rows, [{ row_number: 2, matched_fields: [] }]);
  assert.deepEqual(result.body.summary, { checked: 1, matched: 0, clear: 1 });
});

test('matching: several records may match different fields of one row', async () => {
  const { state, harness } = setup();
  // `a1` matches the phone, `a3` matches the barcode: two different records.
  const result = await call(harness, body([row(2, '', '0100', 'B3')]));
  assert.deepEqual(result.body.rows[0].matched_fields, ['phone', 'barcode']);
  assert.deepEqual(result.body.summary, { checked: 1, matched: 1, clear: 0 });
});

test('matching: the response keeps the REQUEST row order, not a numeric order', async () => {
  const { harness } = setup();
  const result = await call(harness, body([
    row(9, '', '0100', ''),
    row(3, 'a@x.com', '', ''),
    row(7, '', '', 'B1'),
  ]));
  assert.deepEqual(result.body.rows.map((entry: any) => entry.row_number), [9, 3, 7]);
  assert.deepEqual(result.body.rows.map((entry: any) => entry.matched_fields), [['phone'], ['email'], ['barcode']]);
});

test('matching: exactly one result is returned per request row', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'a@x.com'), row(3, 'nobody@x.com'), row(4, '', '0100', '')]));
  assert.equal(result.body.rows.length, 3);
  assert.deepEqual(result.body.summary, { checked: 3, matched: 2, clear: 1 });
});

test('matching: the summary arithmetic always balances', async () => {
  const { harness } = setup();
  const result = await call(harness, body([
    row(2, 'a@x.com'), row(3, 'nobody@x.com'), row(4, '', '0100', ''), row(5, '', '', 'B2'),
  ]));
  assert.equal(result.body.summary.checked, result.body.rows.length);
  assert.equal(result.body.summary.checked, result.body.summary.matched + result.body.summary.clear);
  assert.equal(
    result.body.summary.matched,
    result.body.rows.filter((entry: any) => entry.matched_fields.length > 0).length,
  );
});

test('privacy: the response carries no stored value and no record identity', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'a@x.com', '0100', 'B1')]));
  const serialized = JSON.stringify(result.body);
  for (const secret of ['a@x.com', '0100', 'B1', 'A@X.COM', 'a1', 'a2', 'Synthetic', 'B2', 'B3']) {
    assert.equal(serialized.includes(secret), false, `the response must not contain ${secret}`);
  }
});

test('privacy: the match statement selects only the match column', async () => {
  const { harness } = setup();
  await call(harness, body([row(2, 'a@x.com', '0100', 'B1')]));
  const matchCalls = harness.calls.filter(entry => squash(entry.sql).includes('FROM students'));
  assert.equal(matchCalls.length, 3, 'one read per non-empty field');
  for (const entry of matchCalls) {
    const sql = squash(entry.sql);
    assert.match(sql, /^SELECT (email|phone|barcode) AS value FROM students WHERE tenant_id=\? AND is_active=1 AND (email|phone|barcode) IN \(\?\)$/);
    assert.equal(/\bname\b/.test(sql), false, 'no name column may be selected');
    assert.equal(/\bid\b/.test(sql), false, 'no id column may be selected');
    assert.equal(/\buser_id\b/.test(sql), false);
    assert.equal(/approval_status|guardian|grade|notes|address/.test(sql), false);
  }
});

// ---------------------------------------------------------------------------
// Read-only guarantees, bounded queries and connection hygiene
// ---------------------------------------------------------------------------

test('read-only: a successful request issues no mutation and opens no transaction', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'a@x.com', '0100', 'B1')]));
  assert.equal(result.status, 200);
  assert.deepEqual(harness.mutations(), [], 'no mutation, audit or transaction statement may be issued');
  assert.equal(harness.events.includes('begin'), false);
  assert.equal(harness.events.includes('commit'), false);
  assert.equal(harness.events.includes('rollback'), false);
});

test('read-only: the statement sequence is owner verification then the three field reads', async () => {
  const { harness } = setup();
  await call(harness, body([row(2, 'a@x.com', '0100', 'B1')]));
  assert.deepEqual(harness.events, ['owner', 'match:email', 'match:phone', 'match:barcode', 'release']);
});

test('bounded: identical values across rows are deduplicated into ONE read', async () => {
  const { harness } = setup();
  await call(harness, body([row(2, '', '0100', ''), row(3, '', '0100', ''), row(4, '', '0100', '')]));
  const phoneCalls = harness.events.filter(event => event === 'match:phone');
  assert.equal(phoneCalls.length, 1, 'a repeated value must not be read once per row');
  const call0 = harness.calls.find(entry => squash(entry.sql).startsWith('SELECT phone AS value'));
  assert.equal(call0!.params.length, 2, 'one distinct value plus the tenant');
});

test('bounded: 1000 distinct values are read in chunks of at most 200, never per row', async () => {
  const { harness } = setup();
  const rows = Array.from({ length: 1000 }, (_, index) => row(index + 2, `s${index}@x.com`));
  const result = await call(harness, body(rows));
  assert.equal(result.status, 200);
  const emailCalls = harness.calls.filter(entry => squash(entry.sql).startsWith('SELECT email AS value'));
  assert.equal(emailCalls.length, 5, '1000 distinct values / 200 per statement');
  for (const entry of emailCalls) {
    assert.ok(entry.params.length - 1 <= 200, 'no statement may exceed the chunk bound');
  }
  // The phone and barcode fields are entirely blank, so they issue NO statement.
  assert.equal(harness.events.filter(event => event === 'match:phone').length, 0);
  assert.equal(harness.events.filter(event => event === 'match:barcode').length, 0);
  assert.equal(result.body.summary.checked, 1000);
});

test('bounded: the chunk statement text matches the documented shape', async () => {
  const { harness } = setup();
  await call(harness, body([row(2, 'a@x.com'), row(3, 'c@x.com')]));
  const emailCall = harness.calls.find(entry => squash(entry.sql).startsWith('SELECT email AS value'));
  assert.equal(squash(emailCall!.sql), matchSql('email', 2));
});

test('connection: the read connection is released exactly once and never destroyed', async () => {
  const { harness } = setup();
  await call(harness, body([row(2, 'a@x.com')]));
  assert.equal(harness.connectionCount(), 1);
  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.destroyCount(), 0);
});

test('connection: a refused authority still releases the connection exactly once', async () => {
  const { harness } = setup();
  await call(harness, body([row(2, 'a@x.com')]), sign(INSTRUCTOR_A, 'instructor'));
  assert.equal(harness.connectionCount(), 1);
  assert.equal(harness.releaseCount(), 1);
});

test('cache: every outcome this handler produces carries Cache-Control: no-store', async () => {
  const { harness } = setup();
  const ok = await call(harness, body([row(2, 'a@x.com')]));
  assert.equal(ok.headers['Cache-Control'], 'no-store');

  const bad = await call(harness, body([]));
  assert.equal(bad.headers['Cache-Control'], 'no-store');

  const forbidden = await call(harness, body([row(2, 'a@x.com')]), sign(INSTRUCTOR_A, 'instructor'));
  assert.equal(forbidden.headers['Cache-Control'], 'no-store');

  // A billing-only denial happens before the first await and still carries it.
  const billing = await call(harness, body([row(2, 'a@x.com')]), sign(BILLING_ONLY, 'instructor'));
  assert.equal(billing.headers['Cache-Control'], 'no-store');
});

test('cache: a 500 outcome also carries no-store', async () => {
  const { state, harness } = setup();
  state.failOwnerSelect = true;
  const result = await call(harness, body([row(2, 'a@x.com')]));
  assert.equal(result.status, 500);
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('response: the envelope is exactly rows plus summary, in request order', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'a@x.com'), row(3, 'nobody@x.com')]));
  assertEnvelope(result.body);
  assert.deepEqual(Object.keys(result.body).sort(), ['rows', 'summary']);
  assert.deepEqual(result.body.rows.map((entry: any) => entry.row_number), [2, 3]);
});

test('response: the owner verification is scoped to the server-selected tenant', async () => {
  const { harness } = setup();
  await call(harness, body([row(2, 'a@x.com')]));
  const ownerCall = harness.calls.find(entry => squash(entry.sql).includes('FROM tenants t JOIN users u'));
  assert.ok(ownerCall);
  assert.equal(ownerCall!.params[1], TENANT_A);
  assert.equal(ownerCall!.params[0], OWNER_A);
});

test('response: an unauthenticated request never reaches the handler', async () => {
  const { harness } = setup();
  const result = await withSilencedErrors(() => runChain(harness.chain, makeReq({ token: null, method: 'POST', pathName: RESOLVE_PATH, body: body([row(2, 'a@x.com')]) })));
  assert.notEqual(result.status, 200);
  assert.equal(harness.connectionCount(), 0);
});

test('response: exactly one response is written per request', async () => {
  const { harness } = setup();
  const result = await call(harness, body([row(2, 'a@x.com')]));
  assert.equal(result.responseCount, 1);
});
