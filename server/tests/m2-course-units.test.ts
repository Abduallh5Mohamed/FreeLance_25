/**
 * M2-B04 — private course-unit metadata (hermetic, behavioral).
 *
 * Contract under test: GET/POST /api/tenants/me/catalog/courses/:courseId/units
 * and PATCH /api/tenants/me/catalog/courses/:courseId/units/:unitId manage the
 * private unit metadata of an ACTIVE course of the tenant the SERVER selected,
 * and only for the VERIFIED owner of that tenant (`tenants.owner_user_id` =
 * caller, tenant active, caller active). A membership role label, a global
 * teacher/admin role and a student never grant unit visibility or writes.
 * Unit metadata carries no teacher assignment, student entitlement,
 * publication, payment or upload effect: archiving a unit is metadata only.
 *
 * Composition under test is the real production order (src/index.ts): the real
 * optional-auth middleware, the real tenant-authority and student-workspace
 * boundaries, then the real `createTenantSelfRouter` with the real
 * `createCourseUnitsRouter` mounted under `/catalog`. Only leaf data
 * repositories and the transactional connection are injected fixtures. No
 * express listener, socket, fetch, DB, provider or app startup.
 *
 * Import isolation is proven positively: the `src/db`, `src/services/minio`,
 * `src/services/subscription-renewal` and `dotenv` module bodies are
 * intercepted in the CommonJS loader before any app module loads, stay out of
 * `require.cache`, need no dummy env and are re-checked in `after`.
 *
 * Live MySQL row-level locking, real concurrency, real keyset index usage,
 * real foreign keys and real HTTP transport are explicitly NOT exercised or
 * claimed.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import jwt from 'jsonwebtoken';
import type { RequestHandler, Router } from 'express';

const TEST_SECRET = 'm2-b04-hermetic-jwt-secret-not-a-real-key';
const originalSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = TEST_SECRET;

after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    assert.equal((Module as any)._load, originalLoad, 'the loader hook must be restored after loading');
    assert.deepEqual(sentinelCalls, [], 'no forbidden default adapter may be called by any test in this suite');
});

// ---------------------------------------------------------------------------
// Positive import interception
// ---------------------------------------------------------------------------

const originalLoad = (Module as any)._load;
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
const dotenvSentinel = {
    config: (): never => violation('dotenv.config'),
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
registerSentinel('dotenv', dotenvSentinel);

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
const restoreInterception = () => { (Module as any)._load = originalLoad; };

let loadError: unknown = null;
let authModule: any;
let boundaryModule: any;
let studentBoundaryModule: any;
let routeModule: any;
let courseUnitsModule: any;
/** The interception log right after the unit module was loaded on its own. */
let unitModuleInterception: string[] = [];

installInterception();
try {
    // The new module is loaded FIRST and alone: it must not pull in the
    // database, the provider, the renewal executor or dotenv by itself.
    courseUnitsModule = require('../src/routes/course-units');
    unitModuleInterception = [...interceptionLog];
    authModule = require('../src/middleware/auth');
    boundaryModule = require('../src/middleware/tenant-authority-boundary');
    studentBoundaryModule = require('../src/middleware/student-workspace-boundary');
    routeModule = require('../src/routes/tenant-self');
} catch (error) {
    loadError = error;
} finally {
    restoreInterception();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const OWNER_A = 'owner-a';
const OWNER_B = 'owner-b';
const INSTRUCTOR_A = 'instructor-a';
const ROLE_OWNER_MEMBER = 'role-owner-member-1';
const BILLING_ONLY = 'billing-only-instructor-1';
const MULTI = 'multi-1';
const STUDENT = 'student-1';
const ADMIN = 'admin-1';
const NO_SCOPE = 'no-scope-1';

const COURSE_A1 = 'a1000000-0000-4000-8000-000000000001';
const COURSE_A2 = 'a1000000-0000-4000-8000-000000000002';
const COURSE_B1 = 'b1000000-0000-4000-8000-000000000001';
const COURSE_NULL = 'c1000000-0000-4000-8000-000000000001';
const ABSENT_COURSE = 'd1000000-0000-4000-8000-000000000000';

const UNIT_A1 = 'e1000000-0000-4000-8000-000000000001';
const UNIT_A2 = 'e1000000-0000-4000-8000-000000000002';
const UNIT_A3 = 'e1000000-0000-4000-8000-000000000003';
const UNIT_B1 = 'f1000000-0000-4000-8000-000000000001';
const UNIT_C1 = 'f2000000-0000-4000-8000-000000000001';
const ABSENT_UNIT = 'f3000000-0000-4000-8000-000000000000';

interface TenantRow {
    id: string;
    business_name: string;
    subject_type: string | null;
    status: string;
    legacy_compat: number;
    owner_user_id: string;
}

interface IdentityRow { is_active: number; token_version: number; suspension_active: number }

interface CourseRow { id: string; tenant_id: string | null; is_active: number }

interface UnitRow {
    id: string;
    course_id: string;
    name: string;
    display_order: number;
    status: string;
    created_at: Date;
    updated_at: Date;
}

/**
 * The stored instant of a unit.
 *
 * `epochSeconds` is the exact stored instant — what `UNIX_TIMESTAMP(col)`
 * returns for a TIMESTAMP column, independently of the session time zone.
 *
 * `driverDate` emulates the INSTALLED mysql2 decoder with the pool's
 * `timezone: '+02:00'`: that option makes the driver INTERPRET the wall
 * time it receives, so the Date it hands back is shifted by -2h from the
 * stored instant. The projection below returns BOTH, so a handler that
 * serialized the raw datetime column would answer a shifted instant and
 * the regression is observable instead of hidden.
 */
const DRIVER_OFFSET_SECONDS = 2 * 60 * 60;
const epochOf = (instant: Date): number => Math.floor(instant.getTime() / 1000);
const driverDateOf = (instant: Date): Date => new Date(instant.getTime() - DRIVER_OFFSET_SECONDS * 1000);

/** The malformed-epoch variants a broken projection could produce. */
type MalformedEpoch = 'none' | 'null' | 'zero' | 'nan' | 'text' | 'missing';

interface State {
    users: Record<string, IdentityRow>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    memberships: Record<string, string[]>;
    tenantOwner: Record<string, string>;
    membershipRole: Record<string, string>;
    enrollments: Record<string, Array<{ id: string; user_id: string; tenant_id: string; instructor_id: string | null; group_id: string | null; grade_id: string | null }>>;
    tenants: TenantRow[];
    courses: CourseRow[];
    units: UnitRow[];
    unitClock: number;
    failAcquire: boolean;
    failBegin: boolean;
    failOwnerSelect: boolean;
    failCourseSelect: boolean;
    failList: boolean;
    failInsert: boolean;
    failAudit: boolean;
    failCommit: boolean;
    failRollback: boolean;
    failUnitSelect: boolean;
    failReadBack: boolean;
    affectedRowsOverride: number | null;
    malformedEpoch: MalformedEpoch;
}

const identity = (): IdentityRow => ({ is_active: 1, token_version: 0, suspension_active: 0 });
const activeAccount = () => ({ tenant_status: 'active', legacy_compat: 1, allowed: 1 });
const stamp = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 19, hour, minute, 0));

function makeState(): State {
    return {
        users: {
            [OWNER_A]: identity(), [OWNER_B]: identity(), [INSTRUCTOR_A]: identity(),
            [ROLE_OWNER_MEMBER]: identity(), [BILLING_ONLY]: identity(), [MULTI]: identity(),
            [STUDENT]: identity(), [ADMIN]: identity(), [NO_SCOPE]: identity(),
        },
        instructorAccounts: {
            [OWNER_A]: activeAccount(), [OWNER_B]: activeAccount(), [INSTRUCTOR_A]: activeAccount(),
            [ROLE_OWNER_MEMBER]: activeAccount(), [MULTI]: activeAccount(), [NO_SCOPE]: activeAccount(),
            // A live instructor account that is neither legacy-compatible nor
            // explicitly allowed: the authentication middleware marks the
            // principal `billingOnly` instead of denying the request.
            [BILLING_ONLY]: { tenant_status: 'active', legacy_compat: 0, allowed: 0 },
        },
        memberships: {
            [OWNER_A]: [TENANT_A],
            [OWNER_B]: [TENANT_B],
            [INSTRUCTOR_A]: [TENANT_A],
            [ROLE_OWNER_MEMBER]: [TENANT_A],
            [BILLING_ONLY]: [TENANT_A],
            [MULTI]: [TENANT_A, TENANT_B],
            [STUDENT]: [],
            [ADMIN]: [],
            [NO_SCOPE]: [],
        },
        tenantOwner: { [TENANT_A]: OWNER_A, [TENANT_B]: OWNER_B },
        membershipRole: {
            [`${OWNER_A}@${TENANT_A}`]: 'owner',
            [`${OWNER_B}@${TENANT_B}`]: 'owner',
            [`${INSTRUCTOR_A}@${TENANT_A}`]: 'instructor',
            [`${ROLE_OWNER_MEMBER}@${TENANT_A}`]: 'owner',
            [`${BILLING_ONLY}@${TENANT_A}`]: 'instructor',
        },
        enrollments: {
            [STUDENT]: [{ id: 'enrollment-1', user_id: STUDENT, tenant_id: TENANT_A, instructor_id: INSTRUCTOR_A, group_id: 'g-1', grade_id: 'gr-1' }],
        },
        tenants: [
            { id: TENANT_A, business_name: 'Alpha Academy', subject_type: 'company', status: 'active', legacy_compat: 0, owner_user_id: OWNER_A },
            { id: TENANT_B, business_name: 'Beta Academy', subject_type: null, status: 'active', legacy_compat: 0, owner_user_id: OWNER_B },
        ],
        courses: [
            { id: COURSE_A1, tenant_id: TENANT_A, is_active: 1 },
            { id: COURSE_A2, tenant_id: TENANT_A, is_active: 0 },
            { id: COURSE_B1, tenant_id: TENANT_B, is_active: 1 },
            { id: COURSE_NULL, tenant_id: null, is_active: 1 },
        ],
        units: [
            { id: UNIT_A1, course_id: COURSE_A1, name: 'Introduction', display_order: 0, status: 'active', created_at: stamp(8, 0), updated_at: stamp(8, 0) },
            { id: UNIT_A2, course_id: COURSE_A1, name: 'Introduction', display_order: 0, status: 'active', created_at: stamp(8, 1), updated_at: stamp(8, 1) },
            { id: UNIT_A3, course_id: COURSE_A1, name: 'Advanced', display_order: 5, status: 'archived', created_at: stamp(8, 2), updated_at: stamp(8, 2) },
            { id: UNIT_B1, course_id: COURSE_B1, name: 'Foreign Unit', display_order: 0, status: 'active', created_at: stamp(8, 3), updated_at: stamp(8, 3) },
            { id: UNIT_C1, course_id: COURSE_NULL, name: 'Orphan Unit', display_order: 0, status: 'active', created_at: stamp(8, 4), updated_at: stamp(8, 4) },
        ],
        unitClock: 0,
        failAcquire: false,
        failBegin: false,
        failOwnerSelect: false,
        failCourseSelect: false,
        failList: false,
        failInsert: false,
        failAudit: false,
        failCommit: false,
        failRollback: false,
        failUnitSelect: false,
        failReadBack: false,
        affectedRowsOverride: null,
        malformedEpoch: 'none',
    };
}

interface Call { sql: string; params: any[] }
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const OWNER_SELECT = 'SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active FROM tenants t JOIN users u ON u.id=? WHERE t.id=?';
const OWNER_LOCK_SELECT = `${OWNER_SELECT} FOR UPDATE`;
const COURSE_SELECT = 'SELECT c.id,c.tenant_id FROM courses c WHERE c.id=? AND c.tenant_id=? AND c.is_active=1';
const COURSE_LOCK_SELECT = `${COURSE_SELECT} FOR UPDATE`;
const LIST_SQL = 'SELECT u.id,u.course_id,u.name,u.display_order,u.status,UNIX_TIMESTAMP(u.created_at) AS created_at_epoch,UNIX_TIMESTAMP(u.updated_at) AS updated_at_epoch FROM course_units u WHERE u.course_id=? AND (u.display_order>? OR (u.display_order=? AND u.id>?)) ORDER BY u.display_order ASC, u.id ASC LIMIT ?';
const UNIT_SELECT = 'SELECT u.id,u.course_id,u.name,u.display_order,u.status,UNIX_TIMESTAMP(u.created_at) AS created_at_epoch,UNIX_TIMESTAMP(u.updated_at) AS updated_at_epoch FROM course_units u WHERE u.id=? AND u.course_id=? LIMIT 1';
const UNIT_LOCK_SELECT = 'SELECT u.id,u.course_id,u.name,u.display_order,u.status,UNIX_TIMESTAMP(u.created_at) AS created_at_epoch,UNIX_TIMESTAMP(u.updated_at) AS updated_at_epoch FROM course_units u WHERE u.id=? AND u.course_id=? FOR UPDATE';
const INSERT_UNIT_SQL = 'INSERT INTO course_units (id,course_id,name,display_order,status) VALUES (?,?,?,?,?)';
const UPDATE_UNIT_SQL = 'UPDATE course_units SET name=?,display_order=?,status=? WHERE id=? AND course_id=?';
const AUDIT_SQL = 'INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value) VALUES (?,?,?,?,?,?,?,?)';

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

    const unitRow = (id: string, courseId: string) =>
        state.units.find(u => u.id === id && u.course_id === courseId) ?? null;

    /**
     * Project a stored unit row the way the production projection reads it:
     * the two instants as epoch seconds, next to the raw datetime columns
     * the installed driver would have decoded with its `timezone: '+02:00'`
     * interpretation. The malformed-epoch variants emulate a broken
     * projection so the refusal of an unreadable instant is observable.
     */
    const projectedRow = (row: UnitRow): any => {
        const projected: any = {
            ...row,
            created_at: driverDateOf(row.created_at),
            updated_at: driverDateOf(row.updated_at),
            created_at_epoch: epochOf(row.created_at),
            updated_at_epoch: epochOf(row.updated_at),
        };
        if (state.malformedEpoch === 'null') {
            projected.created_at_epoch = null;
            projected.updated_at_epoch = null;
        } else if (state.malformedEpoch === 'zero') {
            projected.created_at_epoch = 0;
            projected.updated_at_epoch = 0;
        } else if (state.malformedEpoch === 'nan') {
            projected.created_at_epoch = Number.NaN;
            projected.updated_at_epoch = Number.NaN;
        } else if (state.malformedEpoch === 'text') {
            projected.created_at_epoch = 'not-an-epoch';
            projected.updated_at_epoch = 'not-an-epoch';
        } else if (state.malformedEpoch === 'missing') {
            delete projected.created_at_epoch;
            delete projected.updated_at_epoch;
        }
        return projected;
    };

    const unitSql = async (sql: string, params: any[]): Promise<[any, any]> => {
        const n = squash(sql);
        calls.push({ sql, params });

        if (n === OWNER_SELECT || n === OWNER_LOCK_SELECT) {
            events.push('owner');
            if (state.failOwnerSelect) throw new Error('owner verification failed: internal detail leaked');
            const tenant = state.tenants.find(t => t.id === params[1]);
            const user = state.users[params[0]];
            if (!tenant || !user) return [[], []];
            return [[{
                owner_user_id: tenant.owner_user_id,
                tenant_status: tenant.status,
                caller_active: user.is_active,
            }], []];
        }

        if (n === COURSE_SELECT || n === COURSE_LOCK_SELECT) {
            events.push('course');
            if (state.failCourseSelect) throw new Error('course lookup failed: internal detail leaked');
            const course = state.courses.find(c => c.id === params[0] && c.tenant_id === params[1] && c.is_active === 1);
            return [course ? [{ id: course.id, tenant_id: course.tenant_id }] : [], []];
        }

        if (n === LIST_SQL) {
            events.push('list');
            if (state.failList) throw new Error('course unit list failed: internal detail leaked');
            const [courseId, afterOrder, tieOrder, afterId, limit] = params;
            const rows = state.units
                .filter(u => u.course_id === courseId)
                .filter(u => u.display_order > Number(afterOrder) || (u.display_order === Number(tieOrder) && u.id > String(afterId)))
                .sort((x, y) => (x.display_order - y.display_order) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
                .slice(0, Number(limit))
                .map(u => projectedRow(u));
            return [rows, []];
        }

        if (n === UNIT_LOCK_SELECT) {
            events.push('unit');
            if (state.failUnitSelect) throw new Error('course unit lookup failed: internal detail leaked');
            const row = unitRow(String(params[0]), String(params[1]));
            return [row ? [projectedRow(row)] : [], []];
        }

        if (n === UNIT_SELECT) {
            events.push('select');
            if (state.failReadBack) return [[], []];
            const row = unitRow(String(params[0]), String(params[1]));
            return [row ? [projectedRow(row)] : [], []];
        }

        if (n === INSERT_UNIT_SQL) {
            events.push('insert');
            if (state.failInsert) throw new Error('ER_LOCK_WAIT_TIMEOUT: insert on internal table course_units failed');
            const [id, courseId, name, displayOrder, status] = params;
            state.unitClock += 1;
            const created = stamp(9, state.unitClock);
            state.units.push({
                id: String(id), course_id: String(courseId), name: String(name),
                display_order: Number(displayOrder), status: String(status),
                created_at: created, updated_at: created,
            });
            return [{ affectedRows: 1, insertId: String(id) }, []];
        }

        if (n === UPDATE_UNIT_SQL) {
            events.push('update');
            const [name, displayOrder, status, id, courseId] = params;
            const affected = state.affectedRowsOverride ?? 1;
            if (affected === 1) {
                const row = unitRow(String(id), String(courseId));
                if (row) {
                    row.name = String(name);
                    row.display_order = Number(displayOrder);
                    row.status = String(status);
                    row.updated_at = stamp(10, 0);
                }
            }
            return [{ affectedRows: affected }, []];
        }

        if (n === AUDIT_SQL) {
            events.push('audit');
            if (state.failAudit) throw new Error('audit_events insert failed: internal detail leaked');
            auditRows.push({ sql, params });
            return [{ affectedRows: 1 }, []];
        }

        throw new Error(`Unhandled course unit SQL in hermetic fixture: ${n}`);
    };

    const makeConnection = () => {
        connectionCount += 1;
        return {
            beginTransaction: async () => { events.push('begin'); if (state.failBegin) throw new Error('begin failed: internal detail leaked'); },
            execute: unitSql,
            commit: async () => { events.push('commit'); if (state.failCommit) throw new Error('commit acknowledgement lost: internal detail leaked'); },
            rollback: async () => { events.push('rollback'); if (state.failRollback) throw new Error('rollback failed: internal detail leaked'); },
            release: () => { events.push('release'); releaseCount += 1; },
            destroy: () => { events.push('destroy'); destroyCount += 1; },
        };
    };

    const db = {
        query: async (): Promise<any> => { throw new Error('HERMETIC_VIOLATION:db.query not expected'); },
        queryOne: async (): Promise<any> => { throw new Error('HERMETIC_VIOLATION:db.queryOne not expected'); },
        execute: async (): Promise<any> => { throw new Error('HERMETIC_VIOLATION:db.execute not expected'); },
        getConnection: async () => {
            if (state.failAcquire) throw new Error('pool connection unavailable: internal detail leaked');
            return makeConnection();
        },
    };

    const repository = {
        findUsersIdentity: async (id: string) => state.users[id] ?? null,
        findStaffIdentity: async () => null,
        findInstructorAccount: async (id: string) => state.instructorAccounts[id] ?? null,
        findStudentEnrollments: async (id: string) => state.enrollments[id] ?? [],
        findActiveTenantMemberships: async (id: string) => (state.memberships[id] ?? []).map(tenant_id => ({ tenant_id })),
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
    const pathName = opts.pathName ?? '/catalog';
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

/** base64url without padding — the production cursor encoding. */
const encodeCursor = (displayOrder: number, id: string) => Buffer.from(`${displayOrder}:${id}`, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const UNIT_DTO_KEYS = ['id', 'course_id', 'name', 'display_order', 'status', 'created_at', 'updated_at'];
const ownerToken = () => sign(OWNER_A, 'instructor');
const unitsPath = (courseId: string) => `/catalog/courses/${courseId}/units`;
const unitPath = (courseId: string, unitId: string) => `/catalog/courses/${courseId}/units/${unitId}`;
const listReq = (query: any = {}, courseId = COURSE_A1, token: string | null = ownerToken()) =>
    makeReq({ token, method: 'GET', pathName: unitsPath(courseId), query });
const createReq = (body: any, courseId = COURSE_A1, token: string | null = ownerToken()) =>
    makeReq({ token, method: 'POST', pathName: unitsPath(courseId), body });
const updateReq = (unitId: string, body: any, courseId = COURSE_A1, token: string | null = ownerToken()) =>
    makeReq({ token, method: 'PATCH', pathName: unitPath(courseId, unitId), body });

// ---------------------------------------------------------------------------
// Import isolation — positive evidence
// ---------------------------------------------------------------------------

test('import isolation: forbidden module bodies never evaluate, no dummy env, hook restored', () => {
    assert.equal(loadError, null, `application modules must load through the sentinels: ${String(loadError)}`);
    assert.equal(process.env.MINIO_ACCESS_KEY, undefined);
    assert.equal(process.env.MINIO_SECRET_KEY, undefined);
    assert.equal(process.env.DB_HOST, undefined);

    assert.deepEqual(
        unitModuleInterception,
        [],
        'the unit module must not require the database, the provider, the renewal executor or dotenv by itself',
    );

    for (const [key, intercepted] of sentinelByPath) {
        assert.ok(intercepted.id.length > 0, `sentinel registered for ${key}`);
        assert.equal(
            require.cache[intercepted.id],
            undefined,
            `${intercepted.id} must never be evaluated or cached by Node`,
        );
    }

    for (const required of ['../src/db', '../src/services/minio', '../src/services/subscription-renewal']) {
        const id = require.resolve(required);
        assert.ok(
            interceptionLog.includes(id),
            `the loader must have intercepted ${id} (recorded: ${JSON.stringify(interceptionLog)})`,
        );
    }

    assert.deepEqual(sentinelCalls, [], 'no forbidden default adapter may be called during import or tests');
    assert.equal((Module as any)._load, originalLoad, 'the loader hook is restored in finally');
});

// ---------------------------------------------------------------------------
// Mounting and shape
// ---------------------------------------------------------------------------

test('mount: the unit routes are reachable under the authenticated tenant-self mount', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, listReq());
    assert.equal(res.status, 200, 'the unit list must be reachable through the real tenant-self mount');
    assert.deepEqual(Object.keys(res.body), ['units', 'next_cursor']);
});

test('mount: the unit router factory is usable on its own and binds no default adapter', async () => {
    assert.equal(typeof courseUnitsModule.createCourseUnitsRouter, 'function');
    assert.equal(courseUnitsModule.default, undefined, 'the unit module must have no default export');
    const state = makeState();
    const harness = buildHarness(state);
    const router: Router = courseUnitsModule.createCourseUnitsRouter({
        getConnection: async () => {
            throw new Error('HERMETIC_VIOLATION:the standalone factory must not be reached in this check');
        },
    });
    assert.equal(typeof router, 'function', 'the factory returns an express router');
    assert.equal(harness.connectionCount(), 0);
});

// ---------------------------------------------------------------------------
// GET list — owner-only bounded keyset list
// ---------------------------------------------------------------------------

test('list: the verified owner reads only the units of the selected course', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, listReq());

    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ['units', 'next_cursor']);
    assert.deepEqual(res.body.units.map((u: any) => u.id), [UNIT_A1, UNIT_A2, UNIT_A3]);
    assert.deepEqual(Object.keys(res.body.units[0]), UNIT_DTO_KEYS);
    assert.equal(res.body.next_cursor, null, 'a short page has no successor cursor');
    assert.equal(res.headers['Cache-Control'], 'no-store');

    assert.deepEqual(harness.events, ['begin', 'owner', 'course', 'list', 'rollback', 'release']);
    const ownerCall = harness.calls[0];
    assert.equal(squash(ownerCall.sql), OWNER_SELECT, 'the read path verifies the owner without an exclusive lock');
    assert.deepEqual(ownerCall.params, [OWNER_A, TENANT_A]);
    const courseCall = harness.calls[1];
    assert.equal(squash(courseCall.sql), COURSE_SELECT);
    assert.deepEqual(courseCall.params, [COURSE_A1, TENANT_A], 'the course is qualified by the selected tenant');
    const listCall = harness.calls[2];
    assert.equal(squash(listCall.sql), LIST_SQL);
    assert.deepEqual(listCall.params, [COURSE_A1, -1, -1, '', 26], 'the list is course-qualified, cursor-bounded and reads one extra row');
    assert.ok(!JSON.stringify(res.body).includes(TENANT_B), 'no other tenant may be disclosed');
    assert.ok(!JSON.stringify(res.body).includes('Foreign Unit'), 'a foreign unit must never be listed');
    assert.ok(!JSON.stringify(res.body).includes('Orphan Unit'), 'a unit of a tenant-less course must never be listed');
});

test('list: the DTO renders the stored instants as UTC ISO-8601 from the epoch projection', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, listReq());
    assert.equal(res.status, 200);
    assert.equal(res.body.units[0].created_at, '2026-10-19T08:00:00.000Z');
    assert.equal(res.body.units[0].updated_at, '2026-10-19T08:00:00.000Z');
    assert.equal(res.body.units[2].created_at, '2026-10-19T08:02:00.000Z');

    // The fixture hands back the raw datetime columns decoded by the
    // installed driver with its `timezone: '+02:00'` interpretation, which
    // is TWO HOURS EARLIER than the stored instant. A handler that
    // serialized that column would answer a shifted instant.
    const shifted = driverDateOf(stamp(8, 0)).toISOString();
    assert.equal(shifted, '2026-10-19T06:00:00.000Z', 'the driver-decoded column is the shifted value');
    assert.notEqual(res.body.units[0].created_at, shifted, 'the serialized instant must not be the driver-decoded value');
    assert.equal(res.body.units[0].created_at, new Date(epochOf(stamp(8, 0)) * 1000).toISOString(), 'the serialized instant is the stored instant');
    assert.ok(!JSON.stringify(res.body).includes('epoch'), 'the epoch projection must never leak into the DTO');
});

test('list: the serialized instant is independent of the driver offset and of a DST transition', async () => {
    const state = makeState();
    // Two instants that are exactly one hour apart in real time, placed
    // across the European daylight-saving start (2026-03-29T01:00:00Z): in
    // a local wall clock of a DST zone they are two hours apart, so a
    // wall-clock based serialization could not render both correctly.
    const before = new Date('2026-03-29T00:30:00.000Z');
    const after = new Date('2026-03-29T01:30:00.000Z');
    state.units.push(
        { id: 'e4000000-0000-4000-8000-000000000001', course_id: COURSE_A1, name: 'Before DST', display_order: 20, status: 'active', created_at: before, updated_at: before },
        { id: 'e4000000-0000-4000-8000-000000000002', course_id: COURSE_A1, name: 'After DST', display_order: 21, status: 'active', created_at: after, updated_at: after },
    );
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, listReq());
    assert.equal(res.status, 200);

    const beforeDto = res.body.units.find((u: any) => u.name === 'Before DST');
    const afterDto = res.body.units.find((u: any) => u.name === 'After DST');
    assert.equal(beforeDto.created_at, '2026-03-29T00:30:00.000Z');
    assert.equal(afterDto.created_at, '2026-03-29T01:30:00.000Z');
    assert.equal(
        new Date(afterDto.created_at).getTime() - new Date(beforeDto.created_at).getTime(),
        3600000,
        'the real elapsed time is exactly one hour across the transition',
    );
    // The same epoch rendered under any offset is the same instant.
    assert.equal(beforeDto.created_at, new Date(epochOf(before) * 1000).toISOString());
    assert.equal(afterDto.created_at, new Date(epochOf(after) * 1000).toISOString());
});

test('list: an unreadable epoch projection fails the page instead of fabricating a date', async () => {
    const variants: MalformedEpoch[] = ['null', 'zero', 'nan', 'text', 'missing'];
    for (const variant of variants) {
        const state = makeState();
        state.malformedEpoch = variant;
        const harness = buildHarness(state);
        const res = await withSilencedErrors(() => runChain(harness.chain, listReq()));
        assert.equal(res.status, 500, `epoch=${variant} must fail the page`);
        assert.deepEqual(res.body, { error: 'Failed to list course units' });
        assert.equal(res.headers['Cache-Control'], 'no-store');
        const serialized = JSON.stringify(res.body);
        assert.ok(!serialized.includes('1970'), `epoch=${variant} must not fabricate the epoch`);
        assert.ok(!serialized.includes('null'), `epoch=${variant} must not answer a null date`);
        assert.deepEqual(harness.events, ['begin', 'owner', 'course', 'list', 'rollback', 'release']);
        assert.equal(harness.releaseCount(), 1);
        assert.equal(harness.destroyCount(), 0);
    }
});

test('list: a unit reordered after a page was served can reappear on a later page', async () => {
    // The cursor is a POSITION, not a snapshot: `display_order` is mutable,
    // so a unit moved after the page was served may reappear. The contract
    // promises a deterministic order PER REQUEST and no cross-request
    // snapshot — this regression keeps that promise honest.
    const state = makeState();
    const harness = buildHarness(state);
    const first = await runChain(harness.chain, listReq({ limit: '2' }));
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.units.map((u: any) => u.id), [UNIT_A1, UNIT_A2]);
    assert.equal(first.body.next_cursor, encodeCursor(0, UNIT_A2));

    // A concurrent reorder moves UNIT_A1 behind the cursor position.
    state.units.find(u => u.id === UNIT_A1)!.display_order = 9;

    const second = await runChain(harness.chain, listReq({ limit: '2', cursor: first.body.next_cursor }));
    assert.equal(second.status, 200);
    assert.deepEqual(
        second.body.units.map((u: any) => u.id),
        [UNIT_A3, UNIT_A1],
        'the reordered unit is read again: the cursor is a position, not a snapshot',
    );
    assert.equal(second.body.next_cursor, null, 'the traversal ends after the reordered unit');
});

test('list: a unit reordered before the cursor position is omitted by the later pages', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const first = await runChain(harness.chain, listReq({ limit: '1' }));
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.units.map((u: any) => u.id), [UNIT_A1]);
    assert.equal(first.body.next_cursor, encodeCursor(0, UNIT_A1));

    // A unit that is created or moved BEFORE the cursor position sorts
    // before it and is therefore never read by the remaining pages.
    state.units.push({
        id: 'e1000000-0000-4000-8000-000000000000', course_id: COURSE_A1, name: 'Inserted Later',
        display_order: 0, status: 'active', created_at: stamp(8, 30), updated_at: stamp(8, 30),
    });

    const second = await runChain(harness.chain, listReq({ limit: '10', cursor: first.body.next_cursor }));
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.units.map((u: any) => u.id), [UNIT_A2, UNIT_A3]);
    assert.ok(
        !second.body.units.some((u: any) => u.name === 'Inserted Later'),
        'a unit moved before the cursor is omitted: no cross-request snapshot is promised',
    );
});

test('list: the keyset page is deterministic per request and bounded, with no cross-request snapshot promise', async () => {
    // Two identical requests read the same rows in the same order, and the
    // page never exceeds the requested size.
    const harness = buildHarness(makeState());
    const first = await runChain(harness.chain, listReq({ limit: '2' }));
    const second = await runChain(harness.chain, listReq({ limit: '2' }));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(first.body.units, second.body.units, 'the same rows are read in the same order');
    assert.equal(first.body.next_cursor, second.body.next_cursor);
    assert.equal(first.body.units.length, 2);
    assert.equal(second.body.units.length, 2);
});

test('list: the DTO exposes only the seven documented fields and no tenant column', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, listReq());
    assert.equal(res.status, 200);
    for (const unit of res.body.units) {
        assert.deepEqual(Object.keys(unit), UNIT_DTO_KEYS);
        assert.equal('tenant_id' in unit, false);
        assert.equal('owner_user_id' in unit, false);
        assert.equal('price' in unit, false);
        assert.equal('is_published' in unit, false);
    }
});

test('list: the page size defaults to 25 and the default page never returns more than 25 rows', async () => {
    const state = makeState();
    for (let index = 0; index < 40; index += 1) {
        state.units.push({
            id: `e2000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            course_id: COURSE_A1, name: `Extra ${index}`, display_order: 10 + index, status: 'active',
            created_at: stamp(8, 10), updated_at: stamp(8, 10),
        });
    }
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, listReq());

    assert.equal(res.status, 200);
    assert.equal(res.body.units.length, 25, 'the default page is bounded to 25 rows');
    const last = res.body.units[24];
    assert.equal(res.body.next_cursor, encodeCursor(last.display_order, last.id), 'a full page mints the next cursor');
    const listCall = harness.calls.find(c => squash(c.sql) === LIST_SQL);
    assert.deepEqual(listCall?.params, [COURSE_A1, -1, -1, '', 26]);
});

test('list: an explicit limit is honored and the maximum page size is 100', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, listReq({ limit: '2' }));
    assert.equal(res.status, 200);
    assert.equal(res.body.units.length, 2);
    assert.equal(res.body.next_cursor, encodeCursor(0, UNIT_A2));
    const listCall = harness.calls.find(c => squash(c.sql) === LIST_SQL);
    assert.deepEqual(listCall?.params, [COURSE_A1, -1, -1, '', 3]);

    const maxHarness = buildHarness(makeState());
    const maxRes = await runChain(maxHarness.chain, listReq({ limit: '100' }));
    assert.equal(maxRes.status, 200);
    const maxCall = maxHarness.calls.find(c => squash(c.sql) === LIST_SQL);
    assert.deepEqual(maxCall?.params, [COURSE_A1, -1, -1, '', 101], '100 is the accepted maximum');
});

test('list: an out-of-range or malformed limit is rejected 400 before any database access', async () => {
    const cases = ['0', '101', '1000', 'abc', '-1', '1.5', ' 5', '5 ', '1e2'];
    for (const limit of cases) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, listReq({ limit }));
        assert.equal(res.status, 400, `limit=${limit} must be rejected 400`);
        assert.deepEqual(res.body, { error: 'Invalid course unit list limit' });
        assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.equal(harness.connectionCount(), 0, `limit=${limit} must not open a transaction`);
        assert.deepEqual(harness.calls, []);
    }
});

test('list: a malformed, oversized or non-canonical cursor is rejected 400 before any database access', async () => {
    const cases = ['not-base64!!', 'Zm9v', 'YQ', '', 'a'.repeat(257), encodeCursor(0, 'not-a-uuid'), encodeCursor(0, UNIT_A1) + 'A'];
    for (const cursor of cases) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, listReq({ cursor }));
        assert.equal(res.status, 400, `cursor=${cursor} must be rejected 400`);
        assert.deepEqual(res.body, { error: 'Invalid course unit list cursor' });
        assert.equal(harness.connectionCount(), 0);
        assert.deepEqual(harness.calls, []);
    }
});

test('list: the cursor is opaque and resumes strictly after the last returned row', async () => {
    const harness = buildHarness(makeState());
    const first = await runChain(harness.chain, listReq({ limit: '2' }));
    assert.deepEqual(first.body.units.map((u: any) => u.id), [UNIT_A1, UNIT_A2]);
    assert.equal(first.body.next_cursor, encodeCursor(0, UNIT_A2));

    const second = buildHarness(makeState());
    const res = await runChain(second.chain, listReq({ limit: '2', cursor: first.body.next_cursor }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.units.map((u: any) => u.id), [UNIT_A3], 'the next page starts after the last returned row');
    assert.equal(res.body.next_cursor, null);

    const listCall = second.calls.find(c => squash(c.sql) === LIST_SQL);
    assert.deepEqual(listCall?.params, [COURSE_A1, 0, 0, UNIT_A2, 3], 'the cursor is a position bound into the course-qualified query');
});

test('list: units that tie on display_order are ordered by the unit id', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, listReq());
    assert.equal(res.status, 200);
    const tied = res.body.units.filter((u: any) => u.display_order === 0);
    assert.deepEqual(tied.map((u: any) => u.id), [UNIT_A1, UNIT_A2], 'the id is the stable tie-breaker');
    assert.equal(tied[0].name, tied[1].name, 'duplicate names are allowed');
});

test('list: a cursor is only a position and never discloses another course', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, listReq({ cursor: encodeCursor(0, UNIT_B1) }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.units.map((u: any) => u.id), [UNIT_A3], 'only the selected course continues after the position');
    assert.equal(res.body.next_cursor, null);
    assert.ok(!JSON.stringify(res.body).includes('Foreign Unit'), 'the foreign unit is never disclosed');
    const listCall = harness.calls.find(c => squash(c.sql) === LIST_SQL);
    assert.deepEqual(listCall?.params, [COURSE_A1, 0, 0, UNIT_B1, 26], 'the course qualification is not replaced by the cursor');
});

test('list: archived units are included for the owner and nothing is published', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, listReq());
    assert.equal(res.status, 200);
    const archived = res.body.units.filter((u: any) => u.status === 'archived');
    assert.deepEqual(archived.map((u: any) => u.id), [UNIT_A3], 'the owner sees the private archived metadata');
    assert.equal('is_published' in res.body, false);
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test('list: a membership instructor is not the owner and is refused 403 without reading a unit', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, listReq({}, COURSE_A1, sign(INSTRUCTOR_A, 'instructor')));
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Forbidden' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(harness.events, ['begin', 'owner', 'rollback', 'release']);
    assert.equal(harness.calls.filter(c => squash(c.sql) === LIST_SQL).length, 0, 'no unit row may be read');
});

test('list: an owner role label without the real owner_user_id is refused 403', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, listReq({}, COURSE_A1, sign(ROLE_OWNER_MEMBER, 'instructor')));
    assert.equal(res.status, 403);
    assert.equal(harness.calls.filter(c => squash(c.sql) === LIST_SQL).length, 0);
});

test('list: the owner of another tenant is refused 403 on the selected tenant', async () => {
    // The principal owns tenant B and is a member of tenant A. The SERVER
    // selected tenant A, and tenant A's real owner is somebody else, so the
    // ownership of another tenant never grants access here.
    const state = makeState();
    state.memberships[OWNER_B] = [TENANT_B, TENANT_A];
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, listReq({}, COURSE_A1, sign(OWNER_B, 'instructor', { tenant_id: TENANT_A })));
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Forbidden' });
    assert.equal(harness.calls.filter(c => squash(c.sql) === LIST_SQL).length, 0);
});

test('list: an inactive tenant is refused 403', async () => {
    const state = makeState();
    state.tenants.find(t => t.id === TENANT_A)!.status = 'suspended';
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, listReq());
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Forbidden' });
});

test('list: an inactive caller row is revoked upstream with 401 before any unit is read', async () => {
    const state = makeState();
    state.users[OWNER_A].is_active = 0;
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, listReq());
    assert.equal(res.status, 401, 'a revoked identity never reaches the unit route');
    assert.equal(harness.connectionCount(), 0);
    assert.deepEqual(harness.calls, []);
});

test('list: a principal without a selected tenant scope is refused 404 before any connection', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, listReq({}, COURSE_A1, sign(NO_SCOPE, 'instructor')));
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Tenant membership not found' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(harness.connectionCount(), 0);
});

test('list: an ambiguous multi-tenant scope without a selection is refused 404', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, listReq({}, COURSE_A1, sign(MULTI, 'instructor')));
    assert.equal(res.status, 404);
    assert.equal(harness.connectionCount(), 0);
});

test('list: the selected scope switch reads only the newly selected tenant', async () => {
    const state = makeState();
    // MULTI is a member of both tenants but owns neither, so the switch is
    // observed through the owner of tenant B selecting tenant B.
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, listReq({}, COURSE_B1, sign(OWNER_B, 'instructor')));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.units.map((u: any) => u.id), [UNIT_B1]);
    const listCall = harness.calls.find(c => squash(c.sql) === LIST_SQL);
    assert.deepEqual(listCall?.params, [COURSE_B1, -1, -1, '', 26], 'the page is scoped to the selected course');
    assert.ok(!JSON.stringify(res.body).includes('Introduction'));
});

test('list: a student is refused 403 and never reads a unit row', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, listReq({}, COURSE_A1, sign(STUDENT, 'student', { student_enrollment_id: 'enrollment-1' })));
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Forbidden' });
    assert.equal(harness.calls.filter(c => squash(c.sql) === LIST_SQL).length, 0);
});

test('list: an admin without a tenant scope is refused 404', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, listReq({}, COURSE_A1, sign(ADMIN, 'admin')));
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Tenant membership not found' });
    assert.equal(harness.connectionCount(), 0);
});

test('list: an unauthenticated request is refused 401 by the upstream middleware', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, listReq({}, COURSE_A1, null));
    assert.equal(res.status, 401);
    assert.equal(harness.connectionCount(), 0);
});

test('every route: a billing-only instructor is refused 403 before any database access', async () => {
    const token = sign(BILLING_ONLY, 'instructor');
    const cases: Array<{ label: string; req: any }> = [
        { label: 'list', req: listReq({}, COURSE_A1, token) },
        { label: 'create', req: createReq({ name: 'Unit' }, COURSE_A1, token) },
        { label: 'update', req: updateReq(UNIT_A1, { name: 'Unit' }, COURSE_A1, token) },
    ];
    for (const entry of cases) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, entry.req);
        assert.equal(res.status, 403, `${entry.label}: billing-only must be refused 403`);
        assert.equal(res.body.code, 'BILLING_ONLY');
        assert.equal(harness.connectionCount(), 0, `${entry.label}: billing-only must not open a transaction`);
        assert.deepEqual(harness.calls, []);
    }
});

test('every route: a client supplied tenant selector is refused 400 by the boundary', async () => {
    const cases: Array<{ label: string; req: any }> = [
        { label: 'list', req: makeReq({ token: ownerToken(), method: 'GET', pathName: unitsPath(COURSE_A1), query: { tenant_id: TENANT_B } }) },
        { label: 'create', req: makeReq({ token: ownerToken(), method: 'POST', pathName: unitsPath(COURSE_A1), body: { name: 'Unit', tenant_id: TENANT_B } }) },
    ];
    for (const entry of cases) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, entry.req);
        assert.equal(res.status, 400, `${entry.label}: a client tenant selector must be refused 400`);
        assert.deepEqual(res.body, { error: 'Tenant context must not be supplied by the client' });
        assert.equal(harness.connectionCount(), 0);
    }
});

test('every route: a malformed course id is refused 400 before any database access', async () => {
    const cases = ['not-a-uuid', '12345', 'a1000000-0000-4000-8000-00000000000'];
    for (const courseId of cases) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, listReq({}, courseId));
        assert.equal(res.status, 400, `courseId=${courseId} must be rejected 400`);
        assert.deepEqual(res.body, { error: 'Invalid course id' });
        assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.equal(harness.connectionCount(), 0);
        assert.deepEqual(harness.calls, []);
    }
});

test('every route: an empty path segment never reaches a unit handler', async () => {
    // '/catalog/courses//units' is not a routable path: the request is not a
    // unit request at all, so no unit handler may answer it and no
    // connection may be opened.
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({ token: ownerToken(), method: 'GET', pathName: '/catalog/courses//units' }));
    assert.equal(res.status, 0, 'no unit handler may answer an unroutable path');
    assert.equal(harness.connectionCount(), 0);
    assert.deepEqual(harness.calls, []);
});

test('list: a foreign, an inactive, a tenant-less and an absent course are the identical 404', async () => {
    const cases = [COURSE_B1, COURSE_A2, COURSE_NULL, ABSENT_COURSE];
    for (const courseId of cases) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, listReq({}, courseId));
        assert.equal(res.status, 404, `courseId=${courseId} must be a 404`);
        assert.deepEqual(res.body, { error: 'Course not found' });
        assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.equal(harness.calls.filter(c => squash(c.sql) === LIST_SQL).length, 0, 'no unit row may be read for an unusable course');
    }
});

// ---------------------------------------------------------------------------
// POST create
// ---------------------------------------------------------------------------

test('create: the owner creates a unit under an active course with one audit event', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, createReq({ name: '  Module One  ', display_order: 3 }));

    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body), ['unit']);
    assert.deepEqual(Object.keys(res.body.unit), UNIT_DTO_KEYS);
    assert.equal(res.body.unit.course_id, COURSE_A1, 'the unit is placed under the course of the path');
    assert.equal(res.body.unit.name, 'Module One', 'the name is stored trimmed');
    assert.equal(res.body.unit.display_order, 3);
    assert.equal(res.body.unit.status, 'active');
    assert.equal(res.body.unit.created_at, '2026-10-19T09:01:00.000Z');
    assert.equal(res.headers['Cache-Control'], 'no-store');

    assert.deepEqual(harness.events, ['begin', 'owner', 'course', 'insert', 'audit', 'select', 'commit', 'release']);
    const ownerCall = harness.calls[0];
    assert.equal(squash(ownerCall.sql), OWNER_LOCK_SELECT, 'the write path locks the owner rows');
    assert.deepEqual(ownerCall.params, [OWNER_A, TENANT_A]);
    const courseCall = harness.calls[1];
    assert.equal(squash(courseCall.sql), COURSE_LOCK_SELECT, 'the write path locks the course row');
    assert.deepEqual(courseCall.params, [COURSE_A1, TENANT_A]);
    const insertCall = harness.calls[2];
    assert.equal(squash(insertCall.sql), INSERT_UNIT_SQL);
    assert.equal(insertCall.params[1], COURSE_A1);
    assert.equal(insertCall.params[2], 'Module One');
    assert.equal(insertCall.params[3], 3);
    assert.equal(insertCall.params[4], 'active');
    assert.match(String(insertCall.params[0]), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'the unit id is server generated');

    assert.equal(harness.auditRows.length, 1);
    const audit = harness.auditRows[0];
    assert.equal(squash(audit.sql), AUDIT_SQL);
    assert.equal(audit.params[1], OWNER_A, 'the actor is the caller');
    assert.equal(audit.params[2], TENANT_A, 'the tenant is the derived selected tenant');
    assert.equal(audit.params[3], 'course.unit_created');
    assert.equal(audit.params[4], 'course_unit');
    assert.equal(audit.params[5], insertCall.params[0], 'the audited resource is the created unit');
    assert.equal(audit.params[6], null);
    assert.deepEqual(JSON.parse(String(audit.params[7])), { course_id: COURSE_A1, name: 'Module One', display_order: 3, status: 'active' });
});

test('create: the display order defaults to 0 and duplicate names are allowed', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, createReq({ name: 'Introduction' }));
    assert.equal(res.status, 201);
    assert.equal(res.body.unit.display_order, 0, 'the order defaults to 0');
    assert.equal(res.body.unit.name, 'Introduction');

    const second = buildHarness(makeState());
    const res2 = await runChain(second.chain, createReq({ name: 'Introduction' }));
    assert.equal(res2.status, 201, 'a duplicate name is allowed');
    assert.notEqual(res2.body.unit.id, res.body.unit.id, 'the id is the identity');
});

test('create: the 255/256 character name boundary is enforced', async () => {
    const ok = buildHarness(makeState());
    const okRes = await runChain(ok.chain, createReq({ name: 'x'.repeat(255) }));
    assert.equal(okRes.status, 201);

    const tooLong = buildHarness(makeState());
    const tooLongRes = await runChain(tooLong.chain, createReq({ name: 'x'.repeat(256) }));
    assert.equal(tooLongRes.status, 400);
    assert.equal(tooLong.connectionCount(), 0);
});

test('create: an invalid payload is refused 400 before any database access', async () => {
    const cases: any[] = [
        {},
        { display_order: 1 },
        { name: 'Unit', status: 'active' },
        { name: 'Unit', course_id: COURSE_B1 },
        { name: 'Unit', owner_user_id: OWNER_A },
        { name: 'Unit', is_published: true },
        { name: 'Unit', price: 10 },
        { name: '' },
        { name: '   ' },
        { name: 42 },
        { name: null },
        { name: 'Unit', display_order: '3' },
        { name: 'Unit', display_order: -1 },
        { name: 'Unit', display_order: 2147483648 },
        { name: 'Unit', display_order: 1.5 },
        { name: 'Unit', display_order: true },
        { name: 'Unit', display_order: null },
        [],
        null,
        'unit',
    ];
    for (const body of cases) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, createReq(body));
        assert.equal(res.status, 400, `body=${JSON.stringify(body)} must be rejected 400`);
        assert.deepEqual(res.body, { error: 'Invalid course unit payload' });
        assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.equal(harness.connectionCount(), 0, `body=${JSON.stringify(body)} must not open a transaction`);
        assert.deepEqual(harness.calls, []);
    }
});

test('create: a non-owner is refused 403 and no unit is written', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, createReq({ name: 'Unit' }, COURSE_A1, sign(INSTRUCTOR_A, 'instructor')));
    assert.equal(res.status, 403);
    assert.deepEqual(harness.events, ['begin', 'owner', 'rollback', 'release']);
    assert.equal(harness.calls.filter(c => squash(c.sql) === INSERT_UNIT_SQL).length, 0);
});

test('create: a foreign, an inactive, a tenant-less and an absent course are the identical 404', async () => {
    const cases = [COURSE_B1, COURSE_A2, COURSE_NULL, ABSENT_COURSE];
    for (const courseId of cases) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, createReq({ name: 'Unit' }, courseId));
        assert.equal(res.status, 404, `courseId=${courseId} must be a 404`);
        assert.deepEqual(res.body, { error: 'Course not found' });
        assert.equal(harness.calls.filter(c => squash(c.sql) === INSERT_UNIT_SQL).length, 0);
    }
});

// ---------------------------------------------------------------------------
// PATCH update
// ---------------------------------------------------------------------------

test('update: the owner renames a unit and the change is audited atomically', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, updateReq(UNIT_A1, { name: 'Foundations' }));

    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ['unit']);
    assert.deepEqual(Object.keys(res.body.unit), UNIT_DTO_KEYS);
    assert.equal(res.body.unit.name, 'Foundations');
    assert.equal(res.body.unit.display_order, 0);
    assert.equal(res.body.unit.status, 'active');
    assert.equal(res.body.unit.updated_at, '2026-10-19T10:00:00.000Z');
    assert.equal(res.headers['Cache-Control'], 'no-store');

    assert.deepEqual(harness.events, ['begin', 'owner', 'course', 'unit', 'update', 'audit', 'select', 'commit', 'release']);
    const ownerCall = harness.calls[0];
    assert.equal(squash(ownerCall.sql), OWNER_LOCK_SELECT);
    const courseCall = harness.calls[1];
    assert.equal(squash(courseCall.sql), COURSE_LOCK_SELECT);
    const unitCall = harness.calls[2];
    assert.equal(squash(unitCall.sql), UNIT_LOCK_SELECT, 'the unit row is locked for the write');
    assert.deepEqual(unitCall.params, [UNIT_A1, COURSE_A1], 'the unit lookup always qualifies the course');
    const updateCall = harness.calls[3];
    assert.equal(squash(updateCall.sql), UPDATE_UNIT_SQL);
    assert.deepEqual(updateCall.params, ['Foundations', 0, 'active', UNIT_A1, COURSE_A1]);

    assert.equal(harness.auditRows.length, 1);
    const audit = harness.auditRows[0];
    assert.equal(audit.params[1], OWNER_A);
    assert.equal(audit.params[2], TENANT_A);
    assert.equal(audit.params[3], 'course.unit_updated');
    assert.equal(audit.params[4], 'course_unit');
    assert.equal(audit.params[5], UNIT_A1);
    assert.deepEqual(JSON.parse(String(audit.params[6])), { course_id: COURSE_A1, name: 'Introduction', display_order: 0, status: 'active' });
    assert.deepEqual(JSON.parse(String(audit.params[7])), { course_id: COURSE_A1, name: 'Foundations', display_order: 0, status: 'active' });
});

test('update: a reordered unit only moves its own position and renumbers nothing', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, updateReq(UNIT_A1, { display_order: 9 }));

    assert.equal(res.status, 200);
    assert.equal(res.body.unit.display_order, 9);
    const updateCalls = harness.calls.filter(c => squash(c.sql) === UPDATE_UNIT_SQL);
    assert.equal(updateCalls.length, 1, 'exactly one unit is updated');
    assert.deepEqual(updateCalls[0].params, ['Introduction', 9, 'active', UNIT_A1, COURSE_A1]);
    const other = state.units.find(u => u.id === UNIT_A3)!;
    assert.equal(other.display_order, 5, 'no other unit is renumbered');
    const audit = harness.auditRows[0];
    assert.deepEqual(JSON.parse(String(audit.params[7])), { course_id: COURSE_A1, name: 'Introduction', display_order: 9, status: 'active' });
});

test('update: a unit can be archived and reactivated', async () => {
    const archived = buildHarness(makeState());
    const archivedRes = await runChain(archived.chain, updateReq(UNIT_A1, { status: 'archived' }));
    assert.equal(archivedRes.status, 200);
    assert.equal(archivedRes.body.unit.status, 'archived');
    assert.deepEqual(archived.calls.find(c => squash(c.sql) === UPDATE_UNIT_SQL)?.params, ['Introduction', 0, 'archived', UNIT_A1, COURSE_A1]);

    const reactivated = buildHarness(makeState());
    const reactivatedRes = await runChain(reactivated.chain, updateReq(UNIT_A3, { status: 'active' }));
    assert.equal(reactivatedRes.status, 200);
    assert.equal(reactivatedRes.body.unit.status, 'active');
});

test('update: an identical update is a truthful no-op with no UPDATE and no audit', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, updateReq(UNIT_A1, { name: 'Introduction', display_order: 0, status: 'active' }));
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.unit), UNIT_DTO_KEYS);
    assert.equal(res.body.unit.name, 'Introduction');
    assert.equal(harness.calls.filter(c => squash(c.sql) === UPDATE_UNIT_SQL).length, 0, 'no UPDATE may be issued');
    assert.equal(harness.auditRows.length, 0, 'no audit event may be written');
    assert.deepEqual(harness.events, ['begin', 'owner', 'course', 'unit', 'rollback', 'release']);
});

test('update: an absent unit and a foreign unit are the identical 404', async () => {
    for (const unitId of [ABSENT_UNIT, UNIT_B1, UNIT_C1]) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, updateReq(unitId, { name: 'Renamed' }));
        assert.equal(res.status, 404, `unitId=${unitId} must be a 404`);
        assert.deepEqual(res.body, { error: 'Course unit not found' });
        assert.equal(harness.calls.filter(c => squash(c.sql) === UPDATE_UNIT_SQL).length, 0);
    }
});

test('update: a unit of another course is not reachable through this course', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, updateReq(UNIT_B1, { name: 'Renamed' }, COURSE_A1));
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Course unit not found' });
    assert.equal(harness.calls.find(c => squash(c.sql) === UNIT_LOCK_SELECT)?.params && true, true);
    const unitCall = harness.calls.find(c => squash(c.sql) === UNIT_LOCK_SELECT);
    assert.deepEqual(unitCall?.params, [UNIT_B1, COURSE_A1]);
});

test('update: an invalid payload is refused 400 before any database access', async () => {
    const cases: any[] = [
        {},
        { name: 'Unit', course_id: COURSE_B1 },
        { name: 'Unit', owner_user_id: OWNER_A },
        { name: 'Unit', published: true },
        { name: 'Unit', price: 5 },
        { name: '' },
        { name: 7 },
        { name: 'Unit', display_order: '4' },
        { name: 'Unit', display_order: -1 },
        { name: 'Unit', display_order: 2147483648 },
        { name: 'Unit', display_order: 2.5 },
        { name: 'Unit', status: 'deleted' },
        { name: 'Unit', status: 'Active' },
        { name: 'Unit', status: 1 },
        [],
        null,
    ];
    for (const body of cases) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, updateReq(UNIT_A1, body));
        assert.equal(res.status, 400, `body=${JSON.stringify(body)} must be rejected 400`);
        assert.deepEqual(res.body, { error: 'Invalid course unit update payload' });
        assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.equal(harness.connectionCount(), 0);
        assert.deepEqual(harness.calls, []);
    }
});

test('update: a malformed unit id is refused 400 before any database access', async () => {
    for (const unitId of ['not-a-uuid', '123']) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, updateReq(unitId, { name: 'Renamed' }));
        assert.equal(res.status, 400, `unitId=${unitId} must be rejected 400`);
        assert.deepEqual(res.body, { error: 'Invalid course unit id' });
        assert.equal(harness.connectionCount(), 0);
    }
});

test('update: a non-owner is refused 403 and no unit is written', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, updateReq(UNIT_A1, { name: 'Renamed' }, COURSE_A1, sign(INSTRUCTOR_A, 'instructor')));
    assert.equal(res.status, 403);
    assert.equal(harness.calls.filter(c => squash(c.sql) === UPDATE_UNIT_SQL).length, 0);
});

// ---------------------------------------------------------------------------
// Transaction, audit and connection lifecycle
// ---------------------------------------------------------------------------

test('failure: a failed connection acquisition answers 500 and cleans up nothing', async () => {
    const state = makeState();
    state.failAcquire = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, listReq()));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to list course units' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 0);
    assert.deepEqual(harness.events, []);
});

test('failure: a failed beginTransaction discards the connection instead of pooling it', async () => {
    const state = makeState();
    state.failBegin = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, listReq()));
    assert.equal(res.status, 500);
    assert.equal(harness.releaseCount(), 0, 'an unconfirmed connection must never be released');
    assert.equal(harness.destroyCount(), 1, 'an unconfirmed connection must be destroyed');
    assert.deepEqual(harness.events, ['begin', 'destroy']);
});

test('failure: a failed owner verification rolls back and releases exactly once', async () => {
    const state = makeState();
    state.failOwnerSelect = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, listReq()));
    assert.equal(res.status, 500);
    assert.deepEqual(harness.events, ['begin', 'owner', 'rollback', 'release']);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(harness.destroyCount(), 0);
});

test('failure: a failed course lookup rolls back and releases exactly once', async () => {
    const state = makeState();
    state.failCourseSelect = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, listReq()));
    assert.equal(res.status, 500);
    assert.deepEqual(harness.events, ['begin', 'owner', 'course', 'rollback', 'release']);
    assert.equal(harness.releaseCount(), 1);
});

test('failure: a failed list read rolls back and releases exactly once', async () => {
    const state = makeState();
    state.failList = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, listReq()));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to list course units' });
    assert.equal(harness.releaseCount(), 1);
    assert.equal(harness.destroyCount(), 0);
});

test('failure: a failed insert rolls back, audits nothing and releases exactly once', async () => {
    const state = makeState();
    state.failInsert = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, createReq({ name: 'Unit' })));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to create course unit' });
    assert.deepEqual(harness.events, ['begin', 'owner', 'course', 'insert', 'rollback', 'release']);
    assert.equal(harness.auditRows.length, 0, 'a failed insert must not be audited');
    assert.equal(harness.releaseCount(), 1);
    assert.equal(harness.destroyCount(), 0);
});

test('failure: a failed audit rolls the write back and reports no success', async () => {
    const state = makeState();
    state.failAudit = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, createReq({ name: 'Unit' })));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to create course unit' });
    assert.deepEqual(harness.events, ['begin', 'owner', 'course', 'insert', 'audit', 'rollback', 'release']);
    assert.equal(harness.releaseCount(), 1);
});

test('failure: a lost commit acknowledgement is an uncertain state: no rollback, no retry, discard', async () => {
    const state = makeState();
    state.failCommit = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, createReq({ name: 'Unit' })));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to create course unit' });
    assert.equal(harness.events.includes('rollback'), false, 'no rollback may be claimed after a commit attempt');
    assert.equal(harness.events.includes('commit'), true);
    assert.equal(harness.releaseCount(), 0, 'an uncertain connection must never be pooled');
    assert.equal(harness.destroyCount(), 1, 'an uncertain connection must be destroyed');
});

test('failure: a lost commit acknowledgement on update is an uncertain state as well', async () => {
    const state = makeState();
    state.failCommit = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, updateReq(UNIT_A1, { name: 'Renamed' })));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to update course unit' });
    assert.equal(harness.events.includes('rollback'), false);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 1);
});

test('failure: a failed rollback on the read path discards the connection and still returns the truthful page', async () => {
    const state = makeState();
    state.failRollback = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, listReq()));
    assert.equal(res.status, 200, 'the read itself succeeded and its result stays truthful');
    assert.equal(res.body.units.length, 3);
    assert.equal(harness.events.includes('release'), false, 'a failed rollback must not release the connection');
    assert.equal(harness.destroyCount(), 1, 'the unconfirmed session must be discarded');
    assert.equal(harness.releaseCount(), 0);
});

test('failure: a failed rollback on a write path discards the connection and never releases it', async () => {
    const state = makeState();
    state.failRollback = true;
    state.affectedRowsOverride = 0;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, updateReq(UNIT_A1, { name: 'Renamed' })));
    assert.equal(res.status, 409, 'the write outcome is unchanged by the cleanup failure');
    assert.equal(harness.events.includes('release'), false, 'a failed rollback must not release the connection');
    assert.equal(harness.destroyCount(), 1);
    assert.equal(harness.releaseCount(), 0);
});

test('failure: a zero-row update answers 409 and audits nothing', async () => {
    const state = makeState();
    state.affectedRowsOverride = 0;
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, updateReq(UNIT_A1, { name: 'Renamed' }));
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'Course unit was modified concurrently' });
    assert.equal(harness.auditRows.length, 0, 'a concurrent modification must not be audited');
    assert.deepEqual(harness.events, ['begin', 'owner', 'course', 'unit', 'update', 'rollback', 'release']);
    assert.equal(harness.releaseCount(), 1);
});

test('failure: a missing read-back row answers 500 and rolls the write back', async () => {
    const state = makeState();
    state.failReadBack = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, createReq({ name: 'Unit' })));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to create course unit' });
    assert.equal(harness.events.includes('commit'), false, 'no commit may follow a missing read-back');
    assert.equal(harness.releaseCount(), 1);
});

test('failure: an unreadable epoch on create fails before the commit and fabricates no date', async () => {
    const variants: MalformedEpoch[] = ['null', 'zero', 'nan', 'text', 'missing'];
    for (const variant of variants) {
        const state = makeState();
        state.malformedEpoch = variant;
        const harness = buildHarness(state);
        const res = await withSilencedErrors(() => runChain(harness.chain, createReq({ name: 'Unit' })));
        assert.equal(res.status, 500, `epoch=${variant} must fail the create`);
        assert.deepEqual(res.body, { error: 'Failed to create course unit' });
        assert.ok(!JSON.stringify(res.body).includes('1970'), `epoch=${variant} must not fabricate the epoch`);
        assert.ok(!JSON.stringify(res.body).includes('null'), `epoch=${variant} must not answer a null date`);
        assert.equal(harness.events.includes('commit'), false, `epoch=${variant} must fail before the commit`);
        assert.equal(harness.events.includes('rollback'), true);
        assert.equal(harness.releaseCount(), 1);
        assert.equal(harness.destroyCount(), 0);
    }
});

test('failure: an unreadable epoch on update fails before the commit and fabricates no date', async () => {
    const variants: MalformedEpoch[] = ['null', 'zero', 'nan', 'text', 'missing'];
    for (const variant of variants) {
        const state = makeState();
        state.malformedEpoch = variant;
        const harness = buildHarness(state);
        const res = await withSilencedErrors(() => runChain(harness.chain, updateReq(UNIT_A1, { name: 'Renamed' })));
        assert.equal(res.status, 500, `epoch=${variant} must fail the update`);
        assert.deepEqual(res.body, { error: 'Failed to update course unit' });
        assert.ok(!JSON.stringify(res.body).includes('1970'), `epoch=${variant} must not fabricate the epoch`);
        assert.ok(!JSON.stringify(res.body).includes('null'), `epoch=${variant} must not answer a null date`);
        assert.equal(harness.events.includes('commit'), false, `epoch=${variant} must fail before the commit`);
        assert.equal(harness.events.includes('rollback'), true);
        assert.equal(harness.releaseCount(), 1);
        assert.equal(harness.destroyCount(), 0);
    }
});

test('failure: an unreadable epoch on a truthful no-op fails instead of answering a null date', async () => {
    const state = makeState();
    state.malformedEpoch = 'null';
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, updateReq(UNIT_A1, { name: 'Introduction', display_order: 0, status: 'active' })));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to update course unit' });
    assert.equal(harness.events.includes('commit'), false);
    assert.equal(harness.calls.filter(c => squash(c.sql) === UPDATE_UNIT_SQL).length, 0, 'a no-op still writes nothing');
    assert.equal(harness.auditRows.length, 0, 'a no-op still audits nothing');
    assert.equal(harness.releaseCount(), 1);
});

test('failure: a failed unit lookup on update rolls back and releases exactly once', async () => {
    const state = makeState();
    state.failUnitSelect = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, updateReq(UNIT_A1, { name: 'Renamed' })));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to update course unit' });
    assert.equal(harness.releaseCount(), 1);
    assert.equal(harness.destroyCount(), 0);
});

// ---------------------------------------------------------------------------
// Response contract
// ---------------------------------------------------------------------------

test('contract: every own outcome carries Cache-Control: no-store and exactly one response', async () => {
    const entries: Array<{ label: string; run: () => Promise<Result> }> = [
        { label: 'list 200', run: async () => runChain(buildHarness(makeState()).chain, listReq()) },
        { label: 'list 400 limit', run: async () => runChain(buildHarness(makeState()).chain, listReq({ limit: '0' })) },
        { label: 'list 404 course', run: async () => runChain(buildHarness(makeState()).chain, listReq({}, ABSENT_COURSE)) },
        { label: 'list 403 owner', run: async () => runChain(buildHarness(makeState()).chain, listReq({}, COURSE_A1, sign(INSTRUCTOR_A, 'instructor'))) },
        { label: 'create 201', run: async () => runChain(buildHarness(makeState()).chain, createReq({ name: 'Unit' })) },
        { label: 'create 400', run: async () => runChain(buildHarness(makeState()).chain, createReq({ name: 'Unit', status: 'x' })) },
        { label: 'update 200', run: async () => runChain(buildHarness(makeState()).chain, updateReq(UNIT_A1, { name: 'Renamed' })) },
        { label: 'update 409', run: async () => {
            const state = makeState();
            state.affectedRowsOverride = 0;
            return runChain(buildHarness(state).chain, updateReq(UNIT_A1, { name: 'Renamed' }));
        } },
        { label: 'update 404', run: async () => runChain(buildHarness(makeState()).chain, updateReq(ABSENT_UNIT, { name: 'Renamed' })) },
        { label: 'list 500', run: async () => {
            const state = makeState();
            state.failList = true;
            return withSilencedErrors(() => runChain(buildHarness(state).chain, listReq()));
        } },
    ];

    for (const entry of entries) {
        const res = await entry.run();
        assert.equal(res.headers['Cache-Control'], 'no-store', `${entry.label}: the no-store directive is required`);
        assert.equal(res.responseCount, 1, `${entry.label}: exactly one response may be produced`);
        assert.equal(res.handlerReached, true, `${entry.label}: the handler must have answered`);
    }
});

// ---------------------------------------------------------------------------
// Migration FILE invariants (read-only inspection, never applied)
// ---------------------------------------------------------------------------

test('migration file: the course_units table is additive, course-derived and was never applied', () => {
    const file = path.resolve(__dirname, '..', 'migrations', '20261019_02_course_units.sql');
    const sql = fs.readFileSync(file, 'utf8');

    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS course_units'), 'the table must be created');
    assert.ok(/FOREIGN KEY \(course_id\) REFERENCES courses\(id\)/.test(sql), 'the course relation must be a foreign key');
    assert.ok(/INDEX idx_course_units_page \(course_id,display_order,id\)/.test(sql), 'the keyset index must exist');
    assert.ok(/display_order INT NOT NULL DEFAULT 0/.test(sql), 'the display order must be a nonnull signed int');
    assert.ok(/CHECK \(display_order >= 0\)/.test(sql), 'the display order must be nonnegative');
    assert.ok(/status ENUM\('active','archived'\) NOT NULL DEFAULT 'active'/.test(sql), 'the status must be an enum of the two values');
    assert.ok(/name VARCHAR\(255\) NOT NULL/.test(sql), 'the name must be bounded');
    assert.ok(/id CHAR\(36\) PRIMARY KEY/.test(sql), 'the id must be the primary key');

    assert.equal(/tenant_id\s+CHAR/i.test(sql), false, 'the tenant must be derived from the course, not duplicated');

    // The destructive-statement checks apply to the executable statements only:
    // the header comment deliberately NAMES the statements the file must not
    // contain, so it is stripped before the check.
    const statements = sql
        .split('\n')
        .filter(line => !line.trim().startsWith('--'))
        .join('\n');
    assert.equal(/ALTER TABLE/i.test(statements), false, 'no existing table may be altered');
    assert.equal(/DROP\s/i.test(statements), false, 'nothing may be dropped');
    assert.equal(/TRUNCATE/i.test(statements), false, 'nothing may be truncated');
    assert.equal(/DELETE FROM/i.test(statements), false, 'no data may be deleted');
    assert.equal(/^INSERT INTO/im.test(statements), false, 'no data may be inserted');
    assert.equal(/^UPDATE\s/im.test(statements), false, 'no data may be updated');
    assert.equal(/lessons|materials|lecture/i.test(statements), false, 'no lesson or material schema may be touched');
    assert.ok(sql.includes('SCHEMA FILE ONLY'), 'the file must state that it was not applied');
});
