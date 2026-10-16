import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import jwt from 'jsonwebtoken';
import type { NextFunction, RequestHandler, Router } from 'express';
import { createAuthenticateToken, requireRoles } from '../src/middleware/auth';
import { createRequireAdminPermission } from '../src/security/admin-permissions';
import type { PrincipalRepository } from '../src/security/principal-repository';
import { createGradesRouter, type GradesDataAccess } from '../src/routes/grades';
import { createSubscriptionPlansRouter, type SubscriptionPlansDataAccess } from '../src/routes/subscription-plans';

/**
 * Global subscription-plan catalog + per-tenant grade catalog authorization.
 *
 * `subscription_plans` has no tenant column, so every write is platform-only:
 * tenant authority and JWT role claims never satisfy it.
 *
 * `grades` is PER-TENANT: a tenant row is writable by the teaching-write
 * entitlement of the selected tenant, and a legacy shared row
 * (`tenant_id IS NULL`) is writable only by the verified platform permission
 * `grade.manage`. Because the teaching entitlement is server-derived, the
 * identities below that carry no tenant teaching authority are denied here
 * (403) with no data access, and an identity that cannot authenticate at all
 * is 401.
 */

const TEST_SECRET = 'test-only-secret-with-sufficient-length';
const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

interface Statement { sql: string; params: unknown[] }
interface RouteRequest { method: string; url: string; token?: string; body?: unknown }
interface CapturedResponse {
    statusCode?: number;
    body?: unknown;
    status(code: number): CapturedResponse;
    json(payload: unknown): CapturedResponse;
}

const users = new Set([
    'teacher-a', 'teacher-b', 'admin-bare', 'platform-grade',
    'platform-subscription', 'platform-super', 'permissions-down',
]);
const memberships: Record<string, Array<{ tenant_id: string }>> = {
    'teacher-a': [{ tenant_id: 'tenant-a' }],
    'teacher-b': [{ tenant_id: 'tenant-b' }],
};
const repository: PrincipalRepository = {
    findUsersIdentity: async (id) => users.has(id)
        ? { is_active: 1, token_version: 0, suspension_active: 0 }
        : null,
    findStaffIdentity: async () => null,
    findInstructorAccount: async () => null,
    findStudentEnrollments: async () => [],
    findActiveTenantMemberships: async (id) => memberships[id] ?? [],
};
const permissionLookup = {
    isSuperAdmin: async (userId: string) => userId === 'platform-super',
    getAdminPermissions: async (userId: string): Promise<string[]> => {
        if (userId === 'permissions-down') throw new Error('fixture permission lookup failure');
        if (userId === 'platform-grade') return ['grade.manage'];
        if (userId === 'platform-subscription') return ['subscription.create'];
        return [];
    },
};
const authenticate = createAuthenticateToken(repository) as RequestHandler;
const tokenFor = (id: string, role: string, tenantId?: string): string => jwt.sign({
    id,
    role,
    tv: 0,
    ...(tenantId ? { tenant_id: tenantId } : {}),
}, TEST_SECRET);
const tokens = {
    teacherA: tokenFor('teacher-a', 'teacher'),
    teacherB: tokenFor('teacher-b', 'teacher'),
    bareAdmin: tokenFor('admin-bare', 'admin'),
    gradePlatform: tokenFor('platform-grade', 'admin'),
    subscriptionPlatform: tokenFor('platform-subscription', 'admin'),
    superAdmin: tokenFor('platform-super', 'admin'),
    permissionFailure: tokenFor('permissions-down', 'admin'),
};

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
        query: {},
    };
    await (router as unknown as (r: unknown, s: unknown, n: NextFunction) => Promise<void>)(req, response, () => {});
    const deadline = Date.now() + 5000;
    while (response.statusCode === undefined && response.body === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
};

const gradeRow = {
    id: 'grade-1', name: 'Grade One', display_order: 1,
    is_active: 1, created_at: new Date(0), updated_at: new Date(0),
};
const planRow = {
    id: 'plan-1', name: 'Monthly', duration_months: 1,
    price: '10.00', is_active: true,
};

/**
 * Grade rows reachable by the identities above: this harness injects a
 * teaching-write guard that denies (they hold no tenant teaching entitlement),
 * so no grade row is writable here. Shared rows therefore require the
 * platform permission, tenant rows require tenant authority.
 */
const createHarness = () => {
    const executed: Statement[] = [];
    let planExists = false;
    const record = (sql: string, params?: unknown[]) => executed.push({ sql, params: params ?? [] });
    const gradeDb: GradesDataAccess = {
        query: async <T = unknown>(sql: string, params?: unknown[]): Promise<T[]> => {
            record(sql, params);
            return [];
        },
        queryOne: async <T = unknown>(sql: string, params?: unknown[]): Promise<T | null> => {
            record(sql, params);
            return { ...gradeRow, id: String(params?.[0] ?? gradeRow.id) } as T;
        },
        execute: async (sql: string, params?: unknown[]) => {
            record(sql, params);
            return { affectedRows: 1, insertId: 1, warningStatus: 0 } as unknown as Awaited<ReturnType<GradesDataAccess['execute']>>;
        },
    };
    const planDb: SubscriptionPlansDataAccess = {
        query: async <T = unknown>(sql: string, params?: unknown[]): Promise<T[]> => {
            record(sql, params);
            return [];
        },
        queryOne: async <T = unknown>(sql: string, params?: unknown[]): Promise<T | null> => {
            record(sql, params);
            if (sql.includes('WHERE id = ?') && !planExists) return null;
            return { ...planRow, id: String(params?.[0] ?? planRow.id) } as T;
        },
        execute: async (sql: string, params?: unknown[]) => {
            record(sql, params);
            if (sql.includes('INSERT INTO subscription_plans')) planExists = true;
            return { affectedRows: 1, insertId: 1, warningStatus: 0 } as unknown as Awaited<ReturnType<SubscriptionPlansDataAccess['execute']>>;
        },
    };
    const grades = createGradesRouter({
        db: gradeDb,
        authenticate,
        optionalAuthenticate: (_req, _res, next) => next(),
        // Teaching authority is server-derived; none of the identities in this
        // fixture hold it, so tenant rows stay denied here by construction.
        requireTenantWrite: (_req, res) => { res.status(403).json({ error: 'Forbidden' }); },
        authorizePlatformWrite: createRequireAdminPermission('grade.manage', permissionLookup),
    });
    const plans = createSubscriptionPlansRouter({
        db: planDb,
        authenticate,
        authorize: requireRoles('admin', 'teacher'),
        authorizeWrite: createRequireAdminPermission('subscription.create', permissionLookup),
    });
    return { grades, plans, executed };
};

const gradeMutations = (id: string): RouteRequest[] => [
    { method: 'POST', url: '/', body: { name: 'New Grade' } },
    { method: 'PUT', url: `/${id}`, body: { name: 'Renamed' } },
    { method: 'DELETE', url: `/${id}` },
];
const planMutations = (id: string): RouteRequest[] => [
    { method: 'POST', url: '/', body: { name: 'New Plan', duration_months: 1, price: '10.00' } },
    { method: 'PUT', url: `/${id}`, body: { name: 'Renamed' } },
    { method: 'DELETE', url: `/${id}` },
];

for (const [label, token] of [
    ['tenant A teacher', tokens.teacherA],
    ['tenant B teacher', tokens.teacherB],
    ['bare admin role claim', tokens.bareAdmin],
] as const) {
    test(`global subscription plans: ${label} cannot perform any write`, async () => {
        for (const mutation of planMutations('plan-1')) {
            const { plans, executed } = createHarness();
            const response = await invokeRoute(plans, { ...mutation, token });
            assert.equal(response.statusCode, 403, `plans ${mutation.method} should be forbidden`);
            assert.equal(executed.length, 0, `plans ${mutation.method} must not access data`);
        }
    });

    test(`per-tenant grades: ${label} cannot perform any write`, async () => {
        for (const mutation of gradeMutations('grade-1')) {
            const { grades, executed } = createHarness();
            const response = await invokeRoute(grades, { ...mutation, token });
            assert.equal(response.statusCode, 403, `grades ${mutation.method} should be forbidden`);
            assert.equal(executed.length, 0, `grades ${mutation.method} must not access data`);
        }
    });
}

test('legacy shared grade rows require the verified grade.manage platform permission', async () => {
    for (const token of [tokens.gradePlatform, tokens.superAdmin]) {
        const { grades, executed } = createHarness();
        const response = await invokeRoute(grades, {
            method: 'POST', url: '/', token, body: { name: 'Shared Grade', scope: 'shared' },
        });
        assert.equal(response.statusCode, 201);
        assert.ok(executed.some((statement) => statement.sql.includes('INSERT INTO grades')));
    }
});

test('global subscription plans require subscription.create platform authority', async () => {
    for (const token of [tokens.subscriptionPlatform, tokens.superAdmin]) {
        const { plans, executed } = createHarness();
        const response = await invokeRoute(plans, {
            method: 'POST', url: '/', token,
            body: { name: 'Annual', duration_months: 12, price: '100.00' },
        });
        assert.equal(response.statusCode, 201);
        assert.ok(executed.some((statement) => statement.sql.includes('INSERT INTO subscription_plans')));
    }
});

test('platform permission lookup failure denies global catalog writes without data access', async () => {
    for (const routeName of ['grades', 'plans'] as const) {
        const { grades, plans, executed } = createHarness();
        const response = await invokeRoute(routeName === 'grades' ? grades : plans, {
            ...(routeName === 'grades' ? gradeMutations('grade-1') : planMutations('plan-1'))[0],
            ...(routeName === 'grades' ? { body: { name: 'Shared', scope: 'shared' } } : {}),
            token: tokens.permissionFailure,
        });
        assert.equal(response.statusCode, 503);
        assert.equal(executed.length, 0);
    }
});
