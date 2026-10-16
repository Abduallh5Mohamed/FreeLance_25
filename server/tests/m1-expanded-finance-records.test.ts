import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import jwt from 'jsonwebtoken';
import type { NextFunction, RequestHandler, Router } from 'express';
import { createAuthenticateToken, requireRoles } from '../src/middleware/auth';
import type { PrincipalRepository } from '../src/security/principal-repository';
import { createFeesRouter, FeesDataAccess } from '../src/routes/fees';
import { createExpensesRouter } from '../src/routes/expenses';
import { createRevenuesRouter } from '../src/routes/revenues';

/**
 * M1 expanded finance-records regression suite (behavioral, hermetic).
 *
 * Drives the PRODUCTION fees, expenses, and revenues routers
 * (createFeesRouter / createExpensesRouter / createRevenuesRouter) through
 * injected seams: a fixture-backed SQL adapter, the REAL authentication
 * middleware (createAuthenticateToken over an injected principal repository),
 * the REAL role gate (requireRoles), and fixture-backed stand-ins for the two
 * server-owned authority lookups the routers consume in production (platform
 * finance capability via admin_user_roles, and active tenant authority via
 * tenant_memberships.role_key / tenants.owner_user_id). No database,
 * network, Docker, or real service is contacted.
 *
 * Authority model under test (deny by default):
 *  - verified platform capability (super_admin or the seeded finance.read
 *    key) grants cross-tenant READS only;
 *  - the verified tenant owner (tenants.owner_user_id or an active
 *    membership with role_key 'owner') holds tenant-wide financial authority;
 *  - an active membership with role_key 'instructor' is NOT tenant-wide: it
 *    reaches only fees of students precisely assigned to it
 *    (students.instructor_id or students.group_id in its own groups);
 *  - active membership alone (teacher/staff role_key) grants nothing, and a
 *    bare 'admin' JWT role label grants nothing.
 *
 * Evidence classes used below, labeled per test:
 *  - behavioral: the real handler's own JS decision (status codes, denied
 *    side effects such as absent INSERT/UPDATE/DELETE or unchanged fixture
 *    rows, values returned to the caller);
 *  - decision-boundary (SQL text + params of the executed query): scoping is
 *    applied by MySQL WHERE clauses, so hermetically we assert the exact SQL
 *    and bindings the real handler executed. Live row-level filtering remains
 *    the Docker integration suite's responsibility (NOT RUN here).
 *
 * Scope note: the global /api middlewares (optionalAuth, tenant-authority
 * boundary) live outside this task's allowedPaths; the injected
 * authenticate seam replicates the production authenticateToken exactly.
 */

const TEST_SECRET = 'test-only-secret-with-sufficient-length';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

// ---------------------------------------------------------------------------
// Fixtures: two tenants, their owners, an assigned instructor, unrelated
// teachers/staff, students, groups, and financial rows.
// ---------------------------------------------------------------------------

interface StudentRow {
    id: string; tenant_id: string; name: string; phone: string;
    guardian_phone: string; barcode: string; grade_id: string | null;
    group_id: string | null; instructor_id: string | null;
}
interface ExpenseRow { id: string; tenant_id: string; description: string; amount: number; category: string | null; date: string; time: string | null }
interface RevenueRow { id: string; tenant_id: string; amount: number; source: string; description: string | null; date: string }
interface FeeRow {
    id: string; tenant_id: string; student_id: string | null; student_name: string;
    amount: number; paid_amount: number; status: string; payment_year: number; payment_month: number;
}
interface MembershipRow { tenant_id: string; role_key: string }

interface Fixtures {
    users: Record<string, { is_active: number; token_version: number; suspension_active: number }>;
    staff: Record<string, { is_active: number }>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    memberships: Record<string, MembershipRow[]>;
    enrollments: Record<string, Array<{
        id: string; user_id: string; tenant_id: string;
        instructor_id: string | null; group_id: string | null; grade_id: string | null;
    }>>;
    /** tenants.owner_user_id mirror. */
    tenants: Record<string, { owner_user_id: string }>;
    /** Platform-admin role codes per user (admin_user_roles mirror). */
    adminRoles: Record<string, string[]>;
    /** Platform permission keys per user (admin_role_permissions mirror). */
    adminPermissions: Record<string, string[]>;
    students: StudentRow[];
    courses: Array<{ id: string; tenant_id: string }>;
    groups: Array<{ id: string; course_id: string | null; instructor_id: string | null }>;
    expenses: ExpenseRow[];
    revenues: RevenueRow[];
    fees: FeeRow[];
}

const makeFixtures = (): Fixtures => ({
    users: {
        'teacher-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'teacher-b': { is_active: 1, token_version: 0, suspension_active: 0 },
        'teacher-none': { is_active: 1, token_version: 0, suspension_active: 0 },
        'staff-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'instructor-c': { is_active: 1, token_version: 0, suspension_active: 0 },
        'owner-b': { is_active: 1, token_version: 0, suspension_active: 0 },
        'student-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'admin-x': { is_active: 1, token_version: 0, suspension_active: 0 },
        'admin-super': { is_active: 1, token_version: 0, suspension_active: 0 },
        'admin-fin': { is_active: 1, token_version: 0, suspension_active: 0 },
    },
    staff: {},
    instructorAccounts: {
        'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'instructor-c': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'owner-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
    },
    memberships: {
        'teacher-a': [{ tenant_id: 'tenant-a', role_key: 'teacher' }],
        'teacher-b': [{ tenant_id: 'tenant-b', role_key: 'teacher' }],
        'teacher-none': [],
        'staff-a': [{ tenant_id: 'tenant-a', role_key: 'staff' }],
        'instructor-a': [{ tenant_id: 'tenant-a', role_key: 'owner' }],
        'instructor-c': [{ tenant_id: 'tenant-a', role_key: 'instructor' }],
        'owner-b': [{ tenant_id: 'tenant-b', role_key: 'owner' }],
    },
    enrollments: {
        'student-a': [{
            id: 'enrollment-a', user_id: 'student-a', tenant_id: 'tenant-a',
            instructor_id: 'instructor-a', group_id: 'group-a', grade_id: 'grade-a',
        }],
    },
    tenants: {
        'tenant-a': { owner_user_id: 'instructor-a' },
        'tenant-b': { owner_user_id: 'owner-b' },
    },
    adminRoles: {
        'admin-super': ['super_admin'],
    },
    adminPermissions: {
        'admin-super': ['finance.read', 'finance.export'],
        'admin-fin': ['finance.read'],
    },
    students: [
        { id: 'student-a', tenant_id: 'tenant-a', name: 'Paid Student', phone: '01000', guardian_phone: '01001', barcode: 'BC-A', grade_id: 'grade-a', group_id: 'group-a', instructor_id: 'instructor-c' },
        { id: 'student-d', tenant_id: 'tenant-a', name: 'Assigned Student', phone: '01004', guardian_phone: '01005', barcode: 'BC-D', grade_id: 'grade-a', group_id: null, instructor_id: 'instructor-c' },
        { id: 'student-plain', tenant_id: 'tenant-a', name: 'Plain Student', phone: '01002', guardian_phone: '01003', barcode: 'BC-P', grade_id: 'grade-a', group_id: null, instructor_id: null },
        { id: 'student-b', tenant_id: 'tenant-b', name: 'Tenant B Student', phone: '02000', guardian_phone: '02001', barcode: 'BC-B', grade_id: 'grade-b', group_id: 'group-b', instructor_id: null },
    ],
    courses: [
        { id: 'course-a', tenant_id: 'tenant-a' },
        { id: 'course-b', tenant_id: 'tenant-b' },
    ],
    groups: [
        { id: 'group-a', course_id: 'course-a', instructor_id: 'instructor-c' },
        { id: 'group-b', course_id: 'course-b', instructor_id: null },
        { id: 'group-orphan', course_id: null, instructor_id: null },
    ],
    expenses: [
        { id: 'exp-a', tenant_id: 'tenant-a', description: 'Tenant A rent', amount: 500, category: 'rent', date: '2026-10-01', time: '09:00:00' },
        { id: 'exp-b', tenant_id: 'tenant-b', description: 'Tenant B supplies', amount: 120, category: 'supplies', date: '2026-10-02', time: '10:00:00' },
    ],
    revenues: [
        { id: 'rev-a', tenant_id: 'tenant-a', amount: 300, source: 'student_fees', description: 'Tenant A fee', date: '2026-10-01' },
        { id: 'rev-b', tenant_id: 'tenant-b', amount: 90, source: 'student_fees', description: 'Tenant B fee', date: '2026-10-03' },
    ],
    fees: [
        { id: 'fee-a', tenant_id: 'tenant-a', student_id: 'student-a', student_name: 'Paid Student', amount: 200, paid_amount: 200, status: 'paid', payment_year: 2026, payment_month: 10 },
        { id: 'fee-b', tenant_id: 'tenant-b', student_id: 'student-b', student_name: 'Tenant B Student', amount: 80, paid_amount: 0, status: 'pending', payment_year: 2026, payment_month: 10 },
        { id: 'fee-c', tenant_id: 'tenant-a', student_id: 'student-plain', student_name: 'Plain Student', amount: 50, paid_amount: 0, status: 'pending', payment_year: 2026, payment_month: 11 },
    ],
});

const makeRepository = (f: Fixtures): PrincipalRepository => ({
    findUsersIdentity: async (id) => f.users[id] ?? null,
    findStaffIdentity: async (id) => f.staff[id] ?? null,
    findInstructorAccount: async (id) => f.instructorAccounts[id] ?? null,
    findStudentEnrollments: async (id) => f.enrollments[id] ?? [],
    findActiveTenantMemberships: async (id) => f.memberships[id] ?? [],
});

// ---------------------------------------------------------------------------
// Fixture SQL adapter: answers the exact query shapes the routers issue,
// enforcing the same predicates MySQL would enforce.
// ---------------------------------------------------------------------------

interface ExecutedStatement { sql: string; params: unknown[] }

const makeDb = (f: Fixtures): { executed: ExecutedStatement[] } & FeesDataAccess => {
    const executed: ExecutedStatement[] = [];
    let idCounter = 0;
    const nextId = (prefix: string) => `${prefix}-new-${++idCounter}`;

    const record = (sql: string, params: unknown[]) => { executed.push({ sql, params }); };

    /** The tenant predicate the real handler appended, if any. */
    const tenantPredicate = (sql: string): boolean => /AND tenant_id=\?/.test(sql);

    /** Students precisely assigned to one instructor (own or via own group). */
    const assignedStudentIds = (userId: string): Set<string> => {
        const ownGroups = new Set(f.groups.filter((g) => g.instructor_id === userId).map((g) => g.id));
        return new Set(f.students
            .filter((s) => s.instructor_id === userId || (s.group_id !== null && ownGroups.has(s.group_id)))
            .map((s) => s.id));
    };

    const feeMatchesInstructorScope = (fee: FeeRow, tenantId: unknown, userId: unknown): boolean =>
        fee.tenant_id === tenantId && fee.student_id !== null && assignedStudentIds(String(userId)).has(fee.student_id);

    const applyUpdate = (table: 'student_fees' | 'expenses', sql: string, params: unknown[]): number => {
        const setMatch = /SET([\s\S]*?)WHERE/i.exec(sql);
        assert.ok(setMatch, `unparsable update: ${sql}`);
        // Bound columns only: `col = COALESCE(?` (fees) or `col = ?` (expenses).
        // Never split the SET clause on commas: COALESCE's own argument comma
        // would misalign the column/binding zip.
        const columns = [...setMatch[1].matchAll(/([a-z_]+)\s*=\s*(?:COALESCE\(\s*\?|\?)/gi)]
            .map((match) => match[1]);
        const hasTenant = tenantPredicate(sql);
        const instructorScoped = sql.includes('s.instructor_id');
        // Trailing bindings: [id, tenantId] or, for the instructor predicate,
        // [id, tenantId, userId, userId].
        const tail = instructorScoped ? 4 : hasTenant ? 2 : 1;
        const values = params.slice(0, params.length - tail);
        const id = params[params.length - tail];
        const tenant = hasTenant ? params[params.length - tail + 1] : undefined;
        const rows: Array<Record<string, unknown>> = table === 'student_fees'
            ? (f.fees as unknown as Array<Record<string, unknown>>)
            : (f.expenses as unknown as Array<Record<string, unknown>>);
        const row = rows.find((r) => r.id === id
            && (tenant === undefined || r.tenant_id === tenant)
            && (!instructorScoped || feeMatchesInstructorScope(r as unknown as FeeRow, tenant, params[params.length - 2])));
        if (!row) return 0;
        columns.forEach((column, index) => {
            // COALESCE(?, col) and plain `col = ?` both leave the stored value
            // intact when the binding is null.
            if (values[index] !== null && values[index] !== undefined) row[column] = values[index];
        });
        return 1;
    };

    const respond = (sql: string, params: unknown[]): unknown[] => {
        if (sql.includes('SELECT id FROM student_fees')) {
            // instructor fee-authority probe
            const [id, tenantId, userId] = params as [string, string, string];
            const fee = f.fees.find((row) => row.id === id && feeMatchesInstructorScope(row, tenantId, userId));
            return fee ? [{ id: fee.id }] : [];
        }
        if (sql.includes('SELECT * FROM student_fees WHERE id = ?')) {
            const id = params[0];
            if (sql.includes('s.instructor_id')) {
                const [, tenantId, userId] = params as [string, string, string];
                const fee = f.fees.find((row) => row.id === id && feeMatchesInstructorScope(row, tenantId, userId));
                return fee ? [fee] : [];
            }
            const tenantId = tenantPredicate(sql) ? params[params.length - 1] : undefined;
            const fee = f.fees.find((row) => row.id === id
                && (tenantId === undefined || row.tenant_id === tenantId));
            return fee ? [fee] : [];
        }
        if (sql.includes('SELECT * FROM student_fees WHERE 1=1')) {
            if (sql.includes('s.instructor_id')) {
                const [tenantId, userId] = params as [string, string];
                return f.fees.filter((fee) => feeMatchesInstructorScope(fee, tenantId, userId));
            }
            const tenantId = tenantPredicate(sql) ? params[0] : undefined;
            return f.fees.filter((fee) => tenantId === undefined || fee.tenant_id === tenantId);
        }
        if (sql.includes("status = 'paid'") && sql.includes('FROM student_fees')) {
            // duplicate-month guard probe
            const [studentId, tenantId, year, month] = params as [string, string, number, number];
            const paid = f.fees.find((fee) =>
                fee.student_id === studentId && fee.tenant_id === tenantId
                && fee.payment_year === year && fee.payment_month === month && fee.status === 'paid');
            return paid ? [paid] : [];
        }
        if (sql.includes('(instructor_id')) {
            // instructor assigned-student probe (own student or own-group student)
            const [id, userId] = params as [string, string];
            return assignedStudentIds(userId).has(id) ? [{ id }] : [];
        }
        if (sql.includes('FROM `groups` WHERE id=? AND instructor_id=?')) {
            // instructor own-group probe
            const [id, userId] = params as [string, string];
            const group = f.groups.find((g) => g.id === id && g.instructor_id === userId);
            return group ? [{ id: group.id }] : [];
        }
        if (sql.includes('FROM `groups`') && sql.includes('LEFT JOIN courses')) {
            // owner group-ownership probe (group -> course -> tenant)
            const [id, tenantId] = params as [string, string];
            const group = f.groups.find((g) => g.id === id);
            if (!group || !group.course_id) return [];
            const course = f.courses.find((c) => c.id === group.course_id);
            return course && course.tenant_id === tenantId ? [{ id: group.id }] : [];
        }
        if (sql.includes('SELECT id FROM students')) {
            // owner student-ownership probe
            const [id, tenantId] = params as [string, string];
            const student = f.students.find((s) => s.id === id && s.tenant_id === tenantId);
            return student ? [{ id: student.id }] : [];
        }
        if (sql.includes('FROM students')) {
            // fees POST student resolution probes (barcode / phone / name LIKE)
            const tenantId = params[params.length - 1];
            if (sql.includes('s.barcode = ?')) {
                const barcode = params[0];
                const student = f.students.find((s) => s.tenant_id === tenantId && s.barcode === barcode);
                return student ? [{ ...student, grade_name: 'Grade', group_name: 'Group' }] : [];
            }
            if (sql.includes('s.phone = ?')) {
                const phone = params[0];
                const student = f.students.find((s) => s.tenant_id === tenantId && s.phone === phone);
                return student ? [{ ...student, grade_name: 'Grade', group_name: 'Group' }] : [];
            }
            const like = String(params[0]).replace(/%/g, '');
            const student = f.students.find((s) => s.tenant_id === tenantId && s.name.includes(like));
            return student ? [{ ...student, grade_name: 'Grade', group_name: 'Group' }] : [];
        }
        if (sql.includes('SELECT * FROM expenses WHERE id = ?')) {
            const id = params[0];
            const tenantId = tenantPredicate(sql) ? params[params.length - 1] : undefined;
            const expense = f.expenses.find((row) => row.id === id
                && (tenantId === undefined || row.tenant_id === tenantId));
            return expense ? [expense] : [];
        }
        if (sql.includes('SELECT * FROM expenses WHERE 1=1')) {
            const tenantId = tenantPredicate(sql) ? params[0] : undefined;
            return f.expenses.filter((row) => tenantId === undefined || row.tenant_id === tenantId);
        }
        if (sql.includes('SELECT * FROM revenues WHERE 1=1')) {
            const tenantId = tenantPredicate(sql) ? params[0] : undefined;
            return f.revenues.filter((row) => tenantId === undefined || row.tenant_id === tenantId);
        }
        if (sql.includes('DATE_FORMAT')) {
            // revenues stats aggregation (canned; scoping asserted via SQL + bindings)
            return [{ total_revenue: 300, total_count: 1, source: 'student_fees', month: '2026-10' }];
        }
        return [];
    };

    const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
        record(sql, params);
        return respond(sql, params) as T[];
    };
    const queryOne = async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
        record(sql, params);
        const rows = respond(sql, params);
        return (rows.length > 0 ? rows[0] : null) as T | null;
    };
    const execute = async (sql: string, params: unknown[] = []) => {
        record(sql, params);
        if (sql.includes('INSERT INTO student_fees')) {
            const id = nextId('fee');
            f.fees.push({
                id,
                tenant_id: params[0] as string,
                student_id: (params[1] as string | null) ?? null,
                student_name: params[2] as string,
                amount: params[10] as number,
                paid_amount: params[11] as number,
                status: params[12] as string,
                payment_year: params[18] as number,
                payment_month: params[19] as number,
            });
            return { affectedRows: 1, insertId: id, warningStatus: 0 } as never;
        }
        if (sql.includes('INSERT INTO expenses')) {
            const id = nextId('exp');
            f.expenses.push({
                id,
                tenant_id: params[0] as string,
                description: params[1] as string,
                amount: params[2] as number,
                category: (params[3] as string | null) ?? null,
                date: params[4] as string,
                time: (params[5] as string | null) ?? null,
            });
            return { affectedRows: 1, insertId: id, warningStatus: 0 } as never;
        }
        if (sql.includes('INSERT INTO revenues')) {
            const id = nextId('rev');
            f.revenues.push({
                id,
                tenant_id: params[0] as string,
                amount: params[1] as number,
                source: params[2] as string,
                description: (params[3] as string | null) ?? null,
                date: params[4] as string,
            });
            return { affectedRows: 1, insertId: id, warningStatus: 0 } as never;
        }
        if (sql.includes('UPDATE student_fees')) {
            return { affectedRows: applyUpdate('student_fees', sql, params), insertId: 0, warningStatus: 0 } as never;
        }
        if (sql.includes('UPDATE expenses')) {
            return { affectedRows: applyUpdate('expenses', sql, params), insertId: 0, warningStatus: 0 } as never;
        }
        if (sql.includes('DELETE FROM student_fees')) {
            const id = params[0] as string;
            if (sql.includes('s.instructor_id')) {
                const index = f.fees.findIndex((row) => row.id === id
                    && feeMatchesInstructorScope(row, params[1], params[2]));
                if (index === -1) return { affectedRows: 0, insertId: 0, warningStatus: 0 } as never;
                f.fees.splice(index, 1);
                return { affectedRows: 1, insertId: 0, warningStatus: 0 } as never;
            }
            const tenantId = tenantPredicate(sql) ? params[1] : undefined;
            const index = f.fees.findIndex((row) => row.id === id
                && (tenantId === undefined || row.tenant_id === tenantId));
            if (index === -1) return { affectedRows: 0, insertId: 0, warningStatus: 0 } as never;
            f.fees.splice(index, 1);
            return { affectedRows: 1, insertId: 0, warningStatus: 0 } as never;
        }
        if (sql.includes('DELETE FROM expenses')) {
            const id = params[0] as string;
            const tenantId = tenantPredicate(sql) ? params[1] : undefined;
            const index = f.expenses.findIndex((row) => row.id === id
                && (tenantId === undefined || row.tenant_id === tenantId));
            if (index === -1) return { affectedRows: 0, insertId: 0, warningStatus: 0 } as never;
            f.expenses.splice(index, 1);
            return { affectedRows: 1, insertId: 0, warningStatus: 0 } as never;
        }
        throw new Error(`unexpected statement: ${sql}`);
    };

    return { executed, query, queryOne, execute };
};

// ---------------------------------------------------------------------------
// Harness: production routers over injected seams
// ---------------------------------------------------------------------------

type PlatformLookup = (userId: string) => Promise<boolean>;
type AuthorityLookup = (userId: string, tenantId: string) => Promise<{ authority: string } | null>;

const makeHarness = (
    fixtures: Fixtures = makeFixtures(),
    platformLookup?: PlatformLookup,
    authorityLookup?: AuthorityLookup,
) => {
    const db = makeDb(fixtures);
    const repository = makeRepository(fixtures);
    const authenticate = createAuthenticateToken(repository) as RequestHandler;
    const authorize = requireRoles('admin', 'instructor', 'teacher', 'staff');
    // Mirrors the production createPlatformPermissionCheck('finance.read'):
    // a verified active super_admin OR a seeded finance.read permission key.
    // A bare 'admin' role label never satisfies it.
    const hasVerifiedPlatformFinanceAccess = platformLookup ?? (async (userId: string) => {
        const roles = fixtures.adminRoles[userId] ?? [];
        const permissions = fixtures.adminPermissions[userId] ?? [];
        return roles.includes('super_admin') || permissions.includes('finance.read');
    });
    // Mirrors the production loadActiveTenantAuthority SQL: the verified
    // tenant owner row, else an active membership with role_key owner or
    // instructor in an active tenant.
    const loadActiveTenantAuthority = authorityLookup ?? (async (userId: string, tenantId: string) => {
        const tenant = fixtures.tenants[tenantId];
        if (tenant && tenant.owner_user_id === userId) return { authority: 'owner' };
        const membership = (fixtures.memberships[userId] ?? []).find((m) => m.tenant_id === tenantId);
        if (membership && (membership.role_key === 'owner' || membership.role_key === 'instructor')) {
            return { authority: membership.role_key };
        }
        return null;
    });
    return {
        fixtures,
        executed: db.executed,
        fees: createFeesRouter({ db, authenticate, authorize, hasVerifiedPlatformFinanceAccess, loadActiveTenantAuthority }),
        expenses: createExpensesRouter({ db, authenticate, authorize, hasVerifiedPlatformFinanceAccess, loadActiveTenantAuthority }),
        revenues: createRevenuesRouter({ db, authenticate, authorize, hasVerifiedPlatformFinanceAccess, loadActiveTenantAuthority }),
    };
};

interface RouteRequest {
    method: string;
    url: string;
    token?: string | null;
    body?: unknown;
    query?: Record<string, unknown>;
}

interface CapturedResponse {
    statusCode?: number;
    body?: unknown;
    status(code: number): CapturedResponse;
    json(payload: unknown): CapturedResponse;
}

const invokeRoute = async (
    router: Router,
    request: RouteRequest,
): Promise<CapturedResponse> => {
    const response: CapturedResponse = {
        status(code: number) { response.statusCode = code; return response; },
        json(payload: unknown) { response.body = payload; return response; },
    };
    const req = {
        method: request.method,
        url: request.url,
        originalUrl: request.url,
        headers: request.token ? { authorization: `Bearer ${request.token}` } : {},
        body: request.body ?? {},
        query: request.query ?? {},
    };
    await (router as unknown as (r: unknown, s: unknown, n: NextFunction) => Promise<void>)(req, response, () => {});
    // Express does not await async handlers; poll (bounded) until the fake
    // response settles, matching the established staff/materials test pattern.
    const deadline = Date.now() + 5000;
    while (response.statusCode === undefined && response.body === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
};

const tokenFor = (claims: Record<string, unknown>): string => jwt.sign(claims, TEST_SECRET);

const TEACHER_A = tokenFor({ id: 'teacher-a', role: 'teacher', tv: 0 });
const TEACHER_B = tokenFor({ id: 'teacher-b', role: 'teacher', tv: 0 });
const TEACHER_NONE = tokenFor({ id: 'teacher-none', role: 'teacher', tv: 0 });
const STAFF_A = tokenFor({ id: 'staff-a', role: 'staff', tv: 0 });
const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0 });
const INSTRUCTOR_C = tokenFor({ id: 'instructor-c', role: 'instructor', tv: 0 });
const OWNER_B = tokenFor({ id: 'owner-b', role: 'instructor', tv: 0 });
const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enrollment-a' });
const ADMIN_X = tokenFor({ id: 'admin-x', role: 'admin', tv: 0 });
const ADMIN_SUPER = tokenFor({ id: 'admin-super', role: 'admin', tv: 0 });
const ADMIN_FIN = tokenFor({ id: 'admin-fin', role: 'admin', tv: 0 });
const UNKNOWN_ID = tokenFor({ id: 'ghost', role: 'teacher', tv: 0 });

const assertNoWrite = (executed: ExecutedStatement[]) => {
    for (const statement of executed) {
        assert.ok(!/\bINSERT\b/i.test(statement.sql), `unexpected INSERT: ${statement.sql}`);
        assert.ok(!/\bUPDATE\b/i.test(statement.sql), `unexpected UPDATE: ${statement.sql}`);
        assert.ok(!/\bDELETE\b/i.test(statement.sql), `unexpected DELETE: ${statement.sql}`);
    }
};

const throwingPlatformLookup: PlatformLookup = async () => { throw new Error('admin permissions db down'); };
const throwingAuthorityLookup: AuthorityLookup = async () => { throw new Error('tenant authority db down'); };

// ===========================================================================
// EXPENSES — tenant owner authority only (no assignment column exists)
// ===========================================================================

test('expenses: anonymous list is denied with 401 before any data access', async () => {
    const { expenses, executed } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'GET', url: '/' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('expenses: anonymous create is denied with 401 and no INSERT is issued', async () => {
    const { expenses, executed } = makeHarness();
    const response = await invokeRoute(expenses, {
        method: 'POST', url: '/',
        body: { description: 'x', amount: 10, date: '2026-10-01' },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('expenses: anonymous update and delete are denied with 401 and no mutation is issued', async () => {
    const put = makeHarness();
    const putResponse = await invokeRoute(put.expenses, { method: 'PUT', url: '/exp-a', body: { amount: 1 } });
    assert.equal(putResponse.statusCode, 401);
    assertNoWrite(put.executed);

    const del = makeHarness();
    const delResponse = await invokeRoute(del.expenses, { method: 'DELETE', url: '/exp-a' });
    assert.equal(delResponse.statusCode, 401);
    assertNoWrite(del.executed);
});

test('expenses: a malformed bearer token is rejected instead of downgraded to anonymous', async () => {
    const { expenses, executed } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'GET', url: '/', token: 'not-a-jwt' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('expenses: an identity with no live server row is rejected (session revoked)', async () => {
    const { expenses, executed } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'GET', url: '/', token: UNKNOWN_ID });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('expenses: a student role is denied with 403 before any data access', async () => {
    const { expenses, executed } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'GET', url: '/', token: STUDENT_A });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

test('expenses: the verified tenant owner lists only the resolved tenant', async () => {
    const { expenses, executed } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'GET', url: '/', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, undefined);
    const ids = (response.body as Array<{ id: string }>).map((row) => row.id);
    assert.deepEqual(ids, ['exp-a'], 'only tenant A expenses may be listed');
    const list = executed[0];
    assert.match(list.sql, /AND tenant_id=\?/);
    assert.ok(list.params.includes('tenant-a'));
    assert.ok(!list.params.includes('tenant-b'), 'tenant B must not be bound for a tenant A principal');
});

test('expenses: a tenant-B owner lists only tenant-B expenses', async () => {
    const { expenses, executed } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'GET', url: '/', token: OWNER_B });
    assert.equal(response.statusCode, undefined);
    const ids = (response.body as Array<{ id: string }>).map((row) => row.id);
    assert.deepEqual(ids, ['exp-b']);
    assert.ok(executed[0].params.includes('tenant-b'));
    assert.ok(!executed[0].params.includes('tenant-a'));
});

test('expenses: a same-tenant unrelated teacher is denied 403 before any data access', async () => {
    const { expenses, executed } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'GET', url: '/', token: TEACHER_A });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error: string }).error, 'Expense records require tenant owner authority');
    assert.equal(executed.length, 0, 'active membership alone must not reach the data layer');
});

test('expenses: a same-tenant staff identity is denied 403 before any data access', async () => {
    const { expenses, executed } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'GET', url: '/', token: STAFF_A });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

test('expenses: an instructor membership without tenant ownership is denied 403 (no assignment column exists)', async () => {
    const { expenses, executed } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'GET', url: '/', token: INSTRUCTOR_C });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error: string }).error, 'Expense records require tenant owner authority');
    assert.equal(executed.length, 0);
});

test('expenses: a bare admin role label no longer reads across tenants — denied 403 before any data access', async () => {
    const { expenses, executed } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'GET', url: '/', token: ADMIN_X });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error: string }).error, 'Workspace access required');
    assert.equal(executed.length, 0, 'no query may run before the scope is resolved');
});

test('expenses: a read without a resolved tenant membership fails closed with 403 before any query', async () => {
    const { expenses, executed } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'GET', url: '/', token: TEACHER_NONE });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

test('expenses: a verified platform operator (super_admin) lists across tenants without a tenant predicate', async () => {
    const { expenses, executed } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'GET', url: '/', token: ADMIN_SUPER });
    assert.equal(response.statusCode, undefined);
    const ids = (response.body as Array<{ id: string }>).map((row) => row.id);
    assert.deepEqual(ids.sort(), ['exp-a', 'exp-b']);
    assert.doesNotMatch(executed[0].sql, /AND tenant_id=\?/);
});

test('expenses: a verified finance.read permission holder (not super_admin) lists across tenants', async () => {
    const { expenses, executed } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'GET', url: '/', token: ADMIN_FIN });
    assert.equal(response.statusCode, undefined);
    const ids = (response.body as Array<{ id: string }>).map((row) => row.id);
    assert.deepEqual(ids.sort(), ['exp-a', 'exp-b']);
    assert.doesNotMatch(executed[0].sql, /AND tenant_id=\?/);
});

test('expenses: a platform permission lookup failure denies with 503 and runs no query', async () => {
    const { expenses, executed } = makeHarness(makeFixtures(), throwingPlatformLookup);
    const response = await invokeRoute(expenses, { method: 'GET', url: '/', token: TEACHER_A });
    assert.equal(response.statusCode, 503);
    assert.equal(executed.length, 0);
});

test('expenses: a tenant authority lookup failure denies with 503 and runs no query', async () => {
    const { expenses, executed } = makeHarness(makeFixtures(), undefined, throwingAuthorityLookup);
    const response = await invokeRoute(expenses, { method: 'GET', url: '/', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 503);
    assert.equal(executed.length, 0);
});

test('expenses: single read of another tenant expense is denied (404) and leaks nothing', async () => {
    const { expenses, executed } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'GET', url: '/exp-b', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 404);
    assert.ok(executed[0].params.includes('tenant-a'));
    assert.ok(!executed[0].params.includes('tenant-b'));
});

test('expenses: single read of an own-tenant expense succeeds for the owner', async () => {
    const { expenses } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'GET', url: '/exp-a', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, undefined);
    assert.equal((response.body as { id: string }).id, 'exp-a');
});

test('expenses: the owner creates an expense attributed to the server-derived tenant', async () => {
    const { expenses, executed, fixtures } = makeHarness();
    const response = await invokeRoute(expenses, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { description: 'Marker money', amount: 75, category: 'stationery', date: '2026-10-05', time: '08:30:00' },
    });
    assert.equal(response.statusCode, 201);
    const insert = executed.find((e) => e.sql.includes('INSERT INTO expenses'));
    assert.ok(insert, 'the INSERT must have run');
    assert.equal(insert.params[0], 'tenant-a', 'tenant_id must come from the resolved principal');
    assert.equal(insert.params[2], 75);
    const created = fixtures.expenses.find((row) => row.id === (response.body as { id: string }).id);
    assert.ok(created);
    assert.equal(created.tenant_id, 'tenant-a');
    assert.equal(created.amount, 75);
});

test('expenses: a same-tenant teacher create is denied 403 before any INSERT', async () => {
    const { expenses, executed, fixtures } = makeHarness();
    const response = await invokeRoute(expenses, {
        method: 'POST', url: '/', token: TEACHER_A,
        body: { description: 'x', amount: 10, date: '2026-10-05' },
    });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
    assert.equal(fixtures.expenses.length, 2);
});

test('expenses: a platform operator write is denied 403 — the capability is reads-only', async () => {
    const { expenses, executed, fixtures } = makeHarness();
    const response = await invokeRoute(expenses, {
        method: 'POST', url: '/', token: ADMIN_SUPER,
        body: { description: 'x', amount: 10, date: '2026-10-05' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error: string }).error, 'Active tenant membership required');
    assertNoWrite(executed);
    assert.equal(fixtures.expenses.length, 2);
});

test('expenses: a negative amount is rejected with 400 and no INSERT is issued', async () => {
    const { expenses, executed, fixtures } = makeHarness();
    const response = await invokeRoute(expenses, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { description: 'Refund trick', amount: -500, date: '2026-10-05' },
    });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
    assert.equal(fixtures.expenses.length, 2, 'no row may be created');
});

test('expenses: a non-numeric string amount is rejected with 400 instead of being coerced', async () => {
    const { expenses, executed } = makeHarness();
    const response = await invokeRoute(expenses, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { description: 'Coercion trick', amount: '1000', date: '2026-10-05' },
    });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

test('expenses: a NaN amount is rejected with 400', async () => {
    const { expenses, executed } = makeHarness();
    const response = await invokeRoute(expenses, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { description: 'NaN trick', amount: NaN, date: '2026-10-05' },
    });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

test('expenses: a write without a resolved tenant membership fails closed with 403 (admin included)', async () => {
    const unscoped = makeHarness();
    const unscopedResponse = await invokeRoute(unscoped.expenses, {
        method: 'POST', url: '/', token: TEACHER_NONE,
        body: { description: 'x', amount: 10, date: '2026-10-05' },
    });
    assert.equal(unscopedResponse.statusCode, 403);
    assertNoWrite(unscoped.executed);

    const admin = makeHarness();
    const adminResponse = await invokeRoute(admin.expenses, {
        method: 'POST', url: '/', token: ADMIN_X,
        body: { description: 'x', amount: 10, date: '2026-10-05' },
    });
    assert.equal(adminResponse.statusCode, 403);
    assertNoWrite(admin.executed);
});

test('expenses: a cross-tenant update is denied with 404 and leaves the foreign row untouched', async () => {
    const { expenses, executed, fixtures } = makeHarness();
    const response = await invokeRoute(expenses, {
        method: 'PUT', url: '/exp-b', token: INSTRUCTOR_A,
        body: { description: 'Hijacked', amount: 999999 },
    });
    assert.equal(response.statusCode, 404);
    const update = executed.find((e) => e.sql.includes('UPDATE expenses'));
    assert.ok(update, 'an UPDATE may be attempted but must be tenant-scoped');
    assert.ok(update.params.includes('tenant-a'));
    assert.ok(!update.params.includes('tenant-b'), 'tenant B must not be bound for a tenant A principal');
    const foreign = fixtures.expenses.find((row) => row.id === 'exp-b');
    assert.equal(foreign?.description, 'Tenant B supplies', 'foreign row must not be mutated');
    assert.equal(foreign?.amount, 120);
});

test('expenses: a same-tenant teacher update is denied 403 before any UPDATE', async () => {
    const { expenses, executed, fixtures } = makeHarness();
    const response = await invokeRoute(expenses, {
        method: 'PUT', url: '/exp-a', token: TEACHER_A,
        body: { description: 'Hijacked', amount: 1 },
    });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
    assert.equal(fixtures.expenses.find((row) => row.id === 'exp-a')?.description, 'Tenant A rent');
});

test('expenses: an own-tenant update applies, including a legitimate zero amount', async () => {
    const { expenses, executed, fixtures } = makeHarness();
    const response = await invokeRoute(expenses, {
        method: 'PUT', url: '/exp-a', token: INSTRUCTOR_A,
        body: { description: 'Adjusted rent', amount: 0 },
    });
    assert.equal(response.statusCode, undefined);
    const row = fixtures.expenses.find((r) => r.id === 'exp-a');
    assert.equal(row?.description, 'Adjusted rent');
    assert.equal(row?.amount, 0, 'a zero amount must be applied, not dropped by a falsy check');
    const update = executed.find((e) => e.sql.includes('UPDATE expenses'));
    assert.ok(update);
    assert.ok(update.params.includes(0), 'the zero binding must reach the data layer');
});

test('expenses: an update with a negative amount is rejected with 400 and no UPDATE is issued', async () => {
    const { expenses, executed, fixtures } = makeHarness();
    const response = await invokeRoute(expenses, {
        method: 'PUT', url: '/exp-a', token: INSTRUCTOR_A,
        body: { amount: -1 },
    });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
    assert.equal(fixtures.expenses.find((r) => r.id === 'exp-a')?.amount, 500);
});

test('expenses: an empty update body is rejected with 400', async () => {
    const { expenses, executed } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'PUT', url: '/exp-a', token: INSTRUCTOR_A, body: {} });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

test('expenses: a cross-tenant delete is denied with 404 and the foreign row survives', async () => {
    const { expenses, executed, fixtures } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'DELETE', url: '/exp-b', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 404);
    const del = executed.find((e) => e.sql.includes('DELETE FROM expenses'));
    assert.ok(del);
    assert.ok(del.params.includes('tenant-a'));
    assert.ok(!del.params.includes('tenant-b'));
    assert.ok(fixtures.expenses.some((row) => row.id === 'exp-b'), 'foreign row must not be deleted');
});

test('expenses: a same-tenant teacher delete is denied 403 and the row survives', async () => {
    const { expenses, executed, fixtures } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'DELETE', url: '/exp-a', token: TEACHER_A });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
    assert.ok(fixtures.expenses.some((row) => row.id === 'exp-a'), 'the row must survive');
});

test('expenses: an own-tenant delete succeeds for the owner', async () => {
    const { expenses, fixtures } = makeHarness();
    const response = await invokeRoute(expenses, { method: 'DELETE', url: '/exp-a', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, undefined);
    assert.ok(!fixtures.expenses.some((row) => row.id === 'exp-a'));
});

// ===========================================================================
// REVENUES — tenant owner authority only (no assignment column exists)
// ===========================================================================

test('revenues: anonymous read, stats, and create are all denied with 401 before any data access', async () => {
    const read = makeHarness();
    const readResponse = await invokeRoute(read.revenues, { method: 'GET', url: '/' });
    assert.equal(readResponse.statusCode, 401);
    assert.equal(read.executed.length, 0);

    const stats = makeHarness();
    const statsResponse = await invokeRoute(stats.revenues, { method: 'GET', url: '/stats' });
    assert.equal(statsResponse.statusCode, 401);
    assert.equal(stats.executed.length, 0);

    const create = makeHarness();
    const createResponse = await invokeRoute(create.revenues, {
        method: 'POST', url: '/',
        body: { amount: 10, source: 'student_fees', date: '2026-10-01' },
    });
    assert.equal(createResponse.statusCode, 401);
    assert.equal(create.executed.length, 0);
});

test('revenues: a student role is denied with 403', async () => {
    const { revenues, executed } = makeHarness();
    const response = await invokeRoute(revenues, { method: 'GET', url: '/', token: STUDENT_A });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

test('revenues: list and stats are tenant-scoped for the verified owner', async () => {
    const { revenues, executed } = makeHarness();
    const response = await invokeRoute(revenues, { method: 'GET', url: '/', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, undefined);
    assert.deepEqual((response.body as Array<{ id: string }>).map((r) => r.id), ['rev-a']);
    assert.match(executed[0].sql, /AND tenant_id=\?/);
    assert.ok(executed[0].params.includes('tenant-a'));

    const stats = makeHarness();
    const statsResponse = await invokeRoute(stats.revenues, { method: 'GET', url: '/stats', token: OWNER_B });
    assert.equal(statsResponse.statusCode, undefined);
    const statsQuery = stats.executed[0];
    assert.match(statsQuery.sql, /AND tenant_id=\?/);
    assert.ok(statsQuery.params.includes('tenant-b'));
    assert.ok(!statsQuery.params.includes('tenant-a'));
});

test('revenues: same-tenant teacher, staff, and non-owner instructor are all denied 403 before any data access', async () => {
    for (const token of [TEACHER_A, STAFF_A, INSTRUCTOR_C, TEACHER_B]) {
        const { revenues, executed } = makeHarness();
        const response = await invokeRoute(revenues, { method: 'GET', url: '/', token });
        assert.equal(response.statusCode, 403, 'active membership alone must not reach revenue records');
        assert.equal((response.body as { error: string }).error, 'Revenue records require tenant owner authority');
        assert.equal(executed.length, 0);
    }
});

test('revenues: a bare admin role label no longer aggregates across tenants — denied 403 before any data access', async () => {
    const { revenues, executed } = makeHarness();
    const response = await invokeRoute(revenues, { method: 'GET', url: '/stats', token: ADMIN_X });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0, 'no query may run before the scope is resolved');
});

test('revenues: a read without a resolved tenant membership fails closed with 403 before any query', async () => {
    const { revenues, executed } = makeHarness();
    const response = await invokeRoute(revenues, { method: 'GET', url: '/', token: TEACHER_NONE });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

test('revenues: a verified platform operator (super_admin) aggregates across tenants without a tenant predicate', async () => {
    const { revenues, executed } = makeHarness();
    const response = await invokeRoute(revenues, { method: 'GET', url: '/stats', token: ADMIN_SUPER });
    assert.equal(response.statusCode, undefined);
    assert.doesNotMatch(executed[0].sql, /AND tenant_id=\?/);
});

test('revenues: the owner creates a revenue attributed to the server tenant and returns the insertId', async () => {
    const { revenues, executed, fixtures } = makeHarness();
    const response = await invokeRoute(revenues, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { amount: 250, source: 'student_fees', description: 'Fee payment', date: '2026-10-07' },
    });
    assert.equal(response.statusCode, 201);
    const body = response.body as { message: string; id: string };
    assert.equal(body.message, 'Revenue created successfully');
    const insert = executed.find((e) => e.sql.includes('INSERT INTO revenues'));
    assert.ok(insert, 'the INSERT must have run');
    assert.equal(insert.params[0], 'tenant-a', 'tenant_id must come from the resolved principal');
    assert.equal(insert.params[1], 250);
    assert.ok(body.id, 'the response must carry the created id');
    const created = fixtures.revenues.find((row) => row.id === body.id);
    assert.ok(created, 'the created row must exist in the fixture store');
    assert.equal(created.tenant_id, 'tenant-a');
    assert.equal(created.amount, 250);
});

test('revenues: a same-tenant teacher create is denied 403 before any INSERT', async () => {
    const { revenues, executed, fixtures } = makeHarness();
    const response = await invokeRoute(revenues, {
        method: 'POST', url: '/', token: TEACHER_A,
        body: { amount: 250, source: 'student_fees', date: '2026-10-07' },
    });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
    assert.equal(fixtures.revenues.length, 2);
});

test('revenues: a platform operator write is denied 403 — the capability is reads-only', async () => {
    const { revenues, executed, fixtures } = makeHarness();
    const response = await invokeRoute(revenues, {
        method: 'POST', url: '/', token: ADMIN_FIN,
        body: { amount: 250, source: 'student_fees', date: '2026-10-07' },
    });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
    assert.equal(fixtures.revenues.length, 2);
});

test('revenues: negative and non-numeric amounts are rejected with 400 and no INSERT is issued', async () => {
    const negative = makeHarness();
    const negativeResponse = await invokeRoute(negative.revenues, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { amount: -10, source: 'student_fees', date: '2026-10-07' },
    });
    assert.equal(negativeResponse.statusCode, 400);
    assertNoWrite(negative.executed);

    const stringAmount = makeHarness();
    const stringResponse = await invokeRoute(stringAmount.revenues, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { amount: '250', source: 'student_fees', date: '2026-10-07' },
    });
    assert.equal(stringResponse.statusCode, 400);
    assertNoWrite(stringAmount.executed);
    assert.equal(stringAmount.fixtures.revenues.length, 2, 'no row may be created');
});

test('revenues: a write without a resolved tenant membership fails closed with 403', async () => {
    const { revenues, executed } = makeHarness();
    const response = await invokeRoute(revenues, {
        method: 'POST', url: '/', token: TEACHER_NONE,
        body: { amount: 10, source: 'student_fees', date: '2026-10-07' },
    });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('revenues: a tenant authority lookup failure denies with 503 and runs no query', async () => {
    const { revenues, executed } = makeHarness(makeFixtures(), undefined, throwingAuthorityLookup);
    const response = await invokeRoute(revenues, { method: 'GET', url: '/', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 503);
    assert.equal(executed.length, 0);
});

// ===========================================================================
// FEES — owner = tenant-wide; instructor membership = assigned students only
// ===========================================================================

test('fees: anonymous read is denied with 401 before any data access', async () => {
    const { fees, executed } = makeHarness();
    const response = await invokeRoute(fees, { method: 'GET', url: '/' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('fees: a student role is denied with 403', async () => {
    const { fees, executed } = makeHarness();
    const response = await invokeRoute(fees, { method: 'GET', url: '/', token: STUDENT_A });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

test('fees: the owner lists every fee of the tenant, including unassigned offline rows', async () => {
    const list = makeHarness();
    const listResponse = await invokeRoute(list.fees, { method: 'GET', url: '/', token: INSTRUCTOR_A });
    assert.equal(listResponse.statusCode, undefined);
    const ids = (listResponse.body as Array<{ id: string }>).map((r) => r.id).sort();
    assert.deepEqual(ids, ['fee-a', 'fee-c'], 'owner sees the whole tenant, including the unassigned fee');
    assert.match(list.executed[0].sql, /AND tenant_id=\?/);
    assert.ok(!list.executed[0].sql.includes('s.instructor_id'), 'owner reads carry no assignment predicate');

    const foreign = makeHarness();
    const foreignRead = await invokeRoute(foreign.fees, { method: 'GET', url: '/fee-b', token: INSTRUCTOR_A });
    assert.equal(foreignRead.statusCode, 404);

    const own = makeHarness();
    const ownRead = await invokeRoute(own.fees, { method: 'GET', url: '/fee-c', token: INSTRUCTOR_A });
    assert.equal(ownRead.statusCode, undefined);
    assert.equal((ownRead.body as { id: string }).id, 'fee-c');
});

test('fees: an instructor membership lists ONLY fees of students assigned to it', async () => {
    const { fees, executed } = makeHarness();
    const response = await invokeRoute(fees, { method: 'GET', url: '/', token: INSTRUCTOR_C });
    assert.equal(response.statusCode, undefined);
    const ids = (response.body as Array<{ id: string }>).map((r) => r.id);
    assert.deepEqual(ids, ['fee-a'], 'fee-c belongs to an unassigned student and must be hidden');
    const list = executed[0];
    assert.match(list.sql, /s\.instructor_id = \?/);
    assert.ok(list.params.includes('tenant-a'));
    assert.ok(list.params.includes('instructor-c'));
    assert.ok(!list.params.includes('instructor-a'), 'another instructor must never be bound');
});

test('fees: an instructor membership reads its assigned fee and gets 404 on an unassigned one', async () => {
    const assigned = makeHarness();
    const assignedRead = await invokeRoute(assigned.fees, { method: 'GET', url: '/fee-a', token: INSTRUCTOR_C });
    assert.equal(assignedRead.statusCode, undefined);
    assert.equal((assignedRead.body as { id: string }).id, 'fee-a');
    assert.match(assigned.executed[0].sql, /s\.instructor_id = \?/);

    const unassigned = makeHarness();
    const unassignedRead = await invokeRoute(unassigned.fees, { method: 'GET', url: '/fee-c', token: INSTRUCTOR_C });
    assert.equal(unassignedRead.statusCode, 404, 'an unassigned same-tenant fee must not leak');
    assert.ok(unassigned.executed[0].params.includes('instructor-c'));
});

test('fees: a same-tenant unrelated teacher or staff identity is denied 403 before any data access', async () => {
    for (const token of [TEACHER_A, STAFF_A, TEACHER_B]) {
        const { fees, executed } = makeHarness();
        const response = await invokeRoute(fees, { method: 'GET', url: '/', token });
        assert.equal(response.statusCode, 403);
        assert.equal((response.body as { error: string }).error, 'Financial records require owner or assigned-instructor authority');
        assert.equal(executed.length, 0);
    }
});

test('fees: a bare admin role label no longer lists across tenants — denied 403 before any data access', async () => {
    const { fees, executed } = makeHarness();
    const response = await invokeRoute(fees, { method: 'GET', url: '/', token: ADMIN_X });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0, 'no query may run before the scope is resolved');
});

test('fees: a read without a resolved tenant membership fails closed with 403 before any query', async () => {
    const { fees, executed } = makeHarness();
    const response = await invokeRoute(fees, { method: 'GET', url: '/', token: TEACHER_NONE });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

test('fees: a verified platform operator lists across tenants without a tenant predicate', async () => {
    const { fees, executed } = makeHarness();
    const response = await invokeRoute(fees, { method: 'GET', url: '/', token: ADMIN_SUPER });
    assert.equal(response.statusCode, undefined);
    assert.equal((response.body as unknown[]).length, 3);
    assert.doesNotMatch(executed[0].sql, /AND tenant_id=\?/);
});

test('fees: a verified platform operator may read a foreign-tenant fee by id', async () => {
    const { fees, executed } = makeHarness();
    const response = await invokeRoute(fees, { method: 'GET', url: '/fee-b', token: ADMIN_SUPER });
    assert.equal(response.statusCode, undefined);
    assert.equal((response.body as { id: string }).id, 'fee-b');
    assert.doesNotMatch(executed[0].sql, /AND tenant_id=\?/);
});

test('fees: a platform permission lookup failure denies with 503 and runs no query', async () => {
    const { fees, executed } = makeHarness(makeFixtures(), throwingPlatformLookup);
    const response = await invokeRoute(fees, { method: 'GET', url: '/', token: TEACHER_A });
    assert.equal(response.statusCode, 503);
    assert.equal(executed.length, 0);
});

test('fees: a tenant authority lookup failure denies with 503 and runs no query', async () => {
    const { fees, executed } = makeHarness(makeFixtures(), undefined, throwingAuthorityLookup);
    const response = await invokeRoute(fees, { method: 'GET', url: '/', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 503);
    assert.equal(executed.length, 0);
});

test('fees: the owner create resolves the student inside the tenant and inserts the server tenant', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { student_name: 'Plain Student', amount: 150, paid_amount: 150, payment_year: 2026, payment_month: 12 },
    });
    assert.equal(response.statusCode, 201);
    const insert = executed.find((e) => e.sql.includes('INSERT INTO student_fees'));
    assert.ok(insert, 'the INSERT must have run');
    assert.equal(insert.params[0], 'tenant-a', 'tenant_id must come from the resolved principal');
    assert.equal(insert.params[1], 'student-plain', 'the student must be resolved inside the caller tenant');
    assert.equal(insert.params[10], 150);
    assert.equal(insert.params[11], 150);
    const created = fixtures.fees.find((row) => row.id === (response.body as { id: string }).id);
    assert.ok(created);
    assert.equal(created.tenant_id, 'tenant-a');
});

test('fees: the owner may still create an unlinked offline record (no student match)', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { student_name: 'Offline Kid', amount: 150, payment_year: 2026, payment_month: 12 },
    });
    assert.equal(response.statusCode, 201);
    const insert = executed.find((e) => e.sql.includes('INSERT INTO student_fees'));
    assert.ok(insert);
    assert.equal(insert.params[1], null, 'no student may be linked');
    assert.equal(fixtures.fees.length, 4, 'an unlinked offline record may still be created by the owner');
});

test('fees: an instructor create is allowed for an assigned student and attributed to the server tenant', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'POST', url: '/', token: INSTRUCTOR_C,
        body: { student_name: 'Assigned Student', amount: 120, paid_amount: 120, payment_year: 2026, payment_month: 12 },
    });
    assert.equal(response.statusCode, 201);
    const insert = executed.find((e) => e.sql.includes('INSERT INTO student_fees'));
    assert.ok(insert, 'the INSERT must have run');
    assert.equal(insert.params[0], 'tenant-a');
    assert.equal(insert.params[1], 'student-d', 'the assigned student must be resolved');
    assert.equal(fixtures.fees.length, 4);
});

test('fees: an instructor create for an unassigned same-tenant student is denied 403 before any INSERT', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'POST', url: '/', token: INSTRUCTOR_C,
        body: { student_name: 'Plain Student', amount: 120, payment_year: 2026, payment_month: 12 },
    });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error: string }).error, 'Student not in your assigned scope');
    assertNoWrite(executed);
    assert.equal(fixtures.fees.length, 3, 'no row may be created');
});

test('fees: an instructor create with no resolvable student is denied 403 (no provable assignment)', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'POST', url: '/', token: INSTRUCTOR_C,
        body: { student_name: 'Ghost Kid', amount: 120, payment_year: 2026, payment_month: 12 },
    });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
    assert.equal(fixtures.fees.length, 3);
});

test('fees: a same-tenant teacher create is denied 403 before any INSERT', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'POST', url: '/', token: TEACHER_A,
        body: { student_name: 'Plain Student', amount: 120, payment_year: 2026, payment_month: 12 },
    });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
    assert.equal(fixtures.fees.length, 3);
});

test('fees: the duplicate paid month guard blocks a second paid fee for the same month', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { student_name: 'Paid Student', amount: 200, payment_year: 2026, payment_month: 10 },
    });
    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: string }).error, 'تم الدفع مسبقاً');
    assertNoWrite(executed);
    assert.equal(fixtures.fees.length, 3, 'no duplicate row may be created');
});

test('fees: unsafe monetary input (string, negative, NaN) is rejected with 400 and no INSERT is issued', async () => {
    for (const badAmount of ['150', -5, NaN]) {
        const { fees, executed, fixtures } = makeHarness();
        const response = await invokeRoute(fees, {
            method: 'POST', url: '/', token: INSTRUCTOR_A,
            body: { student_name: 'Plain Student', amount: badAmount, payment_year: 2026, payment_month: 12 },
        });
        assert.equal(response.statusCode, 400, `amount ${String(badAmount)} must be rejected`);
        assertNoWrite(executed);
        assert.equal(fixtures.fees.length, 3);
    }
});

test('fees: a create without a resolved tenant membership fails closed with 403', async () => {
    const { fees, executed } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'POST', url: '/', token: ADMIN_X,
        body: { student_name: 'Plain Student', amount: 150 },
    });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('fees: a platform operator write is denied 403 — the capability is reads-only', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'POST', url: '/', token: ADMIN_SUPER,
        body: { student_name: 'Plain Student', amount: 150 },
    });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error: string }).error, 'Active tenant membership required');
    assertNoWrite(executed);
    assert.equal(fixtures.fees.length, 3);
});

test('fees: an own-tenant update applies a zero amount instead of silently keeping the stale value', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'PUT', url: '/fee-a', token: INSTRUCTOR_A,
        body: { amount: 0 },
    });
    assert.equal(response.statusCode, undefined);
    const update = executed.find((e) => e.sql.includes('UPDATE student_fees'));
    assert.ok(update, 'the UPDATE must have run');
    assert.ok(update.params.includes(0), 'the zero amount binding must reach the data layer');
    assert.equal(fixtures.fees.find((row) => row.id === 'fee-a')?.amount, 0);
});

test('fees: a same-tenant teacher update is denied 403 before any UPDATE', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'PUT', url: '/fee-a', token: TEACHER_A,
        body: { amount: 0 },
    });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
    assert.equal(fixtures.fees.find((row) => row.id === 'fee-a')?.amount, 200);
});

test('fees: an instructor update of an unassigned same-tenant fee is denied 403 before any UPDATE', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'PUT', url: '/fee-c', token: INSTRUCTOR_C,
        body: { amount: 10 },
    });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error: string }).error, 'Fee is outside your assigned scope');
    assertNoWrite(executed);
    assert.equal(fixtures.fees.find((row) => row.id === 'fee-c')?.amount, 50);
});

test('fees: an instructor update of an assigned fee applies', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'PUT', url: '/fee-a', token: INSTRUCTOR_C,
        body: { amount: 0 },
    });
    assert.equal(response.statusCode, undefined);
    const update = executed.find((e) => e.sql.includes('UPDATE student_fees'));
    assert.ok(update, 'the UPDATE must have run');
    assert.match(update.sql, /s\.instructor_id = \?/);
    assert.equal(fixtures.fees.find((row) => row.id === 'fee-a')?.amount, 0);
});

test('fees: an update with a negative amount is rejected with 400 and no UPDATE is issued', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'PUT', url: '/fee-a', token: INSTRUCTOR_A,
        body: { amount: -3 },
    });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
    assert.equal(fixtures.fees.find((row) => row.id === 'fee-a')?.amount, 200);
});

test('fees: a foreign-tenant student_id on update is rejected with 404 and no UPDATE is issued', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'PUT', url: '/fee-a', token: INSTRUCTOR_A,
        body: { student_id: 'student-b', amount: 10 },
    });
    assert.equal(response.statusCode, 404);
    assert.equal((response.body as { error: string }).error, 'Student not found in your tenant');
    assertNoWrite(executed);
    assert.equal(fixtures.fees.find((row) => row.id === 'fee-a')?.student_id, 'student-a');
});

test('fees: an instructor relink to an unassigned same-tenant student is rejected with 404 and no UPDATE', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'PUT', url: '/fee-a', token: INSTRUCTOR_C,
        body: { student_id: 'student-plain', amount: 10 },
    });
    assert.equal(response.statusCode, 404);
    assertNoWrite(executed);
    assert.equal(fixtures.fees.find((row) => row.id === 'fee-a')?.student_id, 'student-a');
});

test('fees: an instructor relink to an assigned student applies', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'PUT', url: '/fee-a', token: INSTRUCTOR_C,
        body: { student_id: 'student-d' },
    });
    assert.equal(response.statusCode, undefined);
    const update = executed.find((e) => e.sql.includes('UPDATE student_fees'));
    assert.ok(update, 'the UPDATE must have run');
    assert.equal(fixtures.fees.find((row) => row.id === 'fee-a')?.student_id, 'student-d');
});

test('fees: an owner relink to a same-tenant student applies', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'PUT', url: '/fee-a', token: INSTRUCTOR_A,
        body: { student_id: 'student-plain' },
    });
    assert.equal(response.statusCode, undefined);
    const update = executed.find((e) => e.sql.includes('UPDATE student_fees'));
    assert.ok(update, 'the UPDATE must have run');
    assert.equal(fixtures.fees.find((row) => row.id === 'fee-a')?.student_id, 'student-plain');
});

test('fees: a cross-tenant update is denied: no mutation and no foreign data returned', async () => {
    const put = makeHarness();
    const putResponse = await invokeRoute(put.fees, {
        method: 'PUT', url: '/fee-b', token: INSTRUCTOR_A,
        body: { amount: 999999 },
    });
    // The tenant predicate confines the UPDATE to the caller's tenant, and
    // the follow-up read is tenant-scoped too, so the foreign row is neither
    // mutated nor returned. (The pre-existing PUT contract answers a missing
    // row with a null body rather than 404; preserved here deliberately.)
    assert.equal(putResponse.body, null, 'no foreign fee data may be returned');
    assert.equal(put.fixtures.fees.find((row) => row.id === 'fee-b')?.amount, 80);
    const update = put.executed.find((e) => e.sql.includes('UPDATE student_fees'));
    assert.ok(update, 'the UPDATE may be attempted but must be tenant-scoped');
    assert.ok(update.params.includes('tenant-a'));
    assert.ok(!update.params.includes('tenant-b'), 'tenant B must not be bound for a tenant A principal');

    const del = makeHarness();
    const delResponse = await invokeRoute(del.fees, { method: 'DELETE', url: '/fee-b', token: INSTRUCTOR_A });
    assert.equal(delResponse.statusCode, 404);
    assert.ok(del.fixtures.fees.some((row) => row.id === 'fee-b'), 'foreign row must not be deleted');
});

test('fees: a POST with a foreign-tenant group_id is rejected with 404 before any INSERT', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { student_name: 'Plain Student', group_id: 'group-b', amount: 150 },
    });
    assert.equal(response.statusCode, 404);
    assert.equal((response.body as { error: string }).error, 'Group not found in your tenant');
    assertNoWrite(executed);
    assert.equal(fixtures.fees.length, 3, 'no row may be created');
});

test('fees: a POST with an own-tenant group_id passes the ownership probe', async () => {
    const { fees, executed } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { student_name: 'Plain Student', group_id: 'group-a', amount: 150, payment_year: 2026, payment_month: 12 },
    });
    assert.equal(response.statusCode, 201);
    const insert = executed.find((e) => e.sql.includes('INSERT INTO student_fees'));
    assert.ok(insert, 'the INSERT must have run');
    assert.equal(insert.params[7], 'group-a');
});

test('fees: a POST with a group whose course carries no provable tenant owner is denied', async () => {
    const { fees, executed } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { student_name: 'Plain Student', group_id: 'group-orphan', amount: 150 },
    });
    assert.equal(response.statusCode, 404);
    assertNoWrite(executed);
});

test('fees: an instructor POST with a foreign group is denied 404 and an own group is accepted', async () => {
    const foreign = makeHarness();
    const foreignResponse = await invokeRoute(foreign.fees, {
        method: 'POST', url: '/', token: INSTRUCTOR_C,
        body: { student_name: 'Assigned Student', group_id: 'group-b', amount: 150, payment_year: 2026, payment_month: 12 },
    });
    assert.equal(foreignResponse.statusCode, 404);
    assertNoWrite(foreign.executed);

    const own = makeHarness();
    const ownResponse = await invokeRoute(own.fees, {
        method: 'POST', url: '/', token: INSTRUCTOR_C,
        body: { student_name: 'Assigned Student', group_id: 'group-a', amount: 150, payment_year: 2026, payment_month: 12 },
    });
    assert.equal(ownResponse.statusCode, 201);
});

test('fees: a PUT with a foreign-tenant group_id is rejected with 404 before any UPDATE', async () => {
    const { fees, executed } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'PUT', url: '/fee-a', token: INSTRUCTOR_A,
        body: { group_id: 'group-b', amount: 10 },
    });
    assert.equal(response.statusCode, 404);
    assert.equal((response.body as { error: string }).error, 'Group not found in your tenant');
    assertNoWrite(executed);
});

test('fees: an instructor PUT with a foreign group is denied 404 before any UPDATE', async () => {
    const { fees, executed } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'PUT', url: '/fee-a', token: INSTRUCTOR_C,
        body: { group_id: 'group-b', amount: 10 },
    });
    assert.equal(response.statusCode, 404);
    assertNoWrite(executed);
});

test('fees: a bare admin role label can no longer delete another tenant fee — denied 403 before any mutation', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, { method: 'DELETE', url: '/fee-a', token: ADMIN_X });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
    assert.ok(fixtures.fees.some((row) => row.id === 'fee-a'), 'the row must survive');
});

test('fees: an instructor delete of an unassigned same-tenant fee is denied 403 and the row survives', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, { method: 'DELETE', url: '/fee-c', token: INSTRUCTOR_C });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error: string }).error, 'Fee is outside your assigned scope');
    assertNoWrite(executed);
    assert.ok(fixtures.fees.some((row) => row.id === 'fee-c'), 'the row must survive');
});

test('fees: an instructor delete of an assigned fee succeeds', async () => {
    const { fees, fixtures } = makeHarness();
    const response = await invokeRoute(fees, { method: 'DELETE', url: '/fee-a', token: INSTRUCTOR_C });
    assert.equal(response.statusCode, undefined);
    assert.ok(!fixtures.fees.some((row) => row.id === 'fee-a'));
});

test('fees: a same-tenant teacher delete is denied 403 and the row survives', async () => {
    const { fees, executed, fixtures } = makeHarness();
    const response = await invokeRoute(fees, { method: 'DELETE', url: '/fee-a', token: TEACHER_A });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
    assert.ok(fixtures.fees.some((row) => row.id === 'fee-a'), 'the row must survive');
});

test('fees: an own-tenant delete succeeds for the owner', async () => {
    const { fees, fixtures } = makeHarness();
    const response = await invokeRoute(fees, { method: 'DELETE', url: '/fee-a', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, undefined);
    assert.ok(!fixtures.fees.some((row) => row.id === 'fee-a'));
});


