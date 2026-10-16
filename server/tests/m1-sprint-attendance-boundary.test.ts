/**
 * M1 sprint regressions — attendance and grade-catalog access boundaries
 * (hermetic: no MySQL, no external network, no .env file, no Docker, no live
 * app boot).
 *
 * Strategy: the two routers already expose injectable factories
 * (`createAttendanceRouter` / `createGradesRouter`). This suite injects the
 * production seams directly:
 *   - the REAL authentication middleware (`createAuthenticateToken` /
 *     `createOptionalAuth`) over an in-memory PrincipalRepository fixture, so
 *     real JWT verification, liveness, revocation and server-derived tenant
 *     selection all run;
 *   - the REAL teaching-write guard (`createRequireTeachingWrite('groups')`)
 *     over an in-memory TeachingAccessRepository fixture, so the real
 *     entitlement decision runs for grade writes;
 *   - an in-memory data-access adapter that answers the exact SQL the routers
 *     emit, mirroring the emitted predicates (scope filters, ownership,
 *     affectedRows). It is not a MySQL engine — the point is to prove the
 *     production authorization, ownership, input-bound and failure-handling
 *     decisions, not to emulate a database.
 *
 * Every request goes through a real express app on a loopback ephemeral port
 * with the routers mounted exactly as production mounts them; the injected
 * authenticate middleware is the only substitution. No pool is ever created,
 * no .env file is read and no external service is contacted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';

import { createAuthenticateToken, createOptionalAuth } from '../src/middleware/auth';
import { createRequireTeachingWrite, type TeachingAccessRepository } from '../src/middleware/teaching-access';
import type { PrincipalRepository } from '../src/security/principal-repository';
import { createAttendanceRouter } from '../src/routes/attendance';
import { createGradesRouter } from '../src/routes/grades';

process.env.JWT_SECRET ??= 'hermetic-attendance-test-jwt-secret-not-a-real-key';
const TEST_JWT_SECRET = process.env.JWT_SECRET!;

type Row = Record<string, any>;

// ---------------------------------------------------------------------------
// Fixture state
// ---------------------------------------------------------------------------

interface State {
  users: Record<string, { is_active: number; token_version: number; suspension_active: number }>;
  staff: Record<string, { is_active: number }>;
  instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
  memberships: Record<string, { tenant_id: string }[]>;
  platformUsers: Set<string>;
  students: Row[];
  groups: Row[];
  courses: Row[];
  attendance: Row[];
  grades: Row[];
  teachingMemberships: Record<string, { role_key: string; user_is_active: number; tenant_status: string; tenant_legacy_compat: number; subscription_entitles: number }>;
  staffPages: Record<string, { accessible_pages: string | string[] | null; is_active: number }>;
  executed: { sql: string; params: unknown[] }[];
  notifyCalls: { to: string; body: string }[];
  failWith: Error | null;
}

const makeState = (): State => ({
  users: {},
  staff: {},
  instructorAccounts: {},
  memberships: {},
  platformUsers: new Set<string>(),
  students: [],
  groups: [],
  courses: [],
  attendance: [],
  grades: [],
  teachingMemberships: {},
  staffPages: {},
  executed: [],
  notifyCalls: [],
  failWith: null,
});

let state: State = makeState();

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

// ---------------------------------------------------------------------------
// In-memory data-access adapter mirroring the routers' emitted SQL
// ---------------------------------------------------------------------------

const day = (value: unknown): string => String(value ?? '').slice(0, 10);

/** Evaluate an attendance/student scope clause against the fixture students. */
const studentMatchesScope = (studentId: string, scopeSql: string, scopeParams: unknown[]): boolean => {
  const student = state.students.find((s) => s.id === studentId);
  if (!student) return false;
  if (scopeSql.includes('sc.instructor_id')) {
    const [tenantId, instructorId] = scopeParams;
    if (student.tenant_id !== tenantId) return false;
    if (student.instructor_id === instructorId) return true;
    const group = state.groups.find((g) => g.id === student.group_id);
    return group?.instructor_id === instructorId;
  }
  if (scopeSql.includes('sc.tenant_id')) {
    return student.tenant_id === scopeParams[0];
  }
  return true; // platform operator: no scope predicate
};

const runSelect = (sql: string, params: unknown[]): Row[] => {
  state.executed.push({ sql, params });
  if (state.failWith) throw state.failWith;

  // Routers emit multi-line SQL; flatten whitespace so predicates can be matched.
  const q = sql.replace(/\s+/g, ' ');

  // --- students -----------------------------------------------------------
  if (q.includes('FROM students sc') && q.includes('sc.barcode = ?')) {
    const barcode = params[0];
    const scopeSql = q.slice(q.indexOf('WHERE sc.barcode'));
    const student = state.students.find((s) => s.barcode === barcode && Boolean(s.is_active));
    if (!student) return [];
    if (!studentMatchesScope(student.id, scopeSql, params.slice(1))) return [];
    return [{ id: student.id, group_id: student.group_id }];
  }
  if (q.includes('SELECT sc.id FROM students sc WHERE sc.id = ?')) {
    const scopeSql = q.slice(q.indexOf('SELECT sc.id FROM students sc'));
    return studentMatchesScope(String(params[0]), scopeSql, params.slice(1)) ? [{ id: params[0] }] : [];
  }
  if (q.includes('SELECT id, group_id FROM students WHERE id = ?')) {
    const student = state.students.find((s) => s.id === params[0]);
    return student ? [{ id: student.id, group_id: student.group_id }] : [];
  }
  if (q.includes('FROM students WHERE group_id = ? AND is_active = TRUE')) {
    return state.students.filter((s) => s.group_id === params[0] && Boolean(s.is_active));
  }

  // --- courses ------------------------------------------------------------
  if (q.includes('SELECT id, tenant_id FROM courses WHERE id = ?')) {
    const course = state.courses.find((c) => c.id === params[0]);
    return course ? [{ id: course.id, tenant_id: course.tenant_id }] : [];
  }

  // --- groups -------------------------------------------------------------
  if (q.includes('FROM `groups` g') && q.includes('gc.tenant_id = ?')) {
    const group = state.groups.find((g) => g.id === params[0]);
    if (!group) return [];
    if (q.includes('g.instructor_id = ?')) {
      const [, instructorId, tenantId] = params;
      if (group.instructor_id !== instructorId) return [];
      const course = state.courses.find((c) => c.id === group.course_id);
      return course?.tenant_id === tenantId ? [{ id: group.id }] : [];
    }
    const course = state.courses.find((c) => c.id === group.course_id);
    return course?.tenant_id === params[1] ? [{ id: group.id }] : [];
  }

  // --- attendance ---------------------------------------------------------
  if (q.includes('SELECT * FROM attendance WHERE id = ?')) {
    const row = state.attendance.find((a) => a.id === params[0]);
    return row ? [{ ...row }] : [];
  }
  if (q.includes('SELECT id FROM attendance WHERE student_id = ?')) {
    const [studentId, wantDay] = params;
    const exceptId = params.length > 2 ? params[2] : undefined;
    return state.attendance
      .filter((a) => a.student_id === studentId && day(a.attendance_date) === wantDay && a.id !== exceptId)
      .map((a) => ({ id: a.id }));
  }
  if (q.includes("FROM attendance WHERE DATE(attendance_date) = ? AND status = 'present'")) {
    return state.attendance
      .filter((a) => day(a.attendance_date) === params[0] && a.status === 'present')
      .map((a) => ({ student_id: a.student_id }));
  }
  if (q.includes('SELECT a.*, s.name AS student_name')) {
    const [studentId, wantDay] = params;
    const row = state.attendance
      .filter((a) => a.student_id === studentId && day(a.attendance_date) === wantDay)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (!row) return [];
    const student = state.students.find((s) => s.id === row.student_id);
    return [{ ...row, student_name: student?.name ?? null, student_group_id: student?.group_id ?? null }];
  }
  if (q.includes('FROM attendance a') && q.includes('LEFT JOIN students s')) {
    let i = 0;
    let rows = state.attendance.map((a) => ({ ...a }));
    if (q.includes('AND DATE(a.attendance_date) = ?')) {
      const wanted = params[i++];
      rows = rows.filter((a) => day(a.attendance_date) === wanted);
    } else if (q.includes('AND DATE(a.attendance_date) BETWEEN ? AND ?')) {
      const [start, end] = [params[i++], params[i++]];
      rows = rows.filter((a) => day(a.attendance_date) >= String(start) && day(a.attendance_date) <= String(end));
    } else if (q.includes('AND DATE(a.attendance_date) >= ?')) {
      const start = params[i++];
      rows = rows.filter((a) => day(a.attendance_date) >= String(start));
    } else if (q.includes('AND DATE(a.attendance_date) <= ?')) {
      const end = params[i++];
      rows = rows.filter((a) => day(a.attendance_date) <= String(end));
    }
    if (q.includes('AND a.student_id = ?')) {
      const studentId = params[i++];
      rows = rows.filter((a) => a.student_id === studentId);
    }
    if (q.includes('AND COALESCE(a.group_id, s.group_id) = ?')) {
      const groupId = params[i++];
      rows = rows.filter((a) => {
        const student = state.students.find((s) => s.id === a.student_id);
        return (a.group_id ?? student?.group_id) === groupId;
      });
    }
    if (q.includes('AND a.course_id = ?')) {
      const courseId = params[i++];
      rows = rows.filter((a) => a.course_id === courseId);
    }
    if (q.includes('a.student_id IN (SELECT sc.id FROM students sc')) {
      const scopeSql = q.slice(q.indexOf('SELECT sc.id FROM students sc'));
      const scopeParams = params.slice(i);
      rows = rows.filter((a) => studentMatchesScope(a.student_id, scopeSql, scopeParams));
    }
    const ascending = /ORDER BY a\.attendance_date ASC/.test(q);
    rows.sort((a, b) => {
      const cmp = String(a.attendance_date).localeCompare(String(b.attendance_date));
      return ascending ? cmp : -cmp;
    });
    const limit = /LIMIT (\d+)/.exec(q);
    if (limit) rows = rows.slice(0, Number(limit[1]));
    return rows.map((a) => {
      const student = state.students.find((s) => s.id === a.student_id);
      return { ...a, student_name: student?.name ?? null, student_barcode: student?.barcode ?? null };
    });
  }

  // --- grades -------------------------------------------------------------
  if (q.includes('FROM grades WHERE is_active = TRUE ORDER BY display_order')) {
    return state.grades
      .filter((g) => Boolean(g.is_active))
      .sort((a, b) => Number(a.display_order) - Number(b.display_order))
      .map((g) => ({ ...g }));
  }
  if (q.includes('FROM grades WHERE id = ? AND is_active = TRUE')) {
    const grade = state.grades.find((g) => g.id === params[0] && Boolean(g.is_active));
    return grade ? [{ ...grade }] : [];
  }
  if (q.includes('FROM grades WHERE id = ?')) {
    const grade = state.grades.find((g) => g.id === params[0]);
    return grade ? [{ ...grade }] : [];
  }

  throw new Error(`fake db: unhandled SELECT: ${sql}`);
};

const runWrite = (sql: string, params: unknown[]): { affectedRows: number; insertId: number } => {
  state.executed.push({ sql, params });
  if (state.failWith) throw state.failWith;

  if (sql.includes('INSERT INTO attendance')) {
    const [studentId, courseId, groupId, attendanceDate, status, notes] = params;
    state.attendance.push({
      id: `att-${state.attendance.length + 1}`,
      student_id: studentId,
      course_id: courseId ?? null,
      group_id: groupId ?? null,
      attendance_date: attendanceDate,
      attendance_time: '09:00:00',
      status,
      notes: notes ?? null,
      marked_by: null,
      method: 'barcode',
      created_at: `2026-10-16T09:0${state.attendance.length}:00Z`,
    });
    return { affectedRows: 1, insertId: 0 };
  }
  if (sql.includes('UPDATE attendance')) {
    const [status, notes, attendanceDate, id] = params;
    const row = state.attendance.find((a) => a.id === id);
    if (!row) return { affectedRows: 0, insertId: 0 };
    if (status !== null && status !== undefined) row.status = status;
    if (notes !== null && notes !== undefined) row.notes = notes;
    if (attendanceDate !== null && attendanceDate !== undefined) row.attendance_date = attendanceDate;
    return { affectedRows: 1, insertId: 0 };
  }
  if (sql.includes('DELETE FROM attendance WHERE id = ?')) {
    const before = state.attendance.length;
    state.attendance = state.attendance.filter((a) => a.id !== params[0]);
    return { affectedRows: before - state.attendance.length, insertId: 0 };
  }
  if (sql.includes('INSERT INTO grades')) {
    const [id, name, displayOrder] = params;
    state.grades.push({
      id,
      name,
      display_order: displayOrder,
      is_active: 1,
      created_at: '2026-10-16T09:00:00Z',
      updated_at: '2026-10-16T09:00:00Z',
    });
    return { affectedRows: 1, insertId: 0 };
  }
  if (sql.includes('UPDATE grades SET name = ?')) {
    const [name, displayOrder, id] = params;
    const grade = state.grades.find((g) => g.id === id);
    if (!grade) return { affectedRows: 0, insertId: 0 };
    grade.name = name;
    grade.display_order = displayOrder;
    return { affectedRows: 1, insertId: 0 };
  }
  if (sql.includes('UPDATE grades SET is_active = FALSE')) {
    const grade = state.grades.find((g) => g.id === params[0]);
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

const fakeNotify = {
  sendWhatsAppMessage: async (to: string, body: string) => {
    state.notifyCalls.push({ to, body });
    return { success: true, whatsappLink: `https://wa.me/${to}` };
  },
};

const principalRepo: PrincipalRepository = {
  findUsersIdentity: async (id) => state.users[id] ?? null,
  findStaffIdentity: async (id) => state.staff[id] ?? null,
  findInstructorAccount: async (id) => state.instructorAccounts[id] ?? null,
  findStudentEnrollments: async () => [],
  findActiveTenantMemberships: async (id) => state.memberships[id] ?? [],
};

const teachingRepo: TeachingAccessRepository = {
  loadSelectedTenantMembership: async (userId, tenantId) => state.teachingMemberships[`${userId}:${tenantId}`] ?? null,
  loadStaffPagePermissions: async (userId) => state.staffPages[userId] ?? null,
};

// ---------------------------------------------------------------------------
// Harness: real express app, real routers, real auth middleware
// ---------------------------------------------------------------------------

const authenticate = createAuthenticateToken(principalRepo);
const optionalAuthenticate = createOptionalAuth(principalRepo);

const buildApp = (): express.Express => {
  const app = express();
  app.use(express.json());
  app.use('/api/attendance', createAttendanceRouter({
    db: fakeDb as never,
    authenticate,
    optionalAuthenticate,
    notify: fakeNotify,
    hasVerifiedPlatformCapability: async (userId) => state.platformUsers.has(userId),
  }));
  app.use('/api/grades', createGradesRouter({
    db: fakeDb as never,
    authenticate,
    optionalAuthenticate,
    requireGroupWrite: createRequireTeachingWrite('groups', teachingRepo),
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
  jwt.sign({ id: user.id, role: user.role, tv: 0, tenant_id: user.tenantId ?? null }, TEST_JWT_SECRET);

// ---------------------------------------------------------------------------
// Canonical fixture: two tenants, two instructors in tenant A, one in B
// ---------------------------------------------------------------------------

const seedBase = () => {
  state.users['instr-1'] = { is_active: 1, token_version: 0, suspension_active: 0 };
  state.users['instr-2'] = { is_active: 1, token_version: 0, suspension_active: 0 };
  state.users['instr-b'] = { is_active: 1, token_version: 0, suspension_active: 0 };
  state.users['super-1'] = { is_active: 1, token_version: 0, suspension_active: 0 };
  state.staff['staff-no-tenant'] = { is_active: 1 };
  state.staff['staff-revoked'] = { is_active: 0 };

  state.instructorAccounts['instr-1'] = { tenant_status: 'active', legacy_compat: 1, allowed: 1 };
  state.instructorAccounts['instr-2'] = { tenant_status: 'active', legacy_compat: 1, allowed: 1 };
  state.instructorAccounts['instr-b'] = { tenant_status: 'active', legacy_compat: 1, allowed: 1 };

  state.memberships['instr-1'] = [{ tenant_id: TENANT_A }];
  state.memberships['instr-2'] = [{ tenant_id: TENANT_A }];
  state.memberships['instr-b'] = [{ tenant_id: TENANT_B }];
  state.memberships['staff-no-tenant'] = [];
  state.platformUsers.add('super-1');

  state.students.push(
    { id: 's-own', tenant_id: TENANT_A, instructor_id: 'instr-1', group_id: 'g-1', barcode: 'BC-OWN', is_active: 1, name: 'Own Student', phone: '+201000000001', guardian_phone: '+201000000011' },
    { id: 's-foreign', tenant_id: TENANT_A, instructor_id: 'instr-2', group_id: 'g-2', barcode: 'BC-FOREIGN', is_active: 1, name: 'Foreign Student', phone: '+201000000002', guardian_phone: '+201000000012' },
    { id: 's-other-tenant', tenant_id: TENANT_B, instructor_id: 'instr-b', group_id: 'g-b', barcode: 'BC-B', is_active: 1, name: 'Other Tenant Student', phone: '+201000000003', guardian_phone: '+201000000013' },
    { id: 's-own-2', tenant_id: TENANT_A, instructor_id: 'instr-1', group_id: 'g-1', barcode: 'BC-OWN2', is_active: 1, name: 'Own Student Two', phone: '+201000000004', guardian_phone: '+201000000014' },
  );
  state.groups.push(
    { id: 'g-1', instructor_id: 'instr-1', course_id: 'c-a' },
    { id: 'g-2', instructor_id: 'instr-2', course_id: 'c-a' },
    { id: 'g-b', instructor_id: 'instr-b', course_id: 'c-b' },
  );
  state.courses.push(
    { id: 'c-a', tenant_id: TENANT_A },
    { id: 'c-b', tenant_id: TENANT_B },
    { id: 'c-unowned', tenant_id: null },
  );
  state.attendance.push(
    { id: 'a-own', student_id: 's-own', course_id: 'c-a', group_id: 'g-1', attendance_date: '2026-10-15', attendance_time: '09:00:00', status: 'present', notes: null, marked_by: null, method: 'manual', created_at: '2026-10-15T09:00:00Z' },
    { id: 'a-foreign', student_id: 's-foreign', course_id: 'c-a', group_id: 'g-2', attendance_date: '2026-10-15', attendance_time: '09:00:00', status: 'present', notes: null, marked_by: null, method: 'manual', created_at: '2026-10-15T09:05:00Z' },
    { id: 'a-b', student_id: 's-other-tenant', course_id: 'c-b', group_id: 'g-b', attendance_date: '2026-10-15', attendance_time: '09:00:00', status: 'present', notes: null, marked_by: null, method: 'manual', created_at: '2026-10-15T09:10:00Z' },
  );
  state.grades.push(
    { id: 'gr-active', name: 'Grade One', display_order: 1, is_active: 1, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
    { id: 'gr-deleted', name: 'Grade Two', display_order: 2, is_active: 0, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
  );
  state.teachingMemberships['instr-1:tenant-a'] = { role_key: 'instructor', user_is_active: 1, tenant_status: 'active', tenant_legacy_compat: 1, subscription_entitles: 0 };
  state.staffPages['staff-no-tenant'] = { accessible_pages: JSON.stringify(['groups']), is_active: 1 };
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

const instr1 = { id: 'instr-1', role: 'instructor', tenantId: TENANT_A };
const instr2 = { id: 'instr-2', role: 'instructor', tenantId: TENANT_A };
const super1 = { id: 'super-1', role: 'admin' };

// ---------------------------------------------------------------------------
// Attendance — authentication and namespace resolution
// ---------------------------------------------------------------------------

test('attendance rejects anonymous callers before any data access', async () => {
  await withState(seedBase, async (h) => {
    assert.equal((await api(h, 'GET', '/api/attendance', null)).status, 401);
    assert.equal((await api(h, 'GET', '/api/attendance/a-own', null)).status, 401);
    assert.equal((await api(h, 'POST', '/api/attendance', null, { student_id: 's-own' })).status, 401);
    assert.equal((await api(h, 'PUT', '/api/attendance/a-own', null, { status: 'absent' })).status, 401);
    assert.equal((await api(h, 'DELETE', '/api/attendance/a-own', null)).status, 401);
    assert.equal(state.executed.length, 0, 'an anonymous caller must not reach any query');
  });
});

test('a staff identity with no resolved workspace is 403, never anonymous', async () => {
  await withState(seedBase, async (h) => {
    const token = sign({ id: 'staff-no-tenant', role: 'staff' });
    const res = await api(h, 'GET', '/api/attendance', token);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /Workspace access required/);
    assert.equal(state.executed.length, 0);
  });
});

test('a revoked staff identity and a forged teacher role claim are rejected at authentication (401)', async () => {
  await withState(seedBase, async (h) => {
    const revoked = await api(h, 'GET', '/api/attendance', sign({ id: 'staff-revoked', role: 'staff' }));
    assert.equal(revoked.status, 401);

    // A 'teacher' token whose id has no live users row must not downgrade to anonymous.
    const forged = await api(h, 'GET', '/api/attendance', sign({ id: 'ghost-teacher', role: 'teacher' }));
    assert.equal(forged.status, 401);
    assert.equal(state.executed.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Attendance — instructor scope on reads
// ---------------------------------------------------------------------------

test('an instructor lists only attendance of their own students inside the selected tenant', async () => {
  await withState(seedBase, async (h) => {
    const res = await api(h, 'GET', '/api/attendance', sign(instr1));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((a: Row) => a.id), ['a-own']);

    const listSql = state.executed.find((e) => e.sql.includes('FROM attendance a'))!;
    assert.match(listSql.sql, /sc\.tenant_id = \?/);
    assert.match(listSql.sql, /sc\.instructor_id = \?/);
    assert.deepEqual(listSql.params, [TENANT_A, 'instr-1', 'instr-1']);
  });
});

test('an instructor cannot read a same-tenant student that belongs to another instructor', async () => {
  await withState(seedBase, async (h) => {
    const res = await api(h, 'GET', '/api/attendance/a-foreign', sign(instr1));
    assert.equal(res.status, 404, 'a record the caller may not act on is indistinguishable from missing');
  });
});

test('an instructor cannot read a record from another tenant', async () => {
  await withState(seedBase, async (h) => {
    const res = await api(h, 'GET', '/api/attendance/a-b', sign(instr1));
    assert.equal(res.status, 404);
  });
});

test('a verified platform operator reads across tenants', async () => {
  await withState(seedBase, async (h) => {
    const res = await api(h, 'GET', '/api/attendance', sign(super1));
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 3);
  });
});

// ---------------------------------------------------------------------------
// Attendance — write authorization and spoofed body ids
// ---------------------------------------------------------------------------

test('an instructor marks attendance for their own student and the row is stored with a server-derived group', async () => {
  await withState(seedBase, async (h) => {
    const res = await api(h, 'POST', '/api/attendance', sign(instr1), {
      student_id: 's-own-2',
      attendance_date: '2026-10-16',
      status: 'present',
    });
    assert.equal(res.status, 201);
    const insert = state.executed.find((e) => e.sql.includes('INSERT INTO attendance'))!;
    assert.equal(insert.params[0], 's-own-2');
    assert.equal(insert.params[2], 'g-1', 'group comes from the resolved student, not the client');
    assert.equal(state.attendance.at(-1)!.group_id, 'g-1');
  });
});

test('an instructor cannot mark attendance for a same-tenant student of another instructor (403, no insert)', async () => {
  await withState(seedBase, async (h) => {
    const res = await api(h, 'POST', '/api/attendance', sign(instr1), {
      student_id: 's-foreign',
      attendance_date: '2026-10-16',
    });
    assert.equal(res.status, 403);
    assert.equal(state.executed.some((e) => e.sql.includes('INSERT INTO attendance')), false);
    assert.equal(state.attendance.length, 3);
  });
});

test('an instructor cannot mark attendance for a student in another tenant (403, no insert)', async () => {
  await withState(seedBase, async (h) => {
    const res = await api(h, 'POST', '/api/attendance', sign(instr1), {
      student_id: 's-other-tenant',
      attendance_date: '2026-10-16',
    });
    assert.equal(res.status, 403);
    assert.equal(state.executed.some((e) => e.sql.includes('INSERT INTO attendance')), false);
  });
});

test('a barcode outside the caller scope is indistinguishable from an unknown barcode (404)', async () => {
  await withState(seedBase, async (h) => {
    const foreign = await api(h, 'POST', '/api/attendance', sign(instr1), { barcode: 'BC-FOREIGN', attendance_date: '2026-10-16' });
    assert.equal(foreign.status, 404);
    const unknown = await api(h, 'POST', '/api/attendance', sign(instr1), { barcode: 'BC-NOPE', attendance_date: '2026-10-16' });
    assert.equal(unknown.status, 404);
    assert.equal(state.executed.some((e) => e.sql.includes('INSERT INTO attendance')), false);
  });
});

test('a spoofed group_id that disagrees with the resolved student is rejected (400, no insert)', async () => {
  await withState(seedBase, async (h) => {
    const res = await api(h, 'POST', '/api/attendance', sign(instr1), {
      student_id: 's-own',
      group_id: 'g-2',
      attendance_date: '2026-10-16',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /group_id does not match the student group/);
    assert.equal(state.executed.some((e) => e.sql.includes('INSERT INTO attendance')), false);
  });
});

test('a matching group_id is accepted and stored', async () => {
  await withState(seedBase, async (h) => {
    const res = await api(h, 'POST', '/api/attendance', sign(instr1), {
      student_id: 's-own-2',
      group_id: 'g-1',
      attendance_date: '2026-10-16',
    });
    assert.equal(res.status, 201);
  });
});

test('a course id outside the tenant is 403 and an unknown course id is 404', async () => {
  await withState(seedBase, async (h) => {
    const foreign = await api(h, 'POST', '/api/attendance', sign(instr1), {
      student_id: 's-own-2', course_id: 'c-b', attendance_date: '2026-10-16',
    });
    assert.equal(foreign.status, 403);

    const unowned = await api(h, 'POST', '/api/attendance', sign(instr1), {
      student_id: 's-own-2', course_id: 'c-unowned', attendance_date: '2026-10-16',
    });
    assert.equal(unowned.status, 403, 'a course with no provable tenant owner never matches');

    const unknown = await api(h, 'POST', '/api/attendance', sign(instr1), {
      student_id: 's-own-2', course_id: 'c-nope', attendance_date: '2026-10-16',
    });
    assert.equal(unknown.status, 404);
    assert.equal(state.executed.some((e) => e.sql.includes('INSERT INTO attendance')), false);
  });
});

test('duplicate attendance for the same student and day is a 409 with no second row', async () => {
  await withState(seedBase, async (h) => {
    const res = await api(h, 'POST', '/api/attendance', sign(instr1), {
      student_id: 's-own',
      attendance_date: '2026-10-15',
    });
    assert.equal(res.status, 409);
    assert.equal(state.attendance.filter((a) => a.student_id === 's-own' && day(a.attendance_date) === '2026-10-15').length, 1);
  });
});

// ---------------------------------------------------------------------------
// Attendance — update / delete ownership
// ---------------------------------------------------------------------------

test('update and delete of an out-of-scope record fail closed (404) with no mutation', async () => {
  await withState(seedBase, async (h) => {
    const put = await api(h, 'PUT', '/api/attendance/a-foreign', sign(instr1), { status: 'absent' });
    assert.equal(put.status, 404);
    const del = await api(h, 'DELETE', '/api/attendance/a-b', sign(instr1));
    assert.equal(del.status, 404);

    assert.equal(state.attendance.find((a) => a.id === 'a-foreign')!.status, 'present');
    assert.ok(state.attendance.find((a) => a.id === 'a-b'));
    assert.equal(state.executed.some((e) => e.sql.includes('UPDATE attendance') || e.sql.includes('DELETE FROM attendance')), false);
  });
});

test('the owner updates and deletes their own record', async () => {
  await withState(seedBase, async (h) => {
    const put = await api(h, 'PUT', '/api/attendance/a-own', sign(instr1), { status: 'excused', notes: 'approved leave' });
    assert.equal(put.status, 200);
    assert.equal(state.attendance.find((a) => a.id === 'a-own')!.status, 'excused');

    const del = await api(h, 'DELETE', '/api/attendance/a-own', sign(instr1));
    assert.equal(del.status, 200);
    assert.equal(state.attendance.find((a) => a.id === 'a-own'), undefined);
  });
});

test('moving a record onto a day the student already has fails with 409', async () => {
  await withState(seedBase, async (h) => {
    state.attendance.push({
      id: 'a-own-16', student_id: 's-own', course_id: 'c-a', group_id: 'g-1', attendance_date: '2026-10-16',
      attendance_time: '09:00:00', status: 'present', notes: null, marked_by: null, method: 'manual', created_at: '2026-10-16T09:00:00Z',
    });
    const res = await api(h, 'PUT', '/api/attendance/a-own', sign(instr1), { attendance_date: '2026-10-16' });
    assert.equal(res.status, 409);
  });
});

// ---------------------------------------------------------------------------
// Attendance — input validation and failure handling
// ---------------------------------------------------------------------------

test('attendance write inputs are validated against the schema (4xx, never a driver error)', async () => {
  await withState(seedBase, async (h) => {
    assert.equal((await api(h, 'POST', '/api/attendance', sign(instr1), { student_id: 's-own-2', status: 'bogus' })).status, 400);
    assert.equal((await api(h, 'POST', '/api/attendance', sign(instr1), { student_id: 's-own-2', attendance_date: 'not-a-day' })).status, 400);
    assert.equal((await api(h, 'POST', '/api/attendance', sign(instr1), { student_id: 's-own-2', notes: 'x'.repeat(2001) })).status, 400);
    assert.equal((await api(h, 'POST', '/api/attendance', sign(instr1), { attendance_date: '2026-10-16' })).status, 400);
    assert.equal((await api(h, 'PUT', '/api/attendance/a-own', sign(instr1), { status: 'bogus' })).status, 400);
    assert.equal(state.executed.some((e) => e.sql.includes('INSERT INTO attendance')), false);
  });
});

test('an absent attendance_date still defaults to the current day (default preserved)', async () => {
  await withState(seedBase, async (h) => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await api(h, 'POST', '/api/attendance', sign(instr1), { student_id: 's-own-2' });
    assert.equal(res.status, 201);
    const insert = state.executed.find((e) => e.sql.includes('INSERT INTO attendance'))!;
    assert.equal(insert.params[3], today);
  });
});

test('attendance surfaces a storage failure as 500, never as success', async () => {
  await withState(seedBase, async (h) => {
    state.failWith = new Error('simulated db outage');
    assert.equal((await api(h, 'GET', '/api/attendance', sign(instr1))).status, 500);
    assert.equal((await api(h, 'POST', '/api/attendance', sign(instr1), { student_id: 's-own-2', attendance_date: '2026-10-16' })).status, 500);
  });
});

// ---------------------------------------------------------------------------
// Attendance — notify-absent group scope
// ---------------------------------------------------------------------------

test('notify-absent refuses a group outside the caller scope before any notification', async () => {
  await withState(seedBase, async (h) => {
    const res = await api(h, 'POST', '/api/attendance/notify-absent', sign(instr1), { group_id: 'g-b', date: '2026-10-16' });
    assert.equal(res.status, 403);
    assert.equal(state.notifyCalls.length, 0);
  });
});

test('notify-absent notifies guardians only for in-scope absent students', async () => {
  await withState(seedBase, async (h) => {
    const res = await api(h, 'POST', '/api/attendance/notify-absent', sign(instr1), { group_id: 'g-1', date: '2026-10-16' });
    assert.equal(res.status, 200);
    assert.equal(res.body.absent, 2, 'both own students are absent on the chosen day');
    assert.equal(state.notifyCalls.length, 2);
    assert.ok(state.notifyCalls.every((c) => c.body.includes('Own Student')));
  });
});

// ---------------------------------------------------------------------------
// Grades — read boundary
// ---------------------------------------------------------------------------

test('grades reject anonymous readers and serve authenticated ones', async () => {
  await withState(seedBase, async (h) => {
    assert.equal((await api(h, 'GET', '/api/grades', null)).status, 401);
    const res = await api(h, 'GET', '/api/grades', sign(instr1));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((g: Row) => g.id), ['gr-active']);
  });
});

// ---------------------------------------------------------------------------
// Grades — write entitlement (real teaching-write guard)
// ---------------------------------------------------------------------------

test('grades writes are denied without a selected-tenant teaching membership', async () => {
  await withState(seedBase, async (h) => {
    // A bare admin role claim carries no tenant membership and never satisfies the guard.
    const adminClaim = await api(h, 'POST', '/api/grades', sign({ id: 'ghost-admin', role: 'admin' }), { name: 'X' });
    assert.equal(adminClaim.status, 401, 'a forged admin claim fails authentication');

    const adminNoMembership = await api(h, 'POST', '/api/grades', sign({ id: 'super-1', role: 'admin' }), { name: 'X' });
    assert.equal(adminNoMembership.status, 403, 'a platform admin without a tenant membership is denied here');

    assert.equal(state.executed.some((e) => e.sql.includes('INSERT INTO grades')), false);
  });
});

test('grades writes are allowed for an entitled instructor of the selected tenant', async () => {
  await withState(seedBase, async (h) => {
    const created = await api(h, 'POST', '/api/grades', sign(instr1), { name: 'Grade Three', display_order: 3 });
    assert.equal(created.status, 201);
    assert.ok(created.body.id, 'the id is generated server-side');
    assert.ok(state.grades.some((g) => g.id === created.body.id && g.name === 'Grade Three'));

    const updated = await api(h, 'PUT', '/api/grades/gr-active', sign(instr1), { name: 'Grade One Updated' });
    assert.equal(updated.status, 200);
    assert.equal(state.grades.find((g) => g.id === 'gr-active')!.name, 'Grade One Updated');

    const deleted = await api(h, 'DELETE', '/api/grades/gr-active', sign(instr1));
    assert.equal(deleted.status, 200);
    assert.equal(state.grades.find((g) => g.id === 'gr-active')!.is_active, 0);
  });
});

test('a soft-deleted grade cannot be edited or resurrected (404)', async () => {
  await withState(seedBase, async (h) => {
    assert.equal((await api(h, 'PUT', '/api/grades/gr-deleted', sign(instr1), { name: 'Nope' })).status, 404);
    assert.equal((await api(h, 'DELETE', '/api/grades/gr-deleted', sign(instr1))).status, 404);
    assert.equal(state.grades.find((g) => g.id === 'gr-deleted')!.name, 'Grade Two');
  });
});

test('grade write inputs are validated before any statement runs', async () => {
  await withState(seedBase, async (h) => {
    assert.equal((await api(h, 'POST', '/api/grades', sign(instr1), {})).status, 400);
    assert.equal((await api(h, 'POST', '/api/grades', sign(instr1), { name: '   ' })).status, 400);
    assert.equal((await api(h, 'POST', '/api/grades', sign(instr1), { name: 'x'.repeat(256) })).status, 400);
    assert.equal((await api(h, 'POST', '/api/grades', sign(instr1), { name: 'Ok', display_order: 'first' })).status, 400);
    assert.equal(state.executed.some((e) => e.sql.includes('INSERT INTO grades')), false);
  });
});

test('a staff identity needs the groups page permission in addition to membership', async () => {
  await withState(() => {
    seedBase();
    // Staff membership in the selected tenant, but the area page permission is absent.
    state.memberships['staff-no-tenant'] = [{ tenant_id: TENANT_A }];
    state.teachingMemberships['staff-no-tenant:tenant-a'] = { role_key: 'instructor', user_is_active: 1, tenant_status: 'active', tenant_legacy_compat: 1, subscription_entitles: 0 };
    state.staffPages['staff-no-tenant'] = { accessible_pages: JSON.stringify(['students']), is_active: 1 };
  }, async (h) => {
    const token = sign({ id: 'staff-no-tenant', role: 'staff', tenantId: TENANT_A });
    const denied = await api(h, 'POST', '/api/grades', token, { name: 'Blocked' });
    assert.equal(denied.status, 403);

    state.staffPages['staff-no-tenant'] = { accessible_pages: JSON.stringify(['groups']), is_active: 1 };
    const allowed = await api(h, 'POST', '/api/grades', token, { name: 'Allowed' });
    assert.equal(allowed.status, 201);
  });
});
