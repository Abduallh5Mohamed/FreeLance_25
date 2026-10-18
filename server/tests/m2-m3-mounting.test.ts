import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Router } from 'express';
import { authenticateToken, optionalAuth } from '../src/middleware/auth';
import { enforceTenantAuthorityBoundary } from '../src/middleware/tenant-authority-boundary';
import { enforceStudentWorkspaceBoundary } from '../src/middleware/student-workspace-boundary';
import { createContentAccessRouter } from '../src/routes/content-access';
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
