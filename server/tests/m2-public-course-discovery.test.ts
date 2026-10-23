/**
 * M2-22 — anonymous published-course discovery (hermetic, behavioral).
 *
 * Contract under test: `GET /api/public/courses` and
 * `GET /api/public/courses/:courseId` serve ONE bounded page, and ONE exact
 * record, of the FIXED ten-field public projection for courses that are
 * published, active, and belong to an active academy.
 *
 * Every test here also pins the boundary: the surface exposes no lesson, unit,
 * material, file, video, exam, group, student, instructor, contact, price,
 * payment, subscription, membership count, internal status or unpublished row;
 * it schedules nothing; and it grants no access or enrollment.
 *
 * Composition under test is the real router module `src/routes/public-catalog.ts`
 * with ONLY the `src/db` leaf adapter replaced by a fixture. The `src/db`
 * module body is intercepted in the CommonJS loader and proven never to
 * evaluate, so no pool, no connection, no environment variable and no live
 * database is touched. No express listener, socket, fetch, provider or app
 * startup.
 *
 * Live MySQL collation, real LIKE semantics, real index usage and real HTTP
 * transport are explicitly NOT exercised or claimed; the fixture models the
 * documented `utf8mb4_unicode_ci` case-insensitivity explicitly.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import Module from 'node:module';
import type { RequestHandler } from 'express';

// ---------------------------------------------------------------------------
// Positive import interception — the src/db module body never evaluates
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

const activeFixture: { db: any } = { db: null };

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
    getPool: (): any => violation('db.getPool'),
};

interface Intercepted { id: string; exports: unknown }
const sentinelByPath = new Map<string, Intercepted>();

const registerSentinel = (specifier: string, exports: unknown) => {
    const id = require.resolve(specifier);
    sentinelByPath.set(normalize(id), { id, exports });
};

registerSentinel('../src/db', dbSentinel);

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
    routeModule = require('../src/routes/public-catalog');
} catch (error) {
    loadError = error;
} finally {
    restoreInterception();
}

after(() => {
    assert.equal((Module as any)._load, originalLoad, 'the loader hook must be restored after loading');
    assert.deepEqual(forbiddenCalls, [], 'no forbidden default adapter may be called');
    assert.deepEqual(unhandledSql, [], 'every SQL statement must be answered by the fixture');
});

// ---------------------------------------------------------------------------
// Contract SQL (duplicated from the route: this IS the contract under test)
// ---------------------------------------------------------------------------

const PUBLIC_COURSE_PROJECTION =
    'c.id AS course_id,c.name,c.subject,SUBSTRING(c.description,1,600) AS description,c.grade,' +
    't.id AS tenant_id,t.business_name,b.display_name_ar,b.display_name_en,b.accent_color';

const PUBLIC_COURSE_FROM =
    ' FROM courses c' +
    " JOIN tenants t ON t.id=c.tenant_id AND t.status='active'" +
    ' LEFT JOIN tenant_branding b ON b.tenant_id=t.id';

const PUBLIC_COURSE_FILTER = " WHERE c.publication_state='published' AND c.is_active=TRUE";

const PUBLIC_LIST_SQL =
    `SELECT ${PUBLIC_COURSE_PROJECTION}${PUBLIC_COURSE_FROM}${PUBLIC_COURSE_FILTER}` +
    " AND (c.name LIKE ? ESCAPE '!' OR COALESCE(c.subject,'') LIKE ? ESCAPE '!')" +
    ' AND c.id>? ORDER BY c.id ASC LIMIT ?';

const PUBLIC_LIST_SQL_UNSEARCHED =
    `SELECT ${PUBLIC_COURSE_PROJECTION}${PUBLIC_COURSE_FROM}${PUBLIC_COURSE_FILTER}` +
    ' AND c.id>? ORDER BY c.id ASC LIMIT ?';

const PUBLIC_DETAIL_SQL =
    `SELECT ${PUBLIC_COURSE_PROJECTION}${PUBLIC_COURSE_FROM}${PUBLIC_COURSE_FILTER}` +
    ' AND c.id=? LIMIT 1';

/** The exact ten public fields, sorted. Nothing else may ever appear. */
const DTO_KEYS = [
    'course_id', 'name', 'subject', 'description', 'grade',
    'tenant_id', 'business_name', 'display_name_ar', 'display_name_en', 'accent_color',
].sort();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const TENANT_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const TENANT_SUSPENDED = 'cccccccc-0000-4000-8000-00000000000c';

const COURSE_A1 = '10000000-0000-4000-8000-000000000001';
const COURSE_A2 = '20000000-0000-4000-8000-000000000002';
const COURSE_A3 = '30000000-0000-4000-8000-000000000003';
const COURSE_B1 = '40000000-0000-4000-8000-000000000004';
const COURSE_ARCHIVED = '50000000-0000-4000-8000-000000000005';
const COURSE_SUSPENDED = '60000000-0000-4000-8000-000000000006';
const ABSENT_COURSE = '99999999-9999-4999-8999-999999999999';

interface TenantRow { id: string; business_name: string; status: string }

interface BrandingRow {
    tenant_id: string;
    display_name_ar: string | null;
    display_name_en: string | null;
    accent_color: string | null;
}

interface CourseRow {
    id: string;
    tenant_id: string;
    name: string;
    subject: string | null;
    description: string | null;
    grade: string | null;
    is_active: number;
    publication_state: string;
    /** Deliberately present so a row spread would leak it. */
    price: number;
    instructor_id: string;
}

interface State {
    tenants: TenantRow[];
    branding: BrandingRow[];
    courses: CourseRow[];
    failList: boolean;
    failDetail: boolean;
}

function makeState(): State {
    return {
        tenants: [
            { id: TENANT_A, business_name: 'أكاديمية النور', status: 'active' },
            { id: TENANT_B, business_name: 'Bright Academy', status: 'active' },
            { id: TENANT_SUSPENDED, business_name: 'Paused Academy', status: 'suspended' },
        ],
        branding: [
            {
                tenant_id: TENANT_A,
                display_name_ar: 'النور',
                display_name_en: 'Al Noor',
                accent_color: '#0EA5E9',
            },
            // A tenant with no branding row at all: every label inherits.
        ],
        courses: [
            {
                id: COURSE_A1, tenant_id: TENANT_A, name: 'Algebra A', subject: 'Math',
                description: 'Full algebra course.', grade: 'Grade 9',
                is_active: 1, publication_state: 'published', price: 250, instructor_id: 'instructor-a',
            },
            {
                id: COURSE_A2, tenant_id: TENANT_A, name: 'Draft Physics', subject: 'Physics',
                description: 'Not published yet.', grade: 'Grade 10',
                is_active: 1, publication_state: 'draft', price: 300, instructor_id: 'instructor-a',
            },
            {
                id: COURSE_A3, tenant_id: TENANT_A, name: 'Geometry Basics', subject: 'Math',
                description: 'Shapes and proofs.', grade: 'Grade 8',
                is_active: 1, publication_state: 'published', price: 180, instructor_id: 'instructor-a',
            },
            {
                id: COURSE_B1, tenant_id: TENANT_B, name: 'English B1', subject: 'English',
                description: 'Language course.', grade: 'Grade 9',
                is_active: 1, publication_state: 'published', price: 400, instructor_id: 'instructor-b',
            },
            {
                id: COURSE_ARCHIVED, tenant_id: TENANT_A, name: 'Archived Algebra', subject: 'Math',
                description: 'Archived but still published.', grade: 'Grade 9',
                is_active: 0, publication_state: 'published', price: 100, instructor_id: 'instructor-a',
            },
            {
                id: COURSE_SUSPENDED, tenant_id: TENANT_SUSPENDED, name: 'Suspended Course', subject: 'Math',
                description: 'Academy is suspended.', grade: 'Grade 9',
                is_active: 1, publication_state: 'published', price: 150, instructor_id: 'instructor-c',
            },
        ],
        failList: false,
        failDetail: false,
    };
}

/** Undoes the route's `!` escaping so the fixture can compare literally. */
const unescapeLikeTerm = (pattern: string): string => {
    const inner = pattern.replace(/^%/, '').replace(/%$/, '');
    return inner.replace(/!(.)/g, (_match, character) => character);
};

interface Call { sql: string; params: any[] }

interface Harness {
    calls: Call[];
    handlers: { method: string; path: string; middlewareCount: number }[];
}

function buildHarness(state: State): Harness {
    const calls: Call[] = [];

    /** The documented public visibility rule, in one place. */
    const visible = (row: CourseRow): boolean => {
        if (row.publication_state !== 'published') return false;
        if (row.is_active !== 1) return false;
        const tenant = state.tenants.find((candidate) => candidate.id === row.tenant_id);
        return !!tenant && tenant.status === 'active';
    };

    const project = (row: CourseRow) => {
        const tenant = state.tenants.find((candidate) => candidate.id === row.tenant_id)!;
        const branding = state.branding.find((candidate) => candidate.tenant_id === tenant.id) ?? null;
        return {
            course_id: row.id,
            name: row.name,
            subject: row.subject,
            description: row.description === null ? null : row.description.slice(0, 600),
            grade: row.grade,
            tenant_id: tenant.id,
            business_name: tenant.business_name,
            display_name_ar: branding?.display_name_ar ?? null,
            display_name_en: branding?.display_name_en ?? null,
            accent_color: branding?.accent_color ?? null,
        };
    };

    const ordered = () => state.courses
        .filter(visible)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    activeFixture.db = {
        query: async (sql: string, params: any[]) => {
            const n = squash(sql);
            calls.push({ sql, params });
            if (n === PUBLIC_LIST_SQL_UNSEARCHED) {
                if (state.failList) throw new Error('public course list failed: internal detail leaked');
                const [afterId, limit] = params;
                return ordered()
                    .filter((row) => row.id > afterId)
                    .slice(0, Number(limit))
                    .map(project);
            }
            if (n === PUBLIC_LIST_SQL) {
                if (state.failList) throw new Error('public course list failed: internal detail leaked');
                const term = unescapeLikeTerm(String(params[0])).toLowerCase();
                const afterId = params[2];
                const limit = Number(params[3]);
                return ordered()
                    .filter((row) => row.id > afterId)
                    .filter((row) =>
                        row.name.toLowerCase().includes(term) ||
                        (row.subject ?? '').toLowerCase().includes(term))
                    .slice(0, limit)
                    .map(project);
            }
            throw new Error(`Unhandled public query in hermetic fixture: ${n}`);
        },
        queryOne: async (sql: string, params: any[]) => {
            const n = squash(sql);
            calls.push({ sql, params });
            if (n === PUBLIC_DETAIL_SQL) {
                if (state.failDetail) throw new Error('public course detail failed: internal detail leaked');
                const row = ordered().find((candidate) => candidate.id === String(params[0]));
                return row ? project(row) : null;
            }
            throw new Error(`Unhandled public queryOne in hermetic fixture: ${n}`);
        },
        execute: async (sql: string, params: any[]) => {
            const n = squash(sql);
            calls.push({ sql, params });
            throw new Error(`Unhandled public execute in hermetic fixture: ${n}`);
        },
    };

    const stack = (routeModule.default as any).stack as any[];
    const handlers = stack
        .filter((layer) => layer.route)
        .flatMap((layer) => (layer.route.stack as any[]).map((inner) => ({
            method: String(layer.route.methods ? Object.keys(layer.route.methods)[0] : '').toLowerCase(),
            path: String(layer.route.path),
            middlewareCount: (layer.route.stack as any[]).length,
        })))
        .filter((entry) => entry.middlewareCount > 0);

    return { calls, handlers };
}

// ---------------------------------------------------------------------------
// Request/response plumbing (no listener, no socket)
// ---------------------------------------------------------------------------

interface Result { status: number; body: any; headers: Record<string, string>; responseCount: number }

interface ReqOptions {
    method?: string;
    pathName?: string;
    query?: any;
    token?: string | null;
}

function makeReq(opts: ReqOptions = {}) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const pathName = opts.pathName ?? '/';
    return {
        method: opts.method ?? 'GET',
        url: pathName,
        originalUrl: `/api/public${pathName === '/' ? '' : pathName}`,
        path: pathName,
        headers,
        query: opts.query ?? {},
        body: {},
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
            json(payload: any) { responseCount += 1; finish({ status: res.statusCode, body: payload, headers, responseCount }); return res; },
            send(payload: any) { responseCount += 1; finish({ status: res.statusCode, body: payload, headers, responseCount }); return res; },
            end() { responseCount += 1; finish({ status: res.statusCode, body: undefined, headers, responseCount }); return res; },
        };

        const next = (error?: any) => {
            if (error) { if (!settled) { settled = true; reject(error); } return; }
            const middleware = chain[index++];
            if (!middleware) {
                finish({ status: 0, body: undefined, headers, responseCount });
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

const withState = async <T>(mutate: (state: State) => void, fn: (state: State) => Promise<T>): Promise<T> => {
    const state = makeState();
    mutate(state);
    return fn(state);
};

const chain = () => [routeModule.default as RequestHandler];

const listReq = (query: any = {}, token: string | null = null) =>
    makeReq({ method: 'GET', pathName: '/courses', query, token });

const detailReq = (courseId: string, token: string | null = null) =>
    makeReq({ method: 'GET', pathName: `/courses/${courseId}`, token });

const encodeCursor = (id: string) => Buffer.from(id, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const withSilencedErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = () => undefined;
    try { return await fn(); } finally { console.error = original; }
};

// ---------------------------------------------------------------------------
// Import isolation and anonymity — positive evidence
// ---------------------------------------------------------------------------

test('import isolation: the src/db body never evaluates and no dummy env is set', () => {
    assert.equal(loadError, null, `the router must load through the sentinel: ${String(loadError)}`);
    assert.equal(process.env.DB_HOST, undefined);
    assert.equal(process.env.MINIO_ACCESS_KEY, undefined);

    const intercepted = sentinelByPath.get(normalize(require.resolve('../src/db')))!;
    assert.ok(
        interceptionLog.includes(intercepted.id),
        `the loader must have intercepted the db module (recorded: ${JSON.stringify(interceptionLog)})`,
    );
    assert.equal(require.cache[intercepted.id], undefined, 'the db module must never be evaluated');
});

test('anonymity: each public route runs the handler ALONE, with no auth middleware', () => {
    const harness = buildHarness(makeState());

    assert.deepEqual(
        harness.handlers.map((entry) => `${entry.method} ${entry.path}`).sort(),
        ['get /courses', 'get /courses/:courseId'],
        'exactly the two documented public routes exist',
    );
    for (const entry of harness.handlers) {
        assert.equal(
            entry.middlewareCount,
            1,
            `${entry.method} ${entry.path} must have exactly ONE layer: the handler itself (no principal is ever read)`,
        );
    }
});

// ---------------------------------------------------------------------------
// GET /courses — the bounded public page
// ---------------------------------------------------------------------------

test('list: only published, active courses of an active academy are visible', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(chain(), listReq());

        assert.equal(result.status, 200);
        assert.deepEqual(
            result.body.courses.map((row: any) => row.course_id),
            [COURSE_A1, COURSE_A3, COURSE_B1],
            'the draft, the archived course and the suspended academy are all absent',
        );
        assert.equal(result.body.next_cursor, null);
    });
});

test('list: the projection is exactly the ten documented public fields', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(chain(), listReq());

        for (const row of result.body.courses) {
            assert.deepEqual(Object.keys(row).sort(), DTO_KEYS, 'no row may be spread');
        }
        assert.deepEqual(result.body.courses[0], {
            course_id: COURSE_A1,
            name: 'Algebra A',
            subject: 'Math',
            description: 'Full algebra course.',
            grade: 'Grade 9',
            tenant_id: TENANT_A,
            business_name: 'أكاديمية النور',
            display_name_ar: 'النور',
            display_name_en: 'Al Noor',
            accent_color: '#0EA5E9',
        });
    });
});

test('list: no private, price, access or contact value is ever exposed', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(chain(), listReq());

        // Structural: the key set is already pinned, so a leaked column could
        // only appear as a KEY. The values are then checked by identity, which
        // cannot collide with a uuid the way a naive substring test would.
        const forbiddenKeys = [
            'price', 'instructor_id', 'is_active', 'publication_state', 'published_at',
            'tenant_branding', 'tenant_id_owner', 'owner_user_id', 'status', 'created_at',
            'updated_at', 'lessons', 'units', 'materials', 'files', 'students',
        ];
        const forbiddenValues = [250, 180, 400, 100, 150, 300, 'instructor-a', 'instructor-b', 1, 0];
        for (const row of result.body.courses) {
            const keys = Object.keys(row);
            for (const forbidden of forbiddenKeys) {
                assert.equal(keys.includes(forbidden), false, `the projection must not carry a "${forbidden}" key`);
            }
            const values = Object.values(row);
            for (const forbidden of forbiddenValues) {
                assert.equal(values.includes(forbidden), false, `the projection must not carry the value ${String(forbidden)}`);
            }
        }

        // And nothing anywhere in the body names a private surface.
        const text = JSON.stringify(result.body).toLowerCase();
        for (const forbidden of [
            'price', 'instructor', 'lesson', 'material', 'student', 'email', 'phone',
            'owner', 'subscription', 'enrollment', 'payment', 'is_active',
            'publication_state', 'published_at', 'accent_color_override',
        ]) {
            assert.equal(text.includes(forbidden), false, `the public body must not mention "${forbidden}"`);
        }
    });
});

test('list: a missing branding row inherits (null labels) instead of a fabricated default', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(chain(), listReq());

        const english = result.body.courses.find((row: any) => row.course_id === COURSE_B1);
        assert.deepEqual(
            [english.display_name_ar, english.display_name_en, english.accent_color],
            [null, null, null],
            'a tenant with no branding row reports null, never an invented label or colour',
        );
    });
});

test('list: a non-canonical accent colour is reported as null rather than rendered', async () => {
    await withState((state) => {
        state.branding = [{ tenant_id: TENANT_A, display_name_ar: null, display_name_en: null, accent_color: '#0ea5e9' }];
    }, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(chain(), listReq());

        const row = result.body.courses.find((candidate: any) => candidate.course_id === COURSE_A1);
        assert.equal(row.accent_color, null, 'a lowercase accent is not a canonical colour');
    });
});

test('list: the page size defaults to 24 and a full page mints the next cursor', async () => {
    await withState((state) => {
        state.courses = Array.from({ length: 30 }, (_unused, index) => ({
            id: `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            tenant_id: TENANT_A,
            name: `Course ${index}`,
            subject: 'Math',
            description: 'Bounded.',
            grade: 'Grade 9',
            is_active: 1,
            publication_state: 'published',
            price: 100,
            instructor_id: 'instructor-a',
        }));
    }, async (state) => {
        const harness = buildHarness(state);
        const first = await runChain(chain(), listReq());

        assert.equal(first.status, 200);
        assert.equal(first.body.courses.length, 24, 'the documented default page size');
        assert.equal(typeof first.body.next_cursor, 'string');

        const listCall = harness.calls[0];
        assert.deepEqual(listCall.params, ['', 25], 'one extra row is read to learn whether a page follows');
    });
});

test('list: the next page continues from the cursor and the last page closes it', async () => {
    await withState((state) => {
        state.courses = Array.from({ length: 30 }, (_unused, index) => ({
            id: `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            tenant_id: TENANT_A,
            name: `Course ${index}`,
            subject: 'Math',
            description: 'Bounded.',
            grade: 'Grade 9',
            is_active: 1,
            publication_state: 'published',
            price: 100,
            instructor_id: 'instructor-a',
        }));
    }, async (state) => {
        const harness = buildHarness(state);
        const first = await runChain(chain(), listReq());
        const second = await runChain(chain(), listReq({ cursor: first.body.next_cursor }));

        assert.equal(second.status, 200);
        assert.equal(second.body.courses.length, 6, 'the remaining rows');
        assert.equal(second.body.next_cursor, null, 'the last page closes the cursor');

        const firstIds = new Set(first.body.courses.map((row: any) => row.course_id));
        for (const row of second.body.courses) {
            assert.equal(firstIds.has(row.course_id), false, 'no row appears on two pages');
        }

        const secondCall = harness.calls[1];
        assert.equal(
            secondCall.params[0],
            first.body.courses[23].course_id,
            'the cursor is only a POSITION: the last id of the previous page',
        );
    });
});

test('list: a malformed limit or cursor is a bounded 400 before any read', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        for (const query of [
            { limit: '0' }, { limit: '61' }, { limit: 'abc' }, { limit: '1.5' }, { limit: ['1'] },
        ]) {
            const result = await runChain(chain(), listReq(query));
            assert.equal(result.status, 400, `limit ${JSON.stringify(query)} must be refused`);
            assert.deepEqual(result.body, { error: 'Invalid public course list limit' });
        }
        for (const query of [{ cursor: 'not-base64!!' }, { cursor: 'Zm9v' }, { cursor: 5 }]) {
            const result = await runChain(chain(), listReq(query));
            assert.equal(result.status, 400, `cursor ${JSON.stringify(query)} must be refused`);
            assert.deepEqual(result.body, { error: 'Invalid public course list cursor' });
        }
        assert.equal(harness.calls.length, 0, 'no read is attempted for a malformed query');
    });
});

test('list: an over-long search term is a 400 and an empty one is the plain page', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);

        const tooLong = await runChain(chain(), listReq({ q: 'x'.repeat(101) }));
        assert.equal(tooLong.status, 400);
        assert.deepEqual(tooLong.body, { error: 'Invalid public course search term' });

        const blank = await runChain(chain(), listReq({ q: '   ' }));
        assert.equal(blank.status, 200);
        assert.equal(blank.body.courses.length, 3, 'a whitespace-only term is the unfiltered page');
        assert.equal(harness.calls.length, 1, 'the blank term issues the unfiltered statement only');
    });
});

test('list: the search term filters on name and subject and nothing else', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);

        const byName = await runChain(chain(), listReq({ q: 'algebra' }));
        assert.deepEqual(byName.body.courses.map((row: any) => row.course_id), [COURSE_A1]);

        const bySubject = await runChain(chain(), listReq({ q: 'English' }));
        assert.deepEqual(bySubject.body.courses.map((row: any) => row.course_id), [COURSE_B1]);

        const description = await runChain(chain(), listReq({ q: 'Shapes' }));
        assert.deepEqual(
            description.body.courses,
            [],
            'the description is never searched, so it cannot be probed for private wording',
        );

        const draft = await runChain(chain(), listReq({ q: 'Draft Physics' }));
        assert.deepEqual(draft.body.courses, [], 'a search can never surface a draft');

        assert.equal(harness.calls[0].params.length, 4, 'two bound LIKE patterns, the cursor and the limit');
    });
});

test('list: LIKE metacharacters in the term are escaped, not treated as wildcards', async () => {
    await withState((state) => {
        state.courses[0].name = '100% Algebra';
    }, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(chain(), listReq({ q: '100%' }));

        assert.deepEqual(result.body.courses.map((row: any) => row.course_id), [COURSE_A1]);
        assert.equal(
            harness.calls[0].params[0],
            '%100!%%',
            'the percent sign is escaped so the term cannot widen the scan',
        );
    });
});

test('list: an authenticated caller sees byte-identical results to an anonymous one', async () => {
    await withState(() => undefined, async (state) => {
        buildHarness(state);
        const anonymous = await runChain(chain(), listReq());
        const authenticated = await runChain(chain(), listReq({}, 'a-token-that-is-never-read'));

        assert.deepEqual(
            authenticated.body,
            anonymous.body,
            'a presented credential may never widen the public projection',
        );
        assert.equal(authenticated.status, 200);
    });
});

test('list: a read failure is an opaque 500 that echoes nothing internal', async () => {
    await withState((state) => { state.failList = true; }, async (state) => {
        const harness = buildHarness(state);
        const result = await withSilencedErrors(() => runChain(chain(), listReq()));

        assert.equal(result.status, 500);
        assert.deepEqual(result.body, { error: 'Failed to load public courses' });
        assert.equal(JSON.stringify(result.body).includes('leaked'), false);
        assert.equal(result.body.courses, undefined, 'no partial page is returned');
    });
});

test('list: every outcome carries Cache-Control no-store', async () => {
    await withState((state) => { state.failList = true; }, async (state) => {
        buildHarness(state);
        const outcomes = await withSilencedErrors(() => Promise.all([
            runChain(chain(), listReq()),
            runChain(chain(), listReq({ limit: '0' })),
            runChain(chain(), listReq({ cursor: 'x' })),
            runChain(chain(), listReq({ q: 'x'.repeat(101) })),
            runChain(chain(), detailReq(COURSE_A1)),
            runChain(chain(), detailReq(ABSENT_COURSE)),
            runChain(chain(), detailReq('not-a-uuid')),
        ]));
        for (const outcome of outcomes) {
            assert.equal(outcome.headers['cache-control'], 'no-store', `status ${outcome.status} must be uncacheable`);
        }
    });
});

// ---------------------------------------------------------------------------
// GET /courses/:courseId — the exact published record
// ---------------------------------------------------------------------------

test('detail: a published active course is served with the same fixed projection', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(chain(), detailReq(COURSE_A3));

        assert.equal(result.status, 200);
        assert.deepEqual(Object.keys(result.body), ['course']);
        assert.deepEqual(Object.keys(result.body.course).sort(), DTO_KEYS);
        assert.equal(result.body.course.course_id, COURSE_A3);
        assert.equal(result.body.course.name, 'Geometry Basics');
        assert.equal(harness.calls.length, 1);
    });
});

test('detail: a draft, an archived course, a suspended academy and an absent id are ONE 404', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        for (const courseId of [COURSE_A2, COURSE_ARCHIVED, COURSE_SUSPENDED, ABSENT_COURSE]) {
            const result = await runChain(chain(), detailReq(courseId));
            assert.equal(result.status, 404, `${courseId} must not be discoverable`);
            assert.deepEqual(result.body, { error: 'Course not found' });
        }
        assert.equal(harness.calls.length, 4, 'each selector is still one bounded read');
    });
});

test('detail: a malformed id is a 404 before any read', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        for (const courseId of ['abc', '10000000-0000-4000-8000', 'not-a-uuid-but-long-enough-here']) {
            const result = await runChain(chain(), detailReq(courseId));
            assert.equal(result.status, 404, `"${courseId}" must not be a selector`);
            assert.deepEqual(result.body, { error: 'Course not found' });
        }
        assert.equal(harness.calls.length, 0, 'no read is attempted for a malformed id');
    });
});

test('detail: an empty segment collapses to the LIST route and never a detail read', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(chain(), detailReq(''));

        // `/api/public/courses/` is the collection, not a record: Express matches
        // the list route's optional trailing slash. Asserting it here keeps the
        // "no empty id can address a record" property explicit.
        assert.equal(result.status, 200);
        assert.ok(Array.isArray(result.body.courses), 'the trailing-slash URL answers the bounded page');
        assert.equal(result.body.course, undefined, 'and never a single record');
        assert.equal(harness.calls.length, 1);
    });
});

test('detail: a traversal-shaped segment matches no route at all', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(chain(), detailReq('../courses'));

        assert.equal(result.status, 0, 'the router declines the path instead of answering it');
        assert.equal(result.body, undefined);
        assert.equal(harness.calls.length, 0, 'and no statement is ever issued');
    });
});

test('detail: a read failure is an opaque 500', async () => {
    await withState((state) => { state.failDetail = true; }, async (state) => {
        buildHarness(state);
        const result = await withSilencedErrors(() => runChain(chain(), detailReq(COURSE_A1)));

        assert.equal(result.status, 500);
        assert.deepEqual(result.body, { error: 'Failed to load public course' });
        assert.equal(JSON.stringify(result.body).includes('leaked'), false);
    });
});

test('detail: the detail body is identical to the same row inside the list', async () => {
    await withState(() => undefined, async (state) => {
        buildHarness(state);
        const list = await runChain(chain(), listReq());
        const detail = await runChain(chain(), detailReq(COURSE_A1));

        const fromList = list.body.courses.find((row: any) => row.course_id === COURSE_A1);
        assert.deepEqual(detail.body.course, fromList, 'one projection, two endpoints');
    });
});
