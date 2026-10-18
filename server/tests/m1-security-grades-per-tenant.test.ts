/**
 * M1 — grades are PER-TENANT (hermetic: no MySQL, no external network, no
 * .env file, no Docker, no live app boot).
 *
 * The router is driven through a real express app on a loopback ephemeral port
 * with the production factory. Substituted seams are only the injected ones:
 *   - the REAL authentication middleware (`createAuthenticateToken` /
 *     `createOptionalAuth`) over an in-memory PrincipalRepository fixture, so
 *     real JWT verification, identity liveness and server-derived tenant
 *     selection all run;
 *   - the REAL teaching-write guard (`createRequireTeachingWrite('groups')`)
 *     over an in-memory TeachingAccessRepository fixture;
 *   - the REAL platform permission guard
 *     (`createRequireAdminPermission('grade.manage')`) over server-verified
 *     platform-authority fixtures;
 *   - an in-memory data-access adapter that answers the exact SQL the router
 *     emits, mirroring its predicates (tenant scope, shared rows,
 *     affectedRows). It is not a MySQL engine — the point is to prove the
 *     authorization, tenant-scoping and failure decisions.
 *
 * Policy under test:
 *   - a tenant grade row is readable by its own tenant and writable by that
 *     tenant's teaching-write entitlement only;
 *   - a legacy shared row (tenant_id IS NULL) is readable by every
 *     authenticated principal and writable only by verified platform
 *     authority;
 *   - a cross-tenant write is indistinguishable from a missing row (404) and
 *     mutates nothing;
 *   - tenant_id is never accepted from the request body.
 */
import { test } from 'node:test';
import { quietConsole, restoreConsole } from './helpers/quiet-console';

test.beforeEach(quietConsole);
test.afterEach(restoreConsole);
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';

import { createAuthenticateToken, createOptionalAuth } from '../src/middleware/auth';
import { createRequireTeachingWrite, type TeachingAccessRepository } from '../src/middleware/teaching-access';
import { createRequireAdminPermission } from '../src/security/admin-permissions';
import type { PrincipalRepository } from '../src/security/principal-repository';
import { createGradesRouter } from '../src/routes/grades';

process.env.JWT_SECRET ??= 'hermetic-grades-tenant-jwt-secret-not-a-real-key';
const TEST_JWT_SECRET = process.env.JWT_SECRET!;

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

type Row = Record<string, any>;

interface State {
  users: Record<string, { is_active: number; token_version: number; suspension_active: number }>;
  memberships: Record<string, { tenant_id: string }[]>;
  teachingMemberships: Record<string, {
    role_key: string;
    user_is_active: number;
    tenant_status: string;
    tenant_legacy_compat: number;
    subscription_entitles: number;
  }>;
  staffPages: Record<string, { accessible_pages: string | null; is_active: number }>;
  platformSuperAdmins: Set<string>;
  platformPermissions: Record<string, string[]>;
  permissionLookupFails: boolean;
  grades: Row[];
  executed: { sql: string; params: unknown[] }[];
  failWith: Error | null;
}

const makeState = (): State => ({
  users: {},
  memberships: {},
  teachingMemberships: {},
  staffPages: {},
  platformSuperAdmins: new Set<string>(),
  platformPermissions: {},
  permissionLookupFails: false,
  grades: [],
  executed: [],
  failWith: null,
});

let state: State = makeState();

// ---------------------------------------------------------------------------
// In-memory data-access adapter mirroring the router's emitted SQL
// ---------------------------------------------------------------------------

const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

const runSelect = (sql: string, params: unknown[]): Row[] => {
  state.executed.push({ sql, params });
  if (state.failWith) throw state.failWith;

  const q = normalize(sql);

  // List: own tenant OR shared (NULL tenant) rows.
  if (q.includes('SELECT * FROM grades WHERE (tenant_id = ? OR tenant_id IS NULL) AND is_active = TRUE')) {
    const tenantId = params[0] ?? null;
    return state.grades
      .filter((g) => Boolean(g.is_active) && (g.tenant_id === null || g.tenant_id === tenantId))
      .sort((a, b) => Number(a.display_order) - Number(b.display_order))
      .map((g) => ({ ...g }));
  }
  // Single read: id + (own tenant OR shared).
  if (q.includes('SELECT * FROM grades WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL) AND is_active = TRUE')) {
    const [id, tenantId] = params;
    const grade = state.grades.find((g) => g.id === id && Boolean(g.is_active)
      && (g.tenant_id === null || g.tenant_id === tenantId));
    return grade ? [{ ...grade }] : [];
  }
  // Shared mutation probe / read-back: id + shared predicate.
  if (q.includes('SELECT * FROM grades WHERE id = ? AND tenant_id IS NULL AND is_active = TRUE')) {
    const grade = state.grades.find((g) => g.id === params[0] && g.tenant_id === null && Boolean(g.is_active));
    return grade ? [{ ...grade }] : [];
  }
  if (q.includes('SELECT * FROM grades WHERE id = ? AND tenant_id IS NULL')) {
    const grade = state.grades.find((g) => g.id === params[0] && g.tenant_id === null);
    return grade ? [{ ...grade }] : [];
  }
  // Tenant mutation probe / read-back: id + tenant predicate.
  if (q.includes('SELECT * FROM grades WHERE id = ? AND tenant_id = ? AND is_active = TRUE')) {
    const [id, tenantId] = params;
    const grade = state.grades.find((g) => g.id === id && g.tenant_id === tenantId && Boolean(g.is_active));
    return grade ? [{ ...grade }] : [];
  }
  if (q.includes('SELECT * FROM grades WHERE id = ? AND tenant_id = ?')) {
    const [id, tenantId] = params;
    const grade = state.grades.find((g) => g.id === id && g.tenant_id === tenantId);
    return grade ? [{ ...grade }] : [];
  }

  throw new Error(`fake db: unhandled SELECT: ${sql}`);
};

const runWrite = (sql: string, params: unknown[]): { affectedRows: number; insertId: number } => {
  state.executed.push({ sql, params });
  if (state.failWith) throw state.failWith;

  if (sql.includes('INSERT INTO grades')) {
    const [id, tenantId, name, displayOrder] = params;
    state.grades.push({
      id,
      tenant_id: tenantId ?? null,
      name,
      display_order: displayOrder,
      is_active: 1,
      created_at: '2026-10-17T00:00:00Z',
      updated_at: '2026-10-17T00:00:00Z',
    });
    return { affectedRows: 1, insertId: 0 };
  }
  if (sql.includes('UPDATE grades SET name = ?')) {
    const shared = sql.includes('tenant_id IS NULL');
    const name = params[0] as string;
    const displayOrder = params[1] as number;
    const id = params[2] as string;
    const tenantId = shared ? null : (params[3] ?? null);
    const grade = state.grades.find((g) => g.id === id && g.tenant_id === tenantId);
    if (!grade) return { affectedRows: 0, insertId: 0 };
    grade.name = name;
    grade.display_order = displayOrder;
    return { affectedRows: 1, insertId: 0 };
  }
  if (sql.includes('UPDATE grades SET is_active = FALSE')) {
    const shared = sql.includes('tenant_id IS NULL');
    const id = params[0] as string;
    const tenantId = shared ? null : (params[1] ?? null);
    const grade = state.grades.find((g) => g.id === id && g.tenant_id === tenantId);
    if (!grade) return { affectedRows: 0, insertId: 0 };
    grade.is_active = 0;
    return { affectedRows: 1, insertId: 0 };
  }

  throw new Error(`fake db: unhandled WRITE: ${sql}`);
};

const fakeDb = {
  query: async <T>(sql: string, params?: unknown[]) => runSelect(sql, params ?? []) as T[],
  queryOne: async <T>(sql: string, params?: unknown[]) => {
    const rows = runSelect(sql, params ?? []);
    return (rows.length > 0 ? rows[0] : null) as T | null;
  },
  execute: async (sql: string, params?: unknown[]) => runWrite(sql, params ?? []),
};

// ---------------------------------------------------------------------------
// Real middleware over fixture repositories
// ---------------------------------------------------------------------------

const principalRepo: PrincipalRepository = {
  findUsersIdentity: async (id) => state.users[id] ?? null,
  findStaffIdentity: async () => null,
  findInstructorAccount: async () => null,
  findStudentEnrollments: async () => [],
  findActiveTenantMemberships: async (id) => state.memberships[id] ?? [],
};

const teachingRepo: TeachingAccessRepository = {
  loadSelectedTenantMembership: async (userId, tenantId) =>
    state.teachingMemberships[`${userId}:${tenantId}`] ?? null,
  loadStaffPagePermissions: async (userId) => state.staffPages[userId] ?? null,
};

const authenticate = createAuthenticateToken(principalRepo);
const optionalAuthenticate = createOptionalAuth(principalRepo);

const buildApp = (): express.Express => {
  const app = express();
  app.use(express.json());
  app.use('/api/grades', createGradesRouter({
    db: fakeDb as never,
    authenticate,
    optionalAuthenticate,
    requireTenantWrite: createRequireTeachingWrite('groups', teachingRepo),
    authorizePlatformWrite: createRequireAdminPermission('grade.manage', {
      isSuperAdmin: async (userId) => state.platformSuperAdmins.has(userId),
      getAdminPermissions: async (userId) => {
        if (state.permissionLookupFails) throw new Error('fixture permission lookup failure');
        return state.platformPermissions[userId] ?? [];
      },
    }),
  }));
  return app;
};

interface Harness {
  base: string;
  close: () => Promise<void>;
}

const harness = async (): Promise<Harness> => {
  const server: Server = createServer(buildApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
};

interface ApiResult {
  status: number;
  body: any;
}

const api = async (
  h: Harness,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<ApiResult> => {
  const res = await fetch(`${h.base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const sign = (user: { id: string; role: string; tenantId?: string }) =>
  jwt.sign({ id: user.id, role: user.role, tv: 0, ...(user.tenantId ? { tenant_id: user.tenantId } : {}) }, TEST_JWT_SECRET);

// ---------------------------------------------------------------------------
// Fixture: two tenants, one entitled teacher per tenant, one shared legacy row
// ---------------------------------------------------------------------------

const entitled = {
  role_key: 'instructor',
  user_is_active: 1,
  tenant_status: 'active',
  tenant_legacy_compat: 1,
  subscription_entitles: 0,
};

const seedBase = () => {
  state.users['teacher-a'] = { is_active: 1, token_version: 0, suspension_active: 0 };
  state.users['teacher-b'] = { is_active: 1, token_version: 0, suspension_active: 0 };
  state.users['teacher-unentitled'] = { is_active: 1, token_version: 0, suspension_active: 0 };
  state.users['admin-bare'] = { is_active: 1, token_version: 0, suspension_active: 0 };
  state.users['platform-grade'] = { is_active: 1, token_version: 0, suspension_active: 0 };
  state.users['platform-super'] = { is_active: 1, token_version: 0, suspension_active: 0 };

  state.memberships['teacher-a'] = [{ tenant_id: TENANT_A }];
  state.memberships['teacher-b'] = [{ tenant_id: TENANT_B }];
  state.memberships['teacher-unentitled'] = [{ tenant_id: TENANT_A }];

  state.teachingMemberships[`teacher-a:${TENANT_A}`] = { ...entitled };
  state.teachingMemberships[`teacher-b:${TENANT_B}`] = { ...entitled };
  // A membership that exists but carries no subscription entitlement and no
  // legacy compatibility: the real guard denies it.
  state.teachingMemberships[`teacher-unentitled:${TENANT_A}`] = {
    ...entitled, tenant_legacy_compat: 0, subscription_entitles: 0,
  };

  // A verified holder of the platform permission key (not a super admin).
  state.platformPermissions['platform-grade'] = ['grade.manage'];

  state.grades.push(
    { id: 'gr-a', tenant_id: TENANT_A, name: 'Grade A', display_order: 1, is_active: 1 },
    { id: 'gr-b', tenant_id: TENANT_B, name: 'Grade B', display_order: 2, is_active: 1 },
    { id: 'gr-shared', tenant_id: null, name: 'Shared Grade', display_order: 3, is_active: 1 },
    { id: 'gr-deleted', tenant_id: TENANT_A, name: 'Deleted Grade', display_order: 4, is_active: 0 },
  );
};

const withState = async <T>(seed: () => void, fn: (h: Harness) => Promise<T>): Promise<T> => {
  state = makeState();
  seed();
  const h = await harness();
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
};

const teacherA = { id: 'teacher-a', role: 'teacher', tenantId: TENANT_A };
const teacherB = { id: 'teacher-b', role: 'teacher', tenantId: TENANT_B };
const platformAdmin = { id: 'platform-grade', role: 'admin' };
const platformSuper = { id: 'platform-super', role: 'admin' };

const writes = (): { sql: string; params: unknown[] }[] =>
  state.executed.filter((e) => /INSERT INTO grades|UPDATE grades/.test(e.sql));

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test('a teacher lists only their own tenant grades plus the shared catalog', async () => {
  await withState(seedBase, async (h) => {
    const res = await api(h, 'GET', '/api/grades', sign(teacherA));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((g: Row) => g.id), ['gr-a', 'gr-shared']);

    const listSql = state.executed.find((e) => e.sql.includes('tenant_id IS NULL'))!;
    assert.match(listSql.sql, /tenant_id = \? OR tenant_id IS NULL/);
    assert.deepEqual(listSql.params, [TENANT_A]);
  });
});

test('a single read of another tenant grade is 404 (no leak of existence)', async () => {
  await withState(seedBase, async (h) => {
    const own = await api(h, 'GET', '/api/grades/gr-a', sign(teacherA));
    assert.equal(own.status, 200);

    const foreign = await api(h, 'GET', '/api/grades/gr-b', sign(teacherA));
    assert.equal(foreign.status, 404);

    const shared = await api(h, 'GET', '/api/grades/gr-shared', sign(teacherA));
    assert.equal(shared.status, 200, 'legacy shared rows stay readable');
  });
});

test('grade reads reject anonymous callers before any data access', async () => {
  await withState(seedBase, async (h) => {
    assert.equal((await api(h, 'GET', '/api/grades', null)).status, 401);
    assert.equal((await api(h, 'GET', '/api/grades/gr-a', null)).status, 401);
    assert.equal(state.executed.length, 0);
  });
});

test('read failures surface as 500, never as an empty success', async () => {
  await withState(seedBase, async (h) => {
    state.failWith = new Error('simulated db outage');
    assert.equal((await api(h, 'GET', '/api/grades', sign(teacherA))).status, 500);
    assert.equal((await api(h, 'GET', '/api/grades/gr-a', sign(teacherA))).status, 500);
  });
});

// ---------------------------------------------------------------------------
// Writes — per-tenant authorization
// ---------------------------------------------------------------------------

test('an entitled teacher of the tenant creates a grade row bound to the selected tenant', async () => {
  await withState(seedBase, async (h) => {
    const res = await api(h, 'POST', '/api/grades', sign(teacherA), { name: 'Grade New', display_order: 5 });
    assert.equal(res.status, 201);

    const insert = state.executed.find((e) => e.sql.includes('INSERT INTO grades'))!;
    assert.equal(insert.params[1], TENANT_A, 'tenant_id comes from the verified selection');
    const created = state.grades.find((g) => g.name === 'Grade New')!;
    assert.equal(created.tenant_id, TENANT_A);
  });
});

test('an entitled teacher updates and soft-deletes their own tenant grade', async () => {
  await withState(seedBase, async (h) => {
    const updated = await api(h, 'PUT', '/api/grades/gr-a', sign(teacherA), { name: 'Grade A Renamed' });
    assert.equal(updated.status, 200);
    assert.equal(state.grades.find((g) => g.id === 'gr-a')!.name, 'Grade A Renamed');

    const deleted = await api(h, 'DELETE', '/api/grades/gr-a', sign(teacherA));
    assert.equal(deleted.status, 200);
    assert.equal(state.grades.find((g) => g.id === 'gr-a')!.is_active, 0);
  });
});

test('a cross-tenant update is indistinguishable from missing (404) and mutates nothing', async () => {
  await withState(seedBase, async (h) => {
    const put = await api(h, 'PUT', '/api/grades/gr-b', sign(teacherA), { name: 'Hijacked' });
    assert.equal(put.status, 404);
    assert.equal(state.grades.find((g) => g.id === 'gr-b')!.name, 'Grade B');
    assert.equal(writes().length, 0);

    const del = await api(h, 'DELETE', '/api/grades/gr-b', sign(teacherA));
    assert.equal(del.status, 404);
    assert.equal(state.grades.find((g) => g.id === 'gr-b')!.is_active, 1);
    assert.equal(writes().length, 0);
  });
});

test('a client-supplied tenant_id in the body never steers the row or the predicate', async () => {
  await withState(seedBase, async (h) => {
    const res = await api(h, 'POST', '/api/grades', sign(teacherA), {
      name: 'Spoofed', tenant_id: TENANT_B,
    });
    assert.equal(res.status, 201);
    const created = state.grades.find((g) => g.name === 'Spoofed')!;
    assert.equal(created.tenant_id, TENANT_A, 'the body tenant_id is ignored');
  });
});

test('a soft-deleted grade cannot be edited or resurrected (404)', async () => {
  await withState(seedBase, async (h) => {
    assert.equal((await api(h, 'PUT', '/api/grades/gr-deleted', sign(teacherA), { name: 'Nope' })).status, 404);
    assert.equal((await api(h, 'DELETE', '/api/grades/gr-deleted', sign(teacherA))).status, 404);
    assert.equal(state.grades.find((g) => g.id === 'gr-deleted')!.name, 'Deleted Grade');
    assert.equal(writes().length, 0);
  });
});

// ---------------------------------------------------------------------------
// Writes — denials (teaching entitlement, role claims, shared rows)
// ---------------------------------------------------------------------------

test('a teacher whose tenant has no entitlement is denied without any write', async () => {
  await withState(seedBase, async (h) => {
    const token = sign({ id: 'teacher-unentitled', role: 'teacher', tenantId: TENANT_A });
    const created = await api(h, 'POST', '/api/grades', token, { name: 'Blocked' });
    assert.equal(created.status, 403);
    assert.match(created.body.error, /Teaching access is not active/);
    assert.equal(writes().length, 0);
    assert.equal(state.grades.some((g) => g.name === 'Blocked'), false);
  });
});

test('a bare admin role claim without teaching membership is denied', async () => {
  await withState(seedBase, async (h) => {
    const token = sign({ id: 'admin-bare', role: 'admin' });
    const created = await api(h, 'POST', '/api/grades', token, { name: 'Blocked' });
    assert.equal(created.status, 403);
    assert.equal(writes().length, 0);

    const forged = await api(h, 'POST', '/api/grades', sign({ id: 'ghost-teacher', role: 'teacher' }), { name: 'Blocked' });
    assert.equal(forged.status, 401, 'an unknown identity cannot authenticate');
    assert.equal(writes().length, 0);
  });
});

test('an anonymous write is rejected before any authorization or data access', async () => {
  await withState(seedBase, async (h) => {
    assert.equal((await api(h, 'POST', '/api/grades', null, { name: 'Blocked' })).status, 401);
    assert.equal((await api(h, 'PUT', '/api/grades/gr-a', null, { name: 'Blocked' })).status, 401);
    assert.equal((await api(h, 'DELETE', '/api/grades/gr-a', null)).status, 401);
    assert.equal(writes().length, 0);
  });
});

test('a shared catalog row is writable only by verified platform authority', async () => {
  await withState(seedBase, async (h) => {
    // The shared row is readable by a tenant teacher but is not that tenant's
    // row: reaching it requires the explicit shared scope, which then asks for
    // the platform permission.
    const teacherPut = await api(h, 'PUT', '/api/grades/gr-shared', sign(teacherA), { name: 'Hijacked Shared', scope: 'shared' });
    assert.equal(teacherPut.status, 403, 'the shared row asks for the platform permission');
    assert.equal(writes().length, 0);

    // Without the shared scope the row is simply not in the tenant scope.
    const tenantScoped = await api(h, 'PUT', '/api/grades/gr-shared', sign(teacherA), { name: 'Hijacked Shared' });
    assert.equal(tenantScoped.status, 404);
    assert.equal(writes().length, 0);

    // A holder of grade.manage may maintain the legacy shared catalog.
    const allowed = await api(h, 'PUT', '/api/grades/gr-shared', sign(platformAdmin), { name: 'Shared Renamed', scope: 'shared' });
    assert.equal(allowed.status, 200);
    assert.equal(state.grades.find((g) => g.id === 'gr-shared')!.name, 'Shared Renamed');
    assert.equal(state.grades.find((g) => g.id === 'gr-shared')!.tenant_id, null);

    // An authenticated admin without the permission key is denied.
    const denied = await api(h, 'DELETE', '/api/grades/gr-shared', sign({ id: 'admin-bare', role: 'admin' }), { scope: 'shared' });
    assert.equal(denied.status, 403);
    assert.equal(state.grades.find((g) => g.id === 'gr-shared')!.is_active, 1);

    // Platform authority may also retire a shared row.
    const removed = await api(h, 'DELETE', '/api/grades/gr-shared', sign(platformAdmin), { scope: 'shared' });
    assert.equal(removed.status, 200);
    assert.equal(state.grades.find((g) => g.id === 'gr-shared')!.is_active, 0);
  });
});

test('platform authority manages the shared catalog but never a tenant row', async () => {
  await withState(seedBase, async (h) => {
    state.platformSuperAdmins.add('platform-super');

    const created = await api(h, 'POST', '/api/grades', sign(platformSuper), { name: 'Shared New', scope: 'shared' });
    assert.equal(created.status, 201);
    const insert = state.executed.find((e) => e.sql.includes('INSERT INTO grades'))!;
    assert.equal(insert.params[1], null, 'a shared create binds no tenant');

    // Platform authority is not a tenant teaching entitlement, so a tenant row
    // is out of reach: denied, never mutated.
    state.executed.length = 0;
    const tenantRow = await api(h, 'PUT', '/api/grades/gr-a', sign(platformAdmin), { name: 'Platform Renamed' });
    assert.equal(tenantRow.status, 403);
    assert.equal(state.grades.find((g) => g.id === 'gr-a')!.name, 'Grade A');
    assert.equal(writes().length, 0);
  });
});

test('a caller with no selected tenant cannot create a tenant grade', async () => {
  await withState(seedBase, async (h) => {
    const res = await api(h, 'POST', '/api/grades', sign({ id: 'admin-bare', role: 'admin' }), { name: 'No Tenant' });
    assert.equal(res.status, 403);
    assert.equal(writes().length, 0);
    assert.equal(state.grades.some((g) => g.name === 'No Tenant'), false);
  });
});

// ---------------------------------------------------------------------------
// Input validation and failure containment
// ---------------------------------------------------------------------------

test('grade write inputs are validated before any statement runs', async () => {
  await withState(seedBase, async (h) => {
    assert.equal((await api(h, 'POST', '/api/grades', sign(teacherA), {})).status, 400);
    assert.equal((await api(h, 'POST', '/api/grades', sign(teacherA), { name: '   ' })).status, 400);
    assert.equal((await api(h, 'POST', '/api/grades', sign(teacherA), { name: 'x'.repeat(256) })).status, 400);
    assert.equal((await api(h, 'POST', '/api/grades', sign(teacherA), { name: 'Ok', display_order: 'first' })).status, 400);
    assert.equal(writes().length, 0);
  });
});

test('a write storage failure is a 500, never a success', async () => {
  await withState(seedBase, async (h) => {
    state.failWith = new Error('simulated db outage');
    assert.equal((await api(h, 'POST', '/api/grades', sign(teacherA), { name: 'Outage' })).status, 500);
    assert.equal(state.grades.some((g) => g.name === 'Outage'), false);
  });
});

test('a platform permission lookup failure denies the shared catalog write (fail closed)', async () => {
  await withState(seedBase, async (h) => {
    state.permissionLookupFails = true;
    const res = await api(h, 'PUT', '/api/grades/gr-shared', sign(platformAdmin), { name: 'Unavailable', scope: 'shared' });
    assert.equal(res.status, 503);
    assert.equal(state.grades.find((g) => g.id === 'gr-shared')!.name, 'Shared Grade');
    assert.equal(writes().length, 0);
  });
});
