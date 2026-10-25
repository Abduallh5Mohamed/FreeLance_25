/**
 * M2-22 — explicit course publication (hermetic, behavioral).
 *
 * Contract under test: `PUT /api/courses/:id/publication` with the strict body
 * `{ publication_state: 'draft' | 'published' }` publishes or withdraws ONE
 * active course of the server-selected tenant, atomically and with exactly one
 * sanitized audit event, and answers a TRUTHFUL no-op when the requested state
 * is already the stored one.
 *
 * Every test here also pins the boundary: publication grants no access, enrolls
 * no student, exposes no lesson/file/price and is NOT reachable through any
 * other course route.
 *
 * Composition under test is the real production order: the real
 * `optionalAuth` over the real principal resolver, the real
 * `requireTeachingWrite('courses')` entitlement guard (with its own documented
 * repository injection point, so the entitlement DECISION stays the real one)
 * and the real router from `src/routes/courses.ts`. Only leaf data boundaries
 * are fixtures: the `src/db` adapters, the entitlement guard's repository and
 * the `src/security/principal-repository` lookups. No express listener, socket,
 * fetch, DB, provider or app startup.
 *
 * The fake transaction BUFFERS the column write and the audit and applies them
 * only at COMMIT, so a rolled-back or uncertain transaction can be proven to
 * leave ZERO partial writes. The read-back overlays the buffered row, exactly
 * as a real transaction sees its own change.
 *
 * Live MySQL row-level locking, real concurrency, real index usage and real HTTP
 * transport are explicitly NOT exercised or claimed. The migration that adds
 * these columns is a FILE and is not applied.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import Module from 'node:module';
import jwt from 'jsonwebtoken';
import type { RequestHandler } from 'express';

const TEST_SECRET = 'm2-22-publication-hermetic-jwt-secret-not-a-real-key';
const originalSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = TEST_SECRET;

// ---------------------------------------------------------------------------
// Positive import interception
// ---------------------------------------------------------------------------

const originalLoad = (Module as any)._load;
const forbiddenCalls: string[] = [];
const unhandledSql: string[] = [];
const interceptionLog: string[] = [];
const normalize = (id: string) => path.resolve(id).toLowerCase();

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const violation = (name: string): never => {
    forbiddenCalls.push(name);
    throw new Error(`HERMETIC_VIOLATION:${name}`);
};

/** The active per-test fixture. Replaced by `buildHarness` before any request. */
const activeFixture: { db: any } = { db: null };
const poolHolder: { pool: any } = { pool: null };

const requireFixture = (kind: string, sql: string): any => {
    if (!activeFixture.db) {
        unhandledSql.push(`no fixture for ${kind}: ${squash(sql)}`);
        throw new Error('HERMETIC_NO_FIXTURE');
    }
    return activeFixture.db;
};

const dbSentinel = {
    query: async (sql: string, params?: any[]) => requireFixture('query', sql).query(sql, params ?? []),
    queryOne: async (sql: string, params?: any[]) => requireFixture('queryOne', sql).queryOne(sql, params ?? []),
    execute: async (sql: string, params?: any[]) => requireFixture('execute', sql).execute(sql, params ?? []),
    testConnection: async (): Promise<any> => violation('db.testConnection'),
    closePool: async (): Promise<any> => violation('db.closePool'),
    getPool: (): any => {
        if (!poolHolder.pool) {
            unhandledSql.push('getPool called without an active pool fixture');
            throw new Error('HERMETIC_NO_POOL');
        }
        return poolHolder.pool;
    },
};

const identityHolder: {
    users: Record<string, any>;
    instructorAccounts: Record<string, any>;
    enrollments: Record<string, any[]>;
    memberships: Record<string, string[]>;
} = { users: {}, instructorAccounts: {}, enrollments: {}, memberships: {} };

const principalRepositorySentinel = {
    defaultPrincipalRepository: {
        findUsersIdentity: async (id: string) => identityHolder.users[id] ?? null,
        findStaffIdentity: async (): Promise<any> => null,
        findInstructorAccount: async (id: string) => identityHolder.instructorAccounts[id] ?? null,
        findStudentEnrollments: async (id: string) => identityHolder.enrollments[id] ?? [],
        findActiveTenantMemberships: async (id: string) =>
            (identityHolder.memberships[id] ?? []).map((tenant_id) => ({ tenant_id })),
    },
};

/**
 * The entitlement guard is real; only its repository seam is injected. The real
 * module is loaded BEFORE the loader hook is installed, and the sentinel
 * re-exports it with `requireTeachingWrite` bound to the per-test fixture — so
 * `evaluateTeachingEntitlement` and the middleware body stay production code.
 */
const realTeachingAccess = require('../src/middleware/teaching-access') as any;
const teachingRepositoryHolder: { repo: any } = { repo: null };

const teachingAccessSentinel = {
    ...realTeachingAccess,
    requireTeachingWrite: (area: string) =>
        realTeachingAccess.createRequireTeachingWrite(area, {
            loadSelectedTenantMembership: async (userId: string, tenantId: string) =>
                teachingRepositoryHolder.repo.loadSelectedTenantMembership(userId, tenantId),
            loadStaffPagePermissions: async () => null,
        }),
};

interface Intercepted { id: string; exports: unknown }
const sentinelByPath = new Map<string, Intercepted>();

const registerSentinel = (specifier: string, exports: unknown) => {
    const id = require.resolve(specifier);
    sentinelByPath.set(normalize(id), { id, exports });
};

registerSentinel('../src/db', dbSentinel);
registerSentinel('../src/security/principal-repository', principalRepositorySentinel);
registerSentinel('../src/middleware/teaching-access', teachingAccessSentinel);

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
let routeModule: any;

installInterception();
try {
    routeModule = require('../src/routes/courses');
} catch (error) {
    loadError = error;
} finally {
    restoreInterception();
}

after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    assert.equal((Module as any)._load, originalLoad, 'the loader hook must be restored after loading');
    assert.deepEqual(forbiddenCalls, [], 'no forbidden default adapter may be called');
    assert.deepEqual(unhandledSql, [], 'every SQL statement must be answered by the fixture');
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

const OWNER_A = 'owner-a';
const INSTRUCTOR_A = 'instructor-a';
const INSTRUCTOR_B = 'instructor-b';
const OUTSIDER_A = 'outsider-a';
const BILLING_ONLY = 'billing-only-instructor';

const COURSE_A1 = '11111111-1111-4111-8111-111111111111';
const COURSE_A2 = '22222222-2222-4222-8222-222222222222';
const COURSE_ARCHIVED = '33333333-3333-4333-8333-333333333333';
const COURSE_B1 = '44444444-4444-4444-8444-444444444444';
const ABSENT_COURSE = '99999999-9999-4999-8999-999999999999';

interface CourseRow {
    id: string;
    tenant_id: string;
    name: string;
    subject: string | null;
    description: string | null;
    grade: string | null;
    price: number;
    is_active: number;
    publication_state: string;
    published_at_epoch: number | null;
    instructor_id: string;
}

interface State {
    users: Record<string, { is_active: number; token_version: number; suspension_active: number }>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    memberships: Record<string, string[]>;
    memberRoles: Record<string, Record<string, string>>;
    tenants: Record<string, { status: string; legacy_compat: number; subscription_entitles: number }>;
    courses: CourseRow[];
    failAcquire: boolean;
    failBegin: boolean;
    failMemberLock: boolean;
    failCourseLock: boolean;
    failUpdate: boolean;
    failAudit: boolean;
    failReadBack: boolean;
    emptyReadBack: boolean;
    failCommit: boolean;
    failRollback: boolean;
    failRelease: boolean;
    failDestroy: boolean;
    affectedRowsOverride: number | null;
    memberLockDenies: boolean;
}

const identity = () => ({ is_active: 1, token_version: 0, suspension_active: 0 });

function makeState(): State {
    return {
        users: {
            [OWNER_A]: identity(),
            [INSTRUCTOR_A]: identity(),
            [INSTRUCTOR_B]: identity(),
            [OUTSIDER_A]: identity(),
            [BILLING_ONLY]: identity(),
        },
        instructorAccounts: {
            [OWNER_A]: { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            [INSTRUCTOR_A]: { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            [INSTRUCTOR_B]: { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            [OUTSIDER_A]: { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            // Live instructor whose tenant is neither legacy-compatible nor
            // entitled: the shared auth marks the principal `billingOnly` and
            // refuses every non-billing path before this handler runs.
            [BILLING_ONLY]: { tenant_status: 'active', legacy_compat: 0, allowed: 0 },
        },
        memberships: {
            [OWNER_A]: [TENANT_A],
            [INSTRUCTOR_A]: [TENANT_A],
            [INSTRUCTOR_B]: [TENANT_B],
            [OUTSIDER_A]: [TENANT_A],
            [BILLING_ONLY]: [TENANT_A],
        },
        memberRoles: {
            [OWNER_A]: { [TENANT_A]: 'owner' },
            [INSTRUCTOR_A]: { [TENANT_A]: 'instructor' },
            [INSTRUCTOR_B]: { [TENANT_B]: 'instructor' },
            [OUTSIDER_A]: { [TENANT_A]: 'student' },
            [BILLING_ONLY]: { [TENANT_A]: 'instructor' },
        },
        tenants: {
            [TENANT_A]: { status: 'active', legacy_compat: 1, subscription_entitles: 1 },
            [TENANT_B]: { status: 'active', legacy_compat: 1, subscription_entitles: 1 },
        },
        courses: [
            {
                id: COURSE_A1, tenant_id: TENANT_A, name: 'Algebra A', subject: 'Math',
                description: 'Full algebra course.', grade: 'Grade 9', price: 250,
                is_active: 1, publication_state: 'draft', published_at_epoch: null, instructor_id: INSTRUCTOR_A,
            },
            {
                id: COURSE_A2, tenant_id: TENANT_A, name: 'Physics B', subject: 'Physics',
                description: 'Published already.', grade: 'Grade 10', price: 300,
                is_active: 1, publication_state: 'published', published_at_epoch: 1793000000, instructor_id: INSTRUCTOR_A,
            },
            {
                id: COURSE_ARCHIVED, tenant_id: TENANT_A, name: 'Archived Course', subject: 'Math',
                description: 'Archived.', grade: 'Grade 9', price: 100,
                is_active: 0, publication_state: 'draft', published_at_epoch: null, instructor_id: INSTRUCTOR_A,
            },
            {
                id: COURSE_B1, tenant_id: TENANT_B, name: 'English B1', subject: 'English',
                description: 'Foreign tenant.', grade: 'Grade 9', price: 400,
                is_active: 1, publication_state: 'draft', published_at_epoch: null, instructor_id: INSTRUCTOR_B,
            },
        ],
        failAcquire: false,
        failBegin: false,
        failMemberLock: false,
        failCourseLock: false,
        failUpdate: false,
        failAudit: false,
        failReadBack: false,
        emptyReadBack: false,
        failCommit: false,
        failRollback: false,
        failRelease: false,
        failDestroy: false,
        affectedRowsOverride: null,
        memberLockDenies: false,
    };
}

interface Call { sql: string; params: any[] }

const MEMBER_LOCK_SELECT =
    'SELECT m.role_key,u.is_active AS caller_active,t.status AS tenant_status FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=? AND m.tenant_id=? AND m.status=\'active\' LIMIT 1 FOR UPDATE';

const COURSE_LOCK_SELECT =
    'SELECT c.id,c.name,c.publication_state,UNIX_TIMESTAMP(c.published_at) AS published_at_epoch FROM courses c WHERE c.id=? AND c.tenant_id=? AND c.is_active=TRUE FOR UPDATE';

const INSTRUCTOR_COURSE_LOCK_SELECT = COURSE_LOCK_SELECT.replace(
    ' FOR UPDATE',
    ' AND c.instructor_id=? FOR UPDATE',
);

const COURSE_PUBLISH_SQL =
    "UPDATE courses SET publication_state='published',published_at=COALESCE(published_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=? AND is_active=TRUE";

const COURSE_UNPUBLISH_SQL =
    "UPDATE courses SET publication_state='draft',published_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=? AND is_active=TRUE";

const COURSE_PUBLICATION_READ_SQL =
    'SELECT c.id,c.name,c.publication_state,UNIX_TIMESTAMP(c.published_at) AS published_at_epoch FROM courses c WHERE c.id=? AND c.tenant_id=? AND c.is_active=TRUE LIMIT 1';

const AUDIT_SQL =
    'INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value) VALUES (?,?,?,?,?,?,?,?)';

/** The accepted legacy update statement, which must never touch publication. */
const LEGACY_UPDATE_PREFIX = 'UPDATE courses SET name=?,subject=?,description=?,grade=?,price=? WHERE id=?';

interface Harness {
    chain: RequestHandler[];
    calls: Call[];
    auditRows: Call[];
    events: string[];
    connectionCount: () => number;
    releaseCount: () => number;
    destroyCount: () => number;
    rollbackCount: () => number;
    commitCount: () => number;
}

function buildHarness(state: State): Harness {
    const calls: Call[] = [];
    const auditRows: Call[] = [];
    const events: string[] = [];
    let connectionCount = 0;
    let releaseCount = 0;
    let destroyCount = 0;
    let rollbackCount = 0;
    let commitCount = 0;

    const hasActiveMembership = (userId: string, tenantId: string) =>
        (state.memberships[userId] ?? []).includes(tenantId);

    const courseById = (id: string) => state.courses.find((row) => row.id === id) ?? null;

    /** Writes staged inside the open transaction, applied only at COMMIT. */
    let pendingUpdate: { id: string; fields: Partial<CourseRow> } | null = null;
    let pendingAudit: Call[] = [];

    /** What the CURRENT transaction sees: the buffered row overlays the stored one. */
    const visible = (row: CourseRow): CourseRow => {
        if (pendingUpdate && pendingUpdate.id === row.id) return { ...row, ...pendingUpdate.fields };
        return row;
    };

    const project = (row: CourseRow) => {
        const effective = visible(row);
        return {
            id: effective.id,
            name: effective.name,
            publication_state: effective.publication_state,
            published_at_epoch: effective.published_at_epoch,
        };
    };

    const connectionExecute = async (sql: string, params: any[]): Promise<[any, any]> => {
        const n = squash(sql);
        calls.push({ sql, params });

        if (n === MEMBER_LOCK_SELECT) {
            events.push('member');
            if (state.failMemberLock) throw new Error('membership lock failed: internal detail leaked');
            const [userId, tenantId] = params.map(String);
            const roleKey = state.memberRoles[userId]?.[tenantId];
            const user = state.users[userId];
            const tenant = state.tenants[tenantId];
            if (!roleKey || !user || !tenant || !hasActiveMembership(userId, tenantId)) return [[], []];
            return [[{
                role_key: state.memberLockDenies ? 'student' : roleKey,
                caller_active: user.is_active,
                tenant_status: tenant.status,
            }], []];
        }

        if (n === COURSE_LOCK_SELECT || n === INSTRUCTOR_COURSE_LOCK_SELECT) {
            events.push('course-lock');
            if (state.failCourseLock) throw new Error('course lock failed: internal detail leaked');
            const [courseId, tenantId] = params.map(String);
            const row = courseById(courseId);
            const instructorId = params.length > 2 ? String(params[2]) : null;
            if (!row || row.is_active !== 1 || row.tenant_id !== tenantId
                || (instructorId !== null && row.instructor_id !== instructorId)) return [[], []];
            return [[project(row)], []];
        }

        if (n === COURSE_PUBLISH_SQL || n === COURSE_UNPUBLISH_SQL) {
            events.push(n === COURSE_PUBLISH_SQL ? 'publish' : 'unpublish');
            if (state.failUpdate) throw new Error('ER_LOCK_DEADLOCK: update on courses failed');
            const [courseId, tenantId] = params.map(String);
            const existing = courseById(courseId);
            const affected = state.affectedRowsOverride ?? 1;
            if (existing && affected === 1 && existing.tenant_id === tenantId && existing.is_active === 1) {
                pendingUpdate = {
                    id: existing.id,
                    fields: n === COURSE_PUBLISH_SQL
                        ? {
                            publication_state: 'published',
                            published_at_epoch: existing.published_at_epoch ?? 1793100000,
                        }
                        : { publication_state: 'draft', published_at_epoch: null },
                };
            }
            return [{ affectedRows: affected }, []];
        }

        if (n === COURSE_PUBLICATION_READ_SQL) {
            events.push('read');
            if (state.failReadBack) throw new Error('read-back failed: internal detail leaked');
            if (state.emptyReadBack) return [[], []];
            const row = courseById(String(params[0]));
            return [row ? [project(row)] : [], []];
        }

        if (n === AUDIT_SQL) {
            events.push('audit');
            if (state.failAudit) throw new Error('audit_events insert failed: internal detail leaked');
            pendingAudit.push({ sql, params });
            return [{ affectedRows: 1 }, []];
        }

        throw new Error(`Unhandled course SQL in hermetic fixture: ${n}`);
    };

    const makeConnection = () => {
        connectionCount += 1;
        pendingUpdate = null;
        pendingAudit = [];
        return {
            beginTransaction: async () => {
                events.push('begin');
                if (state.failBegin) throw new Error('begin failed: internal detail leaked');
            },
            execute: connectionExecute,
            commit: async () => {
                events.push('commit');
                commitCount += 1;
                if (state.failCommit) throw new Error('commit acknowledgement lost: internal detail leaked');
                if (pendingUpdate) {
                    const row = state.courses.find((item) => item.id === pendingUpdate!.id);
                    if (row) Object.assign(row, pendingUpdate.fields);
                }
                for (const row of pendingAudit) auditRows.push(row);
                pendingUpdate = null;
                pendingAudit = [];
            },
            rollback: async () => {
                events.push('rollback');
                rollbackCount += 1;
                if (state.failRollback) throw new Error('rollback failed: internal detail leaked');
                pendingUpdate = null;
                pendingAudit = [];
            },
            release: () => {
                events.push('release');
                releaseCount += 1;
                if (state.failRelease) throw new Error('release failed: internal detail leaked');
            },
            destroy: () => {
                events.push('destroy');
                destroyCount += 1;
                if (state.failDestroy) throw new Error('destroy failed: internal detail leaked');
            },
        };
    };

    poolHolder.pool = {
        getConnection: async () => {
            if (state.failAcquire) throw new Error('pool connection unavailable: internal detail leaked');
            return makeConnection();
        },
    };

    /** The non-transactional adapters the accepted legacy handlers use. */
    activeFixture.db = {
        query: async (sql: string, params: any[]) => {
            const n = squash(sql);
            calls.push({ sql, params });
            if (n.startsWith('SELECT * FROM courses WHERE is_active=TRUE')) {
                const tenantScoped = n.includes('AND tenant_id=?');
                const tenantId = tenantScoped ? String(params[0]) : null;
                return state.courses
                    .filter((row) => row.is_active === 1 && (tenantId === null || row.tenant_id === tenantId))
                    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            }
            throw new Error(`Unhandled course query in hermetic fixture: ${n}`);
        },
        queryOne: async (sql: string, params: any[]) => {
            const n = squash(sql);
            calls.push({ sql, params });
            if (n === 'SELECT * FROM courses WHERE id = ?') {
                return courseById(String(params[0]));
            }
            if (n.startsWith('SELECT * FROM courses WHERE courses.id=? AND courses.tenant_id=?')) {
                const [courseId, tenantId, actorId] = params.map(String);
                const row = courseById(courseId);
                if (!row || row.tenant_id !== tenantId) return null;
                const role = state.memberRoles[actorId]?.[tenantId];
                return role === 'owner' || (role === 'instructor' && row.instructor_id === actorId) ? row : null;
            }
            if (n.startsWith('SELECT t.id FROM tenants t INNER JOIN users u ON u.id=t.owner_user_id')) {
                const [tenantId, userId] = params.map(String);
                return tenantId === TENANT_A && userId === OWNER_A ? { id: TENANT_A } : null;
            }
            throw new Error(`Unhandled course queryOne in hermetic fixture: ${n}`);
        },
        execute: async (sql: string, params: any[]) => {
            const n = squash(sql);
            calls.push({ sql, params });
            if (n.startsWith(LEGACY_UPDATE_PREFIX)) {
                events.push('legacy-update');
                const [name, subject, description, grade, price, id] = params;
                const row = courseById(String(id));
                if (!row) return { affectedRows: 0 };
                // Deliberately touches ONLY the five accepted columns.
                row.name = String(name);
                row.subject = subject === null ? null : String(subject);
                row.description = description === null ? null : String(description);
                row.grade = grade === null ? null : String(grade);
                row.price = Number(price);
                return { affectedRows: 1 };
            }
            throw new Error(`Unhandled course execute in hermetic fixture: ${n}`);
        },
    };

    identityHolder.users = state.users;
    identityHolder.instructorAccounts = state.instructorAccounts;
    identityHolder.memberships = state.memberships;

    teachingRepositoryHolder.repo = {
        loadSelectedTenantMembership: async (userId: string, tenantId: string) => {
            const roleKey = state.memberRoles[userId]?.[tenantId];
            const user = state.users[userId];
            const tenant = state.tenants[tenantId];
            if (!roleKey || !user || !tenant || !hasActiveMembership(userId, tenantId)) return null;
            return {
                role_key: roleKey,
                user_is_active: user.is_active,
                tenant_status: tenant.status,
                tenant_legacy_compat: tenant.legacy_compat,
                subscription_entitles: tenant.subscription_entitles,
            };
        },
        loadStaffPagePermissions: async () => null,
    };

    return {
        chain: [routeModule.default as RequestHandler],
        calls,
        auditRows,
        events,
        connectionCount: () => connectionCount,
        releaseCount: () => releaseCount,
        destroyCount: () => destroyCount,
        rollbackCount: () => rollbackCount,
        commitCount: () => commitCount,
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
}

function makeReq(opts: ReqOptions = {}) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const pathName = opts.pathName ?? '/';
    return {
        method: opts.method ?? 'GET',
        url: pathName,
        originalUrl: `/api/courses${pathName === '/' ? '' : pathName}`,
        path: pathName,
        headers,
        query: opts.query ?? {},
        // An explicitly supplied body is preserved verbatim — including `null`,
        // `[]` and primitives — because `express.json()` would hand the handler
        // exactly that value. Only an OMITTED body defaults to `{}`.
        body: 'body' in opts ? opts.body : {},
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
            set(name: string, value: string) { headers[name.toLowerCase()] = value; return res; },
            setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return res; },
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

const sign = (id: string, role: string, extra: Record<string, unknown> = {}) =>
    jwt.sign({ id, role, tv: 0, ...extra }, TEST_SECRET, { expiresIn: '5m' });

/** A verified instructor of tenant A: the scope the route derives from the token. */
const instructorToken = (extra: Record<string, unknown> = {}) =>
    sign(INSTRUCTOR_A, 'instructor', { tenant_id: TENANT_A, ...extra });

const withState = async <T>(mutate: (state: State) => void, fn: (state: State) => Promise<T>): Promise<T> => {
    const state = makeState();
    mutate(state);
    return fn(state);
};

const courseOf = (state: State, id: string): CourseRow | undefined =>
    state.courses.find((row) => row.id === id);

const publicationPath = (courseId: string) => `/${courseId}/publication`;

const publicationReq = (
    courseId: string,
    body: any,
    token = instructorToken(),
) => makeReq({ token, method: 'PUT', pathName: publicationPath(courseId), body });

const DTO_KEYS = ['course_id', 'publication_state', 'published_at'].sort();

const withSilencedErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = () => undefined;
    try { return await fn(); } finally { console.error = original; }
};

// ---------------------------------------------------------------------------
// Import isolation — positive evidence
// ---------------------------------------------------------------------------

test('import isolation: forbidden module bodies never evaluate, no dummy env', () => {
    assert.equal(loadError, null, `application modules must load through the sentinels: ${String(loadError)}`);
    assert.equal(process.env.MINIO_ACCESS_KEY, undefined);
    assert.equal(process.env.MINIO_SECRET_KEY, undefined);
    assert.equal(process.env.DB_HOST, undefined);

    for (const specifier of ['../src/db', '../src/security/principal-repository']) {
        const intercepted = sentinelByPath.get(normalize(require.resolve(specifier)))!;
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
    assert.deepEqual(forbiddenCalls, [], 'no forbidden default adapter may be called');
});

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

test('publish: a draft course becomes published with one sanitized audit', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, publicationReq(COURSE_A1, { publication_state: 'published' }));

        assert.equal(result.status, 200);
        assert.deepEqual(Object.keys(result.body).sort(), DTO_KEYS, 'exactly the three documented fields');
        assert.equal(result.body.course_id, COURSE_A1);
        assert.equal(result.body.publication_state, 'published');
        assert.equal(result.body.published_at, new Date(1793100000 * 1000).toISOString());

        assert.deepEqual(harness.events, ['begin', 'member', 'course-lock', 'publish', 'audit', 'read', 'commit', 'release']);
        assert.equal(harness.commitCount(), 1);
        assert.equal(harness.rollbackCount(), 0);

        assert.equal(harness.auditRows.length, 1, 'exactly ONE audit event');
        const [id, actor, tenant, action, resourceType, resourceId, oldValue, newValue] = harness.auditRows[0].params;
        assert.equal(typeof id, 'string');
        assert.equal(actor, INSTRUCTOR_A);
        assert.equal(tenant, TENANT_A);
        assert.equal(action, 'course.published');
        assert.equal(resourceType, 'course');
        assert.equal(resourceId, COURSE_A1);
        assert.deepEqual(JSON.parse(oldValue), { publication_state: 'draft' });
        assert.deepEqual(JSON.parse(newValue), { publication_state: 'published' });

        const text = `${oldValue}${newValue}`;
        for (const forbidden of ['Algebra A', 'Math', '250', 'Full algebra', 'Grade 9', 'instructor']) {
            assert.equal(text.includes(forbidden), false, `the audit must not carry "${forbidden}"`);
        }

        assert.equal(courseOf(state, COURSE_A1)?.publication_state, 'published');
    });
});

test('publish: publishing an already-published course is a truthful no-op', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const before = courseOf(state, COURSE_A2)!.published_at_epoch;
        const result = await runChain(harness.chain, publicationReq(COURSE_A2, { publication_state: 'published' }));

        assert.equal(result.status, 200);
        assert.equal(result.body.publication_state, 'published');
        assert.equal(
            result.body.published_at,
            new Date(before! * 1000).toISOString(),
            'the ORIGINAL instant is preserved, never re-stamped',
        );
        assert.deepEqual(harness.events, ['begin', 'member', 'course-lock', 'rollback', 'release']);
        assert.equal(harness.auditRows.length, 0, 'a no-op records no audit');
        assert.equal(harness.commitCount(), 0);
        assert.equal(courseOf(state, COURSE_A2)?.published_at_epoch, before, 'the row is untouched');
    });
});

test('unpublish: a published course returns to draft and clears the instant', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, publicationReq(COURSE_A2, { publication_state: 'draft' }));

        assert.equal(result.status, 200);
        assert.equal(result.body.publication_state, 'draft');
        assert.equal(result.body.published_at, null, 'an unpublished course has no publication instant');
        assert.deepEqual(harness.events, ['begin', 'member', 'course-lock', 'unpublish', 'audit', 'read', 'commit', 'release']);

        const [, , , action, , , oldValue, newValue] = harness.auditRows[0].params;
        assert.equal(action, 'course.unpublished');
        assert.deepEqual(JSON.parse(oldValue), { publication_state: 'published' });
        assert.deepEqual(JSON.parse(newValue), { publication_state: 'draft' });
        assert.equal(courseOf(state, COURSE_A2)?.publication_state, 'draft');
    });
});

test('unpublish: unpublishing a draft is a truthful no-op', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, publicationReq(COURSE_A1, { publication_state: 'draft' }));

        assert.equal(result.status, 200);
        assert.equal(result.body.publication_state, 'draft');
        assert.equal(result.body.published_at, null);
        assert.equal(harness.events.includes('unpublish'), false, 'no UPDATE is issued');
        assert.equal(harness.auditRows.length, 0);
    });
});

test('publish: a second publish after an unpublish stamps a NEW instant', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        await runChain(harness.chain, publicationReq(COURSE_A2, { publication_state: 'draft' }));
        const republished = await runChain(harness.chain, publicationReq(COURSE_A2, { publication_state: 'published' }));

        assert.equal(republished.status, 200);
        assert.equal(republished.body.publication_state, 'published');
        assert.equal(
            republished.body.published_at,
            new Date(1793100000 * 1000).toISOString(),
            'the withdrawal cleared the instant, so the new publication stamps a fresh one',
        );
    });
});

// ---------------------------------------------------------------------------
// Strict payload and selector
// ---------------------------------------------------------------------------

test('payload: every malformed body is rejected before any connection', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const cases: Array<[any, string]> = [
            [null, 'Invalid publication payload'],
            [[], 'Invalid publication payload'],
            ['published', 'Invalid publication payload'],
            [{}, 'Invalid publication payload'],
            [{ publication_state: 'published', tenant_id: TENANT_B }, 'Invalid publication payload'],
            [{ publication_state: 'published', instructor_id: INSTRUCTOR_B }, 'Invalid publication payload'],
            [{ publication_state: 'published', published_at: '2020-01-01' }, 'Invalid publication payload'],
            [{ publication_state: 'published', is_active: false }, 'Invalid publication payload'],
            [{ publication_state: 'published', price: 0 }, 'Invalid publication payload'],
            [{ publication_state: 'unpublished' }, 'Invalid publication state'],
            [{ publication_state: 'archived' }, 'Invalid publication state'],
            [{ publication_state: '' }, 'Invalid publication state'],
            [{ publication_state: null }, 'Invalid publication state'],
            [{ publication_state: 5 }, 'Invalid publication state'],
            [{ publication_state: true }, 'Invalid publication state'],
        ];
        for (const [body, error] of cases) {
            const result = await runChain(harness.chain, publicationReq(COURSE_A1, body));
            assert.equal(result.status, 400, `body ${JSON.stringify(body)} must be rejected`);
            assert.deepEqual(result.body, { error });
        }
        assert.equal(harness.connectionCount(), 0, 'no connection is taken for a malformed payload');
        assert.equal(courseOf(state, COURSE_A1)?.publication_state, 'draft', 'nothing is written');
    });
});

test('selector: a malformed course id is a 404 before any connection', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        for (const courseId of ['abc', '11111111-1111-4111-8111', 'x'.repeat(40)]) {
            const result = await runChain(harness.chain, publicationReq(courseId, { publication_state: 'published' }));
            assert.equal(result.status, 404);
            assert.deepEqual(result.body, { error: 'Course not found' });
        }
        assert.equal(harness.connectionCount(), 0);
    });
});

// ---------------------------------------------------------------------------
// Authority and tenant isolation
// ---------------------------------------------------------------------------

test('authority: an unauthenticated caller never reaches the handler', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, publicationReq(COURSE_A1, { publication_state: 'published' }, null as any));

        assert.equal(result.status, 401);
        assert.equal(harness.connectionCount(), 0);
        assert.equal(courseOf(state, COURSE_A1)?.publication_state, 'draft');
    });
});

test('authority: a student of the tenant is refused before any transaction', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(
            harness.chain,
            publicationReq(COURSE_A1, { publication_state: 'published' }, sign(OUTSIDER_A, 'student', { tenant_id: TENANT_A })),
        );

        assert.equal(result.status, 403);
        assert.equal(harness.connectionCount(), 0, 'the entitlement guard refuses before the handler runs');
        assert.equal(courseOf(state, COURSE_A1)?.publication_state, 'draft');
    });
});

test('authority: a billing-only instructor is refused before any transaction', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(
            harness.chain,
            publicationReq(COURSE_A1, { publication_state: 'published' }, sign(BILLING_ONLY, 'instructor', { tenant_id: TENANT_A })),
        );

        assert.equal(result.status, 403);
        assert.equal(harness.connectionCount(), 0);
        assert.equal(courseOf(state, COURSE_A1)?.publication_state, 'draft');
    });
});

test('authority: a denied membership lock rolls back before the course is touched', async () => {
    await withState((state) => { state.memberLockDenies = true; }, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, publicationReq(COURSE_A1, { publication_state: 'published' }));

        assert.equal(result.status, 403);
        assert.deepEqual(result.body, { error: 'Teaching access is not active for the selected tenant' });
        assert.deepEqual(harness.events, ['begin', 'member', 'rollback', 'release']);
        assert.equal(harness.events.includes('course-lock'), false, 'the course is never locked after a denial');
        assert.equal(courseOf(state, COURSE_A1)?.publication_state, 'draft');
    });
});

test('isolation: a foreign tenant, an archived course and an absent id are ONE 404', async () => {
    await withState(() => undefined, async (state) => {
        for (const courseId of [COURSE_B1, COURSE_ARCHIVED, ABSENT_COURSE]) {
            const harness = buildHarness(state);
            const result = await runChain(harness.chain, publicationReq(courseId, { publication_state: 'published' }));

            assert.equal(result.status, 404, `${courseId} must not be writable from tenant A`);
            assert.deepEqual(result.body, { error: 'Course not found' });
            assert.equal(harness.auditRows.length, 0);
            assert.equal(harness.commitCount(), 0);
        }
        assert.equal(courseOf(state, COURSE_B1)?.publication_state, 'draft', 'the foreign course is untouched');
    });
});

test('isolation: an instructor of another tenant cannot publish through their own token', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(
            harness.chain,
            publicationReq(COURSE_A1, { publication_state: 'published' }, sign(INSTRUCTOR_B, 'instructor', { tenant_id: TENANT_B })),
        );

        assert.equal(result.status, 404, 'the course is invisible from tenant B');
        assert.deepEqual(result.body, { error: 'Course not found' });
        assert.equal(courseOf(state, COURSE_A1)?.publication_state, 'draft');
    });
});

test('isolation: the owner of the tenant may publish', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(
            harness.chain,
            publicationReq(COURSE_A1, { publication_state: 'published' }, sign(OWNER_A, 'instructor', { tenant_id: TENANT_A })),
        );

        assert.equal(result.status, 200);
        assert.equal(courseOf(state, COURSE_A1)?.publication_state, 'published');
    });
});

// ---------------------------------------------------------------------------
// Concurrency and failure paths — zero partial writes
// ---------------------------------------------------------------------------

const snapshot = (state: State) => JSON.stringify(state.courses);

interface Attempt {
    result: Result;
    state: State;
    harness: Harness;
    before: string;
}

const attempt = async (flags: Partial<State>, courseId = COURSE_A1, body: any = { publication_state: 'published' }): Promise<Attempt> => {
    const state = makeState();
    Object.assign(state, flags);
    const before = snapshot(state);
    const harness = buildHarness(state);
    const result = await withSilencedErrors(() => runChain(harness.chain, publicationReq(courseId, body)));
    return { result, state, harness, before };
};

const assertNoPartialWrite = ({ state, harness, before }: Attempt) => {
    assert.equal(snapshot(state), before, 'no course row may be created, changed or removed');
    assert.equal(harness.auditRows.length, 0, 'no audit event may be recorded');
};

const assertOpaque = (body: any) => {
    const text = JSON.stringify(body);
    for (const forbidden of ['ER_LOCK', 'deadlock', 'internal detail', 'leaked', 'stack', 'courses', 'audit_events', 'mysql']) {
        assert.equal(
            text.toLowerCase().includes(forbidden.toLowerCase()),
            false,
            `a failure body must not carry "${forbidden}" (body: ${text})`,
        );
    }
    assert.deepEqual(Object.keys(body), ['error'], 'a failure body carries exactly one field');
};

const SAVE_FAILED = { error: 'Failed to update course publication' };

test('failure: affectedRows 0 is a 409 conflict and writes nothing', async () => {
    const a = await attempt({ affectedRowsOverride: 0 });

    assert.equal(a.result.status, 409);
    assert.deepEqual(a.result.body, { error: 'Course was modified concurrently' });
    assert.equal(a.harness.events.includes('audit'), false, 'a conflict records no audit');
    assert.deepEqual(a.harness.events.slice(-2), ['rollback', 'release']);
    assertNoPartialWrite(a);
});

test('failure: a failed update rolls back and records no audit', async () => {
    const a = await attempt({ failUpdate: true });

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assertOpaque(a.result.body);
    assert.deepEqual(a.harness.events, ['begin', 'member', 'course-lock', 'publish', 'rollback', 'release']);
    assertNoPartialWrite(a);
});

test('failure: a failed audit discards the buffered publication', async () => {
    const a = await attempt({ failAudit: true });

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assert.deepEqual(a.harness.events, ['begin', 'member', 'course-lock', 'publish', 'audit', 'rollback', 'release']);
    assertNoPartialWrite(a);
    assert.equal(courseOf(a.state, COURSE_A1)?.publication_state, 'draft', 'the write did not survive the rollback');
});

test('failure: a failed read-back rolls back the change it just made', async () => {
    const a = await attempt({ failReadBack: true });

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assert.deepEqual(a.harness.events, ['begin', 'member', 'course-lock', 'publish', 'audit', 'read', 'rollback', 'release']);
    assertNoPartialWrite(a);
});

test('failure: an empty read-back is refused rather than answered with a fabricated row', async () => {
    const a = await attempt({ emptyReadBack: true });

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assert.equal(a.result.body.course_id, undefined);
    assertNoPartialWrite(a);
});

test('failure: an uncertain commit destroys the connection and claims no rollback', async () => {
    const a = await attempt({ failCommit: true });

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assert.equal(a.harness.commitCount(), 1, 'the commit was attempted');
    assert.equal(a.harness.rollbackCount(), 0, 'a lost acknowledgement must never be reported as rolled back');
    assert.equal(a.harness.destroyCount(), 1);
    assert.equal(a.harness.releaseCount(), 0, 'an uncertain connection is never returned to the pool');
    assert.deepEqual(a.harness.events, ['begin', 'member', 'course-lock', 'publish', 'audit', 'read', 'commit', 'destroy']);
    assertNoPartialWrite(a);
});

test('failure: a failed rollback escalates to destroy', async () => {
    const a = await attempt({ failUpdate: true, failRollback: true });

    assert.equal(a.result.status, 500);
    assert.equal(a.harness.rollbackCount(), 1);
    assert.equal(a.harness.destroyCount(), 1, 'a connection whose rollback failed is discarded');
    assert.equal(a.harness.releaseCount(), 0);
    assertNoPartialWrite(a);
});

test('failure: a failed begin destroys the connection without a rollback', async () => {
    const a = await attempt({ failBegin: true });

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.harness.events, ['begin', 'destroy']);
    assert.equal(a.harness.rollbackCount(), 0);
    assert.equal(a.harness.releaseCount(), 0);
    assertNoPartialWrite(a);
});

test('failure: a failed acquisition answers an opaque 500 and disposes nothing', async () => {
    const a = await attempt({ failAcquire: true });

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assertOpaque(a.result.body);
    assert.equal(a.harness.connectionCount(), 0);
    assert.equal(a.harness.releaseCount(), 0);
    assert.equal(a.harness.destroyCount(), 0);
    assertNoPartialWrite(a);
});

test('failure: a throwing release or destroy never changes the answer', async () => {
    const released = await attempt({ failRelease: true });
    assert.equal(released.result.status, 200, 'a disposal failure must not fail a committed write');
    assert.equal(released.harness.releaseCount(), 1);

    const destroyed = await attempt({ failCommit: true, failDestroy: true });
    assert.equal(destroyed.result.status, 500, 'a throwing destroy is swallowed by the opaque 500');
    assert.equal(destroyed.harness.destroyCount(), 1);
});

test('failure: no path ever releases and destroys the same connection', async () => {
    const cases: Array<Partial<State>> = [
        { failAcquire: true },
        { failBegin: true },
        { failMemberLock: true },
        { failCourseLock: true },
        { failUpdate: true },
        { failAudit: true },
        { failReadBack: true },
        { emptyReadBack: true },
        { failCommit: true },
        { failUpdate: true, failRollback: true },
        { failCommit: true, failDestroy: true },
        { affectedRowsOverride: 0 },
        { memberLockDenies: true },
    ];
    for (const flags of cases) {
        const a = await attempt(flags);
        const disposals = a.harness.events.filter((event) => event === 'release' || event === 'destroy');
        assert.ok(disposals.length <= 1, `at most one disposal for ${JSON.stringify(flags)} (saw ${JSON.stringify(a.harness.events)})`);
        if (flags.failAcquire) {
            assert.equal(disposals.length, 0, 'a connection that was never acquired is never disposed');
        } else {
            assert.equal(disposals.length, 1, `exactly one disposal for ${JSON.stringify(flags)}`);
        }
    }
});

test('failure: a failed member lock or course lock is an opaque 500', async () => {
    for (const flags of [{ failMemberLock: true }, { failCourseLock: true }]) {
        const a = await attempt(flags);
        assert.equal(a.result.status, 500, `flags ${JSON.stringify(flags)}`);
        assert.deepEqual(a.result.body, SAVE_FAILED);
        assertOpaque(a.result.body);
        assertNoPartialWrite(a);
    }
});

test('responses: every outcome carries Cache-Control no-store', async () => {
    const outcomes: Array<Partial<State>> = [
        {},
        { affectedRowsOverride: 0 },
        { failUpdate: true },
        { failAudit: true },
        { failCommit: true },
        { failAcquire: true },
        { memberLockDenies: true },
    ];
    for (const flags of outcomes) {
        const a = await attempt(flags);
        assert.equal(a.result.headers['cache-control'], 'no-store', `flags ${JSON.stringify(flags)} must be uncacheable`);
    }
});

// ---------------------------------------------------------------------------
// The boundary: publication has exactly one write path
// ---------------------------------------------------------------------------

test('boundary: the legacy course update cannot change publication', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(
            harness.chain,
            makeReq({
                token: instructorToken(),
                method: 'PUT',
                pathName: `/${COURSE_A1}`,
                body: { name: 'Renamed', subject: 'Math', publication_state: 'published' },
            }),
        );

        assert.equal(result.status, 200, 'the accepted legacy update still works');
        assert.equal(courseOf(state, COURSE_A1)?.name, 'Renamed', 'it updated what it is allowed to update');
        assert.equal(
            courseOf(state, COURSE_A1)?.publication_state,
            'draft',
            'and it CANNOT publish: publication has exactly one write path',
        );
        assert.equal(harness.auditRows.length, 0, 'the legacy path records no publication audit');
        assert.equal(harness.events.includes('legacy-update'), true);

        const legacyStatement = harness.calls.find((call) => squash(call.sql).startsWith(LEGACY_UPDATE_PREFIX));
        assert.ok(legacyStatement, 'the legacy UPDATE ran');
        assert.equal(
            squash(legacyStatement!.sql).includes('publication'),
            false,
            'the legacy statement never names a publication column',
        );
    });
});

test('boundary: the publication route never writes a private course column', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        await runChain(harness.chain, publicationReq(COURSE_A1, { publication_state: 'published' }));

        const statements = harness.calls.map((call) => squash(call.sql));
        const update = statements.find((sql) => sql.startsWith('UPDATE courses SET publication_state'));
        assert.ok(update, 'the publication UPDATE ran');

        // "Writing a column" is a property of the SET clause. The WHERE clause
        // legitimately qualifies on `tenant_id`, so the two clauses are asserted
        // separately: the SET clause may name only the publication columns, and
        // the WHERE clause must still pin the row to `id` plus the selected
        // tenant while leaving the archive flag alone.
        const whereAt = update!.indexOf(' WHERE ');
        assert.ok(whereAt > 0, 'the publication UPDATE is qualified');
        const setClause = update!.slice('UPDATE courses SET '.length, whereAt);
        for (const forbidden of [
            'name',
            'subject',
            'description',
            'grade',
            'price',
            'is_active',
            'tenant_id',
            'instructor_id',
            'thumbnail_url',
            'duration_months',
        ]) {
            assert.equal(
                setClause.includes(forbidden),
                false,
                `the publication SET clause must not write "${forbidden}"`,
            );
        }
        for (const written of ['publication_state', 'published_at', 'updated_at']) {
            assert.equal(
                setClause.includes(written),
                true,
                `the publication SET clause writes "${written}"`,
            );
        }

        const whereClause = update!.slice(whereAt);
        for (const qualifier of ['id=?', 'tenant_id=?', 'is_active=TRUE']) {
            assert.equal(
                whereClause.includes(qualifier),
                true,
                `the publication WHERE clause still qualifies on "${qualifier}"`,
            );
        }
        assert.equal(
            whereClause.includes('publication_state'),
            false,
            'the publication WHERE clause does not filter on the state it is setting',
        );
        assert.equal(
            statements.some((sql) => sql.includes('audit_events')),
            true,
            'exactly one audit statement runs alongside it',
        );
        assert.equal(
            harness.calls.filter((call) => squash(call.sql) === AUDIT_SQL).length,
            1,
            'and only one',
        );
    });
});
