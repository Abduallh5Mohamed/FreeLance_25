/**
 * M6 P2 — read-only parent views (hermetic, no MySQL/network).
 *
 * The REAL parent view router and the REAL scoped-token verifier run over an
 * in-memory link/token store and a scripted read-only views store. Every route
 * is authenticated solely by a scoped HMAC token; the verifier re-checks the
 * token record and the link on every request so a revoked/expired link or
 * token denies the next request. No database, provider or network is
 * contacted, and the views store exposes no write path.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { Router } from 'express';
import {
    createParentViewVerifier,
    signParentViewToken,
    verifyParentViewToken,
    type ParentLinkRow,
    type ParentLinksStore,
    type ParentViewClaims,
    type ParentViewTokenRecord,
} from '../src/services/parent-links';
import {
    createParentViewsRouter,
    createSqlParentViewsStore,
    type AttendanceRecordView,
    type ChildSummary,
    type GradeSummary,
    type LessonProgressSummary,
    type ParentViewsDataAccess,
    type ParentViewsStore,
} from '../src/routes/parent-views';
import { invokeRoute, type CapturedResponse } from './helpers/m2-harness';

const VIEW_SECRET = 'm6-parent-view-secret-000123456789abcdef';
const OTHER_SECRET = 'm6-parent-view-secret-999999999999999999';
const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const ENROLLMENT = 'enrollment-1';
const OTHER_ENROLLMENT = 'enrollment-2';
const PARENT = 'parent-user-1';
const LINK_ID = 'link-1';
const JTI = 'jti-1';
const T0 = new Date('2026-10-18T12:00:00.000Z').getTime();
const TTL_MS = 900_000;

interface Clock {
    now(): Date;
}

const makeClock = (): Clock => ({ now: () => new Date(T0) });

interface ViewState {
    links: ParentLinkRow[];
    tokens: ParentViewTokenRecord[];
    children: Map<string, ChildSummary>;
    progress: LessonProgressSummary;
    attendance: AttendanceRecordView[];
    grades: GradeSummary;
    calls: { method: string; tenantId: string; enrollmentId: string; limit?: number }[];
    failWith: Error | null;
}

const makeState = (): ViewState => ({
    links: [],
    tokens: [],
    children: new Map(),
    progress: { courses: [], totals: { completed_lessons: 0, total_lessons: 0 } },
    attendance: [],
    grades: { courses: [] },
    calls: [],
    failWith: null,
});

const makeLinkStore = (state: ViewState): ParentLinksStore => {
    const unused = async (): Promise<never> => { throw new Error('parent-views test: unexpected store call'); };
    return {
        findStudentEnrollmentById: unused,
        findLinkById: unused,
        findLinkByIdScoped: async (tenantId, linkId) =>
            state.links.find((row) => row.id === linkId && row.tenant_id === tenantId) ?? null,
        findLinksByParentUser: unused,
        findActiveLink: unused,
        insertLink: unused,
        revokeLink: unused,
        insertViewToken: unused,
        findViewToken: async (jti) => state.tokens.find((row) => row.jti === jti) ?? null,
        revokeViewToken: unused,
    };
};

const makeViewsStore = (state: ViewState): ParentViewsStore => {
    const guard = (): void => { if (state.failWith) throw state.failWith; };
    return {
        findChildSummary: async (tenantId, enrollmentId) => {
            state.calls.push({ method: 'child', tenantId, enrollmentId });
            guard();
            return state.children.get(enrollmentId) ?? null;
        },
        lessonProgressSummary: async (tenantId, enrollmentId) => {
            state.calls.push({ method: 'progress', tenantId, enrollmentId });
            guard();
            return state.progress;
        },
        attendanceRecords: async (tenantId, enrollmentId, limit) => {
            state.calls.push({ method: 'attendance', tenantId, enrollmentId, limit });
            guard();
            return state.attendance;
        },
        gradeSummary: async (tenantId, enrollmentId) => {
            state.calls.push({ method: 'grades', tenantId, enrollmentId });
            guard();
            return state.grades;
        },
    };
};

interface SeedOptions {
    jti?: string;
    linkId?: string;
    tenantId?: string;
    enrollmentId?: string;
    parentUserId?: string;
    exp?: number;
    linkTenantId?: string;
    linkEnrollmentId?: string;
    linkParentUserId?: string;
    linkStatus?: string;
    linkRevokedAt?: string | Date | null;
    recordExpiresAt?: number;
    recordRevokedAt?: Date | null;
    recordRevokedReason?: string | null;
    omitLink?: boolean;
    omitRecord?: boolean;
    signSecret?: string;
    extra?: (state: ViewState) => void;
}

/**
 * Seed a link + token record, return a signed token, build the router, and run
 * `fn(harness, token)`. Defaults model the happy path; each test overrides
 * exactly one dimension so every denial has a single attributable cause.
 */
const withViews = async <T>(options: SeedOptions, fn: (h: Harness, token: string) => Promise<T>): Promise<T> => {
    const state = makeState();
    const claims: ParentViewClaims = {
        jti: options.jti ?? JTI,
        link_id: options.linkId ?? LINK_ID,
        tenant_id: options.tenantId ?? TENANT,
        student_enrollment_id: options.enrollmentId ?? ENROLLMENT,
        parent_user_id: options.parentUserId ?? PARENT,
        iat: T0,
        exp: options.exp ?? T0 + TTL_MS,
    };
    if (!options.omitLink) {
        state.links.push({
            id: claims.link_id,
            tenant_id: options.linkTenantId ?? claims.tenant_id,
            student_enrollment_id: options.linkEnrollmentId ?? claims.student_enrollment_id,
            parent_user_id: options.linkParentUserId ?? claims.parent_user_id,
            contact_hash: 'hash',
            status: options.linkStatus ?? 'active',
            version: 0,
            revoked_at: options.linkRevokedAt ?? null,
            revoked_by: null,
        });
    }
    if (!options.omitRecord) {
        state.tokens.push({
            jti: claims.jti,
            link_id: claims.link_id,
            tenant_id: claims.tenant_id,
            student_enrollment_id: claims.student_enrollment_id,
            parent_user_id: claims.parent_user_id,
            issued_at: new Date(claims.iat),
            expires_at: new Date(options.recordExpiresAt ?? claims.exp),
            revoked_at: options.recordRevokedAt ?? null,
            revoked_reason: options.recordRevokedReason ?? null,
        });
    }
    options.extra?.(state);
    const token = signParentViewToken(options.signSecret ?? VIEW_SECRET, claims);
    const harness = buildHarness(state);
    return fn(harness, token);
};

interface Harness {
    router: Router;
    state: ViewState;
    setSecret: (secret: string | undefined) => void;
}

const buildHarness = (state: ViewState): Harness => {
    let secret: string | undefined = VIEW_SECRET;
    const verifier = createParentViewVerifier({
        store: makeLinkStore(state),
        getSecret: () => secret,
        now: () => makeClock().now(),
    });
    return {
        router: createParentViewsRouter({ store: makeViewsStore(state), verifier }),
        state,
        setSecret: (value) => { secret = value; },
    };
};

const request = (h: Harness, url: string, token?: string | null, query?: Record<string, string>): Promise<CapturedResponse> =>
    invokeRoute(h.router, { method: 'GET', url, token, query });

const childSummary = (enrollmentId: string): ChildSummary => ({
    enrollment_id: enrollmentId,
    name: `Child ${enrollmentId}`,
    grade: 'Grade 5',
    group: null,
    term: '2026 Term 1',
    enrollment_status: 'active',
    enrolled_at: '2026-09-01T00:00:00.000Z',
});

// ---------------------------------------------------------------------------
// Scoped token primitive
// ---------------------------------------------------------------------------

test('a scoped token round-trips and rejects tampering and a foreign secret', () => {
    const claims: ParentViewClaims = {
        jti: JTI, link_id: LINK_ID, tenant_id: TENANT,
        student_enrollment_id: ENROLLMENT, parent_user_id: PARENT, iat: T0, exp: T0 + TTL_MS,
    };
    const token = signParentViewToken(VIEW_SECRET, claims);
    const parsed = verifyParentViewToken(VIEW_SECRET, token);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.claims, claims);
    assert.equal(verifyParentViewToken(OTHER_SECRET, token).ok, false);
    assert.equal(verifyParentViewToken(VIEW_SECRET, `${token}x`).ok, false);
    assert.equal(verifyParentViewToken(VIEW_SECRET, 'pv1..').ok, false);
    assert.equal(verifyParentViewToken(undefined, token).ok, false);
});

// ---------------------------------------------------------------------------
// Authentication boundary
// ---------------------------------------------------------------------------

test('auth: a missing, malformed or forged token is 401 and never reads storage', async () => {
    await withViews({}, async (h) => {
        assert.equal((await request(h, '/child', null)).statusCode, 401);
        assert.equal((await request(h, '/child', 'not-a-token')).statusCode, 401);
        assert.equal(h.state.calls.length, 0);
    });
    await withViews({ signSecret: OTHER_SECRET }, async (h, forgedToken) => {
        assert.equal((await request(h, '/child', forgedToken)).statusCode, 401);
        assert.equal(h.state.calls.length, 0);
    });
});

test('auth: an unknown token record is 401 and yields no child', async () => {
    await withViews({ omitRecord: true }, async (h, token) => {
        assert.equal((await request(h, '/child', token)).statusCode, 401);
        assert.equal(h.state.calls.length, 0);
    });
});

test('auth: a revoked token record is 401', async () => {
    await withViews({ recordRevokedAt: new Date(T0), recordRevokedReason: 'rotated' }, async (h, token) => {
        assert.equal((await request(h, '/grades', token)).statusCode, 401);
        assert.equal(h.state.calls.length, 0);
    });
});

test('auth: an expired token record is 401', async () => {
    await withViews({ exp: T0 - 1000, recordExpiresAt: T0 - 1000 }, async (h, token) => {
        assert.equal((await request(h, '/child', token)).statusCode, 401);
        assert.equal(h.state.calls.length, 0);
    });
});

test('auth: claims past their own expiry are denied even if the record is live', async () => {
    await withViews({ exp: T0 - 1000, recordExpiresAt: T0 + TTL_MS }, async (h, token) => {
        assert.equal((await request(h, '/child', token)).statusCode, 401);
        assert.equal(h.state.calls.length, 0);
    });
});

test('auth: a revoked link denies the live token', async () => {
    await withViews({ linkStatus: 'revoked', linkRevokedAt: new Date(T0) }, async (h, token) => {
        assert.equal((await request(h, '/child', token)).statusCode, 401);
        assert.equal(h.state.calls.length, 0);
    });
});

test('auth: a foreign-tenant token cannot resolve another tenant link', async () => {
    await withViews({ tenantId: OTHER_TENANT, linkTenantId: TENANT }, async (h, token) => {
        assert.equal((await request(h, '/attendance', token)).statusCode, 401);
        assert.equal(h.state.calls.length, 0);
    });
});

test('auth: an enrollment mismatch between token and link is 401', async () => {
    await withViews({ linkEnrollmentId: OTHER_ENROLLMENT }, async (h, token) => {
        assert.equal((await request(h, '/child', token)).statusCode, 401);
        assert.equal(h.state.calls.length, 0);
    });
});

test('auth: a missing or too-short PARENT_VIEW_SECRET fails closed with 503', async () => {
    await withViews({}, async (h, token) => {
        h.setSecret(undefined);
        assert.equal((await request(h, '/child', token)).statusCode, 503);
        h.setSecret('too-short');
        assert.equal((await request(h, '/grades', token)).statusCode, 503);
        assert.equal(h.state.calls.length, 0);
    });
});

// ---------------------------------------------------------------------------
// Read-only scoped views
// ---------------------------------------------------------------------------

test('child: returns only the linked child for the token enrollment', async () => {
    await withViews({
        extra: (state) => {
            state.children.set(ENROLLMENT, childSummary(ENROLLMENT));
            state.children.set(OTHER_ENROLLMENT, childSummary(OTHER_ENROLLMENT));
        },
    }, async (h, token) => {
        const response = await request(h, '/child', token);
        assert.equal(response.statusCode, 200);
        assert.equal((response.body as ChildSummary).enrollment_id, ENROLLMENT);
        assert.equal((response.body as ChildSummary).name, `Child ${ENROLLMENT}`);
        assert.deepEqual(h.state.calls, [{ method: 'child', tenantId: TENANT, enrollmentId: ENROLLMENT }]);
    });
});

test('child: a missing row is 404 and never falls back to another child', async () => {
    await withViews({
        extra: (state) => { state.children.set(OTHER_ENROLLMENT, childSummary(OTHER_ENROLLMENT)); },
    }, async (h, token) => {
        assert.equal((await request(h, '/child', token)).statusCode, 404);
    });
});

test('progress, attendance and grades are scoped to the token tenant + enrollment', async () => {
    await withViews({
        extra: (state) => {
            state.progress = { courses: [{ course_id: 'c1', course_name: 'Math', completed_lessons: 3, total_lessons: 5 }], totals: { completed_lessons: 3, total_lessons: 5 } };
            state.attendance = [{ session_id: 's1', title: 'Lesson 1', starts_at: '2026-10-01T08:00:00.000Z', state: 'present', marked_at: '2026-10-01T08:05:00.000Z' }];
            state.grades = { courses: [{ course_id: 'c1', course_name: 'Math', total_score: 80, total_max: 100, items: 4, last_recorded_at: '2026-10-02T00:00:00.000Z' }] };
        },
    }, async (h, token) => {
        const progress = await request(h, '/lesson-progress', token);
        assert.equal(progress.statusCode, 200);
        assert.deepEqual(progress.body, {
            courses: [{ course_id: 'c1', course_name: 'Math', completed_lessons: 3, total_lessons: 5 }],
            totals: { completed_lessons: 3, total_lessons: 5 },
        });
        const attendance = await request(h, '/attendance', token);
        assert.equal(attendance.statusCode, 200);
        assert.equal((attendance.body as AttendanceRecordView[]).length, 1);
        const grades = await request(h, '/grades', token);
        assert.equal(grades.statusCode, 200);
        assert.equal((grades.body as GradeSummary).courses[0].total_score, 80);
        for (const call of h.state.calls) {
            assert.equal(call.tenantId, TENANT);
            assert.equal(call.enrollmentId, ENROLLMENT);
        }
    });
});

test('attendance: limit defaults to 100, clamps at 200 and rejects invalid values', async () => {
    await withViews({}, async (h, token) => {
        assert.equal((await request(h, '/attendance', token)).statusCode, 200);
        assert.equal(h.state.calls[h.state.calls.length - 1].limit, 100);
        assert.equal((await request(h, '/attendance', token, { limit: '25' })).statusCode, 200);
        assert.equal(h.state.calls[h.state.calls.length - 1].limit, 25);
        assert.equal((await request(h, '/attendance', token, { limit: '1000' })).statusCode, 200);
        assert.equal(h.state.calls[h.state.calls.length - 1].limit, 200);
        assert.equal((await request(h, '/attendance', token, { limit: 'abc' })).statusCode, 400);
        assert.equal((await request(h, '/attendance', token, { limit: '0' })).statusCode, 400);
        assert.equal((await request(h, '/attendance', token, { limit: '-3' })).statusCode, 400);
    });
});

test('the router is read-only: every declared route is a GET', async () => {
    await withViews({}, async (h) => {
        const layers = (h.router as unknown as { stack: Array<{ route?: { methods: Record<string, boolean> } }> }).stack;
        const methods = new Set<string>();
        for (const layer of layers) {
            if (layer.route) for (const method of Object.keys(layer.route.methods)) methods.add(method.toLowerCase());
        }
        assert.deepEqual([...methods].sort(), ['get']);
    });
});

test('failure: a read error surfaces as 500 without leaking details', async () => {
    await withViews({
        extra: (state) => {
            state.children.set(ENROLLMENT, childSummary(ENROLLMENT));
            state.failWith = new Error('simulated outage');
        },
    }, async (h, token) => {
        const response = await request(h, '/child', token);
        assert.equal(response.statusCode, 500);
        assert.equal(JSON.stringify(response.body).includes('simulated outage'), false);
    });
});

// ---------------------------------------------------------------------------
// SQL store: tenant scoping, published-only projection, no writes
// ---------------------------------------------------------------------------

interface CapturedStatement {
    sql: string;
    params: unknown[];
    kind: 'query' | 'queryOne' | 'execute';
}

const makeCapturingDb = (rows: (sql: string) => unknown[]): { db: ParentViewsDataAccess; executed: CapturedStatement[] } => {
    const executed: CapturedStatement[] = [];
    const db: ParentViewsDataAccess = {
        query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
            executed.push({ sql, params, kind: 'query' });
            return rows(sql) as T[];
        },
        queryOne: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
            executed.push({ sql, params, kind: 'queryOne' });
            return ((rows(sql)[0] ?? null) as T | null);
        },
        execute: async (sql: string, params: unknown[] = []) => {
            executed.push({ sql, params, kind: 'execute' });
            return { affectedRows: 1, insertId: 0 };
        },
    };
    return { db, executed };
};

test('sql store: every read is tenant + enrollment scoped and issues no write', async () => {
    const { db, executed } = makeCapturingDb(() => []);
    const store = createSqlParentViewsStore(db);
    await store.findChildSummary(TENANT, ENROLLMENT);
    await store.lessonProgressSummary(TENANT, ENROLLMENT);
    await store.attendanceRecords(TENANT, ENROLLMENT, 200);
    await store.gradeSummary(TENANT, ENROLLMENT);

    assert.equal(executed.some((statement) => statement.kind === 'execute'), false);

    const find = (fragment: string): CapturedStatement => {
        const match = executed.find((statement) => statement.sql.includes(fragment));
        assert.ok(match, `expected a query containing ${fragment}`);
        return match;
    };

    const child = find('FROM students s');
    assert.ok(child.sql.includes('s.id = ?') && child.sql.includes('s.tenant_id = ?'));
    assert.deepEqual(child.params, [ENROLLMENT, TENANT]);
    assert.ok(!/select\s+\*/i.test(child.sql));
    for (const forbidden of ['password', 'guardian', 'parent_phone', 'phone', 'email', 'address', 'note']) {
        assert.ok(!child.sql.toLowerCase().includes(forbidden), `child projection must not select ${forbidden}`);
    }

    const progress = find('FROM courses c');
    assert.ok(progress.sql.includes('c.tenant_id = ?'));
    assert.ok(progress.sql.includes('sc.student_id = ?'));
    assert.ok(progress.sql.includes('is_published = 1'));
    assert.ok(progress.sql.includes('archived_at IS NULL'));
    assert.deepEqual(progress.params, [ENROLLMENT, TENANT, ENROLLMENT]);

    const attendance = find('FROM attendance_records a');
    assert.ok(attendance.sql.includes('a.tenant_id = ?') && attendance.sql.includes('a.student_id = ?'));
    assert.ok(attendance.sql.includes('LIMIT 200'));
    assert.deepEqual(attendance.params, [TENANT, ENROLLMENT]);

    const grades = find('FROM gradebook_scores gs');
    assert.ok(grades.sql.includes('gs.tenant_id = ?'));
    assert.ok(grades.sql.includes('c.tenant_id = ?'));
    assert.deepEqual(grades.params, [TENANT, TENANT, ENROLLMENT]);
});

test('sql store: published-only progress and coercion of nullable aggregates', async () => {
    const { db } = makeCapturingDb((sql) => {
        if (sql.includes('FROM courses c')) {
            return [{ course_id: 'c1', course_name: 'Math', total_lessons: 5, completed_lessons: 3 }];
        }
        if (sql.includes('FROM gradebook_scores gs')) {
            return [{ course_id: 'c1', course_name: 'Math', total_score: 80, total_max: 100, items: 4, last_recorded_at: null }];
        }
        return [];
    });
    const store = createSqlParentViewsStore(db);
    const progress = await store.lessonProgressSummary(TENANT, ENROLLMENT);
    assert.deepEqual(progress, {
        courses: [{ course_id: 'c1', course_name: 'Math', completed_lessons: 3, total_lessons: 5 }],
        totals: { completed_lessons: 3, total_lessons: 5 },
    });
    const grades = await store.gradeSummary(TENANT, ENROLLMENT);
    assert.equal(grades.courses[0].total_score, 80);
    assert.equal(grades.courses[0].items, 4);
    assert.equal(grades.courses[0].last_recorded_at, null);
});
