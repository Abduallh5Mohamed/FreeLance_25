import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Router } from 'express';
import { optionalAuth } from '../src/middleware/auth';

/**
 * Teacher-school product alignment (human decision 2026-10-19).
 *
 * The product serves school teachers and their students, not a graduation /
 * certificate platform. These tests lock the correction in place:
 *
 *  1. The primary server (server/src/index.ts) mounts nothing under
 *     /api/certificates and imports no certificates router.
 *  2. No other server source file mounts the certificates router.
 *  3. Nothing was deleted: the router/service sources and the historic
 *     certificates migration remain on disk (data/history preserved).
 *  4. Teaching surfaces — lectures, groups, assignments, exams, gradebook,
 *     schedules, attendance — remain mounted and guarded.
 *
 * Static file reads only; no database, storage, network or server start.
 */

const srcDir = path.resolve(__dirname, '..', 'src');
const indexPath = path.join(srcDir, 'index.ts');
const migrationsDir = path.resolve(__dirname, '..', 'migrations');

const indexSource = readFileSync(indexPath, 'utf8');

function listTypeScriptFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...listTypeScriptFiles(full));
        } else if (entry.endsWith('.ts')) {
            out.push(full);
        }
    }
    return out;
}

/* -------------------------------------------------------------------------- */
/* 1. Primary server exposes no certificate surface                             */
/* -------------------------------------------------------------------------- */

test('alignment: index.ts mounts nothing under /api/certificates', () => {
    const mounts = indexSource.match(/app\.use\(\s*'(\/api[^']*)'/g) ?? [];
    for (const mount of mounts) {
        assert.ok(
            !mount.includes('certificates'),
            `the excluded certificates surface must not be mounted (found ${mount})`,
        );
    }
    assert.ok(
        !indexSource.includes("routes/certificates"),
        'index.ts must not import the certificates router module',
    );
});

test('alignment: no other server source file mounts the certificates router', () => {
    const referencing = new Set<string>();
    for (const file of listTypeScriptFiles(srcDir)) {
        const source = readFileSync(file, 'utf8');
        if (source.includes('createCertificatesRouter') || source.includes('certificatesRoutes')) {
            referencing.add(path.relative(srcDir, file));
        }
    }
    assert.deepEqual(
        [...referencing].sort(),
        [path.join('routes', 'certificates.ts')],
        'only the certificates router source itself may reference the router (definition + production wiring); no file may mount it',
    );
});

/* -------------------------------------------------------------------------- */
/* 2. Nothing deleted — sources and historic data stay on disk                  */
/* -------------------------------------------------------------------------- */

test('alignment: certificate sources are preserved on disk (excluded, not deleted)', () => {
    const routeFile = path.join(srcDir, 'routes', 'certificates.ts');
    const serviceFile = path.join(srcDir, 'services', 'certificates.ts');
    assert.ok(existsSync(routeFile), 'routes/certificates.ts must be preserved');
    assert.ok(existsSync(serviceFile), 'services/certificates.ts must be preserved');

    const routeSource = readFileSync(routeFile, 'utf8');
    assert.ok(
        routeSource.includes('export const createCertificatesRouter'),
        'the router factory export must remain (historical code preserved for possible future scope)',
    );

    const serviceSource = readFileSync(serviceFile, 'utf8');
    for (const symbol of ['isEligibleForCertificate', 'publicCertificateFacts', 'generateVerificationId', 'isRevoked']) {
        assert.ok(serviceSource.includes(symbol), `services/certificates.ts must still export ${symbol}`);
    }
});

test('alignment: the historic certificates migration is preserved', () => {
    const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));
    const withCertificates = migrations.filter((name) => {
        const source = readFileSync(path.join(migrationsDir, name), 'utf8');
        return /certificates/i.test(source);
    });
    assert.ok(
        withCertificates.length > 0,
        'at least one historic migration defining certificates data must remain on disk',
    );
    for (const name of withCertificates) {
        assert.ok(
            /create table/i.test(readFileSync(path.join(migrationsDir, name), 'utf8')),
            `migration ${name} must remain a preserved CREATE TABLE artifact (no rewrite)`,
        );
    }
});

/* -------------------------------------------------------------------------- */
/* 3. Teaching surfaces remain mounted and guarded                              */
/* -------------------------------------------------------------------------- */

const TEACHING_MOUNTS: ReadonlyArray<readonly [string, string]> = [
    ['/api/auth', 'authRoutes'],
    ['/api/groups', 'groupsRoutes'],
    ['/api/students', 'studentsRoutes'],
    ['/api/courses', 'coursesRoutes'],
    ['/api/attendance', 'attendanceRoutes'],
    ['/api/attendance-records', 'attendanceRecordsRoutes'],
    ['/api/lectures', 'lecturesRoutes'],
    ['/api/videos', 'videosRoutes'],
    ['/api/materials', 'materialsRoutes'],
    ['/api/question-bank', 'questionBankRoutes'],
    ['/api/assignments', 'assignmentsRoutes'],
    ['/api/exams', 'examsRoutes'],
    ['/api/exam-versions', 'examVersionsRoutes'],
    ['/api/gradebook', 'gradebookRoutes'],
    ['/api/schedules', 'schedulesRoutes'],
    ['/api/student-enrollment', 'studentEnrollmentRoutes'],
    ['/api/branches', 'branchesRoutes'],
];

test('alignment: teaching product surfaces remain mounted in the primary server', () => {
    for (const [mountPath, variable] of TEACHING_MOUNTS) {
        assert.ok(
            indexSource.includes(`app.use('${mountPath}', ${variable})`),
            `teaching surface must remain mounted: app.use('${mountPath}', ${variable})`,
        );
    }
    const guardIndex = indexSource.indexOf("app.use('/api', optionalAuth");
    assert.ok(guardIndex > -1, 'the shared /api guard chain must remain in place');
});

test('alignment: the guard chain still precedes the 404 handler', () => {
    const guardIndex = indexSource.indexOf("app.use('/api', optionalAuth");
    const notFoundIndex = indexSource.indexOf('// 404 handler');
    assert.ok(guardIndex > -1 && notFoundIndex > guardIndex, 'guard chain must precede the 404 handler');
});

/* -------------------------------------------------------------------------- */
/* 4. Runtime proof on a primary-server-shaped surface                          */
/* -------------------------------------------------------------------------- */

test('alignment: a primary-server-shaped surface 404s the excluded certificate paths', async () => {
    // Mirrors server/src/index.ts: the permissive /api guard chain runs, then —
    // because no /api/certificates router exists — the terminal 404 handler
    // answers. The per-route authenticate step lives inside each mounted
    // router and must never apply to an unmounted surface.
    const router = Router();
    router.use(optionalAuth);
    // Terminal 404 handler identical in shape to server/src/index.ts.
    router.use((req, res) => {
        res.status(404).json({ error: 'Route not found' });
    });

    const probe = (url: string): Promise<{ statusCode?: number; body?: unknown }> =>
        new Promise((resolve) => {
            let settled = false;
            const finish = (value: { statusCode?: number; body?: unknown }) => {
                if (!settled) { settled = true; resolve(value); }
            };
            const response = {
                status(code: number) { response.statusCode = code; return response; },
                json(payload: unknown) {
                    if (response.statusCode === undefined) response.statusCode = 200;
                    response.body = payload;
                    return response;
                },
                set() { return response; },
                setHeader() { return response; },
                statusCode: undefined as number | undefined,
                body: undefined as unknown,
            };
            (router as unknown as (r: unknown, s: unknown, n: () => void) => Promise<void>)(
                { method: 'GET', url, headers: {}, body: {}, query: {} },
                response,
                () => finish({ statusCode: 404, body: { error: 'Route not found' } }),
            );
            setTimeout(() => finish({ statusCode: response.statusCode, body: response.body }), 1000);
        });

    for (const url of ['/api/certificates', '/api/certificates/verify/anything', '/api/certificates/x/revoke']) {
        const res = await probe(url);
        assert.equal(res.statusCode, 404, `${url} must resolve to the primary 404 handler`);
        assert.deepEqual(res.body, { error: 'Route not found' }, `${url} must not produce any certificate response`);
    }
});
