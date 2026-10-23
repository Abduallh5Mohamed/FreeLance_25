/**
 * M2-B07 — private academic-period planning catalog (hermetic, behavioral).
 *
 * Contract under test: `GET`/`POST /api/tenants/me/academic-periods` and
 * `PATCH /api/tenants/me/academic-periods/:id` read and write the PLANNING
 * metadata of the tenant the SERVER selected, and only for the VERIFIED owner
 * of that tenant (`tenants.owner_user_id` = caller, tenant active, caller
 * active). A period is a label plus two date-only bounds plus a reversible
 * archive flag: it attaches no enrollment, no access window, no billing and no
 * automatic transition.
 *
 * Composition under test is the real production order (src/index.ts): the real
 * optional-auth middleware, the real tenant-authority and student-workspace
 * boundaries, then the real `createTenantSelfRouter` with the real
 * academic-period router mounted under `/academic-periods`. Only leaf data
 * repositories and the transactional connection are injected fixtures. No
 * express listener, socket, fetch, DB, provider or app startup.
 *
 * Import isolation is proven positively: the `src/db`, `src/services/minio`,
 * `src/services/subscription-renewal` and `dotenv` module bodies are
 * intercepted in the CommonJS loader before any app module loads, stay out of
 * `require.cache`, need no dummy env and are re-checked in `after`.
 *
 * Live MySQL row-level locking, real concurrency, real index usage and real
 * HTTP transport are explicitly NOT exercised or claimed. The migration FILE
 * is not applied, so no runtime rollout is claimed.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import {
  ADMIN,
  AUDIT_SQL,
  BILLING_ONLY,
  INSERT_SQL,
  INSTRUCTOR_A,
  LIST_SQL,
  MULTI,
  NO_SCOPE,
  OWNER_A,
  OWNER_B,
  PERIOD_AUTUMN,
  PERIOD_DTO_KEYS,
  PERIOD_LOCK_SELECT,
  PERIOD_OTHER_TENANT,
  PERIOD_READBACK_SELECT,
  PERIOD_SPRING,
  PERIOD_SUMMER,
  ROLE_OWNER_MEMBER,
  STUDENT,
  TENANT_A,
  TENANT_B,
  TENANT_INACTIVE,
  TEST_SECRET,
  UPDATE_SQL,
  assertPeriodDto,
  buildHarness,
  createIsolation,
  getReq,
  loadAppModules,
  makeReq,
  makeState,
  namesOf,
  ownerBToken,
  ownerToken,
  patchReq,
  periodRow,
  postReq,
  runChain,
  sign,
  squash,
  squashedCalls,
  withSilencedErrors,
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
const getList = (harness: ReturnType<typeof harnessFor>, token: string | null = ownerToken(), query: any = {}) =>
  runChain(harness.chain, getReq(token, query));
const create = (harness: ReturnType<typeof harnessFor>, body: any, token: string | null = ownerToken()) =>
  runChain(harness.chain, postReq(body, token));
const update = (harness: ReturnType<typeof harnessFor>, id: string, body: any, token: string | null = ownerToken()) =>
  runChain(harness.chain, patchReq(id, body, token));

// ===========================================================================
// Positive import isolation
// ===========================================================================

test('import isolation: forbidden module bodies never evaluate, no dummy env, hook restored', () => {
  assert.equal(process.env.MINIO_ACCESS_KEY, undefined);
  assert.equal(process.env.MINIO_SECRET_KEY, undefined);

  const intercepted = isolation.interceptedIds();
  assert.equal(intercepted.length, 4, 'db, minio, renewal and dotenv are registered for interception');
  for (const id of intercepted) {
    assert.equal(
      (require as any).cache[id],
      undefined,
      `${id} must never be evaluated or cached: its body must not run`,
    );
  }
  // Every interception that actually happened must be one of the registered
  // modules — the hook never swallows anything else.
  for (const id of isolation.interceptionLog) {
    assert.ok(intercepted.includes(id), `only a registered module may be intercepted (saw ${id})`);
  }
  // The three modules on this composition path are genuinely REQUESTED and
  // therefore recorded. `dotenv` is registered but no module on this path
  // requests it, so its absence from the log is the truthful outcome rather
  // than a gap — and the cache assertion above already proves its body never
  // ran.
  for (const id of intercepted) {
    if (id.includes('dotenv')) continue;
    assert.ok(
      isolation.interceptionLog.includes(id),
      `the loader must have intercepted ${id} (recorded: ${JSON.stringify(isolation.interceptionLog)})`,
    );
  }
  assert.equal(isolation.hookRestored(), true);
});

// ===========================================================================
// Authority
// ===========================================================================

test('auth: GET without a token is refused by the real authentication middleware', async () => {
  const harness = harnessFor();
  const result = await getList(harness, null);
  assert.equal(result.status, 401);
  assert.equal(result.body?.periods, undefined);
  assert.equal(harness.connectionCount(), 0, 'no connection is acquired for an unauthenticated request');
});

test('auth: the verified owner reads the selected tenant catalog', async () => {
  const harness = harnessFor();
  const result = await getList(harness);
  assert.equal(result.status, 200);
  assert.equal(result.body.periods.length, 2, 'the archived period is not in the default view');
  for (const period of result.body.periods) assertPeriodDto(period);
  assert.equal(harness.connectionCount(), 1);
});

test('auth: a membership instructor is denied and the catalog is never read', async () => {
  const harness = harnessFor();
  const result = await withSilencedErrors(() => getList(harness, sign(INSTRUCTOR_A, 'instructor')));
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'Forbidden');
  // The owner is verified BEFORE the list, so a non-owner learns nothing about
  // the tenant's periods.
  assert.ok(!harness.events.includes('list'), 'no catalog read for a non-owner');
});

test('auth: a membership owner ROLE LABEL is denied — a label is not authority', async () => {
  const harness = harnessFor();
  const result = await withSilencedErrors(() => getList(harness, sign(ROLE_OWNER_MEMBER, 'instructor')));
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'Forbidden');
  assert.equal(result.body.periods, undefined);
});

test('auth: a global admin with no membership has no workspace', async () => {
  const harness = harnessFor();
  const result = await withSilencedErrors(() => getList(harness, sign(ADMIN, 'admin')));
  assert.equal(result.status, 404);
  assert.equal(result.body.error, 'Tenant membership not found');
  assert.equal(harness.connectionCount(), 0, 'a principal without a workspace takes no connection');
});

test('auth: a principal with no active membership has no workspace', async () => {
  const harness = harnessFor();
  const result = await withSilencedErrors(() => getList(harness, sign(NO_SCOPE, 'instructor')));
  assert.equal(result.status, 404);
  assert.equal(result.body.error, 'Tenant membership not found');
});

test('auth: a student is refused by the real student-workspace boundary', async () => {
  const harness = harnessFor();
  const result = await getList(harness, sign(STUDENT, 'student'));
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'Select an instructor workspace first');
  assert.equal(harness.connectionCount(), 0);
});

test('auth: a token selecting an inactive workspace resolves no scope', async () => {
  const harness = harnessFor();
  const result = await withSilencedErrors(() =>
    getList(harness, sign(OWNER_A, 'instructor', { tenant_id: TENANT_INACTIVE })),
  );
  assert.notEqual(result.status, 200);
  assert.equal(result.body?.periods, undefined);
  assert.equal(harness.connectionCount(), 0);
});

test('auth: a multi-workspace instructor is not an owner of either workspace', async () => {
  const harnessA = harnessFor();
  const selectedA = await withSilencedErrors(() => getList(harnessA, sign(MULTI, 'instructor', { tenant_id: TENANT_A })));
  assert.equal(selectedA.status, 403);

  const harnessB = harnessFor();
  const selectedB = await withSilencedErrors(() => getList(harnessB, sign(MULTI, 'instructor', { tenant_id: TENANT_B })));
  assert.equal(selectedB.status, 403);
  assert.equal(selectedB.body?.periods, undefined);
});

// ===========================================================================
// No client selector
// ===========================================================================

test('selector: a body tenant_id is rejected by the real authority boundary', async () => {
  const harness = harnessFor();
  const result = await create(harness, { name: 'فصل', starts_on: '2026-09-01', ends_on: '2027-01-15', tenant_id: TENANT_B });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Tenant context must not be supplied by the client');
  assert.equal(harness.connectionCount(), 0);
});

test('selector: an x-tenant-id header is rejected by the real authority boundary', async () => {
  const harness = harnessFor();
  const result = await runChain(harness.chain, makeReq({
    token: ownerToken(),
    method: 'GET',
    pathName: '/academic-periods',
    headers: { 'x-tenant-id': TENANT_B },
  }));
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Tenant context is resolved from the authenticated membership');
  assert.equal(harness.connectionCount(), 0);
});

test('selector: a query tenant_id is rejected by the real authority boundary', async () => {
  const harness = harnessFor();
  const result = await getList(harness, ownerToken(), { tenant_id: TENANT_B });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Tenant context must not be supplied by the client');
  assert.equal(harness.connectionCount(), 0);
});

// ===========================================================================
// Billing-only guard
// ===========================================================================

test('billing: a billing-only principal is refused before any connection is acquired', async () => {
  const harness = harnessFor();
  const result = await getList(harness, sign(BILLING_ONLY, 'instructor'));
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'BILLING_ONLY');
  assert.equal(harness.connectionCount(), 0, 'the denial happens before acquisition');
  assert.equal(harness.calls.length, 0, 'no statement is issued');

  const writeHarness = harnessFor();
  const written = await create(writeHarness, { name: 'فصل', starts_on: '2026-09-01', ends_on: '2027-01-15' }, sign(BILLING_ONLY, 'instructor'));
  assert.equal(written.status, 403);
  assert.equal(written.body.code, 'BILLING_ONLY');
  assert.equal(writeHarness.connectionCount(), 0);
});

// ===========================================================================
// Contract
// ===========================================================================

test('contract: the envelope is exactly { periods, pagination } with the documented keys', async () => {
  const harness = harnessFor();
  const result = await getList(harness);
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['pagination', 'periods']);
  assert.deepEqual(Object.keys(result.body.pagination).sort(), ['has_more', 'limit', 'offset']);
  assert.equal(result.body.pagination.limit, 25, 'the default page size');
  assert.equal(result.body.pagination.offset, 0, 'the default offset');
  assert.equal(result.body.pagination.has_more, false);
});

test('contract: the DTO is exactly the seven documented fields', async () => {
  const harness = harnessFor();
  const result = await getList(harness);
  for (const period of result.body.periods) {
    assert.deepEqual(Object.keys(period).sort(), PERIOD_DTO_KEYS);
  }
});

test('contract: no tenant_id, owner, enrollment, price or access field is exposed', async () => {
  const harness = harnessFor();
  const result = await getList(harness);
  const serialized = JSON.stringify(result.body);
  for (const forbidden of ['tenant_id', 'owner_user_id', 'business_name', 'enrollment', 'price', 'fee', 'access', 'capacity', 'group_id', 'grade_id', 'course_id']) {
    assert.equal(serialized.includes(forbidden), false, `the response must not carry ${forbidden}`);
  }
});

test('contract: Cache-Control no-store is set on the 200', async () => {
  const harness = harnessFor();
  const result = await getList(harness);
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('contract: Cache-Control no-store is set on the owner denial', async () => {
  const harness = harnessFor();
  const result = await withSilencedErrors(() => getList(harness, sign(INSTRUCTOR_A, 'instructor')));
  assert.equal(result.status, 403);
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('contract: Cache-Control no-store is set on the billing-only denial', async () => {
  const harness = harnessFor();
  const result = await getList(harness, sign(BILLING_ONLY, 'instructor'));
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('contract: a read never commits and never writes an audit event', async () => {
  const harness = harnessFor();
  await getList(harness);
  assert.equal(harness.commitCount(), 0, 'a read transaction is closed, not committed');
  assert.equal(harness.rollbackCount(), 1);
  assert.equal(harness.auditRows.length, 0);
  assert.equal(harness.releaseCount(), 1, 'the connection is released exactly once');
  assert.equal(harness.destroyCount(), 0);
});

// ===========================================================================
// Bounded list: pagination, ordering, archive view
// ===========================================================================

test('list: the page is ordered by starts_on then id, not by insertion order', async () => {
  const harness = harnessFor();
  const result = await getList(harness);
  assert.deepEqual(namesOf(result), ['الفصل الخريفي', 'الفصل الربيعي']);
  const starts = result.body.periods.map((period: any) => period.starts_on);
  assert.deepEqual(starts, ['2026-09-01', '2027-02-01']);
});

test('list: a limit+1 read reports has_more and returns only the page size', async () => {
  const harness = harnessFor();
  const result = await getList(harness, ownerToken(), { limit: '1' });
  assert.equal(result.status, 200);
  assert.equal(result.body.periods.length, 1);
  assert.equal(result.body.pagination.limit, 1);
  assert.equal(result.body.pagination.has_more, true);
  // The extra row is read, never returned: the statement asked for 2.
  const listCall = harness.calls.find(call => squash(call.sql) === LIST_SQL);
  assert.ok(listCall);
  assert.equal(listCall!.params[2], 2, 'limit+1 is requested');
});

test('list: an offset continues the same deterministic order', async () => {
  const harness = harnessFor();
  const result = await getList(harness, ownerToken(), { limit: '1', offset: '1' });
  assert.equal(result.status, 200);
  assert.deepEqual(namesOf(result), ['الفصل الربيعي']);
  assert.equal(result.body.pagination.offset, 1);
  assert.equal(result.body.pagination.has_more, false);
});

test('list: an offset past the end is an empty page, not an error', async () => {
  const harness = harnessFor();
  const result = await getList(harness, ownerToken(), { offset: '50' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.periods, []);
  assert.equal(result.body.pagination.has_more, false);
});

test('list: the archived view returns only archived periods', async () => {
  const harness = harnessFor();
  const result = await getList(harness, ownerToken(), { archived: 'true' });
  assert.equal(result.status, 200);
  assert.deepEqual(namesOf(result), ['الفصل الصيفي']);
  assert.equal(result.body.periods[0].is_archived, true);
});

test('list: archived=false is the same as the default view', async () => {
  const harness = harnessFor();
  const result = await getList(harness, ownerToken(), { archived: 'false' });
  assert.equal(result.status, 200);
  assert.deepEqual(namesOf(result), ['الفصل الخريفي', 'الفصل الربيعي']);
});

test('list: the archive filter is applied in SQL on the selected tenant', async () => {
  const harness = harnessFor();
  await getList(harness, ownerToken(), { archived: 'true' });
  const listCall = harness.calls.find(call => squash(call.sql) === LIST_SQL);
  assert.ok(listCall);
  assert.equal(listCall!.params[0], TENANT_A, 'the server-selected tenant is the filter');
  assert.equal(listCall!.params[1], 1, 'the archived flag is a bound parameter');
});

test('list: one tenant never sees another tenant period', async () => {
  const harness = harnessFor();
  const result = await withSilencedErrors(() => getList(harness, ownerBToken()));
  assert.equal(result.status, 200);
  assert.deepEqual(namesOf(result), ['فصل مساحة أخرى']);
  assert.equal(result.body.periods[0].id, PERIOD_OTHER_TENANT);
  assert.ok(!namesOf(result).includes('الفصل الخريفي'));
});

test('list: the same-name, same-date period of another tenant is invisible here', async () => {
  const harness = harnessFor();
  const result = await getList(harness);
  const ids = result.body.periods.map((period: any) => period.id);
  assert.ok(!ids.includes(PERIOD_OTHER_TENANT));
});

// ===========================================================================
// Bounded list: query validation
// ===========================================================================

test('query: limit 1 and 100 are accepted', async () => {
  for (const limit of ['1', '100']) {
    const harness = harnessFor();
    const result = await getList(harness, ownerToken(), { limit });
    assert.equal(result.status, 200, `limit=${limit} is legal`);
    assert.equal(result.body.pagination.limit, Number(limit));
  }
});

test('query: offset 0 and 10000 are accepted', async () => {
  for (const offset of ['0', '10000']) {
    const harness = harnessFor();
    const result = await getList(harness, ownerToken(), { offset });
    assert.equal(result.status, 200, `offset=${offset} is legal`);
    assert.equal(result.body.pagination.offset, Number(offset));
  }
});

test('query: a malformed limit is rejected before any connection', async () => {
  for (const limit of ['0', '101', 'abc', '1.5', '-1', '', ' 25', '1e2']) {
    const harness = harnessFor();
    const result = await getList(harness, ownerToken(), { limit });
    assert.equal(result.status, 400, `limit=${JSON.stringify(limit)} must be rejected`);
    assert.equal(result.body.error, 'Invalid academic period list limit');
    assert.equal(harness.connectionCount(), 0);
  }
});

test('query: a malformed offset is rejected before any connection', async () => {
  for (const offset of ['-1', '10001', 'abc', '1.5', '', ' 0']) {
    const harness = harnessFor();
    const result = await getList(harness, ownerToken(), { offset });
    assert.equal(result.status, 400, `offset=${JSON.stringify(offset)} must be rejected`);
    assert.equal(result.body.error, 'Invalid academic period list offset');
    assert.equal(harness.connectionCount(), 0);
  }
});

test('query: an array-valued parameter is rejected, never coerced', async () => {
  const harness = harnessFor();
  const result = await getList(harness, ownerToken(), { limit: ['10', '20'] });
  assert.equal(result.status, 400);
  assert.equal(harness.connectionCount(), 0);
});

test('query: archived accepts exactly true or false', async () => {
  for (const archived of ['1', '0', 'yes', 'TRUE', '']) {
    const harness = harnessFor();
    const result = await getList(harness, ownerToken(), { archived });
    assert.equal(result.status, 400, `archived=${JSON.stringify(archived)} must be rejected`);
    assert.equal(result.body.error, 'Invalid academic period archive filter');
    assert.equal(harness.connectionCount(), 0);
  }
});

test('query: an unknown non-selector key is rejected rather than ignored', async () => {
  for (const query of [{ status: 'active' }, { sort: 'name' }, { from: '2026-01-01' }, { q: 'x' }, { page: '2' }]) {
    const harness = harnessFor();
    const result = await getList(harness, ownerToken(), query);
    assert.equal(result.status, 400, `${JSON.stringify(query)} must be rejected`);
    assert.equal(result.body.error, 'Invalid academic period list query');
    assert.equal(harness.connectionCount(), 0);
  }
});

// ===========================================================================
// Create
// ===========================================================================

test('create: a valid period is created with 201 and the documented DTO', async () => {
  const harness = harnessFor();
  const result = await create(harness, { name: 'الفصل الشتوي', starts_on: '2027-01-20', ends_on: '2027-01-30' });
  assert.equal(result.status, 201);
  assertPeriodDto(result.body.period);
  assert.equal(result.body.period.name, 'الفصل الشتوي');
  assert.equal(result.body.period.starts_on, '2027-01-20');
  assert.equal(result.body.period.ends_on, '2027-01-30');
  assert.equal(result.body.period.is_archived, false);
  assert.equal(harness.commitCount(), 1);
});

test('create: the id is server-generated and never taken from the client', async () => {
  const harness = harnessFor();
  const result = await create(harness, {
    name: 'فصل',
    starts_on: '2027-03-01',
    ends_on: '2027-03-31',
    id: PERIOD_AUTUMN,
  });
  // `id` is not a create field at all, so the payload is refused outright.
  assert.equal(result.status, 400);
  assert.equal(harness.connectionCount(), 0);

  const ok = await create(harnessFor(), { name: 'فصل', starts_on: '2027-03-01', ends_on: '2027-03-31' });
  assert.equal(ok.status, 201);
  assert.notEqual(ok.body.period.id, PERIOD_AUTUMN);
  assert.match(ok.body.period.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('create: the name is trimmed before it is stored', async () => {
  const harness = harnessFor();
  const result = await create(harness, { name: '   الفصل الشتوي   ', starts_on: '2027-01-20', ends_on: '2027-01-30' });
  assert.equal(result.status, 201);
  assert.equal(result.body.period.name, 'الفصل الشتوي');
});

test('create: a duplicated name is permitted — no uniqueness policy exists', async () => {
  const harness = harnessFor();
  const first = await create(harness, { name: 'الفصل الخريفي', starts_on: '2028-09-01', ends_on: '2029-01-15' });
  assert.equal(first.status, 201);
  const second = await create(harness, { name: 'الفصل الخريفي', starts_on: '2028-09-01', ends_on: '2029-01-15' });
  assert.equal(second.status, 201, 'a duplicate name is not an error');
  assert.notEqual(first.body.period.id, second.body.period.id, 'they are two distinct periods');
});

test('create: an overlapping range is permitted — no overlap policy exists', async () => {
  const harness = harnessFor();
  // Deliberately overlaps the stored autumn period (2026-09-01..2027-01-15).
  const result = await create(harness, { name: 'فصل متداخل', starts_on: '2026-10-01', ends_on: '2026-12-01' });
  assert.equal(result.status, 201, 'an overlap is not rejected');
});

test('create: the dates round-trip as date-only values with no time or zone', async () => {
  const harness = harnessFor();
  const result = await create(harness, { name: 'فصل', starts_on: '2026-09-01', ends_on: '2027-01-15' });
  assert.equal(result.status, 201);
  assert.equal(result.body.period.starts_on, '2026-09-01', 'the stored calendar date is returned verbatim');
  assert.equal(result.body.period.ends_on, '2027-01-15');
  // The projection returns the DATE_FORMAT string, never a driver Date shifted
  // by the pool timezone offset (which would answer 2026-08-31).
  assert.equal(result.body.period.starts_on.includes('T'), false);
  assert.equal(result.body.period.starts_on, '2026-09-01');
});

test('create: a year boundary date is not shifted by a day', async () => {
  const harness = harnessFor();
  const result = await create(harness, { name: 'فصل', starts_on: '2027-01-01', ends_on: '2027-12-31' });
  assert.equal(result.status, 201);
  assert.equal(result.body.period.starts_on, '2027-01-01');
  assert.equal(result.body.period.ends_on, '2027-12-31');
});

test('create: a single-day period is valid', async () => {
  const harness = harnessFor();
  const result = await create(harness, { name: 'يوم واحد', starts_on: '2027-05-05', ends_on: '2027-05-05' });
  assert.equal(result.status, 201);
  assert.equal(result.body.period.starts_on, result.body.period.ends_on);
});

test('create: exactly one bounded audit event records the period fields', async () => {
  const harness = harnessFor();
  await create(harness, { name: 'الفصل الشتوي', starts_on: '2027-01-20', ends_on: '2027-01-30' });
  assert.equal(harness.auditRows.length, 1, 'exactly one audit event');
  const params = harness.auditRows[0].params;
  assert.equal(params[1], OWNER_A, 'the real actor');
  assert.equal(params[2], TENANT_A, 'the real tenant');
  assert.equal(params[3], 'tenant.academic_period_created');
  assert.equal(params[4], 'academic_period');
  assert.equal(params[5], harness.state.periods.find(p => p.name === 'الفصل الشتوي')!.id);
  assert.equal(params[6], null, 'a create has no old value');
  assert.deepEqual(JSON.parse(params[7]), {
    name: 'الفصل الشتوي', starts_on: '2027-01-20', ends_on: '2027-01-30', is_archived: false,
  });
});

test('create: statement order is begin, owner, insert, audit, read-back, commit', async () => {
  const harness = harnessFor();
  await create(harness, { name: 'فصل', starts_on: '2027-03-01', ends_on: '2027-03-31' });
  assert.deepEqual(harness.events, ['begin', 'owner', 'insert', 'audit', 'period_readback', 'commit', 'release']);
  assert.deepEqual(squashedCalls(harness), [
    squash(`SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active
       FROM tenants t JOIN users u ON u.id=? WHERE t.id=? FOR UPDATE`),
    squash(INSERT_SQL),
    squash(AUDIT_SQL),
    squash(PERIOD_READBACK_SELECT),
  ]);
});

// ===========================================================================
// Create payload validation
// ===========================================================================

test('payload: a create body must carry exactly name, starts_on and ends_on', async () => {
  const harness = harnessFor();
  const missing = await create(harness, { name: 'فصل', starts_on: '2026-09-01' });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'Invalid academic period payload');

  const extra = await create(harness, { name: 'فصل', starts_on: '2026-09-01', ends_on: '2027-01-15', status: 'active' });
  assert.equal(extra.status, 400);

  const empty = await create(harness, {});
  assert.equal(empty.status, 400);
  assert.equal(harness.connectionCount(), 0, 'no connection is acquired for an invalid payload');
});

test('payload: an enrollment, price, access or capacity field is rejected', async () => {
  const harness = harnessFor();
  for (const extra of [
    { enrollment_id: 'e-1' }, { group_id: 'g-1' }, { grade_id: 'gr-1' },
    { course_id: 'c-1' }, { price: '100' }, { fee: '10' }, { access_starts_at: '2026-09-01' },
    { capacity: 30 }, { is_archived: true }, { tenant_id: TENANT_B }, { owner_user_id: OWNER_A },
  ]) {
    const result = await create(harness, { name: 'فصل', starts_on: '2026-09-01', ends_on: '2027-01-15', ...extra });
    assert.equal(result.status, 400, `${JSON.stringify(extra)} must be rejected`);
  }
  assert.equal(harness.connectionCount(), 0);
});

test('payload: an empty or whitespace-only name is rejected', async () => {
  const harness = harnessFor();
  for (const name of ['', '   ', '\t\n']) {
    const result = await create(harness, { name, starts_on: '2026-09-01', ends_on: '2027-01-15' });
    assert.equal(result.status, 400, `name=${JSON.stringify(name)} must be rejected`);
  }
});

test('payload: a name over 255 characters is rejected and 255 is accepted', async () => {
  const harness = harnessFor();
  const tooLong = await create(harness, { name: 'ا'.repeat(256), starts_on: '2026-09-01', ends_on: '2027-01-15' });
  assert.equal(tooLong.status, 400);

  const exact = await create(harness, { name: 'ا'.repeat(255), starts_on: '2026-09-01', ends_on: '2027-01-15' });
  assert.equal(exact.status, 201);
  assert.equal(exact.body.period.name.length, 255);
});

test('payload: a non-string name is rejected — never coerced', async () => {
  const harness = harnessFor();
  for (const name of [42, true, null, ['فصل'], { ar: 'فصل' }]) {
    const result = await create(harness, { name, starts_on: '2026-09-01', ends_on: '2027-01-15' });
    assert.equal(result.status, 400, `name=${JSON.stringify(name)} must be rejected`);
  }
});

test('payload: a Unicode name is accepted verbatim with no script guessing', async () => {
  const harness = harnessFor();
  const result = await create(harness, { name: 'Autumn Term ٢٠٢٦ — الفصل', starts_on: '2026-09-01', ends_on: '2027-01-15' });
  assert.equal(result.status, 201);
  assert.equal(result.body.period.name, 'Autumn Term ٢٠٢٦ — الفصل');
});

test('payload: a non-canonical date shape is rejected', async () => {
  const harness = harnessFor();
  for (const value of ['2026-9-1', '2026/09/01', '01-09-2026', '2026-09-01T00:00:00Z', '2026-09-01 ', '', 20260901, null]) {
    const result = await create(harness, { name: 'فصل', starts_on: value, ends_on: '2027-01-15' });
    assert.equal(result.status, 400, `starts_on=${JSON.stringify(value)} must be rejected`);
  }
});

test('payload: an impossible calendar date is rejected, not normalized', async () => {
  const harness = harnessFor();
  // `new Date('2026-02-30')` silently becomes 2026-03-02; the handler must not.
  for (const value of ['2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '0999-01-01']) {
    const result = await create(harness, { name: 'فصل', starts_on: value, ends_on: '2027-12-31' });
    assert.equal(result.status, 400, `starts_on=${JSON.stringify(value)} must be rejected`);
  }
});

test('payload: a leap day is valid in a leap year and refused otherwise', async () => {
  const leap = await create(harnessFor(), { name: 'فصل', starts_on: '2028-02-29', ends_on: '2028-03-31' });
  assert.equal(leap.status, 201);

  const notLeap = await create(harnessFor(), { name: 'فصل', starts_on: '2027-02-29', ends_on: '2027-03-31' });
  assert.equal(notLeap.status, 400);
});

test('payload: starts_on after ends_on is rejected', async () => {
  const harness = harnessFor();
  const result = await create(harness, { name: 'فصل', starts_on: '2027-01-15', ends_on: '2026-09-01' });
  assert.equal(result.status, 400);
  assert.equal(harness.connectionCount(), 0);
});

test('payload: a non-object create body is rejected', async () => {
  const harness = harnessFor();
  for (const body of [null, 'name', 42, ['فصل'], true]) {
    const result = await create(harness, body);
    assert.equal(result.status, 400, `body=${JSON.stringify(body)} must be rejected`);
  }
});

// ===========================================================================
// Update
// ===========================================================================

test('patch: a name-only update writes the row and audits exactly one event', async () => {
  const harness = harnessFor();
  const result = await update(harness, PERIOD_AUTUMN, { name: 'الفصل الأول' });
  assert.equal(result.status, 200);
  assertPeriodDto(result.body.period);
  assert.equal(result.body.period.name, 'الفصل الأول');
  assert.equal(result.body.period.starts_on, '2026-09-01', 'the untouched dates are preserved');
  assert.equal(result.body.period.ends_on, '2027-01-15');
  assert.equal(harness.auditRows.length, 1);
  assert.equal(harness.commitCount(), 1);
});

test('patch: a date-only update is merged and validated against the STORED other bound', async () => {
  const harness = harnessFor();
  const result = await update(harness, PERIOD_AUTUMN, { starts_on: '2026-10-01' });
  assert.equal(result.status, 200);
  assert.equal(result.body.period.starts_on, '2026-10-01');
  assert.equal(result.body.period.ends_on, '2027-01-15', 'the stored end is kept');
});

test('patch: a merged range whose start passes the stored end is rejected', async () => {
  const harness = harnessFor();
  // The stored end is 2027-01-15; moving only the start past it must fail even
  // though the request itself carries no `ends_on`.
  const result = await update(harness, PERIOD_AUTUMN, { starts_on: '2027-06-01' });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Invalid academic period update payload');
  assert.equal(harness.commitCount(), 0);
  assert.equal(harness.auditRows.length, 0);
  assert.equal(harness.rollbackCount(), 1);
  // The stored row is untouched.
  const stored = harness.state.periods.find(p => p.id === PERIOD_AUTUMN)!;
  assert.equal(stored.starts_on, '2026-09-01');
});

test('patch: a start and end supplied together are validated as one range', async () => {
  const harness = harnessFor();
  const ok = await update(harness, PERIOD_AUTUMN, { starts_on: '2026-08-01', ends_on: '2027-02-01' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.period.starts_on, '2026-08-01');
  assert.equal(ok.body.period.ends_on, '2027-02-01');

  const reversed = await update(harnessFor(), PERIOD_AUTUMN, { starts_on: '2027-03-01', ends_on: '2027-02-01' });
  assert.equal(reversed.status, 400);
});

test('patch: archiving is a reversible flag, not a cancellation', async () => {
  const harness = harnessFor();
  const archived = await update(harness, PERIOD_AUTUMN, { is_archived: true });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.period.is_archived, true);
  // The row still exists with all its fields: nothing was deleted.
  assert.equal(harness.state.periods.filter(p => p.id === PERIOD_AUTUMN).length, 1);

  const restored = await update(harness, PERIOD_AUTUMN, { is_archived: false });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.period.is_archived, false);

  // The default view shows it again and the archived view does not.
  const defaultView = await getList(harness);
  assert.ok(namesOf(defaultView).includes('الفصل الخريفي'));
  const archivedView = await getList(harness, ownerToken(), { archived: 'true' });
  assert.ok(!namesOf(archivedView).includes('الفصل الخريفي'));
});

test('patch: an archived period is still editable — archive hides, it does not lock', async () => {
  const harness = harnessFor();
  const result = await update(harness, PERIOD_SUMMER, { name: 'الفصل الصيفي المعدّل' });
  assert.equal(result.status, 200);
  assert.equal(result.body.period.is_archived, true, 'the flag is preserved');
  assert.equal(result.body.period.name, 'الفصل الصيفي المعدّل');
});

test('patch: identical effective values are a no-op — no update, no audit, no commit', async () => {
  const harness = harnessFor();
  const result = await update(harness, PERIOD_AUTUMN, { name: 'الفصل الخريفي' });
  assert.equal(result.status, 200);
  assert.equal(result.body.period.name, 'الفصل الخريفي');
  assert.equal(harness.commitCount(), 0, 'nothing is committed');
  assert.equal(harness.auditRows.length, 0, 'nothing is audited');
  assert.ok(!harness.events.includes('update'), 'no UPDATE statement is issued');
  assert.equal(harness.rollbackCount(), 1, 'the transaction is closed, not committed');
});

test('patch: a whitespace variant of the same name is a no-op', async () => {
  const harness = harnessFor();
  const result = await update(harness, PERIOD_AUTUMN, { name: '  الفصل الخريفي  ' });
  assert.equal(result.status, 200);
  assert.equal(harness.commitCount(), 0);
  assert.ok(!harness.events.includes('update'));
});

test('patch: a no-op on an archived period does not toggle the flag', async () => {
  const harness = harnessFor();
  const result = await update(harness, PERIOD_SUMMER, { is_archived: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.period.is_archived, true);
  assert.equal(harness.commitCount(), 0);
});

test('patch: the audit event records the bounded old and new period values', async () => {
  const harness = harnessFor();
  await update(harness, PERIOD_AUTUMN, { name: 'الفصل الأول', is_archived: true });
  assert.equal(harness.auditRows.length, 1);
  const params = harness.auditRows[0].params;
  assert.equal(params[1], OWNER_A);
  assert.equal(params[2], TENANT_A);
  assert.equal(params[3], 'tenant.academic_period_updated');
  assert.equal(params[4], 'academic_period');
  assert.equal(params[5], PERIOD_AUTUMN);
  assert.deepEqual(JSON.parse(params[6]), {
    name: 'الفصل الخريفي', starts_on: '2026-09-01', ends_on: '2027-01-15', is_archived: false,
  });
  assert.deepEqual(JSON.parse(params[7]), {
    name: 'الفصل الأول', starts_on: '2026-09-01', ends_on: '2027-01-15', is_archived: true,
  });
});

test('patch: statement order is begin, owner, lock, update, audit, read-back, commit', async () => {
  const harness = harnessFor();
  await update(harness, PERIOD_AUTUMN, { name: 'الفصل الأول' });
  assert.deepEqual(harness.events, ['begin', 'owner', 'period_lock', 'update', 'audit', 'period_readback', 'commit', 'release']);
  assert.deepEqual(squashedCalls(harness), [
    squash(`SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active
       FROM tenants t JOIN users u ON u.id=? WHERE t.id=? FOR UPDATE`),
    squash(PERIOD_LOCK_SELECT),
    squash(UPDATE_SQL),
    squash(AUDIT_SQL),
    squash(PERIOD_READBACK_SELECT),
  ]);
});

test('patch: the row is locked for a write and never for a read', async () => {
  const readHarness = harnessFor();
  await getList(readHarness);
  assert.ok(!readHarness.events.includes('period_lock'), 'a list read takes no exclusive lock');

  const writeHarness = harnessFor();
  await update(writeHarness, PERIOD_AUTUMN, { name: 'x' });
  assert.ok(writeHarness.events.includes('period_lock'), 'a write locks the period row');
});

test('patch: a foreign period id is an identical 404 and writes nothing', async () => {
  const harness = harnessFor();
  // PERIOD_OTHER_TENANT belongs to TENANT_B, but OWNER_A selects TENANT_A.
  const result = await withSilencedErrors(() => update(harness, PERIOD_OTHER_TENANT, { name: 'اختراق' }));
  assert.equal(result.status, 404);
  assert.equal(result.body.error, 'Academic period not found');
  assert.equal(harness.commitCount(), 0);
  assert.equal(harness.auditRows.length, 0);
  assert.equal(harness.state.periods.find(p => p.id === PERIOD_OTHER_TENANT)!.name, 'فصل مساحة أخرى');
});

test('patch: an absent id is the same 404 as a foreign id', async () => {
  const harness = harnessFor();
  const absent = await withSilencedErrors(() => update(harness, '99999999-9999-4999-8999-999999999999', { name: 'x' }));
  const foreign = await withSilencedErrors(() => update(harnessFor(), PERIOD_OTHER_TENANT, { name: 'x' }));
  assert.equal(absent.status, 404);
  assert.equal(foreign.status, 404);
  assert.deepEqual(absent.body, foreign.body, 'a foreign id is indistinguishable from an absent one');
});

test('patch: an uppercase path id addresses the same canonical row', async () => {
  const harness = harnessFor();
  const upper = PERIOD_AUTUMN.toUpperCase();
  const result = await update(harness, upper, { name: 'الفصل الأول' });
  assert.equal(result.status, 200);
  assert.equal(result.body.period.id, PERIOD_AUTUMN, 'the stored canonical id is returned');
});

test('patch: a non-UUID id is a 400 before any connection', async () => {
  const harness = harnessFor();
  for (const id of ['abc', '11111111-1111-1111-1111', '11111111-1111-4111-8111-11111111111z', 'not-a-uuid']) {
    const result = await update(harness, id, { name: 'x' });
    assert.equal(result.status, 400, `id=${JSON.stringify(id)} must be rejected`);
    assert.equal(result.body.error, 'Invalid academic period id');
  }
  assert.equal(harness.connectionCount(), 0);
});

test('patch: an empty path segment does not reach any handler at all', async () => {
  const harness = harnessFor();
  // `/academic-periods/` has no `:id` segment, so the router matches nothing:
  // the request is not answered by this module and no statement is issued.
  const result = await runChain(harness.chain, makeReq({
    token: ownerToken(),
    method: 'PATCH',
    pathName: '/academic-periods/',
    body: { name: 'x' },
  }));
  assert.equal(result.handlerReached, false);
  assert.equal(harness.connectionCount(), 0);
});

test('patch: an empty body is rejected before any connection', async () => {
  const harness = harnessFor();
  const result = await update(harness, PERIOD_AUTUMN, {});
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Invalid academic period update payload');
  assert.equal(harness.connectionCount(), 0);
});

test('patch: an unknown or selector key is rejected', async () => {
  const harness = harnessFor();
  for (const extra of [
    { status: 'active' }, { id: PERIOD_SPRING }, { tenant_id: TENANT_B },
    { enrollment_id: 'e-1' }, { price: '1' }, { deleted: true },
  ]) {
    const result = await update(harness, PERIOD_AUTUMN, { name: 'x', ...extra });
    assert.equal(result.status, 400, `${JSON.stringify(extra)} must be rejected`);
  }
  assert.equal(harness.connectionCount(), 0);
});

test('patch: is_archived must be an actual boolean', async () => {
  const harness = harnessFor();
  for (const value of ['true', 1, 0, null, 'false']) {
    const result = await update(harness, PERIOD_AUTUMN, { is_archived: value });
    assert.equal(result.status, 400, `is_archived=${JSON.stringify(value)} must be rejected`);
  }
  assert.equal(harness.connectionCount(), 0);
});

test('patch: a non-object body is rejected', async () => {
  const harness = harnessFor();
  for (const body of [null, 'name', 42, ['x'], true]) {
    const result = await update(harness, PERIOD_AUTUMN, body);
    assert.equal(result.status, 400, `body=${JSON.stringify(body)} must be rejected`);
  }
});

test('patch: no hard delete path exists', async () => {
  const harness = harnessFor();
  // There is no DELETE route and no `deleted` field, so a delete attempt is a
  // rejected payload or an unrouted method — never a removal.
  const result = await runChain(harness.chain, makeReq({
    token: ownerToken(),
    method: 'DELETE',
    pathName: `/academic-periods/${PERIOD_AUTUMN}`,
  }));
  assert.equal(result.handlerReached, false, 'no handler answers a DELETE');
  assert.equal(harness.state.periods.filter(p => p.id === PERIOD_AUTUMN).length, 1);
});

// ===========================================================================
// Read-back and DTO materialization
// ===========================================================================

test('dto: an unreadable stored instant fails the page instead of fabricating one', async () => {
  for (const variant of ['null', 'zero', 'nan', 'text', 'missing'] as const) {
    const harness = harnessFor();
    harness.state.malformedEpoch = variant;
    const result = await withSilencedErrors(() => getList(harness));
    assert.equal(result.status, 500, `epoch=${variant} must fail the request`);
    assert.equal(result.body.error, 'Failed to list academic periods');
    assert.equal(result.body.periods, undefined, 'no partial page is served');
  }
});

test('dto: a stored impossible date fails the request instead of being normalized', async () => {
  const harness = harnessFor();
  harness.state.malformedDate = 'impossible';
  const result = await withSilencedErrors(() => getList(harness));
  assert.equal(result.status, 500);
  assert.equal(result.body.periods, undefined);
});

test('dto: a driver Date where a date string is promised is refused', async () => {
  const harness = harnessFor();
  harness.state.malformedDate = 'shifted-object';
  const result = await withSilencedErrors(() => getList(harness));
  assert.equal(result.status, 500);
  assert.equal(result.body.periods, undefined);
});

test('dto: a stored reversed range is refused, never served', async () => {
  const harness = harnessFor();
  harness.state.malformedDate = 'reversed';
  const result = await withSilencedErrors(() => getList(harness));
  assert.equal(result.status, 500);
});

test('dto: a missing date projection is refused', async () => {
  const harness = harnessFor();
  harness.state.malformedDate = 'missing';
  const result = await withSilencedErrors(() => getList(harness));
  assert.equal(result.status, 500);
});

test('dto: the serialized instants are not shifted by the driver timezone offset', async () => {
  const harness = harnessFor();
  const result = await getList(harness);
  const autumn = result.body.periods.find((period: any) => period.id === PERIOD_AUTUMN);
  // The stored instant is 2026-10-21T08:00:00Z. The installed driver, with
  // timezone '+02:00', would have decoded the raw column as 06:00Z.
  assert.equal(autumn.created_at, '2026-10-21T08:00:00.000Z');
  assert.equal(autumn.updated_at, '2026-10-21T08:00:00.000Z');
  assert.notEqual(autumn.created_at, '2026-10-21T06:00:00.000Z');
});

// ===========================================================================
// The stored name is canonical or the row is refused
// ===========================================================================

test('dto: a stored name that is not canonical fails the page instead of being emitted', async () => {
  for (const stored of ['  October  ', ' October', 'October ', '\tOctober\n', '\u00a0October\u00a0', '\r\nOctober']) {
    const harness = harnessFor();
    const row = harness.state.periods.find((period) => period.id === PERIOD_AUTUMN);
    assert.ok(row, 'the fixture owns the autumn period');
    row.name = stored;
    const result = await withSilencedErrors(() => getList(harness));
    assert.equal(result.status, 500, `stored=${JSON.stringify(stored)} must fail the request`);
    assert.equal(result.body.error, 'Failed to list academic periods');
    assert.equal(result.body.periods, undefined, 'no partial page is served');
    assert.equal(
      JSON.stringify(result.body).includes('October'),
      false,
      `stored=${JSON.stringify(stored)} is never emitted, raw or normalized`,
    );
  }
});

test('dto: a canonical stored name is served verbatim', async () => {
  const harness = harnessFor();
  const row = harness.state.periods.find((period) => period.id === PERIOD_AUTUMN);
  assert.ok(row, 'the fixture owns the autumn period');
  row.name = 'October';
  const result = await getList(harness);
  assert.equal(result.status, 200);
  const served = result.body.periods.find((period: any) => period.id === PERIOD_AUTUMN);
  assert.equal(served.name, 'October');
  assertPeriodDto(served);
});

test('create: a request name is trimmed and the canonical stored name is confirmed', async () => {
  const harness = harnessFor();
  const result = await create(harness, { name: '  October  ', starts_on: '2027-01-20', ends_on: '2027-01-30' });
  assert.equal(result.status, 201);
  assert.equal(result.body.period.name, 'October', 'the write path still trims the request');
  const stored = harness.state.periods.find((period) => period.id === result.body.period.id);
  assert.ok(stored, 'the created row exists');
  assert.equal(stored.name, 'October', 'what is stored is already canonical');
});

test('patch: a non-canonical stored row is refused and nothing is written', async () => {
  const harness = harnessFor();
  const row = harness.state.periods.find((period) => period.id === PERIOD_AUTUMN);
  assert.ok(row, 'the fixture owns the autumn period');
  row.name = '  October  ';
  const result = await withSilencedErrors(() => update(harness, PERIOD_AUTUMN, { name: 'Fixed' }));
  assert.equal(result.status, 500, 'the unreadable stored projection fails the write');
  assert.equal(result.body.period, undefined, 'no period is confirmed from an unreadable row');
  assert.equal(harness.commitCount(), 0, 'nothing is committed');
  assert.equal(squashedCalls(harness).includes(UPDATE_SQL), false, 'no UPDATE is issued');
  assert.equal(harness.auditRows.length, 0, 'no audit event is written');
  assert.equal(
    harness.state.periods.find((period) => period.id === PERIOD_AUTUMN)?.name,
    '  October  ',
    'the stored row is left exactly as it was',
  );
});

// ===========================================================================
// Missing schema is never a fabricated success
// ===========================================================================

test('schema: a missing table is a 500 on the list, never an empty success', async () => {
  const harness = harnessFor();
  harness.state.missingSchema = true;
  const result = await withSilencedErrors(() => getList(harness));
  assert.equal(result.status, 500);
  assert.equal(result.body.periods, undefined, 'an empty catalog is NEVER fabricated');
  assert.equal(result.body.error, 'Failed to list academic periods');
});

test('schema: a missing table is a 500 on create and writes nothing', async () => {
  const harness = harnessFor();
  harness.state.missingSchema = true;
  const result = await withSilencedErrors(() => create(harness, { name: 'فصل', starts_on: '2026-09-01', ends_on: '2027-01-15' }));
  assert.equal(result.status, 500);
  assert.equal(result.body.period, undefined);
  assert.equal(harness.commitCount(), 0);
});

test('schema: a missing table is a 500 on update', async () => {
  const harness = harnessFor();
  harness.state.missingSchema = true;
  const result = await withSilencedErrors(() => update(harness, PERIOD_AUTUMN, { name: 'x' }));
  assert.equal(result.status, 500);
  assert.equal(result.body.period, undefined);
});

// ===========================================================================
// Isolation of the accepted neighbours
// ===========================================================================

test('isolation: the accepted branding mount still answers under the same router', async () => {
  const harness = harnessFor();
  // The branding route is mounted on the same tenant-self router and must be
  // unaffected by the academic-period mount.
  const result = await runChain(harness.chain, makeReq({ token: ownerToken(), method: 'GET', pathName: '/branding' }));
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['branding']);
  assert.equal(result.body.periods, undefined, 'the branding envelope never carries periods');
});

test('isolation: the academic-period mount never answers a branding path', async () => {
  const harness = harnessFor();
  const result = await runChain(harness.chain, makeReq({ token: ownerToken(), method: 'GET', pathName: '/academic-periods' }));
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['pagination', 'periods']);
  assert.equal(result.body.branding, undefined);
});
