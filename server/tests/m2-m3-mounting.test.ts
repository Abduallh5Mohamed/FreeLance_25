import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Router } from 'express';
import { authenticateToken, optionalAuth } from '../src/middleware/auth';
import { enforceTenantAuthorityBoundary } from '../src/middleware/tenant-authority-boundary';
import { enforceStudentWorkspaceBoundary } from '../src/middleware/student-workspace-boundary';
import { rateLimit } from '../src/middleware/rate-limit';
import { createContentAccessRouter } from '../src/routes/content-access';
import { createQuestionBankRouter } from '../src/routes/question-bank';
import { createAssignmentsRouter } from '../src/routes/assignments';
import { createExamVersionsRouter } from '../src/routes/exam-versions';
import { createGradebookRouter } from '../src/routes/gradebook';
import { createCertificatesRouter } from '../src/routes/certificates';
import { createSchedulesRouter } from '../src/routes/schedules';
import { createAttendanceRecordsRouter } from '../src/routes/attendance-records';
import { createTenantBrandingRouter } from '../src/routes/tenant-branding';
import { createTenantDomainsRouter } from '../src/routes/tenant-domains';
import { createAnnouncementsRouter } from '../src/routes/announcements';
import { createStudentImportRouter } from '../src/routes/student-import';
import { createVideoAssetsRouter } from '../src/routes/video-assets';
import { createPlaybackSessionsRouter } from '../src/routes/playback-sessions';
import { createVideoAssetLifecycle, createSqlVideoAssetStore } from '../src/services/video-asset-lifecycle';
import { createPlaybackEntitlementService, createSqlPlaybackEntitlementStore } from '../src/services/playback-entitlement';
import { createVideoUsageEventService, createSqlVideoUsageStore } from '../src/services/video-usage-events';
import { invokeRoute, makeFakeDataAccess } from './helpers/m2-harness';

/**
 * M2/M3 mounting contract.
 *
 * Two independent, hermetic layers:
 *  1. STATIC — server/src/index.ts is read as text and asserted to mount every
 *     new router (in the expected variable) after the shared /api guard chain,
 *     with no path colliding with another mount.
 *  2. RUNTIME DENIAL — each real mount path is exercised anonymously through a
 *     throwaway Express router that applies the SAME guard chain and mounts the
 *     router factories over a tripwire data access. A 401/403 with a zero
 *     storage-call count proves no anonymous request reaches storage.
 *
 * No database, object storage, Docker, network or live service is contacted;
 * src/index.ts is never imported (importing it would start the server).
 */

const indexPath = path.resolve(__dirname, '..', 'src', 'index.ts');
const indexSource = readFileSync(indexPath, 'utf8');

const GUARD_ANCHOR = "app.use('/api', optionalAuth";

const EXPECTED_MOUNTS: ReadonlyArray<readonly [string, string]> = [
    ['/api/content', 'contentAccessRoutes'],
    ['/api/tenant/branding', 'tenantBrandingRoutes'],
    ['/api/tenant/domains', 'tenantDomainsRoutes'],
    ['/api/announcements', 'announcementsRoutes'],
    ['/api/student-import', 'studentImportRoutes'],
    ['/api/video-assets', 'videoAssetsRoutes'],
    ['/api/playback', 'playbackSessionsRoutes'],
    ['/api/question-bank', 'questionBankRoutes'],
    ['/api/assignments', 'assignmentsRoutes'],
    ['/api/exam-versions', 'examVersionsRoutes'],
    ['/api/gradebook', 'gradebookRoutes'],
    ['/api/certificates', 'certificatesRoutes'],
    ['/api/schedules', 'schedulesRoutes'],
    ['/api/attendance-records', 'attendanceRecordsRoutes'],
];

const MOUNT_RE = /app\.use\(\s*'(\/api[^']*)'\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;

function parseMounts(source: string): Array<{ path: string; variable: string; index: number }> {
    const mounts: Array<{ path: string; variable: string; index: number }> = [];
    for (const match of source.matchAll(MOUNT_RE)) {
        if (match.index === undefined) continue;
        mounts.push({ path: match[1], variable: match[2], index: match.index });
    }
    return mounts;
}

function segments(mountPath: string): string[] {
    return mountPath.split('/').filter(Boolean);
}

function isSegmentPrefix(a: string[], b: string[]): boolean {
    if (a.length >= b.length) return false;
    return a.every((segment, i) => segment === b[i]);
}

/* -------------------------------------------------------------------------- */
/* Static mounting assertions                                                  */
/* -------------------------------------------------------------------------- */

test('mounting: every new M2/M3 router is mounted after the /api guard chain', () => {
    const guardIndex = indexSource.indexOf(GUARD_ANCHOR);
    assert.ok(guardIndex > -1, 'the shared /api guard chain must exist');

    const notFoundIndex = indexSource.indexOf('// 404 handler');
    assert.ok(notFoundIndex > guardIndex, 'the 404 handler must follow the guard chain');

    const mounts = parseMounts(indexSource);
    for (const [mountPath, variable] of EXPECTED_MOUNTS) {
        const statement = `app.use('${mountPath}', ${variable})`;
        const mountIndex = indexSource.indexOf(statement);
        assert.ok(mountIndex > -1, `expected mount statement missing: ${statement}`);
        assert.ok(mountIndex > guardIndex, `${mountPath} must be mounted after the /api guard chain`);
        assert.ok(mountIndex < notFoundIndex, `${mountPath} must be mounted before the 404 handler`);

        const parsed = mounts.find((mount) => mount.path === mountPath);
        assert.ok(parsed, `${mountPath} must be parsed as an /api mount`);
        assert.equal(parsed?.variable, variable, `${mountPath} must mount the expected router variable`);
    }
});

test('mounting: no new path collides with an existing mount (segment-aware)', () => {
    const mounts = parseMounts(indexSource);
    assert.ok(mounts.length > EXPECTED_MOUNTS.length, 'existing mounts must still be present');

    const newPaths = new Set(EXPECTED_MOUNTS.map(([mountPath]) => mountPath));

    for (let i = 0; i < mounts.length; i += 1) {
        const left = segments(mounts[i].path);
        for (let j = i + 1; j < mounts.length; j += 1) {
            const right = segments(mounts[j].path);
            const collides = mounts[i].path === mounts[j].path
                || isSegmentPrefix(left, right)
                || isSegmentPrefix(right, left);
            assert.ok(
                !collides,
                `mount path collision between ${mounts[i].path} and ${mounts[j].path}`,
            );
        }
    }

    // A new mount must not be shadowed by (or shadow) an existing one.
    for (const mount of mounts) {
        if (newPaths.has(mount.path)) continue;
        for (const newPath of newPaths) {
            const existing = segments(mount.path);
            const candidate = segments(newPath);
            assert.ok(
                !isSegmentPrefix(existing, candidate) && !isSegmentPrefix(candidate, existing),
                `${mount.path} would shadow ${newPath}`,
            );
        }
    }
});

/* -------------------------------------------------------------------------- */
/* Runtime anonymous-denial assertions                                         */
/* -------------------------------------------------------------------------- */

interface TripwireDb {
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = unknown>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ affectedRows: number; insertId?: number }>;
    calls: () => number;
}

/** Data access that records and refuses every access; anon must never reach it. */
function tripwireDb(): TripwireDb {
    let calls = 0;
    const trip = (): never => {
        calls += 1;
        throw new Error('storage must not be touched by an anonymous caller');
    };
    return {
        query: async () => trip(),
        queryOne: async () => trip(),
        execute: async () => trip(),
        calls: () => calls,
    };
}

const authorityTripwire = async (): Promise<{ authority: string } | null> => {
    throw new Error('tenant authority must not be resolved for an anonymous caller');
};

interface GuardedSurface {
    router: Router;
    storageCalls: () => number;
}

/**
 * Mount every M2/M3 router behind the exact guard chain from index.ts, over
 * tripwire storage. Mirrors the production mount order and paths.
 */
function buildGuardedSurface(): GuardedSurface {
    const db = tripwireDb();
    const router = Router();
    router.use(optionalAuth, enforceTenantAuthorityBoundary, enforceStudentWorkspaceBoundary);

    router.use('/api/content', createContentAccessRouter({ db, authenticate: authenticateToken }));
    router.use('/api/tenant/branding', createTenantBrandingRouter({ db, authenticate: authenticateToken }));
    router.use('/api/tenant/domains', createTenantDomainsRouter({ db, authenticate: authenticateToken }));
    router.use('/api/announcements', createAnnouncementsRouter({
        db,
        authenticate: authenticateToken,
        loadActiveTenantAuthority: authorityTripwire,
    }));
    router.use('/api/student-import', createStudentImportRouter({
        db,
        authenticate: authenticateToken,
        loadActiveTenantAuthority: authorityTripwire,
    }));

    const lifecycle = createVideoAssetLifecycle({
        store: createSqlVideoAssetStore(db),
        verifyCallbackSignature: () => false,
    });
    const entitlement = createPlaybackEntitlementService({
        store: createSqlPlaybackEntitlementStore(db),
        getSecret: () => 'm2-m3-mounting-test-secret',
    });
    const usage = createVideoUsageEventService({ store: createSqlVideoUsageStore(db) });
    router.use('/api/video-assets', createVideoAssetsRouter({
        authenticate: authenticateToken,
        lifecycle,
        entitlement,
        usage,
        resolveLessonScope: async () => {
            throw new Error('lesson scope must not be resolved for an anonymous caller');
        },
    }));

    router.use('/api/playback', createPlaybackSessionsRouter({ db, authenticate: authenticateToken }));

    router.use('/api/question-bank', createQuestionBankRouter({
        db,
        authenticate: authenticateToken,
        loadActiveTenantAuthority: authorityTripwire,
    }));
    router.use('/api/assignments', createAssignmentsRouter({
        db,
        authenticate: authenticateToken,
        loadActiveTenantAuthority: authorityTripwire,
    }));
    router.use('/api/exam-versions', createExamVersionsRouter({
        db,
        authenticate: authenticateToken,
        loadActiveTenantAuthority: authorityTripwire,
    }));
    router.use('/api/gradebook', createGradebookRouter({
        db,
        authenticate: authenticateToken,
        loadActiveTenantAuthority: authorityTripwire,
    }));
    router.use('/api/certificates', createCertificatesRouter({
        db,
        authenticate: authenticateToken,
        loadActiveTenantAuthority: authorityTripwire,
    }));
    router.use('/api/schedules', createSchedulesRouter({
        db,
        authenticate: authenticateToken,
        loadActiveTenantAuthority: authorityTripwire,
    }));
    router.use('/api/attendance-records', createAttendanceRecordsRouter({
        db,
        authenticate: authenticateToken,
        loadActiveTenantAuthority: authorityTripwire,
    }));

    return { router, storageCalls: db.calls };
}

const ANONYMOUS_PROBES: ReadonlyArray<{ method: string; url: string; path: string }> = [
    { method: 'GET', url: '/api/content/lessons/lesson-1', path: '/api/content' },
    { method: 'GET', url: '/api/tenant/branding', path: '/api/tenant/branding' },
    { method: 'GET', url: '/api/tenant/domains', path: '/api/tenant/domains' },
    { method: 'GET', url: '/api/announcements', path: '/api/announcements' },
    { method: 'POST', url: '/api/student-import/preview', path: '/api/student-import' },
    { method: 'GET', url: '/api/video-assets/assets/asset-1', path: '/api/video-assets' },
    { method: 'GET', url: '/api/playback/sessions', path: '/api/playback' },
    { method: 'GET', url: '/api/question-bank/questions', path: '/api/question-bank' },
    { method: 'GET', url: '/api/assignments', path: '/api/assignments' },
    { method: 'GET', url: '/api/exam-versions/exams/exam-1/versions', path: '/api/exam-versions' },
    { method: 'GET', url: '/api/gradebook/scores', path: '/api/gradebook' },
    { method: 'GET', url: '/api/certificates', path: '/api/certificates' },
    { method: 'GET', url: '/api/schedules', path: '/api/schedules' },
    { method: 'GET', url: '/api/attendance-records/sessions/session-1/records', path: '/api/attendance-records' },
];

test('mounting: every mounted path denies an anonymous caller without touching storage', async () => {
    for (const probe of ANONYMOUS_PROBES) {
        const { router, storageCalls } = buildGuardedSurface();
        const res = await invokeRoute(router, { method: probe.method, url: probe.url });
        assert.ok(
            res.statusCode === 401 || res.statusCode === 403,
            `${probe.method} ${probe.path} must deny an anonymous caller (got ${res.statusCode})`,
        );
        assert.equal(storageCalls(), 0, `${probe.method} ${probe.path} touched storage before denying`);
    }
});

test('mounting: every probe path corresponds to a declared mount', () => {
    const declared = new Set(EXPECTED_MOUNTS.map(([mountPath]) => mountPath));
    for (const probe of ANONYMOUS_PROBES) {
        assert.ok(declared.has(probe.path), `probe path ${probe.path} is not a declared mount`);
    }
});

/* -------------------------------------------------------------------------- */
/* The single public surface: certificate verification                         */
/* -------------------------------------------------------------------------- */

interface ProbeResponse {
    statusCode?: number;
    body?: unknown;
    headers: Record<string, string>;
    status(code: number): ProbeResponse;
    json(payload: unknown): ProbeResponse;
    set(header: string, value: string): ProbeResponse;
    setHeader(header: string, value: string): ProbeResponse;
}

/**
 * Anonymous GET against the guarded surface with a response that also models
 * `setHeader`, which the rate-limited public verify route writes (the shared
 * harness response only models `set()`). Same guard chain as buildGuardedSurface.
 */
async function invokeAnonymousGet(router: Router, url: string): Promise<ProbeResponse> {
    const headers: Record<string, string> = {};
    const response: ProbeResponse = {
        headers,
        status(code) { response.statusCode = code; return response; },
        json(payload) {
            if (response.statusCode === undefined) response.statusCode = 200;
            response.body = payload;
            return response;
        },
        set(header, value) { headers[header.toLowerCase()] = value; return response; },
        setHeader(header, value) { headers[header.toLowerCase()] = value; return response; },
    };
    const req: any = {
        method: 'GET',
        url,
        originalUrl: url,
        headers: {},
        body: {},
        query: {},
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
    };
    await (router as unknown as (r: unknown, s: unknown, n: () => void) => Promise<void>)(req, response, () => {});
    const deadline = Date.now() + 5000;
    while (response.statusCode === undefined && response.body === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
}

function buildPublicVerifySurface(rows: Array<Record<string, unknown>>): { router: Router; storageCalls: () => number } {
    const db = makeFakeDataAccess(() => rows);
    const router = Router();
    router.use(optionalAuth, enforceTenantAuthorityBoundary, enforceStudentWorkspaceBoundary);
    router.use('/api/certificates', createCertificatesRouter({
        db,
        authenticate: authenticateToken,
        loadActiveTenantAuthority: authorityTripwire,
    }));
    return { router, storageCalls: () => db.executed.length };
}

test('mounting: the public certificate verify path is reachable anonymously', async () => {
    const { router, storageCalls } = buildPublicVerifySurface([]);
    const res = await invokeAnonymousGet(router, '/api/certificates/verify/deadbeef');
    assert.ok(
        res.statusCode !== 401 && res.statusCode !== 403,
        `public verify must not be denied to an anonymous caller (got ${res.statusCode})`,
    );
    assert.equal(res.statusCode, 404, 'an unknown verification id resolves to not-found');
    assert.equal(storageCalls(), 1, 'the public verify path is the one anonymous read of storage');
});

test('mounting: the public certificate verify path exposes only minimal facts', async () => {
    const row: Record<string, unknown> = {
        id: 'cert-internal-id',
        tenant_id: 'tenant-internal-id',
        student_enrollment_id: 'enrollment-internal-id',
        course_id: 'course-internal-id',
        verification_id: 'verification-1',
        status: 'issued',
        final_score: 88,
        issued_at: '2026-01-02T03:04:05.000Z',
        issued_by: 'issuer-internal-id',
        revoked_at: null,
        revoked_by: null,
        revoke_reason: null,
        branding_logo_url: 'https://cdn.example/logo.png',
        branding_primary_color: '#111111',
        branding_secondary_color: '#222222',
        branding_accent_color: '#333333',
        branding_locale: 'ar',
    };
    const { router, storageCalls } = buildPublicVerifySurface([row]);
    const res = await invokeAnonymousGet(router, '/api/certificates/verify/verification-1');
    assert.equal(res.statusCode, 200);

    const facts = (res.body as { certificate: Record<string, unknown> }).certificate;
    assert.deepEqual(
        Object.keys(facts).sort(),
        ['branding', 'course', 'final_score', 'issued_at', 'status', 'student', 'tenant', 'verification_id'],
    );
    for (const internal of ['id', 'tenant_id', 'student_enrollment_id', 'course_id', 'issued_by', 'revoked_at', 'revoked_by', 'revoke_reason']) {
        assert.ok(!(internal in facts), `public facts must not leak ${internal}`);
    }
    assert.equal(facts.verification_id, 'verification-1');
    assert.equal(facts.status, 'issued');
    assert.equal(storageCalls(), 1);
});

test('mounting: the public certificate verify path is rate-limited when wired', async () => {
    const db = makeFakeDataAccess(() => []);
    const router = Router();
    router.use(optionalAuth, enforceTenantAuthorityBoundary, enforceStudentWorkspaceBoundary);
    router.use('/api/certificates', createCertificatesRouter({
        db,
        authenticate: authenticateToken,
        loadActiveTenantAuthority: authorityTripwire,
        verifyRateLimit: rateLimit('m2-m3-cert-verify-test', 2, 60_000),
    }));

    const first = await invokeAnonymousGet(router, '/api/certificates/verify/a');
    const second = await invokeAnonymousGet(router, '/api/certificates/verify/b');
    const third = await invokeAnonymousGet(router, '/api/certificates/verify/c');
    assert.ok(first.statusCode !== 429 && second.statusCode !== 429);
    assert.equal(third.statusCode, 429, 'the public verify path must throttle once the limit is exceeded');
});
