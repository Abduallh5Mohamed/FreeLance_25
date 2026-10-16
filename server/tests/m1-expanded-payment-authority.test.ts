/**
 * M1 expanded payment-authority regression suite (hermetic: no DB, no
 * network, no real env keys, no Docker, no live app startup).
 *
 * Drives the PRODUCTION payment-requests and instructor-wallet routers
 * (`createPaymentRequestsRouter` / `createInstructorWalletRouter`) through
 * injected seams: a fixture-backed SQL adapter, the REAL authentication
 * middleware (`createAuthenticateToken` over an injected principal
 * repository), the REAL role gate (`requireRoles`), the REAL
 * platform-capability guard factory (`createRequireAdminPermission`) over an
 * injected permission lookup, and a fixture stand-in for the service-credit
 * transaction service. No MySQL pool is ever created because no production
 * query runs; src/db.ts only runs dotenv.config() at import and there is no
 * .env file on disk (matching the sibling M1 boundary suites).
 *
 * Defects audited and pinned here:
 *  - tenant scoping of every payment-request read/write (owner + tenant);
 *  - duplicate state transition on approve/reject (the request row is locked
 *    FOR UPDATE and the status flip is guarded by status='pending');
 *  - partial-write failure on approve (fee + revenue + status + notify are
 *    one transaction: a mid-flight failure rolls the whole thing back);
 *  - capability/owner checks on the wallet read and the admin-only
 *    credit/debit adjustments, with the actor id server-derived (never taken
 *    from the request body) and the amount validated server-side.
 *
 * Evidence classes, labeled per test:
 *  - behavioral: the real handler's own JS decision (status codes, mutated
 *    fixture rows, values returned to the caller);
 *  - decision-boundary (SQL text + params of the executed statement): scoping
 *    and locking are applied by MySQL clauses, so hermetically we assert the
 *    exact SQL and bindings the real handler executed. Live row-level
 *    filtering / row-lock serialization remains the Docker integration
 *    suite's responsibility (NOT RUN here).
 *
 * Test limits (explicit):
 *  - The HTTP layer is not exercised (no supertest in the repo): the router is
 *    invoked as middleware with fake req/res objects, matching the established
 *    m1-expanded-finance-records pattern.
 *  - `withTransaction` here is an isolated adapter that snapshots/restores the
 *    fixtures; the real pool BEGIN/COMMIT/ROLLBACK and true concurrent
 *    FOR UPDATE serialization are NOT exercised (no live DB).
 *  - `requireSelfOrAdminPermission` is a 4-line wrapper that lives in the
 *    out-of-scope shared file security/admin-permissions.ts, so it is
 *    replicated here on top of the REAL `createRequireAdminPermission`.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import jwt from 'jsonwebtoken';
import type { NextFunction, RequestHandler, Router } from 'express';
import { createAuthenticateToken, requireRoles } from '../src/middleware/auth';
import type { PrincipalRepository } from '../src/security/principal-repository';
import { createRequireAdminPermission } from '../src/security/admin-permissions';
import type { AdminPermissionLookup } from '../src/security/admin-permissions';
import { createPaymentRequestsRouter, PaymentRequestsDataAccess } from '../src/routes/payment-requests';
import { createInstructorWalletRouter, InstructorWalletDataAccess } from '../src/routes/instructor-wallet';
import { CreditAdjustmentError } from '../src/services/service-credit';

const TEST_SECRET = 'test-only-secret-with-sufficient-length';
const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

// ---------------------------------------------------------------------------
// Fixtures: two tenants, instructors/teachers/staff, a platform admin, and
// payment requests / wallets.
// ---------------------------------------------------------------------------

interface StudentRow {
    id: string; tenant_id: string; user_id: string | null; name: string;
    phone: string | null; guardian_phone: string | null; email: string | null;
    grade_id: string | null; group_id: string | null; is_active: number;
}
interface PaymentRequestRow {
    id: string; tenant_id: string; student_id: string; student_name: string;
    phone: string | null; email: string | null; grade_id: string; grade_name: string;
    group_id: string; group_name: string; amount: number; payment_method: string;
    receipt_image_url: string | null; notes: string | null; status: string;
    rejection_reason?: string | null;
}

interface Fixtures {
    users: Record<string, { is_active: number; token_version: number; suspension_active: number }>;
    memberships: Record<string, Array<{ tenant_id: string }>>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    adminRoles: Record<string, string[]>;
    adminPermissions: Record<string, string[]>;
    /** Admins holding the verified platform finance-read capability (global read only). */
    financeReadAdmins: Set<string>;
    tenants: Array<{ id: string; status: string; owner_user_id: string }>;
    grades: Array<{ id: string; name: string }>;
    groups: Array<{ id: string; name: string; instructor_id: string; tenant_id: string }>;
    students: StudentRow[];
    paymentRequests: PaymentRequestRow[];
    studentFees: Array<Record<string, unknown>>;
    revenues: Array<Record<string, unknown>>;
    notifications: Array<Record<string, unknown>>;
    /** First active platform admin id returned by the legacy notify lookup. */
    legacyAdminId: string | null;
    /** Force a mid-transaction write failure to exercise rollback. */
    failOn?: 'student_fees' | 'revenues';
    /** Simulate a concurrent transaction that already consumed the transition. */
    simulateLostTransition?: boolean;
}

const makeFixtures = (): Fixtures => ({
    users: {
        'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'instructor-b': { is_active: 1, token_version: 0, suspension_active: 0 },
        'instructor-none': { is_active: 1, token_version: 0, suspension_active: 0 },
        'teacher-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'staff-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'owner-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'owner-b': { is_active: 1, token_version: 0, suspension_active: 0 },
        'admin-plat': { is_active: 1, token_version: 0, suspension_active: 0 },
        'admin-super': { is_active: 1, token_version: 0, suspension_active: 0 },
        'student-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'revoked-user': { is_active: 0, token_version: 0, suspension_active: 0 },
    },
    memberships: {
        'instructor-a': [{ tenant_id: 'tenant-a' }],
        'instructor-b': [{ tenant_id: 'tenant-b' }],
        'instructor-none': [],
        'teacher-a': [{ tenant_id: 'tenant-a' }],
        'staff-a': [{ tenant_id: 'tenant-a' }],
        'owner-a': [{ tenant_id: 'tenant-a' }],
    },
    instructorAccounts: {
        'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'instructor-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'instructor-none': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'owner-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
    },
    adminRoles: { 'admin-super': ['super_admin'] },
    adminPermissions: { 'admin-super': ['service_credit.read', 'service_credit.adjust'] },
    tenants: [
        { id: 'tenant-a', status: 'active', owner_user_id: 'owner-a' },
        { id: 'tenant-b', status: 'active', owner_user_id: 'owner-b' },
    ],
    grades: [
        { id: 'grade-a1', name: 'Grade A1' },
        { id: 'grade-b1', name: 'Grade B1' },
    ],
    groups: [
        { id: 'group-a1', name: 'Group A1', instructor_id: 'instructor-a', tenant_id: 'tenant-a' },
        { id: 'group-b1', name: 'Group B1', instructor_id: 'instructor-b', tenant_id: 'tenant-b' },
    ],
    students: [
        {
            id: 'student-a1', tenant_id: 'tenant-a', user_id: 'user-stu-a1', name: 'Alice A',
            phone: '0100', guardian_phone: '0111', email: 'a@a.test',
            grade_id: 'grade-a1', group_id: 'group-a1', is_active: 1,
        },
        {
            id: 'student-b1', tenant_id: 'tenant-b', user_id: 'user-stu-b1', name: 'Bob B',
            phone: '0200', guardian_phone: '0222', email: 'b@b.test',
            grade_id: 'grade-b1', group_id: 'group-b1', is_active: 1,
        },
        {
            id: 'student-a-inactive', tenant_id: 'tenant-a', user_id: null, name: 'Gone',
            phone: null, guardian_phone: null, email: null,
            grade_id: 'grade-a1', group_id: 'group-a1', is_active: 0,
        },
    ],
    paymentRequests: [
        {
            id: 'req-a1', tenant_id: 'tenant-a', student_id: 'student-a1', student_name: 'Alice A',
            phone: '0100', email: 'a@a.test', grade_id: 'grade-a1', grade_name: 'Grade A1',
            group_id: 'group-a1', group_name: 'Group A1', amount: 100, payment_method: 'cash',
            receipt_image_url: null, notes: null, status: 'pending',
        },
        {
            id: 'req-a2', tenant_id: 'tenant-a', student_id: 'student-a1', student_name: 'Alice A',
            phone: '0100', email: 'a@a.test', grade_id: 'grade-a1', grade_name: 'Grade A1',
            group_id: 'group-a1', group_name: 'Group A1', amount: 50, payment_method: 'cash',
            receipt_image_url: null, notes: null, status: 'approved',
        },
        {
            id: 'req-b1', tenant_id: 'tenant-b', student_id: 'student-b1', student_name: 'Bob B',
            phone: '0200', email: 'b@b.test', grade_id: 'grade-b1', grade_name: 'Grade B1',
            group_id: 'group-b1', group_name: 'Group B1', amount: 75, payment_method: 'cash',
            receipt_image_url: null, notes: null, status: 'pending',
        },
    ],
    studentFees: [],
    revenues: [],
    notifications: [],
    legacyAdminId: 'admin-plat',
    financeReadAdmins: new Set(['admin-super']),
});

const makeRepository = (fixtures: Fixtures): PrincipalRepository => ({
    findUsersIdentity: async (id) => fixtures.users[id] ?? null,
    findStaffIdentity: async () => null,
    findInstructorAccount: async (id) => fixtures.instructorAccounts[id] ?? null,
    findStudentEnrollments: async () => [],
    findActiveTenantMemberships: async (id) => fixtures.memberships[id] ?? [],
});

// ---------------------------------------------------------------------------
// Fixture-backed SQL adapter for the payment-requests router.
// ---------------------------------------------------------------------------

const tenantPredicate = (sql: string): boolean => sql.includes('tenant_id=?');

const makePaymentDb = (fixtures: Fixtures) => {
    const f = fixtures;
    const executed: Array<{ sql: string; params: unknown[] }> = [];

    const queryImpl = async (sql: string, params: any[] = []): Promise<any[]> => {
        if (sql.includes('FROM payment_requests pr')) {
            const tenantId = tenantPredicate(sql) ? params[0] : undefined;
            const status = sql.includes('pr.status=?') ? params[tenantPredicate(sql) ? 1 : 0] : undefined;
            const studentId = sql.includes('pr.student_id=?')
                ? params[(tenantPredicate(sql) ? 1 : 0) + (status ? 1 : 0)]
                : undefined;
            return f.paymentRequests
                .filter((r) => (tenantId === undefined || r.tenant_id === tenantId))
                .filter((r) => (status === undefined || r.status === status))
                .filter((r) => (studentId === undefined || r.student_id === studentId))
                .map((r) => {
                    const student = f.students.find((s) => s.id === r.student_id && s.tenant_id === r.tenant_id);
                    const grade = f.grades.find((g) => g.id === r.grade_id);
                    const group = f.groups.find((g) => g.id === r.group_id);
                    return {
                        ...r,
                        student_name: student?.name ?? null,
                        student_phone: student?.phone ?? null,
                        grade_name: grade?.name ?? null,
                        group_name: group?.name ?? null,
                    };
                });
        }
        if (sql.includes('COUNT(*) AS total') && sql.includes('payment_requests')) {
            const tenantId = tenantPredicate(sql) ? params[0] : undefined;
            const rows = f.paymentRequests.filter((r) => tenantId === undefined || r.tenant_id === tenantId);
            return [{
                total: rows.length,
                pending: rows.filter((r) => r.status === 'pending').length,
                approved: rows.filter((r) => r.status === 'approved').length,
                rejected: rows.filter((r) => r.status === 'rejected').length,
                total_approved_amount: rows.filter((r) => r.status === 'approved')
                    .reduce((sum, r) => sum + Number(r.amount), 0),
            }];
        }
        if (sql.includes('SELECT * FROM payment_requests')) {
            const id = params[0];
            const tenantId = tenantPredicate(sql) ? params[1] : undefined;
            const row = f.paymentRequests.find((r) => r.id === id && (tenantId === undefined || r.tenant_id === tenantId));
            return row ? [{ ...row }] : [];
        }
        if (sql.includes('FROM students')) {
            const id = params[0];
            const tenantId = tenantPredicate(sql) ? params[1] : undefined;
            const row = f.students.find((s) => s.id === id
                && (tenantId === undefined || s.tenant_id === tenantId)
                && (sql.includes('is_active=1') ? s.is_active === 1 : true));
            return row ? [{ ...row }] : [];
        }
        if (sql.includes('FROM grades')) {
            const row = f.grades.find((g) => g.id === params[0]);
            return row ? [{ ...row }] : [];
        }
        if (sql.includes('`groups`')) {
            const tenantId = params[0];
            const groupId = params[1];
            const group = f.groups.find((g) => g.id === groupId && g.tenant_id === tenantId);
            const tenant = f.tenants.find((t) => t.id === tenantId && t.status === 'active');
            const instructorMember = group
                ? (f.memberships[group.instructor_id] ?? []).some((m) => m.tenant_id === tenantId)
                : false;
            return group && tenant && instructorMember ? [{ id: group.id, name: group.name }] : [];
        }
        if (sql.includes('owner_user_id') && sql.includes('FROM tenants')) {
            const tenantId = params[0];
            const status = params[1];
            const tenant = f.tenants.find((t) => t.id === tenantId && (status === undefined || t.status === status));
            return tenant?.owner_user_id ? [{ owner_user_id: tenant.owner_user_id }] : [];
        }
        if (sql.includes("role='admin'")) {
            return f.legacyAdminId ? [{ id: f.legacyAdminId }] : [];
        }
        throw new Error(`unexpected query: ${sql}`);
    };

    const executeImpl = async (sql: string, params: any[] = []): Promise<{ affectedRows: number; insertId: number }> => {
        if (sql.includes('INSERT INTO payment_requests')) {
            f.paymentRequests.push({
                id: params[0], tenant_id: params[1], student_id: params[2], student_name: params[3],
                phone: params[4], email: params[5], grade_id: params[6], grade_name: params[7],
                group_id: params[8], group_name: params[9], amount: params[10], payment_method: params[11],
                receipt_image_url: params[12], notes: params[13], status: 'pending',
            });
            return { affectedRows: 1, insertId: 0 };
        }
        if (sql.includes('INSERT INTO student_fees')) {
            if (f.failOn === 'student_fees') throw new Error('simulated student_fees write failure');
            f.studentFees.push({
                tenant_id: params[0], student_id: params[1], student_name: params[2], amount: params[9],
                paid_amount: params[10], status: 'paid', payment_method: params[11], notes: params[12],
            });
            return { affectedRows: 1, insertId: f.studentFees.length };
        }
        if (sql.includes('INSERT INTO revenues')) {
            if (f.failOn === 'revenues') throw new Error('simulated revenues write failure');
            f.revenues.push({ tenant_id: params[0], amount: params[1], source: 'student_fees' });
            return { affectedRows: 1, insertId: f.revenues.length };
        }
        if (sql.includes('UPDATE payment_requests')) {
            const isApprove = sql.includes("status='approved'");
            const id = isApprove ? params[0] : params[1];
            const tenantId = isApprove ? params[1] : params[2];
            if (f.simulateLostTransition) return { affectedRows: 0, insertId: 0 };
            const row = f.paymentRequests.find((r) => r.id === id && r.tenant_id === tenantId && r.status === 'pending');
            if (!row) return { affectedRows: 0, insertId: 0 };
            row.status = isApprove ? 'approved' : 'rejected';
            if (!isApprove) row.rejection_reason = params[0];
            return { affectedRows: 1, insertId: 0 };
        }
        if (sql.includes('INSERT INTO notifications')) {
            // user_id is the only bound parameter; user_type/type are SQL
            // literals, so read them from the statement text.
            const typeMatch = /'(payment_[a-z_]+)'/.exec(sql);
            const userTypeMatch = /VALUES \(\?,'([a-z]+)'/.exec(sql);
            f.notifications.push({
                user_id: params[0],
                user_type: userTypeMatch ? userTypeMatch[1] : undefined,
                type: typeMatch ? typeMatch[1] : undefined,
            });
            return { affectedRows: 1, insertId: f.notifications.length };
        }
        throw new Error(`unexpected execute: ${sql}`);
    };

    const query = (async (sql: string, params?: any[]) => {
        executed.push({ sql, params: params ?? [] });
        return queryImpl(sql, params ?? []);
    }) as PaymentRequestsDataAccess['query'];

    const queryOne = (async (sql: string, params?: any[]) => {
        const rows = await query(sql, params);
        return rows.length > 0 ? rows[0] : null;
    }) as PaymentRequestsDataAccess['queryOne'];

    const execute = (async (sql: string, params?: any[]) => {
        executed.push({ sql, params: params ?? [] });
        return executeImpl(sql, params ?? []) as never;
    }) as PaymentRequestsDataAccess['execute'];

    const restore = (snapshot: Fixtures) => {
        (Object.keys(snapshot) as Array<keyof Fixtures>).forEach((key) => {
            (f as any)[key] = structuredClone(snapshot[key]);
        });
    };

    const withTransaction: PaymentRequestsDataAccess['withTransaction'] = async (work) => {
        const snapshot = structuredClone(f);
        try {
            return await work({ query, queryOne, execute });
        } catch (error) {
            restore(snapshot);
            throw error;
        }
    };

    return { db: { query, queryOne, execute, withTransaction } as PaymentRequestsDataAccess, executed };
};

// ---------------------------------------------------------------------------
// Fixture-backed SQL adapter for the instructor-wallet router.
// ---------------------------------------------------------------------------

const makeWalletDb = (fixtures: { balances: Record<string, string>; transactions: any[] }) => {
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const queryImpl = async (sql: string, params: any[] = []): Promise<any[]> => {
        if (sql.includes('INSERT IGNORE INTO instructor_wallets')) {
            const id = params[0];
            if (!(id in fixtures.balances)) fixtures.balances[id] = '0.00';
            return [];
        }
        if (sql.includes('FROM instructor_wallets')) {
            const id = params[0];
            return id in fixtures.balances ? [{ balance: fixtures.balances[id], updated_at: 'now' }] : [];
        }
        if (sql.includes('SUM(type = ')) {
            const id = params[0];
            const rows = fixtures.transactions.filter((t) => t.instructor_id === id);
            return [{
                credits: rows.filter((t) => t.type === 'credit').length,
                debits: rows.filter((t) => t.type === 'debit').length,
                total_credited: rows.filter((t) => t.type === 'credit').reduce((s, t) => s + Number(t.amount), 0),
                total_debited: rows.filter((t) => t.type === 'debit').reduce((s, t) => s + Number(t.amount), 0),
            }];
        }
        if (sql.includes('COUNT(*) AS total') && sql.includes('instructor_wallet_transactions')) {
            const id = params[0];
            const type = params[1];
            const rows = fixtures.transactions.filter((t) => t.instructor_id === id && (type === undefined || t.type === type));
            return [{ total: rows.length }];
        }
        if (sql.includes('FROM instructor_wallet_transactions t')) {
            const id = params[0];
            const type = params[1];
            const rows = fixtures.transactions.filter((t) => t.instructor_id === id && (type === undefined || t.type === type));
            return rows.map((t) => ({ ...t }));
        }
        throw new Error(`unexpected wallet query: ${sql}`);
    };
    const query = (async (sql: string, params?: any[]) => {
        executed.push({ sql, params: params ?? [] });
        return queryImpl(sql, params ?? []);
    }) as InstructorWalletDataAccess['query'];
    const queryOne = (async (sql: string, params?: any[]) => {
        const rows = await query(sql, params);
        return rows.length > 0 ? rows[0] : null;
    }) as InstructorWalletDataAccess['queryOne'];
    const execute = (async (sql: string, params?: any[]) => {
        executed.push({ sql, params: params ?? [] });
        throw new Error(`unexpected wallet execute: ${sql}`);
    }) as InstructorWalletDataAccess['execute'];
    return { db: { query, queryOne, execute } as InstructorWalletDataAccess, executed };
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const invokeRoute = async (router: Router, request: {
    method: string; url: string; token?: string | null; body?: unknown; query?: Record<string, unknown>;
}) => {
    const response: { statusCode?: number; body?: unknown; status(code: number): any; json(payload: unknown): any } = {
        status(code: number) { response.statusCode = code; return response; },
        // Express defaults the status to 200 when json() is called without an
        // explicit status(); mirror that so a success path reports 200.
        json(payload: unknown) {
            if (response.statusCode === undefined) response.statusCode = 200;
            response.body = payload;
            return response;
        },
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
const T = {
    instructorA: tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0 }),
    instructorB: tokenFor({ id: 'instructor-b', role: 'instructor', tv: 0 }),
    instructorNone: tokenFor({ id: 'instructor-none', role: 'instructor', tv: 0 }),
    teacherA: tokenFor({ id: 'teacher-a', role: 'teacher', tv: 0 }),
    staffA: tokenFor({ id: 'staff-a', role: 'staff', tv: 0 }),
    ownerA: tokenFor({ id: 'owner-a', role: 'instructor', tv: 0 }),
    adminPlat: tokenFor({ id: 'admin-plat', role: 'admin', tv: 0 }),
    adminSuper: tokenFor({ id: 'admin-super', role: 'admin', tv: 0 }),
    studentA: tokenFor({ id: 'student-a', role: 'student', tv: 0 }),
    revoked: tokenFor({ id: 'revoked-user', role: 'teacher', tv: 0 }),
};

const makePaymentHarness = (fixtures: Fixtures = makeFixtures()) => {
    const { db, executed } = makePaymentDb(fixtures);
    // Injected server-owned authority seams (mirror the production
    // finance.read capability and the tenant owner/instructor authority
    // lookup used by fees.ts). Hermetic so the real guard runs without a DB.
    const hasVerifiedPlatformFinanceAccess = async (userId: string): Promise<boolean> =>
        fixtures.financeReadAdmins?.has(userId) ?? false;
    const loadActiveTenantAuthority = async (userId: string, tenantId: string) => {
        if (userId === 'instructor-a' && tenantId === 'tenant-a') return { authority: 'instructor' };
        if (userId === 'owner-a' && tenantId === 'tenant-a') return { authority: 'owner' };
        return null;
    };
    const router = createPaymentRequestsRouter({
        db,
        authenticate: createAuthenticateToken(makeRepository(fixtures)) as RequestHandler,
        authorize: requireRoles('admin', 'instructor', 'teacher', 'staff'),
        hasVerifiedPlatformFinanceAccess,
        loadActiveTenantAuthority,
    });
    return { fixtures, executed, router };
};

const makeWalletHarness = (fixtures = makeFixtures(), directAllowed = false) => {
    const walletState = {
        balances: { 'instructor-a': '10.00', 'instructor-b': '20.00' } as Record<string, string>,
        transactions: [
            { id: 1, instructor_id: 'instructor-a', type: 'credit', amount: 10, created_at: '2026-01-01' },
            { id: 2, instructor_id: 'instructor-a', type: 'debit', amount: 5, created_at: '2026-01-02' },
        ],
    };
    const { db, executed } = makeWalletDb(walletState);
    const lookup: AdminPermissionLookup = {
        isSuperAdmin: async (id) => (fixtures.adminRoles[id] ?? []).includes('super_admin'),
        getAdminPermissions: async (id) => fixtures.adminPermissions[id] ?? [],
    };
    const requireAdminPermission = (permission: string) => createRequireAdminPermission(permission, lookup);
    // Replicates the 4-line production wrapper from the out-of-scope shared
    // file security/admin-permissions.ts on top of the REAL guard factory.
    const requireSelfOrAdminPermission = (paramName: string, permission: string) => (req: any, res: any, next: any) => {
        if (!req.user) return res.status(401).json({ error: 'Authentication required' });
        if (String(req.user.id) === String(req.params[paramName])) return next();
        return requireAdminPermission(permission)(req, res, next);
    };
    const adjustments: any[] = [];
    const adjustServiceCredit = (async (input: any) => {
        adjustments.push(input);
        const amount = String(input.amount ?? '').trim();
        if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
            throw new CreditAdjustmentError(400, 'invalid amount');
        }
        const reason = String(input.reason ?? '').trim();
        if (reason.length < 3 || reason.length > 500) throw new CreditAdjustmentError(400, 'invalid reason');
        return '42.00';
    }) as typeof import('../src/services/service-credit').adjustServiceCredit;
    const router = createInstructorWalletRouter({
        db,
        authenticate: createAuthenticateToken(makeRepository(fixtures)) as RequestHandler,
        requireAdminPermission,
        requireSelfOrAdminPermission,
        adjustServiceCredit,
        directAdjustmentAllowed: () => directAllowed,
    });
    return { fixtures, executed, router, adjustments };
};

// ---------------------------------------------------------------------------
// Authentication / authorization
// ---------------------------------------------------------------------------

test('payment requests: a missing token is rejected 401', async () => {
    const { router } = makePaymentHarness();
    const res = await invokeRoute(router, { method: 'GET', url: '/' });
    assert.equal(res.statusCode, 401);
});

test('payment requests: a revoked (inactive) identity is rejected 401', async () => {
    const { router } = makePaymentHarness();
    const res = await invokeRoute(router, { method: 'GET', url: '/', token: T.revoked });
    assert.equal(res.statusCode, 401);
});

test('payment requests: a student role is forbidden 403 (outside the allowed role set)', async () => {
    const { router } = makePaymentHarness();
    const res = await invokeRoute(router, { method: 'GET', url: '/', token: T.studentA });
    assert.equal(res.statusCode, 403);
});

// ---------------------------------------------------------------------------
// Tenant scoping
// ---------------------------------------------------------------------------

test('payment requests: an instructor lists only its own tenant (tenant predicate + binding)', async () => {
    const { router, executed } = makePaymentHarness();
    const res = await invokeRoute(router, { method: 'GET', url: '/', token: T.instructorA });
    assert.equal(res.statusCode, 200);
    const ids = (res.body as any[]).map((r) => r.id).sort();
    assert.deepEqual(ids, ['req-a1', 'req-a2']);
    const list = executed.find((e) => e.sql.includes('FROM payment_requests pr'))!;
    assert.match(list.sql, /pr\.tenant_id=\?/);
    assert.deepEqual(list.params, ['tenant-a']);
});

test('payment requests: a bare platform admin (role label only, no finance capability) is denied 403', async () => {
    // SUPERVISOR: the bare `admin` role label must NOT confer platform
    // authority. A platform admin without the verified finance.read capability
    // cannot read across tenants; the request fails closed.
    const { router } = makePaymentHarness();
    const res = await invokeRoute(router, { method: 'GET', url: '/', token: T.adminPlat });
    assert.equal(res.statusCode, 403);
});

test('payment requests: a verified finance-capable admin reads across tenants (global read only)', async () => {
    // Positive case: super_admin / finance.read holder gets a global read with
    // no tenant predicate. Reads only — see the mutation-denial tests below.
    const { router, executed } = makePaymentHarness();
    const res = await invokeRoute(router, { method: 'GET', url: '/', token: T.adminSuper });
    assert.equal(res.statusCode, 200);
    assert.equal((res.body as any[]).length, 3);
    const list = executed.find((e) => e.sql.includes('FROM payment_requests pr'))!;
    assert.doesNotMatch(list.sql, /tenant_id=\?/);
    assert.deepEqual(list.params, []);
});

test('payment requests: a same-tenant teacher without owner/instructor authority is denied 403', async () => {
    // SUPERVISOR: same-tenant unrelated teacher/staff rejection. teacher-a is
    // active in tenant-a but holds no owner/instructor authority there.
    const { router } = makePaymentHarness();
    const res = await invokeRoute(router, { method: 'GET', url: '/', token: T.teacherA });
    assert.equal(res.statusCode, 403);
});

test('payment requests: a same-tenant staff without owner/instructor authority is denied 403', async () => {
    const { router } = makePaymentHarness();
    const res = await invokeRoute(router, { method: 'GET', url: '/', token: T.staffA });
    assert.equal(res.statusCode, 403);
});

test('payment requests: a bare platform admin approve mutation is denied 403 (platform = reads only)', async () => {
    // SUPERVISOR: exact selected tenant financial authority is required for a
    // mutation; the verified platform capability grants reads only.
    const { router, fixtures } = makePaymentHarness();
    const res = await invokeRoute(router, { method: 'POST', url: '/req-a1/approve', token: T.adminPlat });
    assert.equal(res.statusCode, 403);
    assert.equal(fixtures.studentFees.length, 0);
    assert.equal(fixtures.paymentRequests.find((r) => r.id === 'req-a1')!.status, 'pending');
});

test('payment requests: a finance-capable admin approve mutation is denied 403 (platform = reads only)', async () => {
    const { router, fixtures } = makePaymentHarness();
    const res = await invokeRoute(router, { method: 'POST', url: '/req-a1/approve', token: T.adminSuper });
    assert.equal(res.statusCode, 403);
    assert.equal(fixtures.studentFees.length, 0);
    assert.equal(fixtures.paymentRequests.find((r) => r.id === 'req-a1')!.status, 'pending');
});

test('payment requests: an instructor with no active membership is denied 403 (fail closed)', async () => {
    // No active workspace scope resolves to no tenant authority: fail closed
    // rather than serving an empty cross-tenant scope.
    const { router } = makePaymentHarness();
    const res = await invokeRoute(router, { method: 'GET', url: '/', token: T.instructorNone });
    assert.equal(res.statusCode, 403);
});

// ---------------------------------------------------------------------------
// Create (POST /)
// ---------------------------------------------------------------------------

test('create: a forged cross-tenant student id is refused 404', async () => {
    const { router, fixtures } = makePaymentHarness();
    const res = await invokeRoute(router, {
        method: 'POST', url: '/', token: T.instructorA,
        body: { student_id: 'student-b1', grade_id: 'grade-b1', group_id: 'group-b1', amount: 10 },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(fixtures.paymentRequests.length, 3);
});

test('create: an invalid amount (<= 0 / non-finite) is refused 400', async () => {
    const { router } = makePaymentHarness();
    for (const amount of [0, -5, 'abc', null]) {
        const res = await invokeRoute(router, {
            method: 'POST', url: '/', token: T.instructorA,
            body: { student_id: 'student-a1', grade_id: 'grade-a1', group_id: 'group-a1', amount },
        });
        assert.equal(res.statusCode, 400, `amount=${String(amount)}`);
    }
});

test('create: a platform admin without a tenant is refused 403', async () => {
    const { router } = makePaymentHarness();
    const res = await invokeRoute(router, {
        method: 'POST', url: '/', token: T.adminPlat,
        body: { student_id: 'student-a1', grade_id: 'grade-a1', group_id: 'group-a1', amount: 10 },
    });
    assert.equal(res.statusCode, 403);
});

test('create: the tenant is server-derived; a forged body.tenant_id is ignored', async () => {
    const { router, fixtures } = makePaymentHarness();
    const res = await invokeRoute(router, {
        method: 'POST', url: '/', token: T.instructorA,
        body: { student_id: 'student-a1', grade_id: 'grade-a1', group_id: 'group-a1', amount: 10, tenant_id: 'tenant-b' },
    });
    assert.equal(res.statusCode, 201);
    const created = fixtures.paymentRequests.find((r) => r.id === (res.body as any).id)!;
    assert.equal(created.tenant_id, 'tenant-a');
});

// ---------------------------------------------------------------------------
// Approve (transaction / duplicate transition / partial write)
// ---------------------------------------------------------------------------

test('approve: a pending request in the caller tenant is approved exactly once', async () => {
    const { router, fixtures } = makePaymentHarness();
    const res = await invokeRoute(router, { method: 'POST', url: '/req-a1/approve', token: T.instructorA });
    assert.equal(res.statusCode, 200);
    assert.equal(fixtures.paymentRequests.find((r) => r.id === 'req-a1')!.status, 'approved');
    assert.equal(fixtures.studentFees.length, 1);
    assert.equal(fixtures.revenues.length, 1);
    assert.equal(fixtures.notifications.filter((n) => n.type === 'payment_approved').length, 1);
});

test('approve: a cross-tenant request id is not visible (owner scoping) 404', async () => {
    const { router, fixtures } = makePaymentHarness();
    const res = await invokeRoute(router, { method: 'POST', url: '/req-b1/approve', token: T.instructorA });
    assert.equal(res.statusCode, 404);
    assert.equal(fixtures.studentFees.length, 0);
    assert.equal(fixtures.paymentRequests.find((r) => r.id === 'req-b1')!.status, 'pending');
});

test('approve: an already-approved request is refused 400 (duplicate state transition)', async () => {
    const { router, fixtures } = makePaymentHarness();
    const res = await invokeRoute(router, { method: 'POST', url: '/req-a2/approve', token: T.instructorA });
    assert.equal(res.statusCode, 400);
    assert.equal(fixtures.studentFees.length, 0);
});

test('approve: the request row is locked FOR UPDATE and the flip is guarded by status=pending', async () => {
    const { router, executed } = makePaymentHarness();
    await invokeRoute(router, { method: 'POST', url: '/req-a1/approve', token: T.instructorA });
    const lock = executed.find((e) => e.sql.includes('SELECT * FROM payment_requests'))!;
    assert.match(lock.sql, /FOR UPDATE/);
    const flip = executed.find((e) => e.sql.includes('UPDATE payment_requests'))!;
    assert.match(flip.sql, /AND status='pending'/);
});

test('approve: a transition lost to a concurrent winner returns 400 and writes no fee', async () => {
    const fixtures = makeFixtures();
    fixtures.simulateLostTransition = true;
    const { router } = makePaymentHarness(fixtures);
    const res = await invokeRoute(router, { method: 'POST', url: '/req-a1/approve', token: T.instructorA });
    assert.equal(res.statusCode, 400);
    assert.equal(fixtures.studentFees.length, 0);
});

test('approve: an inactive enrollment is refused 409', async () => {
    const fixtures = makeFixtures();
    fixtures.paymentRequests.push({
        id: 'req-inactive', tenant_id: 'tenant-a', student_id: 'student-a-inactive', student_name: 'Gone',
        phone: null, email: null, grade_id: 'grade-a1', grade_name: 'Grade A1', group_id: 'group-a1',
        group_name: 'Group A1', amount: 10, payment_method: 'cash', receipt_image_url: null, notes: null, status: 'pending',
    });
    const { router } = makePaymentHarness(fixtures);
    const res = await invokeRoute(router, { method: 'POST', url: '/req-inactive/approve', token: T.instructorA });
    assert.equal(res.statusCode, 409);
});

test('approve: a mid-transaction failure rolls the whole write back (no partial fee, status unchanged)', async () => {
    const fixtures = makeFixtures();
    fixtures.failOn = 'revenues';
    const { router } = makePaymentHarness(fixtures);
    const res = await invokeRoute(router, { method: 'POST', url: '/req-a1/approve', token: T.instructorA });
    assert.equal(res.statusCode, 500);
    // BEFORE the fix the fee row would survive the failed revenue insert and
    // the request would stay 'pending' (a permanent partial write). AFTER the
    // fix the transaction rolls back: no fee, no revenue, status still pending.
    assert.equal(fixtures.studentFees.length, 0);
    assert.equal(fixtures.revenues.length, 0);
    assert.equal(fixtures.paymentRequests.find((r) => r.id === 'req-a1')!.status, 'pending');
});

// ---------------------------------------------------------------------------
// Authorization: exact tenant owner authority + cross-tenant notification scope
// ---------------------------------------------------------------------------

test('approve: the verified tenant owner approves a request in their tenant', async () => {
    // "exact selected tenant financial management/assignment authority for
    // mutations": the tenant owner (authority 'owner') is authorized for the
    // mutation within their own tenant.
    const { router, fixtures } = makePaymentHarness();
    const res = await invokeRoute(router, { method: 'POST', url: '/req-a1/approve', token: T.ownerA });
    assert.equal(res.statusCode, 200);
    assert.equal(fixtures.paymentRequests.find((r) => r.id === 'req-a1')!.status, 'approved');
    assert.equal(fixtures.studentFees.length, 1);
    assert.equal(fixtures.revenues.length, 1);
});

test('create: the new-payment notification goes to the proven tenant owner, never an arbitrary global admin', async () => {
    // SUPERVISOR: the old code notified the arbitrary "oldest global admin",
    // leaking the request across tenants. The fix notifies only the verified
    // tenant owner (tenants.owner_user_id) and nothing if unprovable.
    const { router, fixtures } = makePaymentHarness();
    const res = await invokeRoute(router, {
        method: 'POST', url: '/', token: T.instructorA,
        body: { student_id: 'student-a1', grade_id: 'grade-a1', group_id: 'group-a1', amount: 10 },
    });
    assert.equal(res.statusCode, 201);
    const paymentNotes = fixtures.notifications.filter((n) => n.type === 'payment_request');
    // Exactly one recipient: the tenant-a owner.
    assert.equal(paymentNotes.length, 1);
    assert.equal(paymentNotes[0].user_id, 'owner-a');
    // Cross-tenant exclusion: never the arbitrary global admin, never the
    // other tenant's owner.
    assert.ok(!fixtures.notifications.some((n) => n.user_id === 'admin-plat'),
        'must not notify the arbitrary global admin');
    assert.ok(!fixtures.notifications.some((n) => n.user_id === 'owner-b'),
        'must not notify a cross-tenant owner');
});

test('create: a request in tenant-a notifies only tenant-a, even when a finance admin could read it', async () => {
    // A finance-capable admin (admin-super) can read req-b1 globally, but a
    // create in tenant-a must not notify them across tenants.
    const { router, fixtures } = makePaymentHarness();
    await invokeRoute(router, {
        method: 'POST', url: '/', token: T.instructorA,
        body: { student_id: 'student-a1', grade_id: 'grade-a1', group_id: 'group-a1', amount: 10 },
    });
    assert.ok(!fixtures.notifications.some((n) => n.user_id === 'admin-super'),
        'must not notify a cross-tenant finance admin');
});

// ---------------------------------------------------------------------------
// Reject
// ---------------------------------------------------------------------------

test('reject: a missing reason is refused 400', async () => {
    const { router } = makePaymentHarness();
    const res = await invokeRoute(router, { method: 'POST', url: '/req-a1/reject', token: T.instructorA, body: {} });
    assert.equal(res.statusCode, 400);
});

test('reject: a pending request is rejected and the student is notified once', async () => {
    const { router, fixtures } = makePaymentHarness();
    const res = await invokeRoute(router, { method: 'POST', url: '/req-a1/reject', token: T.instructorA, body: { rejection_reason: 'no receipt' } });
    assert.equal(res.statusCode, 200);
    assert.equal(fixtures.paymentRequests.find((r) => r.id === 'req-a1')!.status, 'rejected');
    assert.equal(fixtures.notifications.filter((n) => n.type === 'payment_rejected').length, 1);
});

test('reject: a transition lost to a concurrent winner returns 400 and sends no duplicate notification', async () => {
    const fixtures = makeFixtures();
    fixtures.simulateLostTransition = true;
    const { router } = makePaymentHarness(fixtures);
    const res = await invokeRoute(router, { method: 'POST', url: '/req-a1/reject', token: T.instructorA, body: { rejection_reason: 'dup' } });
    assert.equal(res.statusCode, 400);
    assert.equal(fixtures.notifications.filter((n) => n.type === 'payment_rejected').length, 0);
});

// ---------------------------------------------------------------------------
// Instructor wallet: capability / ownership / actor / amount
// ---------------------------------------------------------------------------

test('wallet: an instructor reads its own wallet 200', async () => {
    const { router } = makeWalletHarness();
    const res = await invokeRoute(router, { method: 'GET', url: '/instructor-a', token: T.instructorA });
    assert.equal(res.statusCode, 200);
    assert.equal((res.body as any).balance, '10.00');
});

test('wallet: an instructor cannot read another instructor wallet 403', async () => {
    const { router } = makeWalletHarness();
    const res = await invokeRoute(router, { method: 'GET', url: '/instructor-b', token: T.instructorA });
    assert.equal(res.statusCode, 403);
});

test('wallet: a bare admin JWT claim without a verified platform capability is refused 403', async () => {
    const { router } = makeWalletHarness();
    const res = await invokeRoute(router, { method: 'GET', url: '/instructor-a', token: T.adminPlat });
    assert.equal(res.statusCode, 403);
});

test('wallet: a verified super_admin reads any wallet 200', async () => {
    const { router } = makeWalletHarness();
    const res = await invokeRoute(router, { method: 'GET', url: '/instructor-b', token: T.adminSuper });
    assert.equal(res.statusCode, 200);
});

test('wallet: transactions list is scoped to the requested instructor with pagination', async () => {
    const { router } = makeWalletHarness();
    const res = await invokeRoute(router, { method: 'GET', url: '/instructor-a/transactions', token: T.instructorA, query: { page: '1', limit: '20' } });
    assert.equal(res.statusCode, 200);
    const body = res.body as any;
    assert.equal(body.data.length, 2);
    assert.equal(body.pagination.total, 2);
    assert.equal(body.pagination.page, 1);
});

test('wallet: a direct credit is refused 409 while the approval-workflow gate is closed', async () => {
    const { router, adjustments } = makeWalletHarness(makeFixtures(), false);
    const res = await invokeRoute(router, {
        method: 'POST', url: '/instructor-a/credit', token: T.adminSuper,
        body: { amount: 5, description: 'top up' },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(adjustments.length, 0);
});

test('wallet: credit requires the platform adjust capability, not a bare admin claim', async () => {
    const { router, adjustments } = makeWalletHarness(makeFixtures(), true);
    const res = await invokeRoute(router, {
        method: 'POST', url: '/instructor-a/credit', token: T.adminPlat,
        body: { amount: 5, description: 'top up' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(adjustments.length, 0);
});

test('wallet: the actor id is server-derived, never taken from the request body', async () => {
    const { router, adjustments } = makeWalletHarness(makeFixtures(), true);
    const res = await invokeRoute(router, {
        method: 'POST', url: '/instructor-a/credit', token: T.adminSuper,
        body: { amount: 5, description: 'top up', actorId: 'attacker', actor_id: 'attacker' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(adjustments.length, 1);
    assert.equal(adjustments[0].actorId, 'admin-super');
    assert.equal(adjustments[0].instructorId, 'instructor-a');
});

test('wallet: an invalid amount is refused with the service status 400 (server-side validation)', async () => {
    const { router } = makeWalletHarness(makeFixtures(), true);
    for (const amount of ['abc', -1, 0]) {
        const res = await invokeRoute(router, {
            method: 'POST', url: '/instructor-a/debit', token: T.adminSuper,
            body: { amount, description: 'withdraw' },
        });
        assert.equal(res.statusCode, 400, `amount=${String(amount)}`);
    }
});
