import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { before, after } from 'node:test';
import jwt from 'jsonwebtoken';
import mysql from 'mysql2/promise';

dotenv.config({ path: path.resolve(process.cwd(), '../.env.m1'), override: true });
const database = process.env.DB_NAME;
const port = Number(process.env.DB_PORT);
const baseUrl = process.env.M1_API_BASE_URL || 'http://127.0.0.1:3188';
const tenantA = 'a0000000-0000-4000-8000-000000000001';
const tenantB = 'b0000000-0000-4000-8000-000000000001';
const apiUserA = 'm1-a-teacher';
const apiUserB = 'm1-b-teacher';
const secret = process.env.JWT_SECRET || '';
let pool: mysql.Pool;
let courseA = '';
let courseB = '';
let videoB = '';
let fileId = '';
let paymentRequestB = '';
let fileDiskPath = '';

function token(userId: string, tenantId: string) {
    return jwt.sign({ id: userId, role: 'teacher', tenant_id: tenantId }, secret, { expiresIn: '5m' });
}

async function api(method: string, route: string, jwtToken?: string, body?: unknown) {
    const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
            ...(jwtToken ? { authorization: `Bearer ${jwtToken}` } : {}),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response;
}

before(async () => {
    assert.equal(database, 'tabweb_m1_test', 'M1 integration tests refuse non-isolated databases');
    assert.ok(port === 13316, 'M1 integration tests require compose MySQL on port 13316');
    assert.ok(secret.length >= 32, 'M1 test JWT secret is missing');
    pool = mysql.createPool({
        host: process.env.DB_HOST || '127.0.0.1', port, user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || process.env.MYSQL_ROOT_PASSWORD, database,
        connectionLimit: 2,
    });
    await pool.query('SELECT 1');
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200, 'Start the M1 API before running this suite');

    const [aRows] = await pool.query<any[]>('SELECT id FROM tenant_memberships WHERE tenant_id=? AND user_id=? AND status=\'active\'', [tenantA, apiUserA]);
    const [bRows] = await pool.query<any[]>('SELECT id FROM tenant_memberships WHERE tenant_id=? AND user_id=? AND status=\'active\'', [tenantB, apiUserB]);
    assert.equal(aRows.length, 1, 'Run npm run seed:m1 first');
    assert.equal(bRows.length, 1, 'Run npm run seed:m1 first');
});

after(async () => {
    if (!pool) return;
    if (courseA) await pool.execute('DELETE FROM courses WHERE id=?', [courseA]);
    if (courseB) await pool.execute('DELETE FROM courses WHERE id=?', [courseB]);
    if (videoB) await pool.execute('DELETE FROM videos WHERE id=? AND tenant_id=?', [videoB, tenantB]);
    if (fileId) await pool.execute('DELETE FROM tenant_media_files WHERE id=? AND tenant_id=?', [fileId, tenantA]);
    if (paymentRequestB) await pool.execute('DELETE FROM payment_requests WHERE id=? AND tenant_id=?', [paymentRequestB, tenantB]);
    if (fileDiskPath) await rm(fileDiskPath, { force: true });
    await pool.end();
});

test('API read/write endpoints keep Tenant A from Tenant B records and ignore supplied selectors', async () => {
    const tokenA = token(apiUserA, tenantA);
    const tokenB = token(apiUserB, tenantB);
    const create = async (jwtToken: string, name: string) => {
        const response = await api('POST', '/api/courses', jwtToken, { name, subject: 'M1 test' });
        assert.equal(response.status, 201);
        return (await response.json() as { id: string }).id;
    };
    courseA = await create(tokenA, 'M1 A isolation course');
    courseB = await create(tokenB, 'M1 B isolation course');
    assert.equal((await api('GET', `/api/courses/${courseB}`, tokenA)).status, 404);
    assert.equal((await api('PUT', `/api/courses/${courseB}`, tokenA, { name: 'Tamper', subject: 'test' })).status, 404);
    assert.equal((await api('DELETE', `/api/courses/${courseB}`, tokenA)).status, 404);
    assert.equal((await api('POST', '/api/courses', tokenA, { name: 'Spoof', subject: 'test', tenant_id: tenantB })).status, 400);
    assert.equal((await api('GET', '/api/courses', tokenA)).status, 200);

    paymentRequestB = randomUUID();
    await pool.execute(
        `INSERT INTO payment_requests (id,tenant_id,student_id,student_name,grade_id,group_id,amount,status)
         VALUES (?,?,?,?,?,?,?,'pending')`,
        [paymentRequestB, tenantB, 'm1-b-student', 'Tenant B Student', 'grade-b', 'group-b', 100]
    );
    const crossTenantList = await api('GET', '/api/payment-requests?student_id=m1-b-student', tokenA);
    assert.equal(crossTenantList.status, 200);
    assert.deepEqual(await crossTenantList.json(), []);
    const crossTenantCreate = await api('POST', '/api/payment-requests', tokenA, {
        student_id: 'm1-b-student', grade_id: 'grade-b', group_id: 'group-b', amount: 100,
    });
    assert.equal(crossTenantCreate.status, 404);
});

test('file download requires authentication and matching tenant', async () => {
    const id = randomUUID();
    const relativePath = path.join('uploads', 'm1-test', `${id}.txt`).replace(/\\/g, '/');
    fileDiskPath = path.resolve(relativePath);
    await mkdir(path.dirname(fileDiskPath), { recursive: true });
    await writeFile(fileDiskPath, 'tenant A fixture');
    fileId = id;
    await pool.execute(
        `INSERT INTO tenant_media_files (id,tenant_id,uploaded_by,storage_path,original_name,mime_type,byte_size)
         VALUES (?,?,?,?,?,?,?)`,
        [id, tenantA, apiUserA, relativePath, 'fixture.txt', 'text/plain', 16]
    );
    assert.equal((await api('GET', `/api/files/${id}/download`)).status, 401);
    assert.equal((await api('GET', `/api/files/${id}/download`, token(apiUserB, tenantB))).status, 404);
    const allowed = await api('GET', `/api/files/${id}/download`, token(apiUserA, tenantA));
    assert.equal(allowed.status, 200);
    assert.equal(await allowed.text(), 'tenant A fixture');
});

test('video session token issuance and background processing reject another tenant video', async () => {
    assert.ok(courseB);
    videoB = randomUUID();
    await pool.execute(
        `INSERT INTO videos (id,course_id,tenant_id,uploaded_by,title,status,original_key)
         VALUES (?,?,?,?,?,'ready','m1-b/original.mp4')`,
        [videoB, courseB, tenantB, apiUserB, 'M1 B video']
    );
    const session = await api('POST', '/api/secure-video/session', token(apiUserA, tenantA), {
        videoId: videoB, fingerprint: 'm1-device', screenRes: '1920x1080',
    });
    assert.equal(session.status, 404);
    const { processVideo } = await import('../../src/services/video-processor');
    await assert.rejects(processVideo(videoB, tenantA), /outside the requested tenant/);
});
