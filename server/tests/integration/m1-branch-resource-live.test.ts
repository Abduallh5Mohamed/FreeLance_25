import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import jwt from 'jsonwebtoken';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { assertSafeM1TestTarget, resolveM1EnvPath } from '../m1-test-target-safety';

/**
 * Live branch-resource evidence against the owned isolated stack only.
 * The suite is intentionally not part of `npm test`; the isolated runner
 * starts the API and supplies the private env file.
 */
dotenv.config({ path: resolveM1EnvPath(__dirname, process.env.M1_TEST_ENV_FILE), override: true });

const target = assertSafeM1TestTarget({
    dbName: process.env.DB_NAME,
    dbPort: process.env.DB_PORT,
    dbHost: process.env.DB_HOST,
    apiBaseUrl: process.env.M1_API_BASE_URL,
    jwtSecret: process.env.JWT_SECRET,
});
const database = target.database;
const baseUrl = target.baseUrl;
const secret = process.env.JWT_SECRET || '';

const TENANT_A = 'a0000000-0000-4000-8000-000000000001';
const TENANT_B = 'b0000000-0000-4000-8000-000000000001';
const BRANCH_A = 'd0000000-0000-4000-8000-000000000001';
const BRANCH_B = 'd0000000-0000-4000-8000-000000000002';
const GROUP_A = 'f0000000-0000-4000-8000-000000000001';
const GROUP_B = 'f0000000-0000-4000-8000-000000000002';
const TEACHER_A = 'm1-a-teacher';
const TEACHER_B = 'm1-b-teacher';
const STUDENT_A = 'm1-a-student';

let pool: mysql.Pool;
let lectureId = '';
let tenantGroupId = '';

const token = (userId: string, role: string, tenantId: string, extra: Record<string, unknown> = {}) =>
    jwt.sign({ id: userId, role, tenant_id: tenantId, ...extra }, secret, { expiresIn: '5m' });

async function api(method: string, route: string, jwtToken?: string, body?: unknown) {
    return fetch(`${baseUrl}${route}`, {
        method,
        redirect: 'manual',
        headers: {
            ...(jwtToken ? { authorization: `Bearer ${jwtToken}` } : {}),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

before(async () => {
    assert.equal(database, 'tabweb_m1_test');
    assert.ok(secret.length >= 32);
    pool = mysql.createPool({
        host: target.dbHost, port: target.dbPort, user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || process.env.MYSQL_ROOT_PASSWORD, database,
        connectionLimit: 2,
    });
    await pool.query('SELECT 1');
    const health = await fetch(`${baseUrl}/health`, { redirect: 'manual' });
    assert.equal(health.status, 200, 'Start the M1 API before running this suite');
    const [rows] = await pool.query<any[]>('SELECT id FROM branches WHERE id IN (?,?)', [BRANCH_A, BRANCH_B]);
    assert.equal(rows.length, 2, 'Run npm run seed:m1 first');
});

after(async () => {
    if (!pool) return;
    if (lectureId) await pool.execute('DELETE FROM lectures WHERE id=?', [lectureId]);
    if (tenantGroupId) await pool.execute('DELETE FROM `groups` WHERE id=?', [tenantGroupId]);
    // Restore the seed row exactly as the seed left it.
    await pool.execute('UPDATE students SET group_id=NULL WHERE id=?', [STUDENT_A]);
    await pool.execute("UPDATE branch_memberships SET status='active', version=0 WHERE branch_id=? AND user_id=?", [BRANCH_A, TEACHER_A]);
    await pool.execute("UPDATE branches SET status='active', version=0 WHERE id=?", [BRANCH_A]);
    await pool.end();
});

test('branch-owned group: member reads, same-tenant non-member and cross-tenant are denied', async () => {
    const member = await api('GET', `/api/groups/${GROUP_A}`, token(TEACHER_A, 'instructor', TENANT_A));
    assert.equal(member.status, 200);

    const crossTenant = await api('GET', `/api/groups/${GROUP_A}`, token(TEACHER_B, 'instructor', TENANT_B));
    assert.equal(crossTenant.status, 404);

    // Remove the branch membership and prove the very next request is denied.
    await pool.execute("UPDATE branch_memberships SET status='revoked', version=version+1 WHERE branch_id=? AND user_id=?", [BRANCH_A, TEACHER_A]);
    const revoked = await api('GET', `/api/groups/${GROUP_A}`, token(TEACHER_A, 'instructor', TENANT_A));
    assert.equal(revoked.status, 403);
    await pool.execute("UPDATE branch_memberships SET status='active', version=version+1 WHERE branch_id=? AND user_id=?", [BRANCH_A, TEACHER_A]);

    // Suspending the branch denies the next request too.
    await pool.execute("UPDATE branches SET status='suspended', version=version+1 WHERE id=?", [BRANCH_A]);
    const suspended = await api('GET', `/api/groups/${GROUP_A}`, token(TEACHER_A, 'instructor', TENANT_A));
    assert.equal(suspended.status, 403);
    await pool.execute("UPDATE branches SET status='active', version=version+1 WHERE id=?", [BRANCH_A]);
});

test('a branch-owned lecture derives its branch and rejects a forged selector', async () => {
    const created = await api('POST', '/api/lectures', token(TEACHER_A, 'instructor', TENANT_A), {
        course_id: 'e0000000-0000-4000-8000-000000000001',
        group_id: GROUP_A,
        title: 'M1 live branch lecture',
        video_url: 'video://m1-live-branch',
        price: 10,
        is_published: true,
    });
    assert.equal(created.status, 201);
    lectureId = (await created.json() as { id: string }).id;

    const read = await api('GET', `/api/lectures/${lectureId}`, token(TEACHER_A, 'instructor', TENANT_A));
    assert.equal(read.status, 200);

    const forged = await api('GET', `/api/lectures/${lectureId}?branch_id=${BRANCH_B}`, token(TEACHER_A, 'instructor', TENANT_A));
    assert.equal(forged.status, 403);

    const crossTenant = await api('GET', `/api/lectures/${lectureId}`, token(TEACHER_B, 'instructor', TENANT_B));
    assert.equal(crossTenant.status, 404);
});

test('a branch-scoped student token is revoked on the next request after membership revocation', async () => {
    await pool.execute('UPDATE students SET group_id=? WHERE id=?', [GROUP_A, STUDENT_A]);
    const studentLogin = token(STUDENT_A, 'student', TENANT_A, { student_enrollment_id: STUDENT_A });
    const selected = await api('POST', `/api/student-enrollment/spaces/${STUDENT_A}/select`, studentLogin, { branch_id: BRANCH_A });
    assert.equal(selected.status, 200);
    const scoped = (await selected.json() as { token: string }).token;
    const decoded = jwt.verify(scoped, secret) as { branch_id?: string; branch_membership_version?: number };
    assert.equal(decoded.branch_id, BRANCH_A);
    assert.equal(typeof decoded.branch_membership_version, 'number');

    assert.equal((await api('GET', `/api/groups/${GROUP_A}`, scoped)).status, 200);

    await pool.execute("UPDATE branch_memberships SET status='revoked', version=version+1 WHERE branch_id=? AND user_id=?", [BRANCH_A, STUDENT_A]);
    const revoked = await api('GET', `/api/groups/${GROUP_A}`, scoped);
    assert.equal(revoked.status, 401);
    assert.equal((await revoked.json() as { code?: string }).code, 'BRANCH_REVOKED');
    await pool.execute("UPDATE branch_memberships SET status='active', version=version+1 WHERE branch_id=? AND user_id=?", [BRANCH_A, STUDENT_A]);
});

test('explicit tenant-level creation stays accessible and a branch selector cannot be invented', async () => {
    const created = await api('POST', '/api/groups', token(TEACHER_A, 'instructor', TENANT_A), {
        name: 'M1 live tenant-level group',
        course_id: 'e0000000-0000-4000-8000-000000000001',
    });
    assert.equal(created.status, 201);
    tenantGroupId = (await created.json() as { id: string }).id;
    const row = await pool.query<any[]>('SELECT branch_scope, branch_id FROM `groups` WHERE id=?', [tenantGroupId]);
    assert.equal(row[0][0].branch_scope, 'tenant');
    assert.equal(row[0][0].branch_id, null);

    const read = await api('GET', `/api/groups/${tenantGroupId}`, token(TEACHER_A, 'instructor', TENANT_A));
    assert.equal(read.status, 200);

    // A selector on a tenant-level group is a context mismatch, not a branch.
    const selected = await api('GET', `/api/groups/${tenantGroupId}?branch_id=${BRANCH_A}`, token(TEACHER_A, 'instructor', TENANT_A));
    assert.equal(selected.status, 403);
});

test('branch administration creates, audits and reports without inventing ownership', async () => {
    const ownerToken = token(TEACHER_A, 'instructor', TENANT_A);
    const created = await api('POST', '/api/branches', ownerToken, { name: `M1 live branch ${Date.now()}` });
    assert.equal(created.status, 201);
    const branch = await created.json() as { id: string; tenant_id: string };
    assert.equal(branch.tenant_id, TENANT_A);

    const list = await api('GET', '/api/branches', ownerToken);
    assert.equal(list.status, 200);
    assert.ok((await list.json() as Array<{ id: string }>).some((row) => row.id === branch.id));

    const audit = await pool.query<any[]>(
        'SELECT action FROM branch_audit_log WHERE branch_id=? AND action=?',
        [branch.id, 'branch.created'],
    );
    assert.equal(audit[0].length, 1);

    const quarantine = await api('GET', '/api/branches/quarantine', ownerToken);
    assert.equal(quarantine.status, 200);
    const report = await quarantine.json() as { rows: Array<{ reason: string }>; note: string };
    assert.ok(Array.isArray(report.rows));
    assert.match(report.note, /no branch is inferred/i);

    // Clean up the live-created branch (no memberships were added to it).
    await pool.execute('DELETE FROM branch_audit_log WHERE branch_id=?', [branch.id]);
    await pool.execute('DELETE FROM branches WHERE id=?', [branch.id]);
});

test('real video session and refresh enforce legacy, missing context and live branch revocation', async () => {
    assert.ok(lectureId, 'the branch-owned lecture fixture must exist');
    const videoId = randomUUID();
    const teacher = token(TEACHER_A, 'instructor', TENANT_A);
    const binding = { fingerprint: 'm1-native-branch-proof', screenRes: '1920x1080' };
    const issue = (extra: Record<string, unknown> = {}) => api('POST', '/api/secure-video/session', teacher,
        { videoId, ...binding, ...extra });
    const refresh = (sessionId: string) => api('POST', '/api/secure-video/refresh-token', teacher,
        { sessionId, ...binding });
    await pool.execute(
        `INSERT INTO videos (id, course_id, lecture_id, tenant_id, uploaded_by, title, status,
         original_key, hls_key, is_encrypted) VALUES (?,?,?,?,?,?,'ready',?,?,1)`,
        [videoId, 'e0000000-0000-4000-8000-000000000001', lectureId, TENANT_A, TEACHER_A,
            'M1 native branch video', 'test-only/original.mp4', 'test-only/hls/playlist.m3u8'],
    );
    try {
        const allowed = await issue();
        assert.equal(allowed.status, 200, await allowed.clone().text());
        const session = await allowed.json() as { sessionId: string; sessionToken: string };
        assert.ok(session.sessionId);
        assert.ok(session.sessionToken);
        assert.equal((await refresh(session.sessionId)).status, 200);
        assert.equal((await issue({ branch_id: BRANCH_B })).status, 403);

        // Retained JWT plus no selector must not bypass an immediately revoked membership.
        await pool.execute("UPDATE branch_memberships SET status='revoked', version=version+1 WHERE branch_id=? AND user_id=?",
            [BRANCH_A, TEACHER_A]);
        assert.equal((await issue()).status, 403);
        assert.equal((await refresh(session.sessionId)).status, 403);
        await pool.execute("UPDATE branch_memberships SET status='active', version=version+1 WHERE branch_id=? AND user_id=?",
            [BRANCH_A, TEACHER_A]);
        assert.equal((await refresh(session.sessionId)).status, 200);

        // A legacy/unclassified parent must deny even the tenant owner on both actual routes.
        await pool.execute("UPDATE `groups` SET branch_scope='unassigned', branch_id=NULL WHERE id=?", [GROUP_A]);
        const legacy = await issue();
        assert.equal(legacy.status, 403);
        assert.equal((await legacy.json() as { code?: string }).code, 'BRANCH_CONTEXT_AMBIGUOUS');
        assert.equal((await refresh(session.sessionId)).status, 403);
        await pool.execute("UPDATE `groups` SET branch_scope='branch', branch_id=? WHERE id=?", [BRANCH_A, GROUP_A]);

        // A supplied dangling lecture must deny even alongside a valid course.
        // course_id is NOT NULL in the actual schema; no constraint is disabled for this test.
        await pool.execute('UPDATE videos SET lecture_id=? WHERE id=?', [randomUUID(), videoId]);
        assert.equal((await issue()).status, 403);
        assert.equal((await refresh(session.sessionId)).status, 403);

        // A proven standalone tenant course remains usable without guessing one of its groups.
        await pool.execute('UPDATE videos SET lecture_id=NULL, course_id=? WHERE id=?',
            ['e0000000-0000-4000-8000-000000000001', videoId]);
        const tenantSessionResponse = await issue();
        assert.equal(tenantSessionResponse.status, 200);
        const tenantSession = await tenantSessionResponse.json() as { sessionId: string };
        // Issuing a new session may retire the previous one under device concurrency policy.
        assert.equal((await refresh(tenantSession.sessionId)).status, 200);
    } finally {
        await pool.execute("UPDATE `groups` SET branch_scope='branch', branch_id=? WHERE id=?", [BRANCH_A, GROUP_A]);
        await pool.execute("UPDATE branch_memberships SET status='active', version=version+1 WHERE branch_id=? AND user_id=?",
            [BRANCH_A, TEACHER_A]);
        await pool.execute('DELETE FROM video_access_logs WHERE video_id=?', [videoId]);
        await pool.execute('DELETE FROM videos WHERE id=?', [videoId]);
    }
});

test('production pending video queue SELECT executes with MySQL prepared LIMIT binding', async () => {
    const { createPendingVideoJobLoader } = await import('../../src/routes/videos');
    const jobs = await createPendingVideoJobLoader(async (sql, params) => {
        const [rows] = await pool.execute<mysql.RowDataPacket[]>(sql, params);
        return rows as Array<mysql.RowDataPacket & { video_id: string; tenant_id: string | null }>;
    }, { batchSize: 3 })();
    assert.ok(Array.isArray(jobs));
    assert.ok(jobs.length <= 3);
});
