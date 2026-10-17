import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import jwt from 'jsonwebtoken';
import type { NextFunction, RequestHandler, Router } from 'express';
import { createAuthenticateToken, requireRoles } from '../src/middleware/auth';
import { createRequireAdminPermission } from '../src/security/admin-permissions';
import type { PrincipalRepository } from '../src/security/principal-repository';
import { createSubscriptionsRouter } from '../src/routes/subscriptions';
import { createSubscriptionPlansRouter } from '../src/routes/subscription-plans';
import { createSubscriptionRequestsRouter } from '../src/routes/subscription-requests';
import { createPremiumLectureRouter } from '../src/routes/premium-lectures';
import { tenantScopeBranchDeps } from './helpers/tenant-scope-branch-deps';
import { createImportsRouter } from '../src/routes/imports';
import { createFeesRouter } from '../src/routes/fees';

/**
 * Finance/billing hardening suite (behavioral, hermetic).
 *
 * Drives the PRODUCTION routers for subscriptions, subscription-plans,
 * subscription-requests, premium-lectures, imports, and fees through injected
 * seams: a fixture-backed SQL adapter, the REAL authentication middleware,
 * the REAL role gate, and fixture-backed server-owned authority lookups. No
 * database, network, Docker, or real service is contacted.
 *
 * Each test asserts a rejection path or an idempotency/tenant boundary:
 *  - Decimal money only (19.999 / NaN / negatives / numeric strings rejected)
 *  - deny-by-default tenant isolation (cross-tenant reads/writes -> 404/empty)
 *  - idempotent approvals (second approve -> 400, single side-effect row)
 *  - premium lecture access requires a real approved entitlement (else 404)
 */

const TEST_SECRET = 'test-only-secret-with-sufficient-length';
const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
    users: Record<string, { is_active: number; token_version: number; suspension_active: number }>;
    staff: Record<string, { is_active: number }>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    memberships: Record<string, Array<{ tenant_id: string; role_key: string }>>;
    enrollments: Record<string, Array<{
        id: string; user_id: string; tenant_id: string;
        instructor_id: string | null; group_id: string | null; grade_id: string | null;
    }>>;
    tenants: Record<string, { owner_user_id: string }>;
    adminRoles: Record<string, string[]>;
    adminPermissions: Record<string, string[]>;
    students: Array<{ id: string; tenant_id: string; name: string; phone: string; grade_id: string | null; group_id: string | null }>;
    courses: Array<{ id: string; tenant_id: string }>;
    groups: Array<{ id: string; course_id: string | null; instructor_id: string | null }>;
    subscriptions: Array<{ id: string; student_id: string; course_id: string; amount: string; status: string }>;
    plans: Array<{ id: string; name: string; duration_months: number; price: string; is_active: boolean }>;
    subRequests: Array<{ id: string; tenant_id: string; student_name: string; phone: string; guardian_phone: string | null; grade_id: string | null; grade_name: string | null; group_id: string | null; group_name: string | null; amount: string | null; notes: string | null; receipt_image_url: string | null; status: string }>;
    premiumLectures: Array<{ id: string; title: string; price: string; group_id: string | null; is_published: boolean }>;
    premiumPayments: Array<{ id: string; student_id: string; premium_lecture_id: string; status: string }>;
    premiumAccess: Array<{ id: string; student_id: string; premium_lecture_id: string; payment_id: string }>;
    imports: Array<{ id: string; tenant_id: string; supplier_name: string; total_amount: string; paid_amount: string }>;
    importItems: Array<{ id: string; import_id: string; item_name: string; quantity: number; unit_price: string }>;
    fees: Array<{ id: string; tenant_id: string }>;
}

const makeFixtures = (): Fixtures => ({
    users: {
        'owner-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'owner-b': { is_active: 1, token_version: 0, suspension_active: 0 },
        'teacher-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'student-u': { is_active: 1, token_version: 0, suspension_active: 0 },
        'admin-super': { is_active: 1, token_version: 0, suspension_active: 0 },
        'admin-bare': { is_active: 1, token_version: 0, suspension_active: 0 },
    },
    staff: {},
    instructorAccounts: {},
    memberships: {
        'owner-a': [{ tenant_id: 'tenant-a', role_key: 'owner' }],
        'owner-b': [{ tenant_id: 'tenant-b', role_key: 'owner' }],
        'teacher-a': [{ tenant_id: 'tenant-a', role_key: 'teacher' }],
    },
    enrollments: {
        'student-u': [{
            id: 'student-a', user_id: 'student-u', tenant_id: 'tenant-a',
            instructor_id: 'owner-a', group_id: 'group-a', grade_id: 'grade-a',
        }],
    },
    tenants: {
        'tenant-a': { owner_user_id: 'owner-a' },
        'tenant-b': { owner_user_id: 'owner-b' },
    },
    adminRoles: { 'admin-super': ['super_admin'] },
    adminPermissions: {},
    students: [
        { id: 'student-a', tenant_id: 'tenant-a', name: 'Student A', phone: '01000', grade_id: 'grade-a', group_id: 'group-a' },
        { id: 'student-b', tenant_id: 'tenant-b', name: 'Student B', phone: '02000', grade_id: null, group_id: 'group-b' },
    ],
    courses: [
        { id: 'course-a', tenant_id: 'tenant-a' },
        { id: 'course-b', tenant_id: 'tenant-b' },
    ],
    groups: [
        { id: 'group-a', course_id: 'course-a', instructor_id: 'owner-a' },
        { id: 'group-b', course_id: 'course-b', instructor_id: 'owner-b' },
    ],
    subscriptions: [
        { id: 'sub-a', student_id: 'student-a', course_id: 'course-a', amount: '100.00', status: 'paid' },
        { id: 'sub-b', student_id: 'student-b', course_id: 'course-b', amount: '80.00', status: 'pending' },
    ],
    plans: [
        { id: 'plan-1', name: 'Monthly', duration_months: 1, price: '500.00', is_active: true },
    ],
    subRequests: [
        { id: 'req-a', tenant_id: 'tenant-a', student_name: 'New Kid', phone: '01111', guardian_phone: null, grade_id: null, grade_name: null, group_id: 'group-a', group_name: null, amount: '500.00', notes: null, receipt_image_url: null, status: 'pending' },
        { id: 'req-b', tenant_id: 'tenant-b', student_name: 'Other Kid', phone: '02222', guardian_phone: null, grade_id: null, grade_name: null, group_id: 'group-b', group_name: null, amount: '500.00', notes: null, receipt_image_url: null, status: 'pending' },
    ],
    premiumLectures: [
        { id: 'lec-a', title: 'Lecture A', price: '50.00', group_id: 'group-a', is_published: true },
    ],
    premiumPayments: [
        { id: 'pay-pending', student_id: 'student-a', premium_lecture_id: 'lec-a', status: 'pending' },
    ],
    premiumAccess: [],
    imports: [
        { id: 'imp-a', tenant_id: 'tenant-a', supplier_name: 'Supplier A', total_amount: '200.00', paid_amount: '100.00' },
        { id: 'imp-b', tenant_id: 'tenant-b', supplier_name: 'Supplier B', total_amount: '300.00', paid_amount: '0.00' },
    ],
    importItems: [],
    fees: [],
});

const makeRepository = (f: Fixtures): PrincipalRepository => ({
    findUsersIdentity: async (id) => f.users[id] ?? null,
    findStaffIdentity: async (id) => f.staff[id] ?? null,
    findInstructorAccount: async (id) => f.instructorAccounts[id] ?? null,
    findStudentEnrollments: async (id) => f.enrollments[id] ?? [],
    findActiveTenantMemberships: async (id) => f.memberships[id] ?? [],
});

// ---------------------------------------------------------------------------
// Fixture SQL adapter: answers the exact query shapes the routers issue.
// ---------------------------------------------------------------------------

interface ExecutedStatement { sql: string; params: unknown[] }

type TxAdapter = {
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = unknown>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId: unknown; affectedRows: number }>;
};

const makeDb = (f: Fixtures): { executed: ExecutedStatement[] } & TxAdapter & {
    withTransaction: <T>(work: (tx: TxAdapter) => Promise<T>) => Promise<T>;
} => {
    const executed: ExecutedStatement[] = [];
    const record = (sql: string, params: unknown[]) => { executed.push({ sql, params }); };

    const studentTenant = (id: unknown): string | undefined =>
        f.students.find((s) => s.id === id)?.tenant_id;

    const respond = (sql: string, params: unknown[]): unknown[] => {
        // -- students probes (tenant-scoped) --
        if (/FROM students WHERE id = \? AND tenant_id = \?/.test(sql)) {
            const [id, tenant] = params as [string, string];
            const s = f.students.find((row) => row.id === id && row.tenant_id === tenant);
            return s ? [{ id: s.id }] : [];
        }
        if (/FROM students WHERE phone = \? AND tenant_id = \?/.test(sql)) {
            const [phone, tenant] = params as [string, string];
            const s = f.students.find((row) => row.phone === phone && row.tenant_id === tenant);
            return s ? [{ id: s.id }] : [];
        }
        // -- courses probes (tenant-scoped) --
        if (/FROM courses WHERE id = \? AND tenant_id = \?/.test(sql)) {
            const [id, tenant] = params as [string, string];
            const c = f.courses.find((row) => row.id === id && row.tenant_id === tenant);
            return c ? [{ id: c.id }] : [];
        }
        // -- groups tenant-membership probe --
        if (/FROM `groups` g/.test(sql) && /tenant_memberships/.test(sql)) {
            const [tenant, groupId] = params as [string, string];
            const g = f.groups.find((row) => row.id === groupId);
            if (!g || !g.instructor_id) return [];
            const member = (f.memberships[g.instructor_id] ?? []).some((m) => m.tenant_id === tenant);
            return member ? [{ id: g.id }] : [];
        }
        // -- grades existence probe --
        if (/FROM grades WHERE id = \?/.test(sql)) {
            return [{ id: params[0] }];
        }
        // -- subscriptions reads (tenant derived via students join) --
        if (/FROM subscriptions/.test(sql) && /SELECT/.test(sql)) {
            if (/WHERE subscriptions\.id = \?/.test(sql)) {
                const id = params[params.length - 1] as string;
                const tenant = params.length > 1 ? params[0] as string : undefined;
                const sub = f.subscriptions.find((row) => row.id === id
                    && (tenant === undefined || studentTenant(row.student_id) === tenant));
                return sub ? [sub] : [];
            }
            const tenant = params[0] as string | undefined;
            return f.subscriptions.filter((row) => tenant === undefined || studentTenant(row.student_id) === tenant);
        }
        // -- subscription_requests reads --
        if (/FROM subscription_requests/.test(sql) && /SELECT/.test(sql)) {
            if (/WHERE id = \?/.test(sql) || (/WHERE .*id = \?/.test(sql) && !/WHERE 1=1/.test(sql))) {
                const id = params[0] as string;
                const tenant = params.length > 1 ? params[1] as string : undefined;
                const r = f.subRequests.find((row) => row.id === id && (tenant === undefined || row.tenant_id === tenant));
                return r ? [{ ...r }] : [];
            }
            const tenantParam = params.find((p) => p === 'tenant-a' || p === 'tenant-b');
            return f.subRequests
                .filter((row) => tenantParam === undefined || row.tenant_id === tenantParam)
                .map((row) => ({ ...row }));
        }
        // -- subscription_plans reads --
        if (/FROM subscription_plans/.test(sql) && /SELECT/.test(sql)) {
            if (/WHERE id = \?/.test(sql)) {
                const plan = f.plans.find((p) => p.id === params[0]);
                return plan && (plan.is_active || !/is_active = TRUE/.test(sql)) ? [{ ...plan }] : [];
            }
            return f.plans.filter((p) => p.is_active).map((p) => ({ ...p }));
        }
        // -- student ownership probe (STUDENT_OWNERSHIP_SQL): [studentId, userId] --
        if (/FROM students s/.test(sql) && /owner_user_id/.test(sql)) {
            const [studentId, userId] = params as [string, string];
            const s = f.students.find((row) => row.id === studentId);
            if (!s || !s.group_id) return [];
            const g = f.groups.find((row) => row.id === s.group_id);
            return g && g.instructor_id === userId ? [{ id: s.id }] : [];
        }
        // -- premium lectures / payments / access --
        if (/FROM premium_lecture_payments/.test(sql) && /SELECT/.test(sql)) {
            const pay = f.premiumPayments.find((p) => p.id === params[0]);
            return pay ? [{ ...pay }] : [];
        }
        if (/FROM premium_lecture_access/.test(sql) && /SELECT/.test(sql)) {
            const [studentId, lectureId] = params as [string, string];
            const access = f.premiumAccess.find((a) => a.student_id === studentId && a.premium_lecture_id === lectureId);
            return access ? [{ ...access }] : [];
        }
        if (/FROM premium_lectures/.test(sql) && /SELECT/.test(sql)) {
            // ownership probe (LECTURE_OWNERSHIP_SQL): [lectureId, userId]
            if (/t\.owner_user_id = \?/.test(sql) && params.length === 2) {
                const [lectureId, userId] = params as [string, string];
                const lec = f.premiumLectures.find((l) => l.id === lectureId);
                if (!lec) return [];
                const g = f.groups.find((row) => row.id === lec.group_id);
                if (!g) return [];
                const tenant = Object.entries(f.tenants).find(([, t]) => t.owner_user_id === g.instructor_id);
                void tenant;
                return g.instructor_id === userId ? [{ id: lec.id }] : [];
            }
            const lec = f.premiumLectures.find((l) => l.id === params[0]);
            return lec ? [{ ...lec, grade_name: null, group_name: null }] : [];
        }
        // -- imports reads --
        if (/FROM imports WHERE/.test(sql) && /SELECT/.test(sql)) {
            if (/WHERE id = \?/.test(sql)) {
                const [id, tenant] = params as [string, string | undefined];
                const imp = f.imports.find((row) => row.id === id && (tenant === undefined || row.tenant_id === tenant));
                return imp ? [{ ...imp }] : [];
            }
            const tenant = params[0] as string | undefined;
            return f.imports
                .filter((row) => tenant === undefined || row.tenant_id === tenant)
                .map((row) => ({ ...row }));
        }
        if (/FROM import_items WHERE import_id = \?/.test(sql)) {
            return f.importItems.filter((row) => row.import_id === params[0]).map((row) => ({ ...row }));
        }
        // -- student_fees duplicate-month / generic --
        if (/FROM student_fees/.test(sql)) return [];
        return [];
    };

    const doExecute = (sql: string, params: unknown[]): { insertId: unknown; affectedRows: number } => {
        if (/INSERT INTO subscriptions/.test(sql)) {
            const [id, student_id, course_id, amount, , , status] = params as [string, string, string, string, unknown, unknown, string];
            f.subscriptions.push({ id, student_id, course_id, amount, status });
            return { insertId: id, affectedRows: 1 };
        }
        if (/UPDATE subscriptions/.test(sql)) {
            const id = params[params.length - 1] as string;
            const tenant = params[0] as string;
            const sub = f.subscriptions.find((row) => row.id === id && studentTenant(row.student_id) === tenant);
            if (!sub) return { insertId: 0, affectedRows: 0 };
            const setPart = /SET([\s\S]*?)subscriptions\.updated_at/s.exec(sql)?.[1] ?? '';
            const cols = [...setPart.matchAll(/subscriptions\.([a-z_]+) = \?/g)].map((m) => m[1]);
            cols.forEach((col, i) => {
                const value = params[1 + i];
                if (col === 'amount') sub.amount = String(value);
                if (col === 'status') sub.status = String(value);
            });
            return { insertId: 0, affectedRows: 1 };
        }
        if (/DELETE .*FROM subscriptions/.test(sql)) {
            const [tenant, id] = params as [string, string];
            const index = f.subscriptions.findIndex((row) => row.id === id && studentTenant(row.student_id) === tenant);
            if (index === -1) return { insertId: 0, affectedRows: 0 };
            f.subscriptions.splice(index, 1);
            return { insertId: 0, affectedRows: 1 };
        }
        if (/INSERT INTO subscription_plans/.test(sql)) {
            const [id, name, duration_months, price] = params as [string, string, number, string];
            f.plans.push({ id, name, duration_months, price, is_active: true });
            return { insertId: id, affectedRows: 1 };
        }
        if (/UPDATE subscription_plans/.test(sql)) {
            const id = params[params.length - 1] as string;
            const plan = f.plans.find((p) => p.id === id);
            if (!plan) return { insertId: 0, affectedRows: 0 };
            // soft-delete guard: only active rows flip
            if (/is_active = FALSE/.test(sql) && !plan.is_active) return { insertId: 0, affectedRows: 0 };
            const setCols = [...sql.matchAll(/([a-z_]+) = \?/g)].map((m) => m[1]);
            setCols.forEach((col, i) => {
                const value = params[i];
                if (col === 'name') plan.name = String(value);
                if (col === 'duration_months') plan.duration_months = Number(value);
                if (col === 'price') plan.price = String(value);
                if (col === 'is_active') plan.is_active = Boolean(value);
            });
            return { insertId: 0, affectedRows: 1 };
        }
        if (/INSERT INTO subscription_requests/.test(sql)) {
            const [id, tenant_id, student_name, phone, guardian_phone, grade_id, grade_name, group_id, group_name,
                , , amount, notes, receipt_image_url] = params as unknown[];
            f.subRequests.push({
                id: String(id), tenant_id: String(tenant_id), student_name: String(student_name), phone: String(phone),
                guardian_phone: (guardian_phone as string | null) ?? null, grade_id: (grade_id as string | null) ?? null,
                grade_name: (grade_name as string | null) ?? null, group_id: (group_id as string | null) ?? null,
                group_name: (group_name as string | null) ?? null, amount: (amount as string | null) ?? null,
                notes: (notes as string | null) ?? null, receipt_image_url: (receipt_image_url as string | null) ?? null,
                status: 'pending',
            });
            return { insertId: id, affectedRows: 1 };
        }
        if (/UPDATE subscription_requests SET status/.test(sql)) {
            const statusMatch = /SET status = \?/.test(sql);
            void statusMatch;
            const hasRejection = /rejection_reason/.test(sql);
            const id = (hasRejection ? params[params.length - 2] : params[params.length - 2]) as string;
            void id;
            const reqId = params.find((p) => typeof p === 'string' && f.subRequests.some((r) => r.id === p)) as string;
            const r = f.subRequests.find((row) => row.id === reqId);
            if (!r || r.status !== 'pending') return { insertId: 0, affectedRows: 0 };
            r.status = String(params[0]);
            return { insertId: 0, affectedRows: 1 };
        }
        if (/DELETE FROM subscription_requests/.test(sql)) {
            const id = params[0] as string;
            const tenant = params.length > 1 ? params[params.length - 1] as string : undefined;
            const index = f.subRequests.findIndex((row) => row.id === id && (tenant === undefined || row.tenant_id === tenant));
            if (index === -1) return { insertId: 0, affectedRows: 0 };
            f.subRequests.splice(index, 1);
            return { insertId: 0, affectedRows: 1 };
        }
        if (/INSERT INTO students/.test(sql)) {
            return { insertId: 'student-new', affectedRows: 1 };
        }
        if (/INSERT INTO student_fees/.test(sql)) {
            f.fees.push({ id: `fee-${f.fees.length}`, tenant_id: String(params[0]) });
            return { insertId: 'fee-new', affectedRows: 1 };
        }
        if (/UPDATE premium_lecture_payments/.test(sql)) {
            // guarded flip: WHERE id=? AND status='pending' -> params [reviewer?, id] or [reviewer, reason, id]
            const id = params.find((p) => typeof p === 'string' && f.premiumPayments.some((pay) => pay.id === p)) as string;
            const pay = f.premiumPayments.find((p) => p.id === id);
            if (!pay || pay.status !== 'pending') return { insertId: 0, affectedRows: 0 };
            pay.status = /'approved'/.test(sql) ? 'approved' : 'rejected';
            return { insertId: 0, affectedRows: 1 };
        }
        if (/INSERT IGNORE INTO premium_lecture_access/.test(sql) || /INSERT INTO premium_lecture_access/.test(sql)) {
            const [id, student_id, premium_lecture_id, payment_id] = params as [string, string, string, string];
            if (/IGNORE/.test(sql) && f.premiumAccess.some((a) => a.student_id === student_id && a.premium_lecture_id === premium_lecture_id)) {
                return { insertId: 0, affectedRows: 0 };
            }
            f.premiumAccess.push({ id, student_id, premium_lecture_id, payment_id });
            return { insertId: 0, affectedRows: 1 };
        }
        if (/INSERT INTO premium_lecture_payments/.test(sql)) {
            const [id, student_id, premium_lecture_id] = params as [string, string, string];
            f.premiumPayments.push({ id, student_id, premium_lecture_id, status: 'pending' });
            return { insertId: 0, affectedRows: 1 };
        }
        if (/INSERT INTO premium_lectures/.test(sql)) {
            const [id, title, , , , , price, , group_id] = params as [string, string, unknown, unknown, unknown, unknown, string, unknown, string | null];
            f.premiumLectures.push({ id, title, price: String(price), group_id, is_published: false });
            return { insertId: 0, affectedRows: 1 };
        }
        if (/INSERT INTO imports/.test(sql)) {
            const [id, tenant_id, supplier_name, , , , total_amount, paid_amount] = params as [string, string, string, unknown, unknown, unknown, string, string];
            f.imports.push({ id, tenant_id, supplier_name, total_amount, paid_amount });
            return { insertId: id, affectedRows: 1 };
        }
        if (/INSERT INTO import_items/.test(sql)) {
            const [id, import_id, , item_name, quantity, unit_price] = params as [string, string, unknown, string, number, string];
            f.importItems.push({ id, import_id, item_name, quantity, unit_price });
            return { insertId: id, affectedRows: 1 };
        }
        if (/UPDATE imports SET/.test(sql)) {
            const id = params[params.length - 2] as string;
            const tenant = params[params.length - 1] as string;
            const imp = f.imports.find((row) => row.id === id && row.tenant_id === tenant);
            if (!imp) return { insertId: 0, affectedRows: 0 };
            return { insertId: 0, affectedRows: 1 };
        }
        if (/DELETE FROM imports/.test(sql)) {
            const [id, tenant] = params as [string, string];
            const index = f.imports.findIndex((row) => row.id === id && row.tenant_id === tenant);
            if (index === -1) return { insertId: 0, affectedRows: 0 };
            f.imports.splice(index, 1);
            return { insertId: 0, affectedRows: 1 };
        }
        throw new Error(`unexpected statement: ${sql}`);
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
        return doExecute(sql, params);
    };
    const withTransaction = async <T>(work: (tx: TxAdapter) => Promise<T>): Promise<T> => {
        // Hermetic stand-in: run on the same fixture adapter. Atomicity of the
        // guarded flip (affectedRows) is what the tests assert; the production
        // adapter binds a real pooled transaction.
        return work({ query, queryOne, execute });
    };

    return { executed, query, queryOne, execute, withTransaction };
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const makeHarness = (fixtures: Fixtures = makeFixtures()) => {
    const db = makeDb(fixtures);
    const repository = makeRepository(fixtures);
    const authenticate = createAuthenticateToken(repository) as RequestHandler;
    const authorize = requireRoles('admin', 'instructor', 'teacher', 'staff');
    const adminPermissionLookup = {
        isSuperAdmin: async (userId: string) => (fixtures.adminRoles[userId] ?? []).includes('super_admin'),
        getAdminPermissions: async (userId: string) => fixtures.adminPermissions[userId] ?? [],
    };
    const authorizeSubscriptionPlanWrite = createRequireAdminPermission(
        'subscription.create',
        adminPermissionLookup,
    );
    const hasVerifiedPlatformFinanceAccess = async (userId: string): Promise<boolean> =>
        (fixtures.adminRoles[userId] ?? []).includes('super_admin');
    const loadActiveTenantAuthority = async (userId: string, tenantId: string) => {
        const tenant = fixtures.tenants[tenantId];
        if (tenant && tenant.owner_user_id === userId) return { authority: 'owner' };
        const membership = (fixtures.memberships[userId] ?? []).find((m) => m.tenant_id === tenantId);
        if (membership && (membership.role_key === 'owner' || membership.role_key === 'instructor')) {
            return { authority: membership.role_key };
        }
        return null;
    };
    return {
        fixtures,
        executed: db.executed,
        subscriptions: createSubscriptionsRouter({ db, authenticate, authorize, hasVerifiedPlatformFinanceAccess, loadActiveTenantAuthority }),
        plans: createSubscriptionPlansRouter({
            db,
            authenticate,
            authorize,
            authorizeWrite: authorizeSubscriptionPlanWrite,
        }),
        subRequests: createSubscriptionRequestsRouter({
            db, authenticate, authorize, hasVerifiedPlatformFinanceAccess, loadActiveTenantAuthority,
            sendApprovalNotification: async () => ({ success: true, whatsappLink: 'https://wa.me/test' }),
        }),
        premium: createPremiumLectureRouter({
            query: db.query, queryOne: db.queryOne, execute: db.execute,
            withTransaction: db.withTransaction,
            authenticate,
            hasPlatformCapability: async (userId) => (fixtures.adminRoles[userId] ?? []).includes('super_admin'),
            branchAccess: tenantScopeBranchDeps((type, id) => {
                if (type !== 'premium_lecture') return null;
                const lecture = fixtures.premiumLectures.find((row) => row.id === id);
                if (!lecture?.group_id) return null;
                return lecture.group_id === 'group-b' ? 'tenant-b' : 'tenant-a';
            }),
        }),
        imports: createImportsRouter({ db, authenticate, authorize, hasVerifiedPlatformFinanceAccess, loadActiveTenantAuthority }),
        fees: createFeesRouter({ db, authenticate, authorize, hasVerifiedPlatformFinanceAccess, loadActiveTenantAuthority }),
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

const invokeRoute = async (router: Router, request: RouteRequest): Promise<CapturedResponse> => {
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
    const deadline = Date.now() + 5000;
    while (response.statusCode === undefined && response.body === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
};

const tokenFor = (claims: Record<string, unknown>): string => jwt.sign(claims, TEST_SECRET);
// NOTE: JWT role labels only pass the outer role gate; real authority is
// resolved server-side (tenants.owner_user_id / membership role_key). Owner
// principals below use the pre-existing route gates ('admin','teacher') with
// owner authority, exactly as production wires them.
// Premium-lecture creation uses the verified platform admin path because the
// teacher-list gate keys off a student-only identity field (open question in
// the finance report); approval and entitlement run as the owning instructor.
const OWNER_A = tokenFor({ id: 'owner-a', role: 'teacher', tv: 0 });
const OWNER_B = tokenFor({ id: 'owner-b', role: 'teacher', tv: 0 });
const TEACHER_A = tokenFor({ id: 'teacher-a', role: 'teacher', tv: 0 });
const STUDENT_U = tokenFor({ id: 'student-u', role: 'student', tv: 0, student_enrollment_id: 'student-a' });
const ADMIN_SUPER = tokenFor({ id: 'admin-super', role: 'admin', tv: 0 });
const ADMIN_BARE = tokenFor({ id: 'admin-bare', role: 'admin', tv: 0 });

const assertNoWrite = (executed: ExecutedStatement[]) => {
    for (const statement of executed) {
        assert.ok(!/\bINSERT\b/i.test(statement.sql), `unexpected INSERT: ${statement.sql}`);
        assert.ok(!/\bUPDATE\b/i.test(statement.sql), `unexpected UPDATE: ${statement.sql}`);
        assert.ok(!/\bDELETE\b/i.test(statement.sql), `unexpected DELETE: ${statement.sql}`);
    }
};

// ===========================================================================
// Money: integer minor units / Decimal only
// ===========================================================================

test('money: subscriptions reject a 3dp float and issue no write', async () => {
    const { subscriptions, executed, fixtures } = makeHarness();
    const response = await invokeRoute(subscriptions, {
        method: 'POST', url: '/', token: OWNER_A,
        body: { student_id: 'student-a', course_id: 'course-a', amount: 19.999 },
    });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
    assert.equal(fixtures.subscriptions.length, 2);
});

test('money: subscription plans reject a non-numeric price', async () => {
    const { plans, executed } = makeHarness();
    const response = await invokeRoute(plans, {
        method: 'POST', url: '/', token: ADMIN_SUPER,
        body: { name: 'Bad', duration_months: 1, price: 'free' },
    });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

test('money: subscription requests reject a negative amount', async () => {
    const { subRequests, executed } = makeHarness();
    const response = await invokeRoute(subRequests, {
        method: 'POST', url: '/', token: TEACHER_A,
        body: { student_name: 'Kid', phone: '03333', amount: -5 },
    });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

test('money: imports reject a 3dp total_amount', async () => {
    const { imports, executed } = makeHarness();
    const response = await invokeRoute(imports, {
        method: 'POST', url: '/', token: OWNER_A,
        body: { supplier_name: 'S', import_date: '2026-10-01', total_amount: '12.345' },
    });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

test('money: fees reject a 3dp float update with 400 and no UPDATE', async () => {
    const { fees, executed } = makeHarness();
    const response = await invokeRoute(fees, {
        method: 'PUT', url: '/fee-a', token: OWNER_A,
        body: { amount: 10.001 },
    });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

test('money: premium lecture creation rejects NaN price', async () => {
    const { premium, executed } = makeHarness();
    const response = await invokeRoute(premium, {
        method: 'POST', url: '/', token: ADMIN_SUPER,
        body: { title: 'L', video_url: 'https://v.test/x', price: NaN, group_id: 'group-a' },
    });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

// ===========================================================================
// Tenant isolation: deny by default
// ===========================================================================

test('tenant: subscriptions list is scoped to the caller tenant', async () => {
    const { subscriptions } = makeHarness();
    const response = await invokeRoute(subscriptions, { method: 'GET', url: '/', token: OWNER_A });
    assert.equal(response.statusCode, undefined);
    assert.deepEqual((response.body as Array<{ id: string }>).map((r) => r.id), ['sub-a']);
});

test('tenant: subscription single read of a foreign row is 404', async () => {
    const { subscriptions } = makeHarness();
    const response = await invokeRoute(subscriptions, { method: 'GET', url: '/sub-b', token: OWNER_A });
    assert.equal(response.statusCode, 404);
});

test('tenant: subscription create with a foreign student is 404 before any INSERT', async () => {
    const { subscriptions, executed, fixtures } = makeHarness();
    const response = await invokeRoute(subscriptions, {
        method: 'POST', url: '/', token: OWNER_A,
        body: { student_id: 'student-b', course_id: 'course-a', amount: '10.00' },
    });
    assert.equal(response.statusCode, 404);
    assertNoWrite(executed);
    assert.equal(fixtures.subscriptions.length, 2);
});

test('tenant: a bare admin role label cannot approve a foreign subscription request', async () => {
    const { subRequests, executed } = makeHarness();
    const response = await invokeRoute(subRequests, { method: 'POST', url: '/req-b/approve', token: ADMIN_BARE });
    // No verified platform capability and no tenant workspace: denied before data access.
    assert.ok(response.statusCode === 403 || response.statusCode === 404);
    assertNoWrite(executed);
});

test('tenant: imports list is scoped and foreign single read is 404', async () => {
    const h = makeHarness();
    const list = await invokeRoute(h.imports, { method: 'GET', url: '/', token: OWNER_A });
    assert.equal(list.statusCode, undefined);
    assert.deepEqual((list.body as Array<{ id: string }>).map((r) => r.id), ['imp-a']);

    const foreign = await invokeRoute(h.imports, { method: 'GET', url: '/imp-b', token: OWNER_A });
    assert.equal(foreign.statusCode, 404);
});

test('tenant: cross-tenant import delete is 404 and the foreign row survives', async () => {
    const { imports, fixtures } = makeHarness();
    const response = await invokeRoute(imports, { method: 'DELETE', url: '/imp-b', token: OWNER_A });
    assert.equal(response.statusCode, 404);
    assert.ok(fixtures.imports.some((row) => row.id === 'imp-b'));
});

// ===========================================================================
// Idempotency: approvals and creates
// ===========================================================================

test('idempotency: double subscription-request approval writes a single fee', async () => {
    const { subRequests, fixtures } = makeHarness();
    const first = await invokeRoute(subRequests, { method: 'POST', url: '/req-a/approve', token: OWNER_A });
    assert.equal(first.statusCode, undefined);
    assert.equal(fixtures.fees.length, 1);

    const second = await invokeRoute(subRequests, { method: 'POST', url: '/req-a/approve', token: OWNER_A });
    assert.equal(second.statusCode, 400);
    assert.equal(fixtures.fees.length, 1, 'the retry must not post a second fee');
});

test('idempotency: double premium-payment approval grants a single access row', async () => {
    const { premium, fixtures } = makeHarness();
    const first = await invokeRoute(premium, { method: 'POST', url: '/payments/pay-pending/approve', token: OWNER_A });
    assert.equal(first.statusCode, 200);
    assert.equal(fixtures.premiumAccess.length, 1);

    const second = await invokeRoute(premium, { method: 'POST', url: '/payments/pay-pending/approve', token: OWNER_A });
    assert.equal(second.statusCode, 400);
    assert.equal(fixtures.premiumAccess.length, 1, 'the retry must not grant access twice');
});

test('idempotency: subscription create with a reused client id returns the existing row once', async () => {
    const { subscriptions, fixtures } = makeHarness();
    const body = { id: 'sub-client-1', student_id: 'student-a', course_id: 'course-a', amount: '25.00' };
    const first = await invokeRoute(subscriptions, { method: 'POST', url: '/', token: OWNER_A, body });
    assert.equal(first.statusCode, 201);
    const second = await invokeRoute(subscriptions, { method: 'POST', url: '/', token: OWNER_A, body });
    assert.equal(second.statusCode, 200);
    assert.equal(fixtures.subscriptions.filter((s) => s.id === 'sub-client-1').length, 1);
});

test('idempotency: double subscription-request rejection is 400 on retry', async () => {
    const { subRequests } = makeHarness();
    const first = await invokeRoute(subRequests, {
        method: 'POST', url: '/req-a/reject', token: OWNER_A, body: { rejection_reason: 'dup' },
    });
    assert.equal(first.statusCode, undefined);
    const second = await invokeRoute(subRequests, {
        method: 'POST', url: '/req-a/reject', token: OWNER_A, body: { rejection_reason: 'dup' },
    });
    assert.equal(second.statusCode, 400);
});

// ===========================================================================
// Entitlement: premium lecture access requires a real approved entitlement
// ===========================================================================

test('entitlement: lecture detail without granted access is 404 (no metadata leak)', async () => {
    const { premium } = makeHarness();
    const response = await invokeRoute(premium, { method: 'GET', url: '/lec-a', token: STUDENT_U });
    assert.equal(response.statusCode, 404);
});

test('entitlement: lecture detail after approval returns the lecture', async () => {
    const h = makeHarness();
    const approve = await invokeRoute(h.premium, { method: 'POST', url: '/payments/pay-pending/approve', token: OWNER_A });
    assert.equal(approve.statusCode, 200);
    const response = await invokeRoute(h.premium, { method: 'GET', url: '/lec-a', token: STUDENT_U });
    assert.equal(response.statusCode, undefined);
    assert.equal((response.body as { id: string }).id, 'lec-a');
});

test('entitlement: access check is false before approval and true after', async () => {
    const h = makeHarness();
    const before = await invokeRoute(h.premium, { method: 'GET', url: '/access/check/student-a/lec-a', token: OWNER_A });
    assert.equal((before.body as { hasAccess: boolean }).hasAccess, false);

    const approve = await invokeRoute(h.premium, { method: 'POST', url: '/payments/pay-pending/approve', token: OWNER_A });
    assert.equal(approve.statusCode, 200);

    const afterCheck = await invokeRoute(h.premium, { method: 'GET', url: '/access/check/student-a/lec-a', token: OWNER_A });
    assert.equal((afterCheck.body as { hasAccess: boolean }).hasAccess, true);
});

test('platform: verified super_admin reads subscriptions across tenants without a tenant predicate', async () => {
    const { subscriptions, executed } = makeHarness();
    const response = await invokeRoute(subscriptions, { method: 'GET', url: '/', token: ADMIN_SUPER });
    assert.equal(response.statusCode, undefined);
    assert.deepEqual((response.body as Array<{ id: string }>).map((r) => r.id).sort(), ['sub-a', 'sub-b']);
    assert.ok(!executed[0].params.includes('tenant-a'), 'platform reads must not bind a tenant');
});
