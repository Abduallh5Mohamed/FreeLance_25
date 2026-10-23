/**
 * M2-B06 — private tenant branding (hermetic, behavioral).
 *
 * Contract under test: `GET`/`PATCH /api/tenants/me/branding` read and update
 * the presentation metadata of the tenant the SERVER selected, and only for
 * the VERIFIED owner of that tenant (`tenants.owner_user_id` = caller, tenant
 * active, caller active). Branding is metadata only: it renames nothing, and it
 * grants or revokes no access, pricing, billing or student entitlement.
 *
 * Composition under test is the real production order (src/index.ts): the real
 * optional-auth middleware, the real tenant-authority and student-workspace
 * boundaries, then the real `createTenantSelfRouter` with the real branding
 * router mounted under `/branding`. Only leaf data repositories and the
 * transactional connection are injected fixtures. No express listener, socket,
 * fetch, DB, provider or app startup.
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
  BILLING_ONLY,
  BRANDING_DTO_KEYS,
  BRANDING_LOCK_SELECT,
  BRANDING_SELECT,
  INSTRUCTOR_A,
  INSERT_SQL,
  MULTI,
  NO_SCOPE,
  OWNER_A,
  OWNER_B,
  ROLE_OWNER_MEMBER,
  STUDENT,
  TENANT_A,
  TENANT_B,
  TENANT_INACTIVE,
  TEST_SECRET,
  UPDATE_SQL,
  assertBrandingDto,
  buildHarness,
  createIsolation,
  getReq,
  loadAppModules,
  makeReq,
  makeState,
  ownerBToken,
  ownerToken,
  patchReq,
  runChain,
  sign,
  squash,
  squashedCalls,
  withSilencedErrors,
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

const harnessFor = () => buildHarness(makeState(), modules);
const get = (harness: ReturnType<typeof harnessFor>, token: string | null = ownerToken(), query: any = {}) =>
  runChain(harness.chain, getReq(token, query));
const patch = (harness: ReturnType<typeof harnessFor>, body: any, token: string | null = ownerToken()) =>
  runChain(harness.chain, patchReq(body, token));

// ===========================================================================
// Import isolation — positive evidence
// ===========================================================================

test('import isolation: forbidden module bodies never evaluate, no dummy env, hook restored', () => {
  assert.equal(process.env.MINIO_ACCESS_KEY, undefined);
  assert.equal(process.env.MINIO_SECRET_KEY, undefined);

  const intercepted = isolation.interceptedIds();
  assert.equal(intercepted.length, 4, 'db, minio, renewal and dotenv are all registered as sentinels');

  // The three modules the mounted router actually requires were INTERCEPTED
  // before their bodies evaluated, so no pool, no MinIO client and no renewal
  // executor was ever constructed.
  const requested = intercepted.filter(id => isolation.interceptionLog.includes(id));
  assert.equal(requested.length, 3, `db, minio and renewal must be intercepted (recorded: ${JSON.stringify(isolation.interceptionLog)})`);
  assert.ok(requested.some(id => /[\\/]src[\\/]db\.ts$/.test(id)), 'src/db is intercepted');
  assert.ok(requested.some(id => /[\\/]src[\\/]services[\\/]minio\.ts$/.test(id)), 'src/services/minio is intercepted');
  assert.ok(requested.some(id => /[\\/]src[\\/]services[\\/]subscription-renewal\.ts$/.test(id)), 'src/services/subscription-renewal is intercepted');

  // `dotenv` is registered as a sentinel but was never REQUESTED at all: the
  // branding router and its composition import no environment loader, so the
  // strongest possible isolation holds for it (the body cannot run because
  // nothing asks for it).
  const neverRequested = intercepted.filter(id => !isolation.interceptionLog.includes(id));
  assert.equal(neverRequested.length, 1);
  assert.match(neverRequested[0], /dotenv/, 'the only never-requested sentinel is dotenv');

  // No intercepted module is ever evaluated or cached: its body must not run.
  for (const id of intercepted) {
    assert.equal(
      (require as any).cache[id],
      undefined,
      `${id} must never be evaluated or cached: its body must not run`,
    );
  }
  assert.equal(isolation.hookRestored(), true);
});

// ===========================================================================
// Authority — the verified owner of the SELECTED tenant only
// ===========================================================================

test('auth: GET without a token is refused by the real authentication middleware', async () => {
  const harness = harnessFor();
  const result = await get(harness, null);
  assert.equal(result.status, 401);
  assert.equal(result.body?.branding, undefined);
  assert.equal(harness.connectionCount(), 0, 'no connection is acquired for an unauthenticated request');
});

test('auth: the verified owner reads the selected tenant branding', async () => {
  const harness = harnessFor();
  const result = await get(harness);
  assert.equal(result.status, 200);
  assertBrandingDto(result.body.branding);
  assert.equal(result.body.branding.display_name_ar, 'أكاديمية أ');
  assert.equal(result.body.branding.display_name_en, 'Academy A');
  assert.equal(result.body.branding.accent_color, '#1D4ED8');
  assert.equal(harness.connectionCount(), 1);
});

test('auth: a membership instructor is denied and the config row is never read', async () => {
  const harness = harnessFor();
  const result = await withSilencedErrors(() => get(harness, sign(INSTRUCTOR_A, 'instructor')));
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'Forbidden');
  // The owner is verified BEFORE the config lookup, so a non-owner learns
  // nothing about whether a branding row exists.
  assert.ok(!harness.events.includes('branding_select'), 'no config read for a non-owner');
  assert.ok(!harness.events.includes('branding_lock'), 'no config lock for a non-owner');
});

test('auth: a membership owner ROLE LABEL is denied — a label is not authority', async () => {
  const harness = harnessFor();
  const result = await withSilencedErrors(() => get(harness, sign(ROLE_OWNER_MEMBER, 'instructor')));
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'Forbidden');
  assert.equal(result.body.branding, undefined);
});

test('auth: a global admin with no membership has no workspace', async () => {
  const harness = harnessFor();
  const result = await withSilencedErrors(() => get(harness, sign(ADMIN, 'admin')));
  assert.equal(result.status, 404);
  assert.equal(result.body.error, 'Tenant membership not found');
  assert.equal(harness.connectionCount(), 0, 'a principal without a workspace takes no connection');
});

test('auth: a principal with no active membership has no workspace', async () => {
  const harness = harnessFor();
  const result = await withSilencedErrors(() => get(harness, sign(NO_SCOPE, 'instructor')));
  assert.equal(result.status, 404);
  assert.equal(result.body.error, 'Tenant membership not found');
});

test('auth: a student is refused by the real student-workspace boundary', async () => {
  const harness = harnessFor();
  const result = await get(harness, sign(STUDENT, 'student'));
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'Select an instructor workspace first');
  assert.equal(harness.connectionCount(), 0);
});

test('auth: a token selecting a foreign or inactive workspace resolves no scope', async () => {
  const harness = harnessFor();
  // OWNER_A owns TENANT_INACTIVE but holds no active membership there, so the
  // selector resolves no scope and the handler never reaches a connection.
  const result = await withSilencedErrors(() =>
    get(harness, sign(OWNER_A, 'instructor', { tenant_id: TENANT_INACTIVE })),
  );
  assert.notEqual(result.status, 200);
  assert.equal(result.body?.branding, undefined);
  assert.equal(harness.connectionCount(), 0);
});

test('auth: a multi-workspace owner reads only the SELECTED tenant branding', async () => {
  const harnessA = harnessFor();
  const selectedA = await withSilencedErrors(() =>
    get(harnessA, sign(MULTI, 'instructor', { tenant_id: TENANT_A })),
  );
  // MULTI is only a membership instructor of TENANT_A, never its owner.
  assert.equal(selectedA.status, 403);

  const harnessB = harnessFor();
  const selectedB = await withSilencedErrors(() =>
    get(harnessB, sign(MULTI, 'instructor', { tenant_id: TENANT_B })),
  );
  assert.equal(selectedB.status, 403);
  assert.equal(selectedB.body?.branding, undefined);
});

// ===========================================================================
// No client selector — the real authority boundary enforces it
// ===========================================================================

test('selector: a body tenant_id is rejected by the real authority boundary', async () => {
  const harness = harnessFor();
  const result = await patch(harness, { display_name_en: 'Academy', tenant_id: TENANT_B });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Tenant context must not be supplied by the client');
  assert.equal(harness.connectionCount(), 0);
});

test('selector: an x-tenant-id header is rejected by the real authority boundary', async () => {
  const harness = harnessFor();
  const result = await runChain(harness.chain, makeReq({
    token: ownerToken(),
    method: 'GET',
    pathName: '/branding',
    headers: { 'x-tenant-id': TENANT_B },
  }));
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Tenant context is resolved from the authenticated membership');
  assert.equal(harness.connectionCount(), 0);
});

test('selector: a query tenant_id is rejected by the real authority boundary', async () => {
  const harness = harnessFor();
  const result = await get(harness, ownerToken(), { tenant_id: TENANT_B });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Tenant context must not be supplied by the client');
  assert.equal(harness.connectionCount(), 0);
});

// ===========================================================================
// Billing-only refusal — before acquisition
// ===========================================================================

test('billing: a billing-only principal is refused before any connection is acquired', async () => {
  const harness = harnessFor();
  const read = await get(harness, sign(BILLING_ONLY, 'instructor'));
  assert.equal(read.status, 403);
  assert.equal(read.body.code, 'BILLING_ONLY');
  assert.equal(
    read.body.error,
    'Branding management is not available while the account is limited to billing and support',
  );

  const write = await patch(harness, { display_name_en: 'Academy' }, sign(BILLING_ONLY, 'instructor'));
  assert.equal(write.status, 403);
  assert.equal(write.body.code, 'BILLING_ONLY');

  assert.equal(harness.connectionCount(), 0, 'the local refusal happens BEFORE acquisition');
  assert.equal(harness.calls.length, 0);
});

// ===========================================================================
// Canonical contract
// ===========================================================================

test('contract: the envelope is exactly { branding } with exactly four fields', async () => {
  const harness = harnessFor();
  const result = await get(harness);
  assert.deepEqual(Object.keys(result.body), ['branding']);
  assert.deepEqual(Object.keys(result.body.branding).sort(), BRANDING_DTO_KEYS);
});

test('contract: no tenant_id, created_at, owner or business identity field is exposed', async () => {
  const harness = harnessFor();
  const result = await get(harness);
  const dto = result.body.branding as Record<string, unknown>;
  for (const forbidden of ['tenant_id', 'created_at', 'owner_user_id', 'business_name', 'id', 'status', 'subject_type']) {
    assert.equal(dto[forbidden], undefined, `${forbidden} must never be exposed`);
  }
});

test('contract: Cache-Control no-store is set on the 200', async () => {
  const harness = harnessFor();
  const result = await get(harness);
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('contract: Cache-Control no-store is set on the owner denial', async () => {
  const harness = harnessFor();
  const result = await withSilencedErrors(() => get(harness, sign(INSTRUCTOR_A, 'instructor')));
  assert.equal(result.status, 403);
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('contract: Cache-Control no-store is set on the billing-only denial', async () => {
  const harness = harnessFor();
  const result = await get(harness, sign(BILLING_ONLY, 'instructor'));
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('contract: an absent config row answers the all-null DTO with a null updated_at', async () => {
  const harness = harnessFor();
  const result = await withSilencedErrors(() => get(harness, ownerBToken()));
  assert.equal(result.status, 200);
  assertBrandingDto(result.body.branding);
  assert.deepEqual(result.body.branding, {
    display_name_ar: null,
    display_name_en: null,
    accent_color: null,
    updated_at: null,
  });
});

test('contract: a stored row answers a canonical ISO instant from the epoch projection', async () => {
  const harness = harnessFor();
  const result = await get(harness);
  assert.equal(result.body.branding.updated_at, '2026-10-21T08:00:00.000Z');
});

test('contract: the serialized instant is not shifted by the driver timezone offset', async () => {
  const harness = harnessFor();
  const result = await get(harness);
  // The fixture also returns the raw datetime column decoded with the pool's
  // `timezone: '+02:00'` interpretation (06:00Z). A handler that serialized
  // that column instead of the epoch projection would answer the shifted value.
  assert.notEqual(result.body.branding.updated_at, '2026-10-21T06:00:00.000Z');
  assert.equal(result.body.branding.updated_at, '2026-10-21T08:00:00.000Z');
});

test('contract: a read never commits and never writes an audit event', async () => {
  const harness = harnessFor();
  const result = await get(harness);
  assert.equal(result.status, 200);
  assert.equal(harness.commitCount(), 0);
  assert.equal(harness.auditRows.length, 0);
  assert.ok(harness.events.includes('rollback'), 'a read transaction is closed by rollback');
  assert.equal(harness.releaseCount(), 1);
  assert.equal(harness.destroyCount(), 0);
});

// ===========================================================================
// PATCH — write, canonicalize, audit
// ===========================================================================

test('patch: a label-only update writes the row and audits exactly one bounded event', async () => {
  const harness = harnessFor();
  const result = await patch(harness, { display_name_en: 'Academy A Plus' });
  assert.equal(result.status, 200);
  assertBrandingDto(result.body.branding);
  assert.equal(result.body.branding.display_name_en, 'Academy A Plus');
  // Unmentioned fields keep their current value.
  assert.equal(result.body.branding.display_name_ar, 'أكاديمية أ');
  assert.equal(result.body.branding.accent_color, '#1D4ED8');
  assert.equal(harness.auditRows.length, 1, 'exactly one audit event');
  assert.equal(harness.commitCount(), 1);
  assert.equal(harness.state.branding[TENANT_A].display_name_en, 'Academy A Plus');
});

test('patch: an accent color is canonicalized to UPPERCASE', async () => {
  const harness = harnessFor();
  const result = await patch(harness, { accent_color: '#a1b2c3' });
  assert.equal(result.status, 200);
  assert.equal(result.body.branding.accent_color, '#A1B2C3');
  assert.equal(harness.state.branding[TENANT_A].accent_color, '#A1B2C3', 'the stored value is canonical');
});

test('patch: a label is trimmed before it is stored', async () => {
  const harness = harnessFor();
  const result = await patch(harness, { display_name_ar: '   أكاديمية أ   ' });
  assert.equal(result.status, 200);
  assert.equal(result.body.branding.display_name_ar, 'أكاديمية أ');
  assert.equal(harness.state.branding[TENANT_A].display_name_ar, 'أكاديمية أ');
});

test('patch: null is stored as inherit, never as an empty string', async () => {
  const harness = harnessFor();
  const result = await patch(harness, { display_name_ar: null, accent_color: null });
  assert.equal(result.status, 200);
  assert.equal(result.body.branding.display_name_ar, null);
  assert.equal(result.body.branding.accent_color, null);
  assert.equal(harness.state.branding[TENANT_A].display_name_ar, null);
  assert.equal(harness.state.branding[TENANT_A].accent_color, null);
  assert.notEqual(harness.state.branding[TENANT_A].display_name_ar, '');
});

test('patch: the audit event records the bounded old and new branding values', async () => {
  const harness = harnessFor();
  await patch(harness, { display_name_en: 'Renamed Academy', accent_color: '#00AA11' });
  assert.equal(harness.auditRows.length, 1);
  const params = harness.auditRows[0].params;
  assert.equal(params[1], OWNER_A, 'actor is the verified owner');
  assert.equal(params[2], TENANT_A, 'audit is tenant-scoped');
  assert.equal(params[3], 'tenant.branding_updated');
  assert.equal(params[4], 'tenant_branding');
  assert.equal(params[5], TENANT_A);
  assert.deepEqual(JSON.parse(params[6]), {
    display_name_ar: 'أكاديمية أ',
    display_name_en: 'Academy A',
    accent_color: '#1D4ED8',
  });
  assert.deepEqual(JSON.parse(params[7]), {
    display_name_ar: 'أكاديمية أ',
    display_name_en: 'Renamed Academy',
    accent_color: '#00AA11',
  });
  // The audit payload carries the three branding fields only.
  const auditJson = `${params[6]}${params[7]}`;
  for (const forbidden of ['password', 'token', 'student', 'amount', 'price', 'owner_user_id', 'business_name']) {
    assert.ok(!auditJson.includes(forbidden), `the audit payload must not carry ${forbidden}`);
  }
});

// ===========================================================================
// No-op semantics
// ===========================================================================

test('no-op: identical effective values write, audit and commit nothing', async () => {
  const harness = harnessFor();
  const result = await patch(harness, {
    display_name_ar: 'أكاديمية أ',
    display_name_en: 'Academy A',
    accent_color: '#1D4ED8',
  });
  assert.equal(result.status, 200);
  assertBrandingDto(result.body.branding);
  assert.equal(result.body.branding.display_name_en, 'Academy A');
  assert.equal(harness.auditRows.length, 0, 'a no-op audits nothing');
  assert.equal(harness.commitCount(), 0, 'a no-op commits nothing');
  assert.ok(!harness.events.includes('update'), 'a no-op issues no UPDATE');
  assert.ok(!harness.events.includes('insert'), 'a no-op issues no INSERT');
});

test('no-op: a whitespace variant of the same label is a no-op', async () => {
  const harness = harnessFor();
  const result = await patch(harness, { display_name_en: '  Academy A  ' });
  assert.equal(result.status, 200);
  assert.equal(result.body.branding.display_name_en, 'Academy A');
  assert.equal(harness.auditRows.length, 0);
  assert.equal(harness.commitCount(), 0);
});

test('no-op: an absent row plus an all-null request stays absent', async () => {
  const harness = harnessFor();
  const result = await withSilencedErrors(() =>
    patch(harness, { display_name_ar: null, display_name_en: null, accent_color: null }, ownerBToken()),
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.branding, {
    display_name_ar: null,
    display_name_en: null,
    accent_color: null,
    updated_at: null,
  });
  assert.equal(harness.state.branding[TENANT_B], undefined, 'the row stays absent');
  assert.equal(harness.auditRows.length, 0);
  assert.equal(harness.commitCount(), 0);
});

test('no-op: a null for an already-null field on an absent row stays absent', async () => {
  const harness = harnessFor();
  const result = await withSilencedErrors(() => patch(harness, { accent_color: null }, ownerBToken()));
  assert.equal(result.status, 200);
  assert.equal(result.body.branding.updated_at, null);
  assert.equal(harness.state.branding[TENANT_B], undefined);
  assert.equal(harness.auditRows.length, 0);
});

// ===========================================================================
// First insert
// ===========================================================================

test('insert: an absent row plus a change inserts the complete effective row', async () => {
  const harness = harnessFor();
  const result = await withSilencedErrors(() =>
    patch(harness, { display_name_en: 'Academy B' }, ownerBToken()),
  );
  assert.equal(result.status, 200);
  assertBrandingDto(result.body.branding);
  assert.equal(result.body.branding.display_name_en, 'Academy B');
  assert.equal(result.body.branding.updated_at, '2026-10-21T09:00:00.000Z');
  assert.ok(harness.events.includes('insert'), 'a first save inserts');
  assert.ok(!harness.events.includes('update'), 'a first save never updates');
  assert.equal(harness.auditRows.length, 1);
  assert.equal(harness.commitCount(), 1);
});

test('insert: an absent row keeps the unmentioned fields null', async () => {
  const harness = harnessFor();
  await withSilencedErrors(() => patch(harness, { accent_color: '#123456' }, ownerBToken()));
  const stored = harness.state.branding[TENANT_B];
  assert.ok(stored, 'the row exists after the first save');
  assert.equal(stored.display_name_ar, null);
  assert.equal(stored.display_name_en, null);
  assert.equal(stored.accent_color, '#123456');
});

test('insert: the audit event of a first save records null as the old state', async () => {
  const harness = harnessFor();
  await withSilencedErrors(() => patch(harness, { display_name_en: 'Academy B' }, ownerBToken()));
  const params = harness.auditRows[0].params;
  assert.equal(params[1], OWNER_B);
  assert.equal(params[2], TENANT_B);
  assert.deepEqual(JSON.parse(params[6]), {
    display_name_ar: null,
    display_name_en: null,
    accent_color: null,
  });
  assert.deepEqual(JSON.parse(params[7]), {
    display_name_ar: null,
    display_name_en: 'Academy B',
    accent_color: null,
  });
});

// ===========================================================================
// Strict payload
// ===========================================================================

test('payload: an empty object is rejected before any connection', async () => {
  const harness = harnessFor();
  const result = await patch(harness, {});
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Invalid branding payload');
  assert.equal(harness.connectionCount(), 0);
});

test('payload: an unknown field is rejected', async () => {
  const harness = harnessFor();
  const result = await patch(harness, { display_name_en: 'Academy', logo_url: 'https://x/y.png' });
  assert.equal(result.status, 400);
  assert.equal(harness.connectionCount(), 0);
});

test('payload: a theme, locale, host or identity selector is rejected', async () => {
  const cases: any[] = [
    { theme: 'dark' },
    { locale: 'en' },
    { subdomain: 'acme' },
    { business_name: 'Renamed' },
    { owner_user_id: OWNER_B },
    { display_name_ar: 'أ', accent_color: '#FFFFFF', status: 'active' },
  ];
  for (const body of cases) {
    const harness = harnessFor();
    const result = await patch(harness, body);
    assert.equal(result.status, 400, `rejected: ${JSON.stringify(body)}`);
    assert.equal(harness.connectionCount(), 0);
  }
});

test('payload: an empty or whitespace-only label is rejected', async () => {
  for (const value of ['', '   ', '\t\n']) {
    const harness = harnessFor();
    const result = await patch(harness, { display_name_en: value });
    assert.equal(result.status, 400, `rejected: ${JSON.stringify(value)}`);
    assert.equal(harness.connectionCount(), 0);
  }
});

test('payload: a label over 255 characters is rejected', async () => {
  const harness = harnessFor();
  const result = await patch(harness, { display_name_en: 'a'.repeat(256) });
  assert.equal(result.status, 400);
  assert.equal(harness.connectionCount(), 0);
});

test('payload: a non-string label is rejected — never coerced', async () => {
  for (const value of [42, true, ['a'], { text: 'a' }]) {
    const harness = harnessFor();
    const result = await patch(harness, { display_name_en: value });
    assert.equal(result.status, 400, `rejected: ${JSON.stringify(value)}`);
    assert.equal(harness.connectionCount(), 0);
  }
});

test('payload: a non-canonical hex color is rejected', async () => {
  for (const value of ['#abc', '#AABBCCDD', 'AABBCC', '#GGGGGG', '#12345', '#1234567', '']) {
    const harness = harnessFor();
    const result = await patch(harness, { accent_color: value });
    assert.equal(result.status, 400, `rejected: ${JSON.stringify(value)}`);
    assert.equal(harness.connectionCount(), 0);
  }
});

test('payload: a named, rgb() or URL color is rejected', async () => {
  for (const value of ['red', 'rgb(1,2,3)', 'url(#x)', 'javascript:alert(1)', 'https://x/y.png']) {
    const harness = harnessFor();
    const result = await patch(harness, { accent_color: value });
    assert.equal(result.status, 400, `rejected: ${JSON.stringify(value)}`);
    assert.equal(harness.connectionCount(), 0);
  }
});

test('payload: a non-object body is rejected', async () => {
  for (const body of [[], 'text', 7, true]) {
    const harness = harnessFor();
    const result = await patch(harness, body);
    assert.equal(result.status, 400, `rejected: ${JSON.stringify(body)}`);
    assert.equal(harness.connectionCount(), 0);
  }
});

test('payload: a 255-character label is accepted', async () => {
  const harness = harnessFor();
  const label = 'a'.repeat(255);
  const result = await patch(harness, { display_name_en: label });
  assert.equal(result.status, 200);
  assert.equal(result.body.branding.display_name_en, label);
});

test('payload: a Unicode label is accepted verbatim, with no script guessing', async () => {
  const harness = harnessFor();
  // Latin text in the Arabic slot and Arabic text in the English slot: the
  // columns are two label slots, not a language policy.
  const result = await patch(harness, {
    display_name_ar: 'Cairo Academy',
    display_name_en: 'أكاديمية القاهرة',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.branding.display_name_ar, 'Cairo Academy');
  assert.equal(result.body.branding.display_name_en, 'أكاديمية القاهرة');
});

// ===========================================================================
// Statement order and locking
// ===========================================================================

test('order: the owner is verified before the config row is read', async () => {
  const harness = harnessFor();
  await get(harness);
  assert.deepEqual(harness.events, ['begin', 'owner', 'branding_select', 'rollback', 'release']);
});

test('order: the config row is locked for a write and never for a read', async () => {
  const readHarness = harnessFor();
  await get(readHarness);
  assert.ok(readHarness.events.includes('branding_select'), 'a read uses the plain snapshot select');
  assert.ok(!readHarness.events.includes('branding_lock'), 'a read takes no exclusive lock');
  const readStatements = squashedCalls(readHarness);
  assert.ok(readStatements.includes(squash(BRANDING_SELECT)), 'the read statement is the documented snapshot select');
  assert.ok(!readStatements.includes(squash(BRANDING_LOCK_SELECT)), 'a read never issues the locking select');

  const writeHarness = harnessFor();
  await patch(writeHarness, { display_name_en: 'Locked' });
  assert.ok(writeHarness.events.includes('branding_lock'), 'a write locks the config row');
  assert.ok(squashedCalls(writeHarness).includes(squash(BRANDING_LOCK_SELECT)), 'the write locks the existing row');
});

test('order: exactly one audit event follows the write and precedes the read-back', async () => {
  const harness = harnessFor();
  await patch(harness, { display_name_en: 'Ordered' });
  const events = harness.events;
  const updateAt = events.indexOf('update');
  const auditAt = events.indexOf('audit');
  const readBackAt = events.lastIndexOf('branding_select');
  assert.ok(updateAt >= 0, 'the UPDATE runs');
  assert.ok(auditAt > updateAt, 'the audit event follows the write');
  assert.ok(readBackAt > auditAt, 'the read-back follows the audit event');
  assert.equal(events.filter(event => event === 'audit').length, 1, 'exactly one audit event');
  assert.equal(events.filter(event => event === 'commit').length, 1, 'exactly one commit');
});

test('order: the DTO is materialized before the single commit', async () => {
  const harness = harnessFor();
  const result = await patch(harness, { accent_color: '#FFAA00' });
  assert.equal(result.status, 200);
  // The response instant comes from the row read back INSIDE the transaction,
  // not from the pre-write state.
  assert.equal(result.body.branding.updated_at, '2026-10-21T10:00:00.000Z');
  const events = harness.events;
  assert.ok(events.lastIndexOf('branding_select') < events.indexOf('commit'));
});

test('order: the branding statements are the documented ones', async () => {
  const harness = harnessFor();
  await patch(harness, { display_name_en: 'Documented' });
  const statements = squashedCalls(harness);
  assert.ok(statements.includes(squash(INSERT_SQL)) === false, 'no insert on an existing row');
  assert.ok(statements.includes(squash(UPDATE_SQL)), 'the update statement is the documented one');
});
