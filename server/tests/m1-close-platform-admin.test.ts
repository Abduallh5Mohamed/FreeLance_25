import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import test, { before } from 'node:test';
import type { RequestHandler, Response, Router } from 'express';
import type { AuthRequest } from '../src/middleware/auth';
import type {
  PlatformTenantsConnection,
  PlatformTenantsDataAccess,
  PlatformTenantsDeps,
} from '../src/routes/platform-tenants';
import type { TenantSelfDataAccess, TenantSelfDeps } from '../src/routes/tenant-self';
import type { AdminApprovalsDataAccess } from '../src/routes/admin-approvals';

const require = createRequire(import.meta.url);
let createPlatformTenantsRouter!: typeof import('../src/routes/platform-tenants').createPlatformTenantsRouter;
let createTenantSelfRouter!: typeof import('../src/routes/tenant-self').createTenantSelfRouter;
let createAdminApprovalsRouter!: typeof import('../src/routes/admin-approvals').createAdminApprovalsRouter;
let escapeCsvCell!: typeof import('../src/routes/admin-insights').escapeCsvCell;
let adminInsightsRouter!: typeof import('../src/routes/admin-insights').default;
const insightsDbFixture: {
  query: PlatformTenantsDataAccess['query'];
  queryOne: PlatformTenantsDataAccess['queryOne'];
  execute: PlatformTenantsDataAccess['execute'];
} = { query: async () => [], queryOne: async () => null, execute: async () => ({ affectedRows: 1 }) };

before(async () => {
  const stubs: Array<[string, Record<string, unknown>]> = [
    ['../src/db', {
      query: (...args: Parameters<PlatformTenantsDataAccess['query']>) => insightsDbFixture.query(...args),
      queryOne: (...args: Parameters<PlatformTenantsDataAccess['queryOne']>) => insightsDbFixture.queryOne(...args),
      execute: (...args: Parameters<PlatformTenantsDataAccess['execute']>) => insightsDbFixture.execute(...args),
      getPool: () => ({}),
    }],
    ['../src/middleware/auth', { authenticateToken: (_req: unknown, _res: unknown, next: () => void) => next() }],
    ['../src/security/admin-permissions', {
      getAdminPermissions: async () => [],
      isSuperAdmin: async () => false,
      requireAdminPermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    }],
    ['../src/services/minio', {
      BUCKETS: { PAYMENT_PROOFS: 'payment-proofs' },
      deleteFile: async () => undefined,
      getPrivateObjectUrl: async () => 'unused',
      uploadBuffer: async () => undefined,
    }],
    ['../src/services/service-credit', {
      CreditAdjustmentError: class CreditAdjustmentError extends Error { status = 400; },
      postServiceCreditAdjustment: async () => '0.00',
    }],
  ];
  for (const [specifier, exports] of stubs) {
    const filename = require.resolve(specifier);
    const mockedModule = new Module(filename);
    mockedModule.filename = filename;
    mockedModule.loaded = true;
    mockedModule.exports = exports;
    require.cache[filename] = mockedModule;
  }
  ({ createPlatformTenantsRouter } = await import('../src/routes/platform-tenants'));
  ({ createTenantSelfRouter } = await import('../src/routes/tenant-self'));
  ({ createAdminApprovalsRouter } = await import('../src/routes/admin-approvals'));
  ({ escapeCsvCell } = await import('../src/routes/admin-insights'));
  ({ default: adminInsightsRouter } = await import('../src/routes/admin-insights'));
} );

type TestRequest = AuthRequest & { permissions?: string[] };
type TestNext = (error?: unknown) => void;
type TestHandler = (req: TestRequest, res: Response, next: TestNext) => unknown;
type RouteLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: TestHandler }>;
  };
};
type TestResponse = Response & {
  statusCode: number;
  body: unknown;
  sent: boolean;
};

const makeResponse = (): TestResponse => {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    sent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      this.sent = true;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      this.sent = true;
      return this;
    },
    setHeader() {
      return this;
    },
  };
  return response as unknown as TestResponse;
};

const invokeRoute = async (
  router: Router,
  method: string,
  path: string,
  request: TestRequest,
) => {
  const layers = (router as unknown as { stack: RouteLayer[] }).stack;
  const route = layers.find(layer => layer.route?.path === path && layer.route.methods[method.toLowerCase()])?.route;
  assert.ok(route, `Expected ${method} ${path} route`);
  const response = makeResponse();
  for (const { handle } of route.stack) {
    await new Promise<void>((resolve, reject) => {
      let nextCalled = false;
      const next: TestNext = error => {
        nextCalled = true;
        if (error !== undefined) reject(error);
        else resolve();
      };
      try {
        Promise.resolve(handle(request, response, next)).then(() => {
          if (!nextCalled) resolve();
        }, reject);
      } catch (error) {
        reject(error);
      }
    });
    if (response.sent) break;
  }
  return response;
};

const makePlatformTenantsRouter = (
  connection: PlatformTenantsConnection,
  permissions: string[] = ['subscription.create'],
  onGetConnection: () => void = () => undefined,
  onQuery: () => void = () => undefined,
  fixture: Partial<PlatformTenantsDataAccess> = {},
  superAdmin = false,
): ReturnType<typeof createPlatformTenantsRouter> => {
  const db = {
    query: async (...args: Parameters<PlatformTenantsDataAccess['query']>) => { onQuery(); return fixture.query ? fixture.query(...args) : []; },
    queryOne: async (...args: Parameters<PlatformTenantsDataAccess['queryOne']>) => fixture.queryOne ? fixture.queryOne(...args) : null,
    execute: async (...args: Parameters<PlatformTenantsDataAccess['execute']>) => fixture.execute ? fixture.execute(...args) : ({ affectedRows: 1 }),
    getConnection: async () => { onGetConnection(); return connection; },
  } as unknown as PlatformTenantsDataAccess;
  const deps = {
    db,
    authenticate: ((_req, _res, next) => next()) as RequestHandler,
    requireAdminPermission: (permission: string): RequestHandler => (req, res, next) => {
      const request = req as TestRequest;
      if (request.permissions?.includes(permission)) return next();
      return res.status(403).json({ error: 'Forbidden' });
    },
    getAdminPermissions: async () => permissions,
    isSuperAdmin: async () => superAdmin,
    postServiceCreditEntry: async () => ({ transactionId: 'unused', balance: '0.00' }),
    executeRenewalIntent: async () => ({ status: 'unused' }),
    getPrivateObjectUrl: async () => 'unused',
  } as unknown as PlatformTenantsDeps;
  return createPlatformTenantsRouter(deps);
};

const makeTenantSelfRouter = (
  queryOne: TenantSelfDataAccess['queryOne'],
  loadActiveTenantAuthority: TenantSelfDeps['loadActiveTenantAuthority'],
): ReturnType<typeof createTenantSelfRouter> => {
  const db = {
    query: async () => [],
    queryOne,
    execute: async () => ({ affectedRows: 1 }),
    getConnection: async () => { throw new Error('Unexpected connection access'); },
  } as unknown as TenantSelfDataAccess;
  const deps = {
    db,
    authenticate: ((_req, _res, next) => next()) as RequestHandler,
    loadActiveTenantAuthority,
    uploadBuffer: async () => undefined,
    deleteFile: async () => undefined,
    getPrivateObjectUrl: async () => 'unused',
    executeRenewalIntent: async () => ({ status: 'unused' }),
  } as unknown as TenantSelfDeps;
  return createTenantSelfRouter(deps);
};

const makeRequest = (overrides: Record<string, unknown> = {}) => ({
  params: {},
  query: {},
  body: {},
  user: { id: 'admin-1', tenantId: undefined },
  header: () => undefined,
  ...overrides,
} as unknown as TestRequest);

test('CSV export escapes formula markers after leading whitespace and control characters', () => {
  assert.ok(escapeCsvCell('\t=1+1').startsWith(String.fromCharCode(34, 39, 9, 61)));
  assert.equal(escapeCsvCell('  @SUM(A1:A2)'), '"\'  @SUM(A1:A2)"');
  assert.equal(escapeCsvCell('ordinary "text"'), '"ordinary ""text"""');
});

test('finance CSV export path escapes a formula-shaped method and audits the export', async () => {
  let audited = false;
  insightsDbFixture.queryOne = async () => null;
  insightsDbFixture.query = async sql => String(sql).includes('FROM (') ? [{ label: '=HYPERLINK("x")', attempts: 1, verified: 1, revenue: 10 }] : [];
  insightsDbFixture.execute = async (_sql, params) => { audited = params?.[2] === 'finance_report.exported'; return { affectedRows: 1 }; };
  const response = await invokeRoute(adminInsightsRouter, 'get', '/finance/export', makeRequest({
    query: { months: '3' }, permissions: ['finance.export'],
  }));
  assert.equal(response.statusCode, 200);
  assert.match(String(response.body), /'=HYPERLINK/);
  assert.equal(audited, true);
  insightsDbFixture.query = async () => [];
  insightsDbFixture.execute = async () => ({ affectedRows: 1 });
});

test('platform permission denial is not bypassed by a super-admin role label', async () => {
  let connectionRequested = false;
  const connection: PlatformTenantsConnection = {
    beginTransaction: async () => undefined,
    execute: async () => [[], []],
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined,
  };
  const router = makePlatformTenantsRouter(connection, [], () => { connectionRequested = true; });
  const response = await invokeRoute(router, 'post', '/tenants/:id/renewals', makeRequest({
    params: { id: 'tenant-1' },
    user: { id: 'admin-1', role: 'super_admin' },
  }));
  assert.equal(response.statusCode, 403);
  assert.equal(connectionRequested, false);
});

test('top-up pagination rejects out-of-range input before querying data', async () => {
  let queried = false;
  const connection: PlatformTenantsConnection = {
    beginTransaction: async () => undefined,
    execute: async () => [[], []],
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined,
  };
  const router = makePlatformTenantsRouter(connection, [], () => undefined, () => { queried = true; });
  const response = await invokeRoute(router, 'get', '/topups', makeRequest({
    query: { page: '10001' },
    permissions: ['platform_payment.read'],
  }));
  assert.equal(response.statusCode, 400);
  assert.equal(queried, false);
});

test('instructor account summary redacts personal details, teaching detail, billing profile, and notes without detail capabilities', async () => {
  const sqlCalls: string[] = [];
  const auditActions: unknown[][] = [];
  const router = makePlatformTenantsRouter({
    beginTransaction: async () => undefined, execute: async () => [[], []], commit: async () => undefined,
    rollback: async () => undefined, release: () => undefined,
  }, ['instructor.read'], undefined, undefined, {
    queryOne: (async sql => {
      sqlCalls.push(String(sql));
      if (String(sql).includes('FROM users u')) return {
        owner_user_id: 'owner-1', owner_name: 'Ada Example', owner_phone: '020000000', owner_email: 'private@example.test',
        login_active: 1, account_created_at: '2026-01-01', tenant_id: 'tenant-1', business_name: 'Example',
        subject_type: 'math', tenant_status: 'active', legacy_compat: 0, tenant_created_at: '2026-01-02',
        billing_cycle_day: 15, reminder_days_before: 5, collection_status: 'follow_up', next_followup_at: '2026-02-01', billing_updated_at: '2026-01-03',
      };
      return { students: 12, online_students: 10, offline_students: 2, lectures: 30 };
    }) as PlatformTenantsDataAccess['queryOne'],
    query: (async sql => {
      sqlCalls.push(String(sql));
      if (String(sql).includes('tenant_account_notes')) return [{ id: 'note-1', note_type: 'private', body: 'sensitive note', created_by_name: 'Admin' }];
      return [];
    }) as PlatformTenantsDataAccess['query'],
    execute: (async (sql, params) => {
      sqlCalls.push(String(sql));
      if (String(sql).includes('INSERT INTO audit_events')) auditActions.push(params ?? []);
      return { affectedRows: 1 };
    }) as PlatformTenantsDataAccess['execute'],
  });
  const response = await invokeRoute(router, 'get', '/instructors/:ownerUserId/account', makeRequest({
    params: { ownerUserId: 'owner-1' }, permissions: ['instructor.read'],
  }));
  assert.equal(response.statusCode, 200);
  const body = response.body as {
    instructor: { owner_phone?: string; owner_email?: string };
    billing_profile: unknown;
    teaching: unknown;
    notes: unknown[];
    subscriptions: Array<Record<string, unknown>>;
    payments: Array<Record<string, unknown>>;
  };
  assert.equal(body.instructor.owner_phone, undefined);
  assert.equal(body.instructor.owner_email, undefined);
  assert.equal(body.billing_profile, null);
  assert.equal(body.teaching, null);
  assert.deepEqual(body.notes, []);
  assert.equal(body.subscriptions[0]?.agreed_price, undefined);
  assert.equal(body.payments[0]?.reference_number, undefined);
  assert.ok(auditActions.some(params => params[3] === 'tenant.account_statement.viewed'));
});

test('proof URL access requires a sensitive capability and audits successful access', async () => {
  let audited = false;
  let signed = false;
  const connection: PlatformTenantsConnection = {
    beginTransaction: async () => undefined, execute: async () => [[], []], commit: async () => undefined,
    rollback: async () => undefined, release: () => undefined,
  };
  const deniedRouter = makePlatformTenantsRouter(connection, [], undefined, undefined, {
    queryOne: (async () => ({ proof_object_key: 'private/proof.png' })) as PlatformTenantsDataAccess['queryOne'],
    execute: (async (_sql, params) => { if (params?.[2] === 'instructor_topup.proof_accessed') audited = true; return { affectedRows: 1 }; }) as PlatformTenantsDataAccess['execute'],
  });
  const denied = await invokeRoute(deniedRouter, 'get', '/topups/:id/proof-url', makeRequest({
    params: { id: 'topup-1' }, permissions: ['platform_payment.read'],
  }));
  assert.equal(denied.statusCode, 403);
  assert.equal(audited, false);
  assert.equal(signed, false);

  const allowedRouter = createPlatformTenantsRouter({
    db: {
      query: async () => [], queryOne: async () => ({ proof_object_key: 'private/proof.png' }),
      execute: async (_sql, params) => { if (params?.[2] === 'instructor_topup.proof_accessed') audited = true; return { affectedRows: 1 }; },
      getConnection: async () => connection,
    } as unknown as PlatformTenantsDataAccess,
    authenticate: ((_req, _res, next) => next()) as RequestHandler,
    requireAdminPermission: (permission): RequestHandler => (req, res, next) => (req as TestRequest).permissions?.includes(permission) ? next() : res.status(403).json({ error: 'Forbidden' }),
    getAdminPermissions: async () => ['finance.read'], isSuperAdmin: async () => false,
    postServiceCreditEntry: async () => ({ transactionId: 'unused', balance: '0.00' }),
    executeRenewalIntent: async () => ({ status: 'unused' }),
    getPrivateObjectUrl: async () => { signed = true; return 'https://private.example.test/short-lived'; },
  });
  const allowed = await invokeRoute(allowedRouter, 'get', '/topups/:id/proof-url', makeRequest({
    params: { id: 'topup-1' }, permissions: ['platform_payment.read'],
  }));
  assert.equal(allowed.statusCode, 200);
  assert.equal((allowed.body as { url?: string }).url, 'https://private.example.test/short-lived');
  assert.equal(audited, true);
  assert.equal(signed, true);
});

test('approval rejects a malformed stored amount before adjustment or write', async () => {
  let adjustmentCalled = false;
  let rollbackCalled = false;
  const connection = {
    beginTransaction: async () => undefined,
    execute: async () => [[{
      id: 'approval-1', action_key: 'service_credit.credit', resource_type: 'instructor', resource_id: 'instructor-1',
      requested_value: '{"amount":"1e9"}', reason: 'approved request', status: 'pending', requested_by: 'requester-1',
    }], []] as [unknown[], unknown],
    commit: async () => undefined, rollback: async () => { rollbackCalled = true; }, release: () => undefined,
  };
  const router = createAdminApprovalsRouter({
    db: { query: async () => [], queryOne: async () => null, getConnection: async () => connection } as unknown as AdminApprovalsDataAccess,
    authenticate: ((_req, _res, next) => next()) as RequestHandler,
    approvalRead: ((_req, _res, next) => next()) as RequestHandler,
    creditAdjust: ((_req, _res, next) => next()) as RequestHandler,
    approvalApprove: ((_req, _res, next) => next()) as RequestHandler,
    isSuperAdmin: async () => false,
  });
  const response = await invokeRoute(router, 'post', '/:id/approve', makeRequest({ params: { id: 'approval-1' }, user: { id: 'reviewer-1' } }));
  assert.equal(response.statusCode, 409);
  assert.equal(adjustmentCalled, false);
  assert.equal(rollbackCalled, true);
});

test('renewal rejects a suspended tenant and rolls back without creating a subscription', async () => {
  let inserts = 0;
  let rolledBack = false;
  const connection: PlatformTenantsConnection = {
    beginTransaction: async () => undefined,
    execute: async sql => {
      if (sql.includes('SELECT id,status,legacy_compat FROM tenants')) {
        return [[{ id: 'tenant-1', status: 'suspended', legacy_compat: 0 }], []];
      }
      inserts += 1;
      return [[], []];
    },
    commit: async () => undefined,
    rollback: async () => { rolledBack = true; },
    release: () => undefined,
  };
  const router = makePlatformTenantsRouter(connection);
  const response = await invokeRoute(router, 'post', '/tenants/:id/renewals', makeRequest({
    params: { id: 'tenant-1' },
    body: { plan_id: 'plan-1' },
    permissions: ['subscription.create'],
  }));
  assert.equal(response.statusCode, 409);
  assert.equal(inserts, 0);
  assert.equal(rolledBack, true);
});

test('renewal proceeds for an active tenant and commits the audited request', async () => {
  let selectCount = 0;
  let committed = false;
  const connection: PlatformTenantsConnection = {
    beginTransaction: async () => undefined,
    execute: async sql => {
      if (sql.includes('SELECT id,status,legacy_compat FROM tenants')) {
        selectCount += 1;
        return [[{ id: 'tenant-1', status: 'active', legacy_compat: 0 }], []];
      }
      if (sql.includes('SELECT id,price FROM platform_plans')) {
        selectCount += 1;
        return [[{ id: 'plan-1', price: '50.00' }], []];
      }
      if (sql.includes("SELECT id FROM tenant_subscriptions WHERE tenant_id=? AND status='pending'")) {
        selectCount += 1;
        return [[], []];
      }
      return [[], []];
    },
    commit: async () => { committed = true; },
    rollback: async () => undefined,
    release: () => undefined,
  };
  const router = makePlatformTenantsRouter(connection);
  const response = await invokeRoute(router, 'post', '/tenants/:id/renewals', makeRequest({
    params: { id: 'tenant-1' },
    body: { plan_id: 'plan-1' },
    permissions: ['subscription.create'],
  }));
  assert.equal(response.statusCode, 201);
  assert.equal(selectCount, 3);
  assert.equal(committed, true);
});

test('payment verification cannot activate a subscription for a suspended tenant', async () => {
  let writes = 0;
  let rolledBack = false;
  const connection: PlatformTenantsConnection = {
    beginTransaction: async () => undefined,
    execute: async sql => {
      if (sql.includes('FROM platform_payment_attempts p')) {
        return [[{
          id: 'payment-1', amount: '50.00', status: 'submitted', submitted_by: 'user-1',
          subscription_id: 'subscription-1', tenant_id: 'tenant-1', agreed_price: '50.00',
          discount_amount: '0.00', subscription_status: 'pending', duration_months: 1,
          duration_days: 0, owner_user_id: 'owner-1', tenant_status: 'suspended',
        }], []];
      }
      writes += 1;
      return [[], []];
    },
    commit: async () => undefined,
    rollback: async () => { rolledBack = true; },
    release: () => undefined,
  };
  const router = makePlatformTenantsRouter(connection);
  const response = await invokeRoute(router, 'post', '/payments/:id/verify', makeRequest({
    params: { id: 'payment-1' },
    permissions: ['platform_payment.verify'],
  }));
  assert.equal(response.statusCode, 409);
  assert.equal(writes, 0);
  assert.equal(rolledBack, true);
});

test('tenant self-service stays within the verified tenant when a different tenant is requested', async () => {
  const tenantQueries: unknown[][] = [];
  const router = makeTenantSelfRouter(
    (async (sql, params) => {
      tenantQueries.push(params ?? []);
      if (sql.includes('FROM tenants t WHERE t.id=?')) {
        return { id: params?.[0], business_name: 'Verified tenant', status: 'active', legacy_compat: 0 };
      }
      return { tenant_id: params?.[0], business_name: 'Verified tenant', tenant_status: 'active' };
    }) as TenantSelfDataAccess['queryOne'],
    async (_userId, tenantId) => tenantId === 'tenant-a' ? { authority: 'owner' } : null,
  );
  const response = await invokeRoute(router, 'get', '/subscription', makeRequest({
    query: { tenant_id: 'tenant-b' },
    user: { id: 'owner-a', tenantId: 'tenant-a' },
  }));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(tenantQueries, [['tenant-a'], ['tenant-a']]);
});

test('tenant self-service rejects an unverified tenant and reports data-access failure', async t => {
  await t.test('unverified tenant', async () => {
    let subscriptionQuery = false;
    const router = makeTenantSelfRouter(
      (async sql => {
        if (sql.includes('FROM tenants t WHERE t.id=?')) return null;
        subscriptionQuery = true;
        return null;
      }) as TenantSelfDataAccess['queryOne'],
      async () => null,
    );
    const response = await invokeRoute(router, 'get', '/subscription', makeRequest({
      user: { id: 'owner-a', tenantId: 'tenant-b' },
    }));
    assert.equal(response.statusCode, 404);
    assert.equal(subscriptionQuery, false);
  });

  await t.test('database failure', async () => {
    const router = makeTenantSelfRouter(
      (async () => { throw new Error('fixture failure'); }) as TenantSelfDataAccess['queryOne'],
      async () => ({ authority: 'owner' }),
    );
    const response = await invokeRoute(router, 'get', '/subscription', makeRequest({
      user: { id: 'owner-a', tenantId: 'tenant-a' },
    }));
    assert.equal(response.statusCode, 500);
  });
});
