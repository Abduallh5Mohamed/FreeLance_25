/**
 * M2-B12 — private instructor branch-assignment organization metadata
 * (hermetic, behavioral).
 *
 * Contract under test: GET /api/tenants/me/instructor-memberships and
 * PATCH /api/tenants/me/instructor-memberships/:membershipId record which
 * ACTIVE branch of the SERVER-selected tenant an EXISTING ACTIVE instructor
 * membership is organized under, and only for the VERIFIED owner of that
 * tenant (`tenants.owner_user_id` = caller, tenant active, caller active).
 *
 * The record is planning metadata only. Every test here pins that boundary:
 * the membership row keeps its `role_key` and `status`, no other table is
 * written, the audit carries only `{ branch_id, branch_name }`, and no
 * authorization decision consults the recorded branch.
 *
 * Composition under test is the real production order (src/index.ts): the real
 * optional-auth middleware, the real tenant-authority and student-workspace
 * boundaries, then the real `createTenantSelfRouter` handlers. Only leaf data
 * repositories and the transactional connection are injected fixtures. No
 * express listener, socket, fetch, DB, provider or app startup.
 *
 * The fake transaction BUFFERS the single column write and the audit event and
 * applies them only at COMMIT, so a rolled-back or uncertain transaction can be
 * proven to leave ZERO partial writes behind. The post-write read-back overlays
 * the buffered write, exactly as a real transaction would see its own change.
 *
 * Import isolation is proven positively: the `src/db`, `src/services/minio` and
 * `src/services/subscription-renewal` module bodies are intercepted in the
 * CommonJS loader before any app module loads, stay out of `require.cache`,
 * need no dummy env and are re-checked in `after`.
 *
 * Live MySQL row-level locking, real concurrency, real keyset index usage and
 * real HTTP transport are explicitly NOT exercised or claimed.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import Module from 'node:module';
import jwt from 'jsonwebtoken';
import type { RequestHandler, Router } from 'express';

const TEST_SECRET = 'm2-b12-hermetic-jwt-secret-not-a-real-key';
const originalSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = TEST_SECRET;

const originalLoad = (Module as any)._load;

after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    assert.equal((Module as any)._load, originalLoad, 'the loader hook must be restored after loading');
    assert.deepEqual(sentinelCalls, [], 'no forbidden default adapter may be called by any test in this suite');
});

// ---------------------------------------------------------------------------
// Positive import interception
// ---------------------------------------------------------------------------

const sentinelCalls: string[] = [];
const interceptionLog: string[] = [];
const normalize = (id: string) => path.resolve(id).toLowerCase();

const violation = (name: string): never => {
    sentinelCalls.push(name);
    throw new Error(`HERMETIC_VIOLATION:${name}`);
};

const dbSentinel = {
    query: async (): Promise<any> => violation('db.query'),
    queryOne: async (): Promise<any> => violation('db.queryOne'),
    execute: async (): Promise<any> => violation('db.execute'),
    getPool: (): never => violation('db.getPool'),
};
const minioSentinel = {
    BUCKETS: { PAYMENT_PROOFS: 'payment-proofs', LECTURES: 'lectures' },
    uploadBuffer: async (): Promise<any> => violation('minio.uploadBuffer'),
    deleteFile: async (): Promise<any> => violation('minio.deleteFile'),
    getPrivateObjectUrl: async (): Promise<any> => violation('minio.getPrivateObjectUrl'),
};
const renewalSentinel = {
    executeRenewalIntent: async (): Promise<any> => violation('renewal.executeRenewalIntent'),
};

interface Intercepted { id: string; exports: unknown }
const sentinelByPath = new Map<string, Intercepted>();

const registerSentinel = (specifier: string, exports: unknown) => {
    const id = require.resolve(specifier);
    sentinelByPath.set(normalize(id), { id, exports });
};

registerSentinel('../src/db', dbSentinel);
registerSentinel('../src/services/minio', minioSentinel);
registerSentinel('../src/services/subscription-renewal', renewalSentinel);

const installInterception = () => {
    (Module as any)._load = function (request: string, parent: any, isMain: boolean) {
        let resolved: string | null = null;
        if (parent && typeof parent.filename === 'string') {
            try { resolved = Module.createRequire(parent.filename).resolve(request); }
            catch { resolved = null; }
        }
        const hit = resolved ? sentinelByPath.get(normalize(resolved)) : undefined;
        if (hit) {
            interceptionLog.push(hit.id);
            return hit.exports;
        }
        return originalLoad.apply(this, [request, parent, isMain]);
    };
};

let loadError: unknown = null;
let authModule: any;
let boundaryModule: any;
let studentBoundaryModule: any;
let routeModule: any;

installInterception();
try {
    authModule = require('../src/middleware/auth');
    boundaryModule = require('../src/middleware/tenant-authority-boundary');
    studentBoundaryModule = require('../src/middleware/student-workspace-boundary');
    routeModule = require('../src/routes/tenant-self');
} catch (error) {
    loadError = error;
} finally {
    (Module as any)._load = originalLoad;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const OWNER_A = 'owner-a';
const OWNER_B = 'owner-b';
const INSTRUCTOR_A = 'instructor-a';
const INSTRUCTOR_A2 = 'instructor-a2';
const INSTRUCTOR_A3 = 'instructor-a3';
const INSTRUCTOR_A4 = 'instructor-a4';
const INSTRUCTOR_A5 = 'instructor-a5';
const INSTRUCTOR_B1 = 'instructor-b1';
const ROLE_OWNER_MEMBER = 'role-owner-member-1';
const BILLING_ONLY = 'billing-only-instructor-1';
const MULTI = 'multi-1';

const BRANCH_A1 = 'a0000000-0000-4000-8000-000000000001';
const BRANCH_A2 = 'a0000000-0000-4000-8000-000000000002';
const BRANCH_A3 = 'a0000000-0000-4000-8000-000000000003';
const BRANCH_B1 = 'b0000000-0000-4000-8000-000000000001';
const ABSENT_BRANCH = 'cccccccc-0000-4000-8000-000000000000';

const MEMBER_A1 = 'a1111111-1111-4111-8111-111111111111';
const MEMBER_A2 = 'a2222222-2222-4222-8222-222222222222';
const MEMBER_A3 = 'a3333333-3333-4333-8333-333333333333';
const MEMBER_A4 = 'a4444444-4444-4444-8444-444444444444';
const MEMBER_A5 = 'a5555555-5555-4555-8555-555555555555';
const MEMBER_B1 = 'b1111111-1111-4111-8111-111111111111';
const ABSENT_MEMBER = 'cccccccc-0000-4000-8000-000000000001';

interface TenantRow {
    id: string;
    business_name: string;
    subject_type: string | null;
    status: string;
    legacy_compat: number;
    owner_user_id: string;
}

interface IdentityRow { is_active: number; token_version: number; suspension_active: number }

interface BranchRow {
    id: string;
    tenant_id: string;
    name: string;
    status: string;
    created_at: string;
    updated_at: string;
}

interface MembershipRow {
    id: string;
    tenant_id: string;
    user_id: string;
    role_key: string;
    status: string;
    branch_id: string | null;
}

interface State {
    users: Record<string, IdentityRow>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    membershipsByUser: Record<string, string[]>;
    tenantOwner: Record<string, string>;
    membershipRole: Record<string, string>;
    enrollments: Record<string, any[]>;
    tenants: TenantRow[];
    branches: BranchRow[];
    memberships: MembershipRow[];
}

const identity = (): IdentityRow => ({ is_active: 1, token_version: 0, suspension_active: 0 });
const inactiveIdentity = (): IdentityRow => ({ is_active: 0, token_version: 0, suspension_active: 0 });
const activeAccount = () => ({ tenant_status: 'active', legacy_compat: 1, allowed: 1 });

function makeState(): State {
    return {
        users: {
            [OWNER_A]: identity(), [OWNER_B]: identity(),
            [INSTRUCTOR_A]: identity(), [INSTRUCTOR_A2]: identity(), [INSTRUCTOR_A3]: identity(),
            [INSTRUCTOR_A4]: identity(), [INSTRUCTOR_A5]: inactiveIdentity(), [INSTRUCTOR_B1]: identity(),
            [ROLE_OWNER_MEMBER]: identity(), [BILLING_ONLY]: identity(), [MULTI]: identity(),
        },
        instructorAccounts: {
            [OWNER_A]: activeAccount(), [OWNER_B]: activeAccount(),
            [INSTRUCTOR_A]: activeAccount(), [INSTRUCTOR_A2]: activeAccount(), [INSTRUCTOR_A3]: activeAccount(),
            [INSTRUCTOR_A4]: activeAccount(), [INSTRUCTOR_A5]: activeAccount(), [INSTRUCTOR_B1]: activeAccount(),
            [ROLE_OWNER_MEMBER]: activeAccount(), [MULTI]: activeAccount(),
            // A live instructor account that is neither legacy-compatible nor
            // explicitly allowed: the authentication middleware marks the
            // principal `billingOnly` instead of denying the request.
            [BILLING_ONLY]: { tenant_status: 'active', legacy_compat: 0, allowed: 0 },
        },
        membershipsByUser: {
            [OWNER_A]: [TENANT_A],
            [OWNER_B]: [TENANT_B],
            [INSTRUCTOR_A]: [TENANT_A],
            [INSTRUCTOR_A2]: [TENANT_A],
            [INSTRUCTOR_A3]: [TENANT_A],
            [INSTRUCTOR_A4]: [TENANT_A],
            [INSTRUCTOR_A5]: [TENANT_A],
            [INSTRUCTOR_B1]: [TENANT_B],
            [ROLE_OWNER_MEMBER]: [TENANT_A],
            [BILLING_ONLY]: [TENANT_A],
            [MULTI]: [TENANT_A, TENANT_B],
        },
        tenantOwner: { [TENANT_A]: OWNER_A, [TENANT_B]: OWNER_B },
        membershipRole: {
            [`${OWNER_A}@${TENANT_A}`]: 'owner',
            [`${OWNER_B}@${TENANT_B}`]: 'owner',
            [`${INSTRUCTOR_A}@${TENANT_A}`]: 'instructor',
            [`${INSTRUCTOR_A2}@${TENANT_A}`]: 'instructor',
            [`${INSTRUCTOR_A3}@${TENANT_A}`]: 'instructor',
            [`${INSTRUCTOR_A4}@${TENANT_A}`]: 'instructor',
            [`${INSTRUCTOR_A5}@${TENANT_A}`]: 'instructor',
            [`${INSTRUCTOR_B1}@${TENANT_B}`]: 'instructor',
            [`${ROLE_OWNER_MEMBER}@${TENANT_A}`]: 'owner',
            [`${BILLING_ONLY}@${TENANT_A}`]: 'instructor',
        },
        enrollments: {},
        tenants: [
            { id: TENANT_A, business_name: 'Alpha Academy', subject_type: 'company', status: 'active', legacy_compat: 0, owner_user_id: OWNER_A },
            { id: TENANT_B, business_name: 'Beta Academy', subject_type: null, status: 'active', legacy_compat: 0, owner_user_id: OWNER_B },
        ],
        branches: [
            { id: BRANCH_A1, tenant_id: TENANT_A, name: 'North Campus', status: 'active', created_at: '2026-10-19 08:00:00', updated_at: '2026-10-19 08:00:00' },
            { id: BRANCH_A2, tenant_id: TENANT_A, name: 'South Campus', status: 'active', created_at: '2026-10-19 08:01:00', updated_at: '2026-10-19 08:01:00' },
            { id: BRANCH_A3, tenant_id: TENANT_A, name: 'Archive Campus', status: 'archived', created_at: '2026-10-19 08:02:00', updated_at: '2026-10-19 08:02:00' },
            { id: BRANCH_B1, tenant_id: TENANT_B, name: 'Foreign Campus', status: 'active', created_at: '2026-10-19 08:03:00', updated_at: '2026-10-19 08:03:00' },
        ],
        memberships: [
            // Active instructor, already recorded on the first branch.
            { id: MEMBER_A1, tenant_id: TENANT_A, user_id: INSTRUCTOR_A, role_key: 'instructor', status: 'active', branch_id: BRANCH_A1 },
            // Active instructor with no branch recorded yet.
            { id: MEMBER_A2, tenant_id: TENANT_A, user_id: INSTRUCTOR_A2, role_key: 'instructor', status: 'active', branch_id: null },
            // Inactive membership: never listed, never writable.
            { id: MEMBER_A3, tenant_id: TENANT_A, user_id: INSTRUCTOR_A3, role_key: 'instructor', status: 'inactive', branch_id: null },
            // Owner-role membership: not an instructor membership.
            { id: MEMBER_A4, tenant_id: TENANT_A, user_id: INSTRUCTOR_A4, role_key: 'owner', status: 'active', branch_id: null },
            // Instructor membership whose user row is inactive.
            { id: MEMBER_A5, tenant_id: TENANT_A, user_id: INSTRUCTOR_A5, role_key: 'instructor', status: 'active', branch_id: null },
            // Another tenant's instructor membership.
            { id: MEMBER_B1, tenant_id: TENANT_B, user_id: INSTRUCTOR_B1, role_key: 'instructor', status: 'active', branch_id: BRANCH_B1 },
        ],
    };
}

interface Call { sql: string; params: any[] }
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const OWNER_SELECT = 'SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active FROM tenants t JOIN users u ON u.id=? WHERE t.id=?';
const OWNER_LOCK_SELECT = `${OWNER_SELECT} FOR UPDATE`;
const LIST_SQL = "SELECT m.id AS membership_id,m.user_id AS instructor_id,u.name AS instructor_name,m.branch_id,b.name AS branch_name FROM tenant_memberships m JOIN users u ON u.id=m.user_id LEFT JOIN tenant_branches b ON b.id=m.branch_id AND b.tenant_id=m.tenant_id WHERE m.tenant_id=? AND m.role_key=? AND m.status='active' AND u.is_active=1 AND m.id>? ORDER BY m.id ASC LIMIT ?";
const MEMBERSHIP_LOCK_SQL = "SELECT m.id AS membership_id,m.user_id AS instructor_id,u.name AS instructor_name,m.branch_id,b.name AS current_branch_name FROM tenant_memberships m JOIN users u ON u.id=m.user_id LEFT JOIN tenant_branches b ON b.id=m.branch_id AND b.tenant_id=m.tenant_id WHERE m.id=? AND m.tenant_id=? AND m.role_key=? AND m.status='active' AND u.is_active=1 FOR UPDATE";
const BRANCH_LOCK_SQL = "SELECT b.id,b.name FROM tenant_branches b WHERE b.id=? AND b.tenant_id=? AND b.status='active' FOR UPDATE";
const MEMBERSHIP_UPDATE_SQL = 'UPDATE tenant_memberships SET branch_id=? WHERE id=? AND tenant_id=?';
const MEMBERSHIP_READ_SQL = 'SELECT m.id AS membership_id,m.user_id AS instructor_id,u.name AS instructor_name,m.branch_id,b.name AS branch_name FROM tenant_memberships m JOIN users u ON u.id=m.user_id LEFT JOIN tenant_branches b ON b.id=m.branch_id AND b.tenant_id=m.tenant_id WHERE m.id=? AND m.tenant_id=? LIMIT 1';
const AUDIT_SQL = 'INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value) VALUES (?,?,?,?,?,?,?,?)';

const displayName = (userId: string) => `Instructor ${userId}`;

interface Harness {
    chain: RequestHandler[];
    calls: Call[];
    auditRows: Call[];
    events: string[];
    connectionCount: () => number;
    releaseCount: () => number;
    destroyCount: () => number;
}

function buildHarness(state: State): Harness {
    const calls: Call[] = [];
    const auditRows: Call[] = [];
    const events: string[] = [];
    let connectionCount = 0;
    let releaseCount = 0;
    let destroyCount = 0;

    /**
     * The buffered transaction. A write and its audit live here until COMMIT
     * applies them, so a rollback leaves the fixture byte-identical and every
     * "zero partial writes" assertion is real.
     */
    let pendingWrite: { membershipId: string; branchId: string | null } | null = null;
    let pendingAudit: Call | null = null;

    const membershipRow = (id: string, tenantId: string) =>
        state.memberships.find(m => m.id === id && m.tenant_id === tenantId) ?? null;

    const branchRow = (id: string, tenantId: string) =>
        state.branches.find(b => b.id === id && b.tenant_id === tenantId) ?? null;

    /** What the CURRENT transaction would see: the buffered value overlays the stored one. */
    const visibleBranchId = (row: MembershipRow): string | null =>
        pendingWrite && pendingWrite.membershipId === row.id ? pendingWrite.branchId : row.branch_id;

    const membershipProjection = (row: MembershipRow, branchNameKey: 'branch_name' | 'current_branch_name') => {
        const effective = visibleBranchId(row);
        const branch = effective ? branchRow(effective, row.tenant_id) : null;
        return {
            membership_id: row.id,
            instructor_id: row.user_id,
            instructor_name: displayName(row.user_id),
            branch_id: effective,
            [branchNameKey]: branch ? branch.name : null,
        };
    };

    const branchSql = async (sql: string, params: any[]): Promise<[any, any]> => {
        const n = squash(sql);
        calls.push({ sql, params });

        if (n === OWNER_SELECT || n === OWNER_LOCK_SELECT) {
            events.push('owner');
            const tenant = state.tenants.find(t => t.id === params[1]);
            const user = state.users[params[0]];
            if (!tenant || !user) return [[], []];
            return [[{
                owner_user_id: tenant.owner_user_id,
                tenant_status: tenant.status,
                caller_active: user.is_active,
            }], []];
        }

        if (n === LIST_SQL) {
            events.push('list');
            const [tenantId, roleKey, afterId, limit] = params;
            const rows = state.memberships
                .filter(m => m.tenant_id === tenantId
                    && m.role_key === roleKey
                    && m.status === 'active'
                    && state.users[m.user_id]?.is_active === 1
                    && m.id > afterId)
                .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
                .slice(0, Number(limit))
                .map(m => membershipProjection(m, 'branch_name'));
            return [rows, []];
        }

        if (n === MEMBERSHIP_LOCK_SQL) {
            events.push('membership-lock');
            const [membershipId, tenantId, roleKey] = params;
            const row = membershipRow(String(membershipId), String(tenantId));
            if (!row) return [[], []];
            if (row.role_key !== roleKey) return [[], []];
            if (row.status !== 'active') return [[], []];
            if (state.users[row.user_id]?.is_active !== 1) return [[], []];
            return [[membershipProjection(row, 'current_branch_name')], []];
        }

        if (n === BRANCH_LOCK_SQL) {
            events.push('branch-lock');
            const row = branchRow(String(params[0]), String(params[1]));
            if (!row || row.status !== 'active') return [[], []];
            return [[{ id: row.id, name: row.name }], []];
        }

        if (n === MEMBERSHIP_UPDATE_SQL) {
            events.push('update');
            const [branchId, membershipId, tenantId] = params;
            const row = membershipRow(String(membershipId), String(tenantId));
            // The handler short-circuits an identical value before this
            // statement, so a real change always affects exactly one row.
            pendingWrite = { membershipId: String(membershipId), branchId: branchId === null ? null : String(branchId) };
            return [{ affectedRows: row ? 1 : 0 }, []];
        }

        if (n === AUDIT_SQL) {
            events.push('audit');
            pendingAudit = { sql, params };
            return [{ affectedRows: 1 }, []];
        }

        if (n === MEMBERSHIP_READ_SQL) {
            events.push('read');
            const row = membershipRow(String(params[0]), String(params[1]));
            if (!row) return [[], []];
            return [[membershipProjection(row, 'branch_name')], []];
        }

        throw new Error(`Unhandled instructor branch SQL in hermetic fixture: ${n}`);
    };

    const makeConnection = () => {
        connectionCount += 1;
        // A fresh transaction starts with nothing buffered.
        pendingWrite = null;
        pendingAudit = null;
        return {
            beginTransaction: async () => { events.push('begin'); },
            execute: branchSql,
            commit: async () => {
                events.push('commit');
                if (pendingWrite) {
                    const row = state.memberships.find(m => m.id === pendingWrite!.membershipId);
                    if (row) row.branch_id = pendingWrite.branchId;
                }
                if (pendingAudit) auditRows.push(pendingAudit);
                pendingWrite = null;
                pendingAudit = null;
            },
            rollback: async () => {
                events.push('rollback');
                // A rollback discards the buffered write and audit entirely.
                pendingWrite = null;
                pendingAudit = null;
            },
            release: () => { events.push('release'); releaseCount += 1; },
            destroy: () => { events.push('destroy'); destroyCount += 1; },
        };
    };

    const db = {
        query: async (): Promise<any> => { throw new Error('HERMETIC_VIOLATION:db.query not expected'); },
        queryOne: async (): Promise<any> => { throw new Error('HERMETIC_VIOLATION:db.queryOne not expected'); },
        execute: async (): Promise<any> => { throw new Error('HERMETIC_VIOLATION:db.execute not expected'); },
        getConnection: async () => makeConnection(),
    };

    const repository = {
        findUsersIdentity: async (id: string) => state.users[id] ?? null,
        findStaffIdentity: async () => null,
        findInstructorAccount: async (id: string) => state.instructorAccounts[id] ?? null,
        findStudentEnrollments: async (id: string) => state.enrollments[id] ?? [],
        findActiveTenantMemberships: async (id: string) => (state.membershipsByUser[id] ?? []).map(tenant_id => ({ tenant_id })),
    };

    const loadActiveTenantAuthority = async (userId: string, tenantId: string) => {
        const tenant = state.tenants.find(t => t.id === tenantId);
        if (!tenant || tenant.status !== 'active') return null;
        if (state.tenantOwner[tenantId] === userId) {
            return state.users[userId]?.is_active === 1 ? { authority: 'owner' } : null;
        }
        const role = state.membershipRole[`${userId}@${tenantId}`];
        if (role === 'owner' || role === 'instructor') return { authority: role };
        return null;
    };

    const tenantSelf: Router = routeModule.createTenantSelfRouter({
        db,
        authenticate: authModule.createAuthenticateToken(repository),
        loadActiveTenantAuthority,
        uploadBuffer: async () => violation('injected.uploadBuffer'),
        deleteFile: async () => violation('injected.deleteFile'),
        getPrivateObjectUrl: async () => violation('injected.getPrivateObjectUrl'),
        executeRenewalIntent: async () => violation('injected.executeRenewalIntent'),
    });

    const chain: RequestHandler[] = [
        authModule.createOptionalAuth(repository),
        boundaryModule.enforceTenantAuthorityBoundary,
        studentBoundaryModule.enforceStudentWorkspaceBoundary,
        tenantSelf,
    ];

    return {
        chain,
        calls,
        auditRows,
        events,
        connectionCount: () => connectionCount,
        releaseCount: () => releaseCount,
        destroyCount: () => destroyCount,
    };
}

// ---------------------------------------------------------------------------
// Request/response plumbing (no listener, no socket)
// ---------------------------------------------------------------------------

interface Result { status: number; body: any; headers: Record<string, string>; handlerReached: boolean; responseCount: number }

interface ReqOptions {
    token?: string | null;
    method?: string;
    pathName?: string;
    query?: any;
    body?: any;
    headers?: Record<string, string>;
}

function makeReq(opts: ReqOptions = {}) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    for (const [key, value] of Object.entries(opts.headers ?? {})) headers[key.toLowerCase()] = value;
    const pathName = opts.pathName ?? '/instructor-memberships';
    return {
        method: opts.method ?? 'GET',
        url: pathName,
        originalUrl: `/api/tenants/me${pathName}`,
        path: pathName,
        headers,
        query: opts.query ?? {},
        body: opts.body ?? {},
        params: {},
        header(name: string) { return headers[name.toLowerCase()]; },
    };
}

function runChain(chain: RequestHandler[], req: any): Promise<Result> {
    return new Promise((resolve, reject) => {
        let index = 0;
        let settled = false;
        let responseCount = 0;
        const finish = (result: Result) => { if (!settled) { settled = true; resolve(result); } };

        const headers: Record<string, string> = {};
        const res: any = {
            statusCode: 200,
            status(code: number) { res.statusCode = code; return res; },
            set(name: string, value: string) { headers[name] = value; return res; },
            setHeader(name: string, value: string) { headers[name] = value; return res; },
            json(payload: any) { responseCount += 1; finish({ status: res.statusCode, body: payload, headers, handlerReached: true, responseCount }); return res; },
            send(payload: any) { responseCount += 1; finish({ status: res.statusCode, body: payload, headers, handlerReached: true, responseCount }); return res; },
            end() { responseCount += 1; finish({ status: res.statusCode, body: undefined, headers, handlerReached: true, responseCount }); return res; },
        };

        const next = (error?: any) => {
            if (error) { if (!settled) { settled = true; reject(error); } return; }
            const middleware = chain[index++];
            if (!middleware) {
                finish({ status: 0, body: undefined, headers, handlerReached: false, responseCount });
                return;
            }
            try {
                const outcome = (middleware as any)(req, res, next);
                if (outcome && typeof outcome.then === 'function') outcome.catch(next);
            } catch (error) {
                next(error);
            }
        };

        next();
    });
}

const sign = (id: string, role: string, extra: Record<string, unknown> = {}, options: jwt.SignOptions = {}) =>
    jwt.sign({ id, role, tv: 0, ...extra }, TEST_SECRET, { expiresIn: '5m', ...options });

const withSilencedErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = () => undefined;
    try { return await fn(); } finally { console.error = original; }
};

const MEMBERSHIP_DTO_KEYS = ['branch_id', 'branch_name', 'instructor_id', 'instructor_name', 'membership_id'];
const ownerToken = () => sign(OWNER_A, 'instructor');
const listReq = (query: any = {}, token = ownerToken()) =>
    makeReq({ token, method: 'GET', pathName: '/instructor-memberships', query });
const assignReq = (membershipId: string, body: any, token = ownerToken()) =>
    makeReq({ token, method: 'PATCH', pathName: `/instructor-memberships/${membershipId}`, body });

/** base64url without padding — the production cursor encoding. */
const encodeCursor = (id: string) => Buffer.from(id, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const storedBranchId = (state: State, membershipId: string) =>
    state.memberships.find(m => m.id === membershipId)?.branch_id ?? null;

// ---------------------------------------------------------------------------
// Import isolation — positive evidence
// ---------------------------------------------------------------------------

test('import isolation: forbidden module bodies never evaluate, no dummy env, hook restored', () => {
    assert.equal(loadError, null, `application modules must load through the sentinels: ${String(loadError)}`);
    assert.equal(process.env.MINIO_ACCESS_KEY, undefined);
    assert.equal(process.env.MINIO_SECRET_KEY, undefined);

    for (const [key, intercepted] of sentinelByPath) {
        assert.ok(intercepted.id.length > 0, `sentinel registered for ${key}`);
        assert.ok(
            interceptionLog.includes(intercepted.id),
            `the loader must have intercepted ${intercepted.id} (recorded: ${JSON.stringify(interceptionLog)})`,
        );
        assert.equal(
            require.cache[intercepted.id],
            undefined,
            `${intercepted.id} must never be evaluated or cached by Node`,
        );
    }

    assert.deepEqual(sentinelCalls, [], 'no forbidden default adapter may be called during import or tests');
    assert.equal((Module as any)._load, originalLoad, 'the loader hook is restored in finally');
});

// ---------------------------------------------------------------------------
// GET /instructor-memberships — owner-only bounded list
// ---------------------------------------------------------------------------

test('list: the verified owner reads only the active instructor memberships of the selected tenant', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, listReq());

    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ['memberships', 'next_cursor']);
    assert.deepEqual(res.body.memberships.map((m: any) => m.membership_id), [MEMBER_A1, MEMBER_A2]);
    assert.equal(res.body.next_cursor, null, 'a short page has no successor cursor');
    assert.equal(res.headers['Cache-Control'], 'no-store');

    assert.deepEqual(harness.events, ['begin', 'owner', 'list', 'rollback', 'release']);
    const ownerCall = harness.calls[0];
    assert.equal(squash(ownerCall.sql), OWNER_SELECT, 'the read path verifies the owner without an exclusive lock');
    assert.deepEqual(ownerCall.params, [OWNER_A, TENANT_A]);
    const listCall = harness.calls[1];
    assert.equal(squash(listCall.sql), LIST_SQL);
    assert.deepEqual(
        listCall.params,
        [TENANT_A, 'instructor', '', 26],
        'the list is tenant+role qualified, cursor-bounded and reads one extra row',
    );
    assert.equal(harness.auditRows.length, 0, 'a read writes nothing');
});

test('list: the projection is exactly the five documented fields and never a row spread', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, listReq());

    assert.equal(res.status, 200);
    for (const row of res.body.memberships) {
        assert.deepEqual(Object.keys(row).sort(), MEMBERSHIP_DTO_KEYS);
    }
    assert.deepEqual(res.body.memberships[0], {
        membership_id: MEMBER_A1,
        instructor_id: INSTRUCTOR_A,
        instructor_name: displayName(INSTRUCTOR_A),
        branch_id: BRANCH_A1,
        branch_name: 'North Campus',
    });
    assert.deepEqual(res.body.memberships[1], {
        membership_id: MEMBER_A2,
        instructor_id: INSTRUCTOR_A2,
        instructor_name: displayName(INSTRUCTOR_A2),
        branch_id: null,
        branch_name: null,
    });

    const text = JSON.stringify(res.body);
    assert.equal(text.includes(TENANT_A), false, 'tenant_id is never disclosed');
    assert.equal(text.includes('role_key'), false, 'the membership role is never disclosed');
    assert.equal(text.includes('"status"'), false, 'the membership status is never disclosed');
    assert.equal(text.includes('Foreign Campus'), false, 'a foreign branch name must never be listed');
    assert.equal(text.includes(MEMBER_B1), false, 'a foreign membership must never be listed');
});

test('list: inactive memberships, non-instructor roles and inactive users are excluded', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, listReq());

    assert.equal(res.status, 200);
    const ids = res.body.memberships.map((m: any) => m.membership_id);
    assert.equal(ids.includes(MEMBER_A3), false, 'an inactive membership is never listed');
    assert.equal(ids.includes(MEMBER_A4), false, 'an owner-role membership is not an instructor membership');
    assert.equal(ids.includes(MEMBER_A5), false, 'a membership whose user row is inactive is never listed');
});

test('list: the page size defaults to 25 and a full page mints the next cursor', async () => {
    const state = makeState();
    for (let index = 0; index < 40; index += 1) {
        const userId = `bulk-instructor-${index}`;
        state.users[userId] = identity();
        state.membershipsByUser[userId] = [TENANT_A];
        state.memberships.push({
            id: `d0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            tenant_id: TENANT_A,
            user_id: userId,
            role_key: 'instructor',
            status: 'active',
            branch_id: null,
        });
    }
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, listReq());

    assert.equal(res.status, 200);
    assert.equal(res.body.memberships.length, 25, 'the default page is bounded to 25 rows');
    assert.equal(res.body.next_cursor, encodeCursor(res.body.memberships[24].membership_id));
    const listCall = harness.calls.find(c => squash(c.sql) === LIST_SQL);
    assert.deepEqual(listCall?.params, [TENANT_A, 'instructor', '', 26]);
});

test('list: a cursor is only a position — it never widens the tenant bound', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    // A cursor minted from ANOTHER tenant's membership id is still only a
    // position: the page stays qualified by the selected tenant.
    const res = await runChain(harness.chain, listReq({ cursor: encodeCursor(MEMBER_B1) }));

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.memberships, [], 'no row of the selected tenant sorts after a foreign id');
    assert.equal(JSON.stringify(res.body).includes(MEMBER_B1), false);
    const listCall = harness.calls.find(c => squash(c.sql) === LIST_SQL);
    assert.deepEqual(listCall?.params, [TENANT_A, 'instructor', MEMBER_B1, 26]);
});

test('list: a membership instructor is refused and no membership row is ever read', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, listReq({}, sign(INSTRUCTOR_A, 'instructor')));

    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Forbidden' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(harness.events, ['begin', 'owner', 'rollback', 'release']);
    assert.equal(harness.calls.some(c => squash(c.sql) === LIST_SQL), false);
});

test('list: the billing-only restriction is refused before any connection is taken', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, listReq({}, sign(BILLING_ONLY, 'instructor')));

    assert.equal(res.status, 403);
    assert.deepEqual(res.body, {
        error: 'Branch management is not available while the account is limited to billing and support',
        code: 'BILLING_ONLY',
    });
    assert.equal(harness.connectionCount(), 0);
});

test('list: an unauthenticated read is refused and discloses nothing', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, makeReq({ token: null, pathName: '/instructor-memberships' }));

    assert.equal(res.status, 401);
    assert.equal(harness.connectionCount(), 0);
    assert.equal(JSON.stringify(res.body).includes(MEMBER_A1), false);
});

test('list: an invalid limit or cursor is rejected before any connection', async () => {
    const state = makeState();
    const harness = buildHarness(state);

    for (const query of [{ limit: '0' }, { limit: '101' }, { limit: 'x' }, { limit: '1.5' }]) {
        const res = await runChain(harness.chain, listReq(query));
        assert.equal(res.status, 400, `limit ${JSON.stringify(query)} must be rejected`);
        assert.deepEqual(res.body, { error: 'Invalid instructor membership list limit' });
        assert.equal(res.headers['Cache-Control'], 'no-store');
    }
    for (const query of [{ cursor: 'not-base64!!' }, { cursor: '' }, { cursor: 'Zm9v' }]) {
        const res = await runChain(harness.chain, listReq(query));
        assert.equal(res.status, 400, `cursor ${JSON.stringify(query)} must be rejected`);
        assert.deepEqual(res.body, { error: 'Invalid instructor membership list cursor' });
    }
    assert.equal(harness.connectionCount(), 0);
});

test('list: an unresolved selected tenant is refused and no membership row is read', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    // The token selects tenant B, but this caller has no membership there.
    const res = await runChain(harness.chain, listReq({}, sign(INSTRUCTOR_A, 'instructor', { tenant_id: TENANT_B })));

    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Tenant membership not found' });
    assert.equal(harness.connectionCount(), 0);
});

// ---------------------------------------------------------------------------
// PATCH /instructor-memberships/:id — assign
// ---------------------------------------------------------------------------

test('assign: the owner records an active same-tenant branch and one audit commits with it', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, assignReq(MEMBER_A2, { branch_id: BRANCH_A2 }));

    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ['membership']);
    assert.deepEqual(res.body.membership, {
        membership_id: MEMBER_A2,
        instructor_id: INSTRUCTOR_A2,
        instructor_name: displayName(INSTRUCTOR_A2),
        branch_id: BRANCH_A2,
        branch_name: 'South Campus',
    });
    assert.deepEqual(Object.keys(res.body.membership).sort(), MEMBERSHIP_DTO_KEYS);
    assert.equal(res.headers['Cache-Control'], 'no-store');

    assert.deepEqual(harness.events, [
        'begin', 'owner', 'membership-lock', 'branch-lock', 'update', 'audit', 'read', 'commit', 'release',
    ]);
    assert.equal(storedBranchId(state, MEMBER_A2), BRANCH_A2, 'the column is written at commit');
    assert.equal(harness.auditRows.length, 1, 'exactly one audit event commits');

    const ownerCall = harness.calls[0];
    assert.equal(squash(ownerCall.sql), OWNER_LOCK_SELECT, 'a write locks the owner row');
    const lockCall = harness.calls[1];
    assert.equal(squash(lockCall.sql), MEMBERSHIP_LOCK_SQL);
    assert.deepEqual(lockCall.params, [MEMBER_A2, TENANT_A, 'instructor']);
    const branchCall = harness.calls[2];
    assert.equal(squash(branchCall.sql), BRANCH_LOCK_SQL);
    assert.deepEqual(branchCall.params, [BRANCH_A2, TENANT_A], 'the branch is qualified by the selected tenant');
    const updateCall = harness.calls[3];
    assert.equal(squash(updateCall.sql), MEMBERSHIP_UPDATE_SQL);
    assert.deepEqual(updateCall.params, [BRANCH_A2, MEMBER_A2, TENANT_A]);
});

test('assign: the audit records the organization change only', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    await runChain(harness.chain, assignReq(MEMBER_A2, { branch_id: BRANCH_A2 }));

    const audit = harness.auditRows[0];
    const [id, actor, tenant, action, resourceType, resourceId, oldValue, newValue] = audit.params;
    assert.equal(typeof id, 'string');
    assert.equal(actor, OWNER_A);
    assert.equal(tenant, TENANT_A);
    assert.equal(action, 'tenant.instructor_branch_assigned');
    assert.equal(resourceType, 'tenant_membership');
    assert.equal(resourceId, MEMBER_A2);
    assert.deepEqual(JSON.parse(oldValue), { branch_id: null, branch_name: null });
    assert.deepEqual(JSON.parse(newValue), { branch_id: BRANCH_A2, branch_name: 'South Campus' });

    // No role, permission, teaching-access, course, group, student, enrollment
    // or billing value may ever appear in this event.
    const text = `${oldValue}${newValue}`;
    for (const forbidden of ['role_key', 'permission', 'teaching', 'course', 'group', 'student', 'enrollment', 'price', 'billing']) {
        assert.equal(text.includes(forbidden), false, `the audit must not carry "${forbidden}"`);
    }
});

test('assign: the membership role and status are never touched', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const before = { ...state.memberships.find(m => m.id === MEMBER_A2)! };
    await runChain(harness.chain, assignReq(MEMBER_A2, { branch_id: BRANCH_A2 }));
    const after = state.memberships.find(m => m.id === MEMBER_A2)!;

    assert.equal(after.role_key, before.role_key);
    assert.equal(after.status, before.status);
    assert.equal(after.tenant_id, before.tenant_id);
    assert.equal(after.user_id, before.user_id);
    assert.equal(after.branch_id, BRANCH_A2);
    const updateCalls = harness.calls.filter(c => squash(c.sql) === MEMBERSHIP_UPDATE_SQL);
    assert.equal(updateCalls.length, 1, 'exactly one statement writes, and it writes one column');
    assert.equal(squash(updateCalls[0].sql).startsWith('UPDATE tenant_memberships SET branch_id=?'), true);
});

test('assign: re-recording the stored branch is a truthful no-op — no write, no audit', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    // MEMBER_A1 is already recorded on BRANCH_A1.
    const res = await runChain(harness.chain, assignReq(MEMBER_A1, { branch_id: BRANCH_A1 }));

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.membership, {
        membership_id: MEMBER_A1,
        instructor_id: INSTRUCTOR_A,
        instructor_name: displayName(INSTRUCTOR_A),
        branch_id: BRANCH_A1,
        branch_name: 'North Campus',
    });
    assert.deepEqual(harness.events, ['begin', 'owner', 'membership-lock', 'branch-lock', 'rollback', 'release']);
    assert.equal(harness.calls.some(c => squash(c.sql) === MEMBERSHIP_UPDATE_SQL), false);
    assert.equal(harness.auditRows.length, 0);
    assert.equal(storedBranchId(state, MEMBER_A1), BRANCH_A1);
});

test('assign: clearing records null and audits the clear', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, assignReq(MEMBER_A1, { branch_id: null }));

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.membership, {
        membership_id: MEMBER_A1,
        instructor_id: INSTRUCTOR_A,
        instructor_name: displayName(INSTRUCTOR_A),
        branch_id: null,
        branch_name: null,
    });
    assert.deepEqual(harness.events, ['begin', 'owner', 'membership-lock', 'update', 'audit', 'read', 'commit', 'release']);
    assert.equal(
        harness.calls.some(c => squash(c.sql) === BRANCH_LOCK_SQL),
        false,
        'a clear has no branch to verify, so no branch row is locked',
    );
    assert.equal(storedBranchId(state, MEMBER_A1), null);
    const audit = harness.auditRows[0];
    assert.equal(audit.params[3], 'tenant.instructor_branch_cleared');
    assert.deepEqual(JSON.parse(audit.params[6]), { branch_id: BRANCH_A1, branch_name: 'North Campus' });
    assert.deepEqual(JSON.parse(audit.params[7]), { branch_id: null, branch_name: null });
});

test('assign: clearing an already-empty record is a truthful no-op', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, assignReq(MEMBER_A2, { branch_id: null }));

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.membership, {
        membership_id: MEMBER_A2,
        instructor_id: INSTRUCTOR_A2,
        instructor_name: displayName(INSTRUCTOR_A2),
        branch_id: null,
        branch_name: null,
    });
    assert.deepEqual(harness.events, ['begin', 'owner', 'membership-lock', 'rollback', 'release']);
    assert.equal(harness.auditRows.length, 0);
});

test('assign: the response is the stored projection read back inside the transaction', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    await runChain(harness.chain, assignReq(MEMBER_A2, { branch_id: BRANCH_A2 }));

    const readCall = harness.calls.find(c => squash(c.sql) === MEMBERSHIP_READ_SQL);
    assert.ok(readCall, 'the handler reads the row back inside the transaction');
    assert.deepEqual(readCall?.params, [MEMBER_A2, TENANT_A]);
    const readIndex = harness.calls.findIndex(c => squash(c.sql) === MEMBERSHIP_READ_SQL);
    const auditIndex = harness.calls.findIndex(c => squash(c.sql) === AUDIT_SQL);
    assert.ok(auditIndex < readIndex, 'the audit is written before the read-back, inside the same transaction');
});

// ---------------------------------------------------------------------------
// Target isolation — foreign, archived, absent, wrong-role, inactive
// ---------------------------------------------------------------------------

test('assign: a foreign tenant branch is the same 404 as an absent one and writes nothing', async () => {
    const state = makeState();
    const harness = buildHarness(state);

    const foreign = await runChain(harness.chain, assignReq(MEMBER_A2, { branch_id: BRANCH_B1 }));
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, { error: 'Branch not found' });

    const absent = await runChain(harness.chain, assignReq(MEMBER_A2, { branch_id: ABSENT_BRANCH }));
    assert.equal(absent.status, 404);
    assert.deepEqual(absent.body, foreign.body, 'a foreign and an absent branch are indistinguishable');

    assert.equal(storedBranchId(state, MEMBER_A2), null);
    assert.equal(harness.auditRows.length, 0);
    assert.equal(harness.calls.some(c => squash(c.sql) === MEMBERSHIP_UPDATE_SQL), false);
    assert.equal(harness.releaseCount(), 2);
    assert.equal(harness.destroyCount(), 0);
});

test('assign: an archived branch is refused, not silently re-recorded', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, assignReq(MEMBER_A2, { branch_id: BRANCH_A3 }));

    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Branch not found' });
    assert.equal(storedBranchId(state, MEMBER_A2), null);
    assert.equal(harness.auditRows.length, 0);
});

test('assign: an archived branch already recorded is refused rather than treated as a no-op', async () => {
    const state = makeState();
    // The recorded branch was archived after it was recorded.
    state.memberships.find(m => m.id === MEMBER_A1)!.branch_id = BRANCH_A3;
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, assignReq(MEMBER_A1, { branch_id: BRANCH_A3 }));

    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Branch not found' });
    assert.equal(harness.calls.some(c => squash(c.sql) === MEMBERSHIP_UPDATE_SQL), false);
});

test('assign: a foreign membership is the same 404 as an absent one', async () => {
    const state = makeState();
    const harness = buildHarness(state);

    const foreign = await runChain(harness.chain, assignReq(MEMBER_B1, { branch_id: BRANCH_A1 }));
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, { error: 'Instructor membership not found' });

    const absent = await runChain(harness.chain, assignReq(ABSENT_MEMBER, { branch_id: BRANCH_A1 }));
    assert.equal(absent.status, 404);
    assert.deepEqual(absent.body, foreign.body, 'a foreign and an absent membership are indistinguishable');

    assert.equal(storedBranchId(state, MEMBER_B1), BRANCH_B1, 'the foreign membership is untouched');
    assert.equal(harness.auditRows.length, 0);
});

test('assign: an inactive membership, an owner-role membership and an inactive user are all 404', async () => {
    const state = makeState();
    const harness = buildHarness(state);

    for (const membershipId of [MEMBER_A3, MEMBER_A4, MEMBER_A5]) {
        const res = await runChain(harness.chain, assignReq(membershipId, { branch_id: BRANCH_A1 }));
        assert.equal(res.status, 404, `${membershipId} must not be assignable`);
        assert.deepEqual(res.body, { error: 'Instructor membership not found' });
        assert.equal(storedBranchId(state, membershipId), null);
    }
    assert.equal(harness.calls.some(c => squash(c.sql) === MEMBERSHIP_UPDATE_SQL), false);
    assert.equal(harness.auditRows.length, 0);
});

test('assign: a membership instructor is refused and nothing is written', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, assignReq(MEMBER_A2, { branch_id: BRANCH_A2 }, sign(INSTRUCTOR_A, 'instructor')));

    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Forbidden' });
    assert.deepEqual(harness.events, ['begin', 'owner', 'rollback', 'release']);
    assert.equal(storedBranchId(state, MEMBER_A2), null);
    assert.equal(harness.auditRows.length, 0);
});

test('assign: the billing-only restriction is refused before any connection', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, assignReq(MEMBER_A2, { branch_id: BRANCH_A2 }, sign(BILLING_ONLY, 'instructor')));

    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'BILLING_ONLY');
    assert.equal(harness.connectionCount(), 0);
    assert.equal(storedBranchId(state, MEMBER_A2), null);
});

test('assign: an unresolved selected tenant is refused before any connection', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, assignReq(
        MEMBER_A2, { branch_id: BRANCH_A2 }, sign(INSTRUCTOR_A, 'instructor', { tenant_id: TENANT_B }),
    ));

    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Tenant membership not found' });
    assert.equal(harness.connectionCount(), 0);
});

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

test('every outcome the handlers produce carries Cache-Control no-store', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const outcomes = await withSilencedErrors(async () => Promise.all([
        runChain(harness.chain, listReq()),
        runChain(harness.chain, listReq({ limit: '0' })),
        runChain(harness.chain, assignReq(MEMBER_A2, { branch_id: BRANCH_A2 })),
        runChain(harness.chain, assignReq(MEMBER_A2, {})),
        runChain(harness.chain, assignReq('not-a-uuid', { branch_id: null })),
        runChain(harness.chain, assignReq(ABSENT_MEMBER, { branch_id: BRANCH_A2 })),
    ]));

    for (const result of outcomes) {
        assert.equal(result.headers['Cache-Control'], 'no-store');
        assert.equal(result.responseCount, 1, 'exactly one response per request');
    }

    // The unauthenticated 401 is produced UPSTREAM by the shared authentication
    // middleware, before this router is reached: it is untouched by M2-20 and
    // therefore carries no router cache directive.
    const unauthenticated = await runChain(harness.chain, makeReq({ token: null, pathName: '/instructor-memberships' }));
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.handlerReached, true);
});

test('the assignment surface never changes any authorization input', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    await runChain(harness.chain, assignReq(MEMBER_A2, { branch_id: BRANCH_A2 }));

    // The tenant owner and the membership role/status rows are the ONLY inputs
    // any authorization decision in this router reads, and none of them moved.
    assert.equal(state.tenantOwner[TENANT_A], OWNER_A);
    assert.equal(state.membershipRole[`${INSTRUCTOR_A2}@${TENANT_A}`], 'instructor');
    assert.equal(state.memberships.find(m => m.id === MEMBER_A2)!.status, 'active');
    assert.equal(state.memberships.find(m => m.id === MEMBER_A2)!.role_key, 'instructor');

    // And the owner still resolves exactly as before, so the write granted the
    // instructor nothing.
    const after = await runChain(harness.chain, listReq());
    assert.equal(after.status, 200);
    assert.deepEqual(after.body.memberships.map((m: any) => m.membership_id), [MEMBER_A1, MEMBER_A2]);
});

test('the branch list of the untouched M2-B03 surface is unaffected by the new routes', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    // A request to the OLD surface must not be answered by the new handlers:
    // the new paths are distinct, so the branch list SQL is never reached and
    // no instructor-membership statement is issued for a branch request.
    const res = await runChain(harness.chain, makeReq({
        token: ownerToken(), method: 'GET', pathName: '/branches', query: {},
    }));
    // The branch handler is out of this suite's fixture, so the truthful outcome
    // is the handler's own opaque 500 — never a membership answer.
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to list branches' });
    assert.equal(harness.calls.some(c => squash(c.sql) === LIST_SQL), false);
});
