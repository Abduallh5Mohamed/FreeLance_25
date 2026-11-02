/**
 * M2-22/A composition — the two `/api/public` routers in the REAL mount order.
 *
 * Defect under test (audit 2026-10-26, finding A): `publicIdentityRoutes` was
 * mounted BEFORE `publicCatalogRoutes` on `/api/public`, and the legacy
 * identity router answered `GET /courses` itself with an Array body and an
 * `is_active`-only filter, so drafts leaked and the M2-22
 * `{ courses, next_cursor }` contract was unreachable. A per-router test could
 * never see this: each router is correct alone.
 *
 * This suite composes the REAL route modules under a REAL express Router in
 * the SAME order `server/src/index.ts` mounts them, with only the `src/db`
 * leaf and the identity router's `optionalAuth` intercepted. No database, no
 * network, no listener, no socket, no app startup.
 *
 * Live MySQL, real HTTP transport and real collation are NOT exercised; the
 * fixture models the documented row-level visibility rule explicitly.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import Module from 'node:module';
import { Router } from 'express';

// ---------------------------------------------------------------------------
// Positive import interception — src/db and the identity auth seam never load
// ---------------------------------------------------------------------------

const originalLoad = (Module as any)._load;
const forbiddenCalls: string[] = [];
const interceptionLog: string[] = [];
const normalize = (id: string) => path.resolve(id).toLowerCase();
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const violation = (name: string): never => {
    forbiddenCalls.push(name);
    throw new Error(`HERMETIC_VIOLATION:${name}`);
};

const routesDir = path.resolve(__dirname, '..', 'src', 'routes');
const serverRoot = path.resolve(__dirname, '..');

interface CourseRow {
    id: string;
    tenant_id: string;
    name: string;
    subject: string | null;
    description: string | null;
    grade: string | null;
    is_active: number;
    publication_state: string;
    price: number;
    instructor_id: string;
}

interface TenantRow { id: string; business_name: string; status: string }

const TEACHER_ID = 'dddddddd-1111-4222-8333-444444444444';
const TENANT_ACTIVE = 'aaaaaaaa-0000-4000-8000-00000000000a';
const TENANT_SUSPENDED = 'cccccccc-0000-4000-8000-00000000000c';
const COURSE_PUBLISHED = '10000000-0000-4000-8000-000000000001';
const COURSE_DRAFT = '20000000-0000-4000-8000-000000000002';

const state: { tenants: TenantRow[]; courses: CourseRow[] } = {
    tenants: [
        { id: TENANT_ACTIVE, business_name: 'أكاديمية النور', status: 'active' },
        { id: TENANT_SUSPENDED, business_name: 'Paused Academy', status: 'suspended' },
    ],
    courses: [
        {
            id: COURSE_PUBLISHED, tenant_id: TENANT_ACTIVE, name: 'Algebra A', subject: 'Math',
            description: 'Published course.', grade: 'Grade 9',
            is_active: 1, publication_state: 'published', price: 250, instructor_id: TEACHER_ID,
        },
        {
            id: COURSE_DRAFT, tenant_id: TENANT_ACTIVE, name: 'Draft Physics', subject: 'Physics',
            description: 'Never published.', grade: 'Grade 10',
            is_active: 1, publication_state: 'draft', price: 300, instructor_id: TEACHER_ID,
        },
    ],
};

const executedSql: string[] = [];

/** The documented public visibility rule, modeled row-level. */
const publiclyVisible = (row: CourseRow): boolean => {
    if (row.publication_state !== 'published') return false;
    if (row.is_active !== 1) return false;
    const tenant = state.tenants.find((candidate) => candidate.id === row.tenant_id);
    return !!tenant && tenant.status === 'active';
};

const fakeDb = {
    query: async (sql: string, params?: any[]) => {
        const n = squash(sql);
        executedSql.push(n);
        // Identity router: teacher page courses. The fixture applies the
        // publication/active-tenant gates ONLY when the statement pins them,
        // so removing a gate from the route makes the draft visible here.
        if (n.includes('FROM courses c INNER JOIN tenants ct ON ct.id=c.tenant_id')) {
            const gated = n.includes("c.publication_state='published'")
                && n.includes('c.is_active=1')
                && n.includes("ct.status='active'");
            const teacherId = String(params?.[0] ?? '');
            // The route binds the teacher id twice (instructor_id OR tenant
            // owner); the fixture models the instructor branch, which covers
            // both fixture courses.
            const rows = state.courses.filter((row) => row.instructor_id === teacherId);
            return gated ? rows.filter(publiclyVisible) : rows;
        }
        // Catalog router: the bounded public page (unsearched variant).
        if (n.includes('FROM courses c') && n.includes('ORDER BY c.id ASC LIMIT ?')) {
            const afterId = String(params?.[0] ?? '');
            const limit = Number(params?.[1] ?? 24);
            return state.courses
                .filter(publiclyVisible)
                .sort((a, b) => (a.id < b.id ? -1 : 1))
                .filter((row) => row.id > afterId)
                .slice(0, limit)
                .map((row) => {
                    const tenant = state.tenants.find((candidate) => candidate.id === row.tenant_id)!;
                    return {
                        course_id: row.id, name: row.name, subject: row.subject,
                        description: row.description, grade: row.grade,
                        tenant_id: tenant.id, business_name: tenant.business_name,
                        display_name_ar: null, display_name_en: null, accent_color: null,
                    };
                });
        }
        throw new Error(`Unhandled query in composition fixture: ${n}`);
    },
    queryOne: async (sql: string, params?: any[]) => {
        const n = squash(sql);
        executedSql.push(n);
        if (n.includes('FROM users u WHERE')) {
            return { id: String(params?.[0]), name: 'Teacher A' };
        }
        if (n.includes('FROM tenants t WHERE t.owner_user_id=?')) {
            const tenant = state.tenants.find((candidate) => candidate.business_name === 'أكاديمية النور');
            return tenant ? { id: tenant.id, business_name: tenant.business_name } : null;
        }
        throw new Error(`Unhandled queryOne in composition fixture: ${n}`);
    },
    execute: async (sql: string) => violation('db.execute'),
    testConnection: async () => violation('db.testConnection'),
    closePool: async () => violation('db.closePool'),
    getPool: () => violation('db.getPool'),
};

installInterception();
let identityRouter: any;
let catalogRouter: any;
let loadError: unknown = null;
try {
    identityRouter = require('../src/routes/public-identity').default;
    catalogRouter = require('../src/routes/public-catalog').default;
} catch (error) {
    loadError = error;
} finally {
    restoreInterception();
}

function installInterception() {
    (Module as any)._load = function (request: string, parent: any, isMain: boolean) {
        if (parent && typeof parent.filename === 'string' && parent.filename.startsWith(routesDir)) {
            let resolved: string | null = null;
            try { resolved = Module.createRequire(parent.filename).resolve(request); } catch { resolved = null; }
            if (resolved && normalize(resolved) === normalize(path.join(serverRoot, 'src', 'db.ts'))) {
                interceptionLog.push('db');
                return fakeDb;
            }
            if (request === '../middleware/auth') {
                interceptionLog.push('middleware/auth');
                return { optionalAuth: (_req: any, _res: any, next: any) => next() };
            }
        }
        return originalLoad.apply(this, [request, parent, isMain]);
    };
}
function restoreInterception() { (Module as any)._load = originalLoad; }

after(() => {
    assert.equal((Module as any)._load, originalLoad, 'the loader hook must be restored after loading');
    assert.deepEqual(forbiddenCalls, [], 'no forbidden default adapter may be called');
});

// ---------------------------------------------------------------------------
// The composed application — the exact mount order of server/src/index.ts
// ---------------------------------------------------------------------------

const composeApp = (): Router => {
    const app = Router();
    app.use('/api/public', catalogRouter);
    app.use('/api/public', identityRouter);
    return app;
};

interface Result { status: number; body: any; headers: Record<string, string> }

const run = (app: Router, method: string, url: string, query: any = {}): Promise<Result> =>
    new Promise((resolve, reject) => {
        let settled = false;
        const finish = (result: Result) => { if (!settled) { settled = true; resolve(result); } };
        const headers: Record<string, string> = {};
        const res: any = {
            statusCode: 200,
            status(code: number) { res.statusCode = code; return res; },
            set(name: string, value: string) { headers[name.toLowerCase()] = value; return res; },
            json(payload: any) { finish({ status: res.statusCode, body: payload, headers }); return res; },
            send(payload: any) { finish({ status: res.statusCode, body: payload, headers }); return res; },
            end() { finish({ status: res.statusCode, body: undefined, headers }); return res; },
        };
        const req: any = { method, url, originalUrl: url, headers: {}, query, body: {} };
        (app as any).handle(req, res, (error?: unknown) => {
            if (error) { if (!settled) { settled = true; reject(error); } return; }
            finish({ status: 0, body: undefined, headers });
        });
    });

const listUrl = '/api/public/courses';
const teacherUrl = `/api/public/teachers/${TEACHER_ID}`;

// ---------------------------------------------------------------------------
// Mount order — pinned from the real composition file
// ---------------------------------------------------------------------------

test('mount order: index.ts mounts the M2-22 catalog router BEFORE the identity router', () => {
    const source = fs.readFileSync(path.join(serverRoot, 'src', 'index.ts'), 'utf8');
    const catalogMount = source.indexOf("app.use('/api/public', publicCatalogRoutes)");
    const identityMount = source.indexOf("app.use('/api/public', publicIdentityRoutes)");
    assert.ok(catalogMount >= 0, 'the catalog router must be mounted on /api/public');
    assert.ok(identityMount >= 0, 'the identity router must be mounted on /api/public');
    assert.ok(
        catalogMount < identityMount,
        'the M2-22 catalog router must win the /courses collision: it is mounted first',
    );
});

// ---------------------------------------------------------------------------
// GET /api/public/courses — only the M2-22 handler can ever answer
// ---------------------------------------------------------------------------

test('composition: the course list resolves to the M2-22 catalog handler, never the legacy one', async () => {
    const app = composeApp();
    const before = executedSql.length;
    const result = await run(app, 'GET', listUrl);

    assert.equal(result.status, 200);
    assert.ok(!Array.isArray(result.body), 'the legacy array body must never answer');
    assert.deepEqual(Object.keys(result.body).sort(), ['courses', 'next_cursor'], 'exactly the M2-22 envelope');
    assert.equal(result.headers['cache-control'], 'no-store', 'the M2-22 cache policy applies');

    const listSql = executedSql.slice(before);
    assert.equal(listSql.length, 1, 'exactly one statement serves the list');
    assert.ok(
        listSql[0].includes("c.publication_state='published'"),
        'the answering statement must pin explicit publication',
    );
    for (const statement of listSql) {
        assert.equal(
            statement.includes('LIMIT ? OFFSET ?'),
            false,
            'the legacy offset-paginated discovery statement must never run',
        );
        assert.equal(statement.includes('ORDER BY c.name'), false, 'the legacy name-ordered statement must never run');
    }
});

test('composition: a never-published draft is invisible through the composed mount', async () => {
    const app = composeApp();
    const result = await run(app, 'GET', listUrl);

    assert.equal(result.status, 200);
    const ids = (result.body.courses as Array<{ course_id: string }>).map((row) => row.course_id);
    assert.deepEqual(ids, [COURSE_PUBLISHED], 'the draft (is_active but never published) must not leak');
    const text = JSON.stringify(result.body);
    assert.equal(text.includes('Draft Physics'), false, 'no draft wording may appear');
});

test('composition: the legacy identity discovery route no longer exists', async () => {
    // Structural: even with the catalog router removed, the identity router
    // must decline /courses rather than answering it — the collision cannot be
    // resurrected by reordering mounts alone.
    const identityOnly = Router();
    identityOnly.use('/api/public', identityRouter);
    const result = await run(identityOnly, 'GET', listUrl);
    assert.equal(result.status, 0, 'the identity router must not register a course list at all');
    assert.equal(result.body, undefined);
});

// ---------------------------------------------------------------------------
// GET /api/public/teachers/:id — the identity surface, publication-gated
// ---------------------------------------------------------------------------

test('composition: the teacher page resolves to the identity handler with the publication gate', async () => {
    const app = composeApp();
    const before = executedSql.length;
    const result = await run(app, 'GET', teacherUrl);

    assert.equal(result.status, 200);
    assert.equal((result.body as any).id, TEACHER_ID);
    const courses = (result.body as any).published_courses as Array<{ id: string }>;
    assert.deepEqual(courses.map((row) => row.id), [COURSE_PUBLISHED], 'the teacher page must hide drafts too');

    const statements = executedSql.slice(before);
    const courseStatement = statements.find((entry) => entry.includes('FROM courses c INNER JOIN tenants ct'));
    assert.ok(courseStatement, 'the teacher page course statement must run');
    assert.ok(courseStatement!.includes("c.publication_state='published'"), 'teacher page pins publication');
    assert.ok(courseStatement!.includes("ct.status='active'"), 'teacher page pins an active tenant');
    for (const statement of statements) {
        assert.equal(statement.includes('ORDER BY c.id ASC LIMIT ?'), false, 'the catalog statement must not serve the teacher page');
    }
});

// ---------------------------------------------------------------------------
// Isolation — positive evidence
// ---------------------------------------------------------------------------

test('isolation: the real src/db body never evaluates and no dummy env is set', () => {
    assert.equal(loadError, null, `both routers must load through the sentinels: ${String(loadError)}`);
    assert.equal(process.env.DB_HOST, undefined);
    assert.equal(process.env.MINIO_ACCESS_KEY, undefined);
    assert.ok(interceptionLog.includes('db'), 'the db module must have been intercepted');
    const dbId = normalize(path.join(serverRoot, 'src', 'db.ts'));
    const evaluated = Object.keys((require as any).cache ?? {}).find((key) => normalize(key) === dbId);
    assert.equal(evaluated, undefined, 'the real db module must never be evaluated');
});
