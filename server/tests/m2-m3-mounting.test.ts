import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Router } from 'express';
import { authenticateToken, optionalAuth } from '../src/middleware/auth';
import { enforceTenantAuthorityBoundary } from '../src/middleware/tenant-authority-boundary';
import { enforceStudentWorkspaceBoundary } from '../src/middleware/student-workspace-boundary';
import { createContentAccessRouter } from '../src/routes/content-access';
import { createQuestionBankRouter } from '../src/routes/question-bank';
import { createAssignmentsRouter } from '../src/routes/assignments';
import { createExamVersionsRouter } from '../src/routes/exam-versions';
import { createGradebookRouter } from '../src/routes/gradebook';
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
import { invokeRoute } from './helpers/m2-harness';

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
    ['/api/schedules', 'schedulesRoutes'],
    ['/api/attendance-records', 'attendanceRecordsRoutes'],
];

/**
 * Human decision (2026-10-19): certificates are out of the current product
 * scope (school teachers/students product, not a graduation/certificate
 * platform). `/api/certificates` must never be mounted by the primary
 * server; source, migrations and historic data are preserved instead of
 * deleted. See docs/streams/server/TEACHER-SCHOOL-PRODUCT-ALIGNMENT.md.
 */
const EXCLUDED_MOUNTS: ReadonlyArray<readonly [string, string]> = [
    ['/api/certificates', 'certificatesRoutes'],
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

test('mounting: excluded certificate surface is not mounted by the primary server', () => {
    for (const [mountPath, variable] of EXCLUDED_MOUNTS) {
        assert.ok(
            !indexSource.includes(`app.use('${mountPath}'`),
            `${mountPath} must not be mounted (excluded from product scope by human decision 2026-10-19)`,
        );
        assert.ok(
            !indexSource.includes(variable),
            `the excluded router variable ${variable} must not be referenced by index.ts`,
        );
    }

    const mounts = parseMounts(indexSource);
    for (const [mountPath] of EXCLUDED_MOUNTS) {
        const mounted = mounts.find((mount) => mount.path === mountPath || mount.path.startsWith(`${mountPath}/`));
        assert.ok(!mounted, `no mount may occupy the excluded surface ${mountPath}`);
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
    // certificates are excluded by human decision (2026-10-19) and are
    // intentionally absent from this guarded surface as well.
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
/* Excluded surface: certificates are out of product scope (2026-10-19)         */
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
 * `setHeader`. Used to prove the excluded certificate surface answers with the
 * primary server's 404 handler rather than any certificate behaviour.
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

/**
 * A primary-server-shaped surface: the exact guard chain, every mounted
 * teaching router (certificates excluded per the 2026-10-19 human decision)
 * and — mirroring server/src/index.ts — the terminal 404 handler. Tripwire
 * storage proves the excluded paths never reach any handler before the 404.
 */
function buildPrimaryServerSurface(): { router: Router; storageCalls: () => number } {
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

    // Terminal 404 handler, identical in shape to server/src/index.ts.
    router.use((_req, res) => {
        res.status(404).json({ error: 'Route not found' });
    });

    return { router, storageCalls: db.calls };
}

test('mounting: the excluded certificates surface resolves to the 404 handler, not to certificate behaviour', async () => {
    const { router, storageCalls } = buildPrimaryServerSurface();
    for (const url of [
        '/api/certificates',
        '/api/certificates/verify/deadbeef',
        '/api/certificates/cert-1',
        '/api/certificates/cert-1/revoke',
    ]) {
        const res = await invokeAnonymousGet(router, url);
        assert.equal(res.statusCode, 404, `anonymous GET ${url} must resolve to the 404 handler (got ${res.statusCode})`);
        assert.deepEqual(res.body, { error: 'Route not found' }, `${url} must not answer with any certificate projection`);
    }
    assert.equal(storageCalls(), 0, 'the excluded surface must never reach storage');
});

test('mounting: sibling teaching surfaces stay mounted and still deny anonymous callers', async () => {
    const { router, storageCalls } = buildPrimaryServerSurface();
    for (const url of ['/api/assignments', '/api/gradebook/scores', '/api/schedules']) {
        const res = await invokeAnonymousGet(router, url);
        assert.ok(
            res.statusCode === 401 || res.statusCode === 403,
            `teaching surface GET ${url} must still deny an anonymous caller (got ${res.statusCode})`,
        );
    }
    assert.equal(storageCalls(), 0, 'anonymous callers must not reach storage');
});

/* -------------------------------------------------------------------------- */
/* M6 P1/P2/P6 mounts (appended 2026-10-18)                                    */
/* -------------------------------------------------------------------------- */

const M6_MOUNTS: ReadonlyArray<readonly [string, string]> = [
    ['/api/parent-links', 'parentLinksRoutes'],
    ['/api/notification-consent', 'notificationConsentRoutes'],
    ['/api/lesson-discussions', 'lessonDiscussionsRoutes'],
];

test('mounting (M6): parent-link, consent and discussion routers mount after the guard chain', () => {
    const guardIndex = indexSource.indexOf(GUARD_ANCHOR);
    assert.ok(guardIndex > -1, 'the shared /api guard chain must exist');
    const notFoundIndex = indexSource.indexOf('// 404 handler');
    assert.ok(notFoundIndex > guardIndex, 'the 404 handler must follow the guard chain');

    for (const [mountPath, variable] of M6_MOUNTS) {
        const statement = `app.use('${mountPath}', ${variable})`;
        const mountIndex = indexSource.indexOf(statement);
        assert.ok(mountIndex > -1, `expected mount statement missing: ${statement}`);
        assert.ok(mountIndex > guardIndex, `${mountPath} must be mounted after the /api guard chain`);
        assert.ok(mountIndex < notFoundIndex, `${mountPath} must be mounted before the 404 handler`);
    }
});

test('mounting (M6): parent read-only views mount BEFORE optionalAuth (opaque pv1 token)', () => {
    const guardIndex = indexSource.indexOf(GUARD_ANCHOR);
    const parentIndex = indexSource.indexOf("app.use('/api/parent', parentViewsRoutes)");
    assert.ok(parentIndex > -1, 'the parent views router must be mounted');
    // parent-views authenticates with its own scoped HMAC token (pv1.<payload>.<sig>),
    // which is not a JWT; optionalAuth would reject it as "Invalid token".
    assert.ok(parentIndex < guardIndex, 'parent views must be mounted before the optionalAuth guard chain');
});

test('mounting (M6): the new mount paths collide with no other mount (segment-aware)', () => {
    const mounts = parseMounts(indexSource);
    const newPaths = M6_MOUNTS.map(([mountPath]) => mountPath);
    for (const newPath of newPaths) {
        const candidate = segments(newPath);
        for (const mount of mounts) {
            if (mount.path === newPath) continue;
            const other = segments(mount.path);
            const collides = isSegmentPrefix(other, candidate)
                || isSegmentPrefix(candidate, other)
                || (other.length === candidate.length && mount.path === newPath);
            assert.ok(!collides, `${newPath} would collide with ${mount.path}`);
        }
    }
});

test('mounting (M6): the new M6 surfaces deny an anonymous caller without touching storage', async () => {
    const { createParentLinksRouter } = await import('../src/routes/parent-links');
    const { createNotificationConsentRouter } = await import('../src/routes/notification-consent');
    const { createParentViewsRouter } = await import('../src/routes/parent-views');
    const { createParentViewVerifier } = await import('../src/services/parent-links');
    const { createLessonDiscussionsRouter } = await import('../src/routes/lesson-discussions');

    let storageCalls = 0;
    const tripwire = <T>(): T => new Proxy({} as T, {
        get: () => (): never => {
            storageCalls += 1;
            throw new Error('storage must not be touched by an anonymous caller');
        },
    });

    const db = tripwireDb();
    const router = Router();
    // parent views are mounted BEFORE the guard chain, mirroring index.ts.
    router.use('/api/parent', createParentViewsRouter({
        store: tripwire(),
        verifier: createParentViewVerifier({ store: tripwire(), getSecret: () => undefined, now: () => new Date() }),
    }));
    router.use(optionalAuth, enforceTenantAuthorityBoundary, enforceStudentWorkspaceBoundary);
    router.use('/api/parent-links', createParentLinksRouter({
        db,
        authenticate: authenticateToken,
        loadActiveTenantAuthority: authorityTripwire,
        getOtpService: () => null,
        getSecret: () => undefined,
    }));
    router.use('/api/notification-consent', createNotificationConsentRouter({
        db,
        authenticate: authenticateToken,
        getLinkSecret: () => undefined,
    }));
    router.use('/api/lesson-discussions', createLessonDiscussionsRouter({
        store: tripwire(),
        authenticate: authenticateToken,
        resolveLessonAccess: async () => { throw new Error('access must not resolve for an anonymous caller'); },
    }));

    const probes = [
        { method: 'GET', url: '/api/parent/child' },
        { method: 'GET', url: '/api/parent-links' },
        { method: 'GET', url: '/api/notification-consent/state' },
        { method: 'GET', url: '/api/lesson-discussions/blocks' },
    ];
    for (const probe of probes) {
        const res = await invokeRoute(router, probe);
        assert.ok(
            res.statusCode === 401 || res.statusCode === 403,
            `${probe.method} ${probe.url} must deny an anonymous caller (got ${res.statusCode})`,
        );
    }
    assert.equal(db.calls(), 0, 'an anonymous caller must not reach SQL storage');
    assert.equal(storageCalls, 0, 'an anonymous caller must not reach injected stores');
});

/* -------------------------------------------------------------------------- */
/* M7 platform mounts (appended 2026-10-19)                                    */
/* -------------------------------------------------------------------------- */

const M7_MOUNTS: ReadonlyArray<readonly [string, string]> = [
    ['/api/platform/flags', 'platformFlagsRoutes'],
    ['/api/audit-logs', 'auditLogsRoutes'],
    ['/api/moderation', 'moderationRoutes'],
];

test('mounting (M7): platform flags, audit logs and moderation mount after the guard chain', () => {
    const guardIndex = indexSource.indexOf(GUARD_ANCHOR);
    assert.ok(guardIndex > -1, 'the shared /api guard chain must exist');
    const notFoundIndex = indexSource.indexOf('// 404 handler');
    assert.ok(notFoundIndex > guardIndex, 'the 404 handler must follow the guard chain');

    for (const [mountPath, variable] of M7_MOUNTS) {
        const statement = `app.use('${mountPath}', ${variable})`;
        const mountIndex = indexSource.indexOf(statement);
        assert.ok(mountIndex > -1, `expected mount statement missing: ${statement}`);
        assert.ok(mountIndex > guardIndex, `${mountPath} must be mounted after the /api guard chain`);
        assert.ok(mountIndex < notFoundIndex, `${mountPath} must be mounted before the 404 handler`);

        const parsed = parseMounts(indexSource).find((mount) => mount.path === mountPath);
        assert.ok(parsed, `${mountPath} must be parsed as an /api mount`);
        assert.equal(parsed?.variable, variable, `${mountPath} must mount the expected router variable`);
    }
});

test('mounting (M7): the new mount paths collide with no other mount (segment-aware)', () => {
    const mounts = parseMounts(indexSource);
    for (const [mountPath] of M7_MOUNTS) {
        const candidate = segments(mountPath);
        for (const mount of mounts) {
            if (mount.path === mountPath) continue;
            const other = segments(mount.path);
            const collides = isSegmentPrefix(other, candidate) || isSegmentPrefix(candidate, other);
            assert.ok(!collides, `${mountPath} would collide with ${mount.path}`);
        }
    }
});

test('mounting (M7): platform flags, audit logs and moderation deny an anonymous caller without touching storage', async () => {
    const { createPlatformFlagsRouter } = await import('../src/routes/platform-flags');
    const { createAuditLogsRouter } = await import('../src/routes/audit-logs');
    const { createModerationRouter } = await import('../src/routes/moderation');
    type RequestHandler = import('express').RequestHandler;

    const forbidden = (): RequestHandler =>
        ((_req: unknown, res: { status(code: number): { json(body: unknown): void } }) => {
            res.status(403).json({ error: 'Forbidden' });
        }) as unknown as RequestHandler;

    const db = tripwireDb();
    const router = Router();
    router.use(optionalAuth, enforceTenantAuthorityBoundary, enforceStudentWorkspaceBoundary);
    router.use('/api/platform/flags', createPlatformFlagsRouter({
        db,
        authenticate: authenticateToken,
        requirePlatformPermission: () => forbidden(),
        recordAudit: async () => { throw new Error('audit must not run for an anonymous caller'); },
    }));
    router.use('/api/audit-logs', createAuditLogsRouter({
        db,
        authenticate: authenticateToken,
        requirePlatformPermission: () => forbidden(),
        isPlatformReader: async () => { throw new Error('scope must not resolve for an anonymous caller'); },
        tenantOwnerTenantId: async () => { throw new Error('scope must not resolve for an anonymous caller'); },
        recordAudit: async () => { throw new Error('audit must not run for an anonymous caller'); },
    }));
    router.use('/api/moderation', createModerationRouter({
        db,
        authenticate: authenticateToken,
        reports: { findReportById: async () => { throw new Error('reports must not be read for an anonymous caller'); } },
        content: {
            snapshotEvidence: async () => { throw new Error('evidence must not be read for an anonymous caller'); },
            applyAction: async () => { throw new Error('content must not change for an anonymous caller'); },
        },
        isPlatformModerator: async () => { throw new Error('permission must not resolve for an anonymous caller'); },
        loadActiveTenantAuthority: async () => { throw new Error('authority must not resolve for an anonymous caller'); },
        notifyTenantOwner: async () => { throw new Error('notification must not fire for an anonymous caller'); },
        recordAudit: async () => { throw new Error('audit must not run for an anonymous caller'); },
    }));

    const probes = [
        { method: 'GET', url: '/api/platform/flags' },
        { method: 'GET', url: '/api/audit-logs' },
        { method: 'GET', url: '/api/moderation/cases' },
    ];
    for (const probe of probes) {
        const res = await invokeRoute(router, probe);
        assert.ok(
            res.statusCode === 401 || res.statusCode === 403,
            `${probe.method} ${probe.url} must deny an anonymous caller (got ${res.statusCode})`,
        );
    }
    assert.equal(db.calls(), 0, 'an anonymous caller must not reach SQL storage');
});

/* -------------------------------------------------------------------------- */
/* M8 search / tenant-export / observability mounts (appended 2026-10-20)      */
/* -------------------------------------------------------------------------- */

/**
 * The M8 surfaces mounted by `server/src/index.ts`.
 *
 * `/api/search` and `/api/tenant-exports` sit behind the shared `/api` guard
 * chain. The observability router (`/metrics`, `/healthz`, `/readyz`) is wired
 * by `mountObservability(app, deps)` at the APPLICATION ROOT — deliberately
 * outside `/api` — so the probes answer without authentication while the
 * metrics scrape stays gated by the dedicated `METRICS_TOKEN`.
 */
const M8_MOUNTS: ReadonlyArray<readonly [string, string]> = [
    ['/api/search', 'searchRoutes'],
    ['/api/tenant-exports', 'tenantExportRoutes'],
];

const M8_OPS_PATHS: readonly string[] = ['/metrics', '/healthz', '/readyz'];

/** A deployable metrics token (>= 32 bytes), never a production value. */
const M8_METRICS_TOKEN = 'm8-mounting-test-metrics-token-0123456789abcdef';

test('mounting (M8): search and tenant-export mount after the guard chain, exactly once', () => {
    const guardIndex = indexSource.indexOf(GUARD_ANCHOR);
    assert.ok(guardIndex > -1, 'the shared /api guard chain must exist');
    const notFoundIndex = indexSource.indexOf('// 404 handler');
    assert.ok(notFoundIndex > guardIndex, 'the 404 handler must follow the guard chain');

    for (const [mountPath, variable] of M8_MOUNTS) {
        const statement = `app.use('${mountPath}', ${variable})`;
        assert.equal(
            indexSource.split(statement).length - 1,
            1,
            `${statement} must be mounted exactly once`,
        );
        const mountIndex = indexSource.indexOf(statement);
        assert.ok(mountIndex > guardIndex, `${mountPath} must be mounted after the /api guard chain`);
        assert.ok(mountIndex < notFoundIndex, `${mountPath} must be mounted before the 404 handler`);

        const parsed = parseMounts(indexSource).find((mount) => mount.path === mountPath);
        assert.ok(parsed, `${mountPath} must be parsed as an /api mount`);
        assert.equal(parsed?.variable, variable, `${mountPath} must mount the expected router variable`);
    }
});

test('mounting (M8): observability runs before the /api guards and its ops paths stay outside /api', () => {
    const guardIndex = indexSource.indexOf(GUARD_ANCHOR);
    assert.ok(guardIndex > -1, 'the shared /api guard chain must exist');

    const observabilityWiring = 'mountObservability(app,';
    assert.equal(
        indexSource.split(observabilityWiring).length - 1,
        1,
        'mountObservability(app, deps) must be wired exactly once',
    );
    const observabilityIndex = indexSource.indexOf(observabilityWiring);
    assert.ok(
        observabilityIndex < guardIndex,
        'mountObservability must be installed BEFORE the /api guards so every request gets a correlation id',
    );

    // The ops router owns root-relative paths. Mounting it under /api (or as a
    // second app-level mount) would either put the probes behind authentication
    // or duplicate the surface.
    for (const opsPath of M8_OPS_PATHS) {
        assert.ok(!indexSource.includes(`app.use('${opsPath}'`), `${opsPath} must not be a separate app-level mount`);
        assert.ok(!indexSource.includes(`app.use('/api${opsPath}'`), `${opsPath} must not be mounted under /api`);
    }

    // Certificates stay unmounted: owner decision 2026-10-19 (product scope).
    assert.ok(!indexSource.includes("app.use('/api/certificates"), '/api/certificates must stay unmounted');
});

test('mounting (M8): the new M8 mount paths collide with no other mount (segment-aware)', () => {
    const mounts = parseMounts(indexSource);
    for (const [mountPath] of M8_MOUNTS) {
        const candidate = segments(mountPath);
        for (const mount of mounts) {
            if (mount.path === mountPath) continue;
            const other = segments(mount.path);
            const collides = isSegmentPrefix(other, candidate) || isSegmentPrefix(candidate, other);
            assert.ok(!collides, `${mountPath} would collide with ${mount.path}`);
        }
    }
});

interface M8Surface {
    app: Router;
    storageCalls: () => number;
    readinessChecks: () => number;
}

interface M8Response {
    statusCode?: number;
    body?: unknown;
    text?: string;
    headers: Record<string, string>;
    status(code: number): M8Response;
    json(payload: unknown): M8Response;
    send(payload: unknown): M8Response;
    set(header: string, value: string): M8Response;
    setHeader(header: string, value: string): M8Response;
    on(event: string, listener: () => void): M8Response;
}

interface M8Request {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
}

/**
 * Mirror `server/src/index.ts` exactly: observability (request context) first,
 * then the shared /api guard chain, then the M8 business routers, then the
 * terminal 404 handler. Every dependency is injected over a tripwire, so an
 * anonymous request that reaches storage fails the assertion instead of
 * silently passing.
 */
async function buildM8Surface(options: { metricsToken?: string } = {}): Promise<M8Surface> {
    const { createSearchRouter } = await import('../src/routes/search');
    const { createTenantExportRouter } = await import('../src/routes/tenant-export');
    const { mountObservability } = await import('../src/routes/ops');
    const { createLogger } = await import('../src/services/logger');
    const { createMetricsRegistry } = await import('../src/services/metrics');

    const db = tripwireDb();
    let readinessRuns = 0;
    const app = Router();

    const metrics = createMetricsRegistry();
    metrics.counter('m8_mounting_probe_total', 'Mounting probe counter').inc();

    mountObservability(app as unknown as import('express').Application, {
        logger: createLogger({ write: () => { /* hermetic: no stdout */ } }),
        metrics,
        metricsToken: options.metricsToken,
        readiness: [{
            name: 'database',
            check: () => {
                readinessRuns += 1;
                return true;
            },
        }],
    });

    app.use('/api', optionalAuth, enforceTenantAuthorityBoundary, enforceStudentWorkspaceBoundary);
    app.use('/api/search', createSearchRouter({
        db,
        authenticate: authenticateToken,
        loadActiveTenantAuthority: async () => {
            throw new Error('tenant authority must not resolve for an anonymous caller');
        },
        resolveStudentViewer: async () => {
            throw new Error('student workspace must not resolve for an anonymous caller');
        },
    }));
    app.use('/api/tenant-exports', createTenantExportRouter({
        db,
        authenticate: authenticateToken,
        requirePlatformPermission: () => () => {
            throw new Error('platform permission guard must not run for an anonymous caller');
        },
        hasPlatformPermission: async () => {
            throw new Error('platform permission must not resolve for an anonymous caller');
        },
        tenantOwnerTenantId: async () => {
            throw new Error('tenant ownership must not resolve for an anonymous caller');
        },
        storage: {
            write: async () => {
                throw new Error('export storage must not be written for an anonymous caller');
            },
            read: async () => {
                throw new Error('export storage must not be read for an anonymous caller');
            },
        },
        secret: 'm8-mounting-test-export-secret-0123456789abcdef',
    }));
    app.use((_req, res) => {
        res.status(404).json({ error: 'Route not found' });
    });

    return { app, storageCalls: db.calls, readinessChecks: () => readinessRuns };
}

/** Invoke the assembled surface with a response that models header + send. */
async function invokeM8(app: Router, request: M8Request): Promise<M8Response> {
    const parsed = new URL(request.url, 'http://m8.invalid');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers ?? {})) {
        headers[key.toLowerCase()] = value;
    }
    const response: M8Response = {
        headers,
        status(code) { response.statusCode = code; return response; },
        json(payload) {
            if (response.statusCode === undefined) response.statusCode = 200;
            response.body = payload;
            return response;
        },
        send(payload) {
            if (response.statusCode === undefined) response.statusCode = 200;
            response.text = typeof payload === 'string' ? payload : String(payload);
            return response;
        },
        set(header, value) { response.headers[header.toLowerCase()] = value; return response; },
        setHeader(header, value) { response.headers[header.toLowerCase()] = value; return response; },
        on() { return response; },
    };
    const req: Record<string, unknown> = {
        method: request.method,
        url: request.url,
        originalUrl: request.url,
        headers,
        body: request.body ?? {},
        query: Object.fromEntries(parsed.searchParams.entries()),
        params: {},
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
    };
    await (app as unknown as (r: unknown, s: unknown, n: () => void) => Promise<void>)(req, response, () => {});
    const deadline = Date.now() + 5000;
    while (response.statusCode === undefined && response.body === undefined && response.text === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
}

test('mounting (M8): search and tenant-export deny an anonymous caller without touching storage', async () => {
    const surface = await buildM8Surface({ metricsToken: M8_METRICS_TOKEN });
    const probes: M8Request[] = [
        { method: 'GET', url: '/api/search?q=math&kind=courses' },
        { method: 'GET', url: '/api/tenant-exports' },
        { method: 'POST', url: '/api/tenant-exports', body: { reason: 'anonymous' } },
    ];
    for (const probe of probes) {
        const res = await invokeM8(surface.app, probe);
        assert.equal(res.statusCode, 401, `${probe.method} ${probe.url} must deny an anonymous caller`);
        assert.equal(surface.storageCalls(), 0, `${probe.method} ${probe.url} touched storage before denying`);
    }
});

test('mounting (M8): /healthz and /readyz answer anonymously while /metrics needs METRICS_TOKEN', async () => {
    const surface = await buildM8Surface({ metricsToken: M8_METRICS_TOKEN });

    const healthz = await invokeM8(surface.app, { method: 'GET', url: '/healthz' });
    assert.equal(healthz.statusCode, 200, '/healthz is liveness and must answer without auth');
    assert.deepEqual(healthz.body, { status: 'ok' });
    assert.equal(surface.readinessChecks(), 0, 'liveness must not run dependency checks');

    const readyz = await invokeM8(surface.app, { method: 'GET', url: '/readyz' });
    assert.equal(readyz.statusCode, 200, '/readyz is readiness and must answer without auth');
    assert.deepEqual(readyz.body, { status: 'ready' });
    assert.equal(surface.readinessChecks(), 1, 'readiness must run the injected dependency checks');

    const anonymousScrape = await invokeM8(surface.app, { method: 'GET', url: '/metrics' });
    assert.equal(anonymousScrape.statusCode, 401, '/metrics must deny a scrape with no bearer');
    assert.equal(anonymousScrape.text, undefined, 'a denied scrape must not render metrics');

    const wrongBearer = await invokeM8(surface.app, {
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer not-the-configured-token' },
    });
    assert.equal(wrongBearer.statusCode, 401, '/metrics must deny a wrong bearer');
    assert.equal(wrongBearer.text, undefined, 'a denied scrape must not render metrics');

    const authorized = await invokeM8(surface.app, {
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${M8_METRICS_TOKEN}` },
    });
    assert.equal(authorized.statusCode, 200, '/metrics must answer the configured bearer');
    assert.match(authorized.text ?? '', /m8_mounting_probe_total/, 'an authorized scrape renders the registry');

    // No configured METRICS_TOKEN: the endpoint fails closed even for a bearer.
    const unconfigured = await buildM8Surface();
    const failClosed = await invokeM8(unconfigured.app, {
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${M8_METRICS_TOKEN}` },
    });
    assert.equal(failClosed.statusCode, 503, 'an unconfigured metrics endpoint must fail closed');
    assert.equal(failClosed.text, undefined, 'a fail-closed scrape must not render metrics');
    assert.equal(
        (await invokeM8(unconfigured.app, { method: 'GET', url: '/healthz' })).statusCode,
        200,
        'the health probes stay public even when metrics is unconfigured',
    );

    assert.equal(surface.storageCalls(), 0, 'the ops surface must not touch tenant storage');
    assert.equal(unconfigured.storageCalls(), 0, 'the ops surface must not touch tenant storage');
});

test('mounting (M8): ops paths stay outside /api and every request carries a correlation id', async () => {
    const { REQUEST_ID_HEADER, REQUEST_ID_PATTERN } = await import('../src/middleware/request-context');
    const surface = await buildM8Surface({ metricsToken: M8_METRICS_TOKEN });

    // The ops surface is root-mounted: /api/metrics is not a route at all.
    const apiMetrics = await invokeM8(surface.app, { method: 'GET', url: '/api/metrics' });
    assert.equal(apiMetrics.statusCode, 404, 'the metrics endpoint must not exist under /api');
    assert.deepEqual(apiMetrics.body, { error: 'Route not found' });

    // Public probes and denied /api calls alike carry a server-issued id, which
    // proves the request-context middleware runs BEFORE the /api guards.
    for (const url of ['/healthz', '/api/search?q=math', '/api/tenant-exports']) {
        const res = await invokeM8(surface.app, { method: 'GET', url });
        const requestId = res.headers[REQUEST_ID_HEADER];
        assert.equal(typeof requestId, 'string', `${url} must carry ${REQUEST_ID_HEADER}`);
        assert.match(String(requestId), REQUEST_ID_PATTERN, `${url} must carry a safe correlation id`);
    }

    // A caller-supplied id is echoed only when it is safe; an unsafe value is replaced.
    const echoed = await invokeM8(surface.app, {
        method: 'GET',
        url: '/healthz',
        headers: { [REQUEST_ID_HEADER]: 'caller-supplied-id-123' },
    });
    assert.equal(echoed.headers[REQUEST_ID_HEADER], 'caller-supplied-id-123');

    const replaced = await invokeM8(surface.app, {
        method: 'GET',
        url: '/healthz',
        headers: { [REQUEST_ID_HEADER]: 'bad id, with spaces' },
    });
    assert.notEqual(replaced.headers[REQUEST_ID_HEADER], 'bad id, with spaces');
    assert.match(String(replaced.headers[REQUEST_ID_HEADER]), REQUEST_ID_PATTERN);

    assert.equal(surface.storageCalls(), 0, 'probing the surface must not reach storage');
});
