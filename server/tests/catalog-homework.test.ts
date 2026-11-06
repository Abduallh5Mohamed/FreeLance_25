import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, id, principal, scope } from './helpers/student-activity-fixture';
import { makeReq, runChain, withSilencedErrors } from './helpers/m2-course-lessons-harness';
import { createAssignmentsRouter, type AssignmentsDataAccess } from '../src/routes/assignments';
import { createCatalogHomeworkAuthority, parseHomeworkContext } from '../src/services/catalog-homework-access';
import type { AssignmentObjectStore } from '../src/services/assignment-storage';
function world(options: {
    configured?: boolean;
    scanner?: boolean;
} = {}) {
    const base = fixture(), authority = createCatalogHomeworkAuthority();
    const s = { ...base.s, contextSchema: true, requestIndex: true, markerType: 'json', etagCollation: 'utf8mb4_0900_bin', rows: [] as any[], writes: [] as string[], audits: [] as any[], signs: 0, stats: 0, prefixes: 0, scans: 0, failCommit: false, failAudit: false, beforeWrite: null as null | (() => void), afterSign: null as null | (() => void), afterScan: null as null | (() => void),
        clock: '2026-11-06T12:00:00Z', assignment: { ...base.s.assignments[0], instructions: 'حل الواجب', deadline_at: null as string | null, deadline_timezone: 'UTC', late_policy: 'block', resubmission_policy: 'allow', max_submissions: 5, max_file_bytes: 100000, allowed_file_types: '["pdf"]', version: 0, created_by: 'teacher' } };
    const sync = () => { for (const key of ['active', 'suspended', 'version', 'enrolled', 'course', 'lesson', 'released', 'prerequisite', 'schema', 'indexes', 'engine', 'groupCount', 'group', 'bindings', 'assignments', 'exams', 'audiences'])
        (base.s as any)[key] = (s as any)[key]; };
    const query = async (sql: string, p: any[] = []): Promise<any[]> => {
        sync();
        const q = sql.replace(/\s+/g, ' ').trim();
        if (q.includes('information_schema.COLUMNS') && q.includes("TABLE_NAME='assignment_submissions'")) {
            if (q.includes("TABLE_NAME='course_lesson_activities'"))
                return [{ table_name: 'course_lesson_activities', column_name: 'assignment_id' }, { table_name: 'course_lesson_activities', column_name: 'kind' }, ...(s.contextSchema ? [{ table_name: 'assignment_submissions', column_name: 'catalog_context', data_type: s.markerType }] : [])];
            return s.contextSchema ? [{ column_name: 'catalog_context', data_type: s.markerType }, { column_name: 'catalog_request_key', data_type: 'char', max_length: 36, collation_name: 'ascii_bin' }, { column_name: 'object_etag', data_type: 'varchar', max_length: 256, collation_name: s.etagCollation }] : [];
        }
        if (q.includes('information_schema.TABLES') && q.includes("IN ('assignment_submissions','assignments','audit_events')"))
            return ['assignment_submissions', 'assignments', 'audit_events'].map(table_name => ({ table_name, engine: s.engine }));
        if (q.includes('information_schema.STATISTICS') && q.includes("TABLE_NAME='assignment_submissions'"))
            return [['PRIMARY', ['id']], ['uq_assignment_submission_version', ['assignment_id', 'student_enrollment_id', 'version']], ...(s.requestIndex ? [['uq_catalog_homework_request', ['tenant_id', 'student_enrollment_id', 'catalog_request_key']]] : [])].flatMap(([index_name, columns]: any) => (columns as string[]).map((column_name, i) => ({ index_name, column_name, seq_in_index: i + 1, non_unique: 0 })));
        if (q.startsWith('SELECT id FROM courses'))
            return s.course ? [{ id: id(1) }] : [];
        if (q.includes('FROM students s INNER JOIN tenants') && p[0] !== scope.enrollmentId)
            return [];
        if (q.startsWith('SELECT s.id, s.tenant_id'))
            return s.enrolled && p[2] === scope.enrollmentId ? [{ id: scope.enrollmentId, tenant_id: 'tenant', group_id: id(8), branch_scope: 'tenant', branch_id: null, course_id: id(1) }] : [];
        if (q.startsWith('SELECT id FROM course_lesson_activities'))
            return s.bindings.some(row => row.assignment_id === p[0]) ? [{ id: id(3) }] : [];
        if (q.startsWith('SELECT deadline_at,late_policy') || q.startsWith('SELECT id,tenant_id,branch_id'))
            return p[0] === id(4) && p[1] === 'tenant' && s.assignment.status === 'published' ? [s.assignment] : [];
        if (q.includes('FROM assignment_submissions')) {
            let rows = s.rows;
            if (q.includes('catalog_request_key=?'))
                rows = rows.filter(row => row.tenant_id === p[0] && row.student_enrollment_id === p[1] && row.catalog_request_key === p[2]);
            else if (q.startsWith('SELECT catalog_context,student_user_id'))
                rows = rows.filter(row => row.id === p[0] && row.assignment_id === p[1] && row.tenant_id === p[2] && row.student_enrollment_id === p[3]);
            else if (q.includes('WHERE id = ?'))
                rows = rows.filter(row => row.id === p[0] && row.assignment_id === p[1] && row.tenant_id === p[2] && row.student_enrollment_id === p[3]);
            else if (q.includes('catalog_context IS NOT NULL'))
                rows = rows.filter(row => row.assignment_id === p[0] && row.catalog_context !== null);
            else
                rows = rows.filter(row => row.assignment_id === p[0] && row.tenant_id === p[1] && row.student_enrollment_id === p[2]);
            return rows.slice().sort((a, b) => b.version - a.version).slice(0, q.includes('LIMIT 1001') ? 1001 : q.includes('LIMIT 1') ? 1 : undefined);
        }
        return (await base.connection.execute(sql, p))[0] as any[];
    };
    const db: AssignmentsDataAccess = { query: query as any, queryOne: async (sql, p) => (await query(sql, p as any))[0] ?? null, execute: async (sql, p: any[] = []) => {
            const q = sql.replace(/\s+/g, ' ').trim();
            s.writes.push(q);
            if (q.startsWith('INSERT INTO assignment_submissions')) {
                assert.ok(q.includes('catalog_context,catalog_request_key'));
                if (s.rows.some(row => row.catalog_request_key === p[13]))
                    throw Object.assign(Error('duplicate'), { code: 'ER_DUP_ENTRY' });
                s.rows.push({ id: p[0], tenant_id: p[1], assignment_id: p[2], student_enrollment_id: p[3], student_user_id: p[4], version: p[5], status: p[6], file_name: p[7], file_type: p[8], file_size_bytes: p[9], storage_key: p[10], scan_status: 'pending', is_late: p[11], catalog_context: JSON.parse(p[12]), catalog_request_key: p[13], submitted_at: '2026-11-06T12:00:00Z', revoked_at: null });
            }
            else if (q.startsWith('INSERT INTO audit_events')) {
                if (s.failAudit)
                    throw Error('audit');
                s.audits.push(p);
            }
            else if (q.startsWith('UPDATE assignment_submissions') && q.includes('SET file_size_bytes=')) {
                const row = s.rows.find(row => row.id === p[3]);
                if (!row || row.file_size_bytes !== 0 || row.status === 'revoked')
                    return { affectedRows: 0 };
                Object.assign(row, { file_size_bytes: p[0], scan_status: p[1], object_etag: p[2] });
            }
            else if (q.startsWith('UPDATE assignment_submissions') && q.includes("SET status='revoked'")) {
                const row = s.rows.find(row => row.id === p[1]);
                if (!row)
                    return { affectedRows: 0 };
                row.status = 'revoked';
            }
            else
                throw Error('Unexpected synthetic mutation ' + q);
            return { affectedRows: 1 };
        } };
    let chain = Promise.resolve();
    const transaction = async <T>(work: (db: AssignmentsDataAccess) => Promise<T>) => { let unlock = () => { }; const previous = chain; chain = new Promise(resolve => { unlock = resolve; }); await previous; const before = structuredClone({ rows: s.rows, audits: s.audits }); try {
        s.beforeWrite?.();
        const result = await work(db);
        if (s.failCommit)
            throw Object.assign(Error('commit'), { committed: true });
        return result;
    }
    catch (error) {
        if (!(error as any).committed)
            Object.assign(s, before);
        throw error;
    }
    finally {
        unlock();
    } };
    const store: AssignmentObjectStore = { statObject: async () => { s.stats++; return { sizeBytes: 2048, contentType: 'application/pdf', etag: 'etag-1', lastModified: null }; }, readPrefix: async () => { s.prefixes++; return Buffer.from('%PDF-1.7\n'); }, createUploadUrl: async () => { s.signs++; s.afterSign?.(); return 'https://storage.invalid/opaque-synthetic-upload'; }, removeObject: async () => { throw Error('Mutable deletion forbidden'); }, capabilities: { conditionalDelete: true }, removeObjectVersion: async () => 'removed' };
    const cleanup: any = { availability: { mode: 'durable', reason: null }, recordPending: async () => ({ id: 'cleanup', claimVersion: 0, outcome: 'recorded' }), completeUnclaimed: async () => true };
    const deps = { db, catalog: authority, authenticate: (_q: any, _s: any, next: any) => next(), loadActiveTenantAuthority: async () => null, transaction, objectStore: store, ...(options.configured === false ? {} : { objectVersionColumn: 'declared' as const, cleanupObligations: cleanup }), ...(options.scanner ? { malwareScanner: { scan: async () => { s.scans++; s.afterScan?.(); return { verdict: 'clean' as const }; } } } : {}), now: () => new Date(s.clock) };
    const router = createAssignmentsRouter(deps), basePath = `/catalog/courses/${id(1)}/lessons/${id(2)}/activities/${id(3)}`, requestKey = id(40);
    const call = (method: string, pathName: string, body: any = {}, key: string | undefined = undefined, actor: any = principal) => { const req: any = makeReq({ method, pathName, body }); req.user = actor; if (key)
        req.headers['idempotency-key'] = key; return runChain([router], req); };
    const start = () => call('POST', basePath + '/submissions', { file_name: 'hw.pdf', file_type: 'application/pdf' }, requestKey);
    return { s, deps, db, authority, call, start, basePath, requestKey, recover: () => call('GET', basePath + '/requests/' + requestKey), mine: () => call('GET', basePath + '/submissions/mine') };
}
test('homework policy and request recovery are private bounded reads, never an upload or a submission', async () => {
    const h = world();
    const policy = await h.call('GET', h.basePath + '/submission-policy');
    assert.equal(policy.status, 200);
    assert.equal(policy.body.upload_configured, true);
    assert.equal(policy.body.accepting, true);
    assert.equal(policy.headers['Cache-Control'], 'no-store');
    assert.deepEqual((await h.recover()).body, { submission: null });
    assert.equal(h.s.signs, 0);
    assert.equal(h.s.writes.length, 0);
});
test('original submission insert/audit persists exact context and stable request key; retries/recovery never create or sign again', async () => {
    const h = world(), created = await h.start();
    assert.equal(created.status, 201);
    assert.equal(created.body.upload_status, 'pending_upload');
    assert.ok(!('assignment_id' in created.body));
    assert.equal(h.s.rows.length, 1);
    assert.equal(h.s.audits.length, 1);
    assert.equal(h.s.signs, 1);
    assert.equal(parseHomeworkContext(h.s.rows[0].catalog_context).enrollmentId, scope.enrollmentId);
    const retry = await h.start(), read = await h.recover();
    assert.equal(retry.status, 200);
    assert.equal(read.body.submission.id, created.body.id);
    assert.ok(!JSON.stringify(read.body).includes('storage_key'));
    assert.ok(!JSON.stringify(read.body).includes('catalog_context'));
    assert.equal(h.s.rows.length, 1);
    assert.equal(h.s.signs, 1);
    assert.equal(h.s.audits.length, 1);
});
for (const gate of ['released', 'prerequisite', 'enrolled', 'active', 'course'] as const)
    test(`withdrawn ${gate} denies creation and existing upload operations before provider calls`, async () => withSilencedErrors(async () => {
        const h = world();
        await h.start();
        h.s[gate] = false;
        const stats = h.s.stats, signs = h.s.signs, writes = h.s.writes.length;
        for (const suffix of ['/upload-authorization', '/finalize'])
            assert.equal((await h.call('POST', h.basePath + '/submissions/' + h.s.rows[0].id + suffix)).status, 403);
        assert.equal((await h.start()).status, 403);
        assert.equal(h.s.stats, stats);
        assert.equal(h.s.signs, signs);
        assert.equal(h.s.writes.length, writes);
    }));
test('actual guarded authorization/finalize reuses signature and scan engine; no scanner stays pending_scan', async () => {
    const h = world();
    await h.start();
    const path = h.basePath + '/submissions/' + h.s.rows[0].id;
    assert.equal((await h.call('POST', path + '/upload-authorization')).status, 200);
    const finalized = await h.call('POST', path + '/finalize');
    assert.equal(finalized.status, 202);
    assert.equal(finalized.body.upload_status, 'pending_scan');
    assert.equal(finalized.body.scan_status, 'pending');
    assert.equal(h.s.rows[0].object_etag, 'etag-1');
    const stats = h.s.stats;
    assert.equal((await h.call('POST', path + '/finalize')).status, 200);
    assert.equal(h.s.stats, stats);
    assert.equal((await h.mine()).body[0].upload_status, 'pending_scan');
});
test('clean is only returned by an injected trusted scanner, and lost finalize acknowledgement recovers stored status', async () => {
    const h = world({ scanner: true });
    await h.start();
    h.s.failCommit = true;
    const result = await h.call('POST', h.basePath + '/submissions/' + h.s.rows[0].id + '/finalize');
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'PERSISTENCE_UNCERTAIN');
    h.s.failCommit = false;
    assert.equal((await h.recover()).body.submission.upload_status, 'finalized');
    assert.equal(h.s.scans, 1);
    assert.equal(h.s.rows.length, 1);
});
test('lost creation commit response is uncertain; pure recovery finds one row and failed audit rolls back', async () => {
    const h = world();
    h.s.failCommit = true;
    const reply = await h.start();
    assert.equal(reply.body.code, 'PERSISTENCE_UNCERTAIN');
    h.s.failCommit = false;
    assert.equal((await h.recover()).body.submission.id, h.s.rows[0].id);
    assert.equal(h.s.rows.length, 1);
    const failed = world();
    failed.s.failAudit = true;
    assert.equal((await failed.start()).body.code, 'PERSISTENCE_UNCERTAIN');
    assert.equal(failed.s.rows.length, 0);
    assert.equal(failed.s.audits.length, 0);
});
test('same key cannot select another file or context, and historical unbound submissions are never attached', async () => {
    const h = world();
    await h.start();
    assert.equal((await h.call('POST', h.basePath + '/submissions', { file_name: 'other.pdf', file_type: 'application/pdf' }, h.requestKey)).status, 409);
    h.s.rows[0].catalog_context = null;
    const before = h.s.stats;
    assert.equal((await h.call('POST', h.basePath + '/submissions/' + h.s.rows[0].id + '/finalize')).status, 403);
    assert.equal(h.s.stats, before);
});
test('generic and percent-encoded assignment resource paths cannot bypass a bound homework', async () => {
    const h = world();
    for (const path of [`/${id(4)}`, `/${id(4)}/submissions`, `/%66${id(4).slice(1)}/submissions/mine`])
        assert.equal((await h.call('GET', path)).status, 403);
});
for (const absent of ['runtime', 'schema', 'requestIndex', 'markerType', 'etagCollation'])
    test(`missing or invalid ${absent} cannot activate catalog upload`, async () => {
        const h = world({ configured: absent !== 'runtime' });
        if (absent === 'schema')
            h.s.contextSchema = false;
        if (absent === 'requestIndex')
            h.s.requestIndex = false;
        if (absent === 'markerType')
            h.s.markerType = 'text';
        if (absent === 'etagCollation')
            h.s.etagCollation = 'utf8mb4_unicode_ci';
        assert.equal((await h.start()).status, 503);
        assert.equal(h.s.signs, 0);
        assert.equal(h.s.writes.length, 0);
    });
test('withdrawal after signing or at transaction entry denies without inserting or releasing an upload grant', async () => {
    const h = world();
    h.s.afterSign = () => { h.s.released = false; };
    const result = await h.start();
    assert.equal(result.status, 403);
    assert.equal(h.s.rows.length, 0);
    assert.equal(h.s.audits.length, 0);
    assert.ok(!result.body.upload);
    const j = world();
    j.s.beforeWrite = () => { j.s.active = false; };
    assert.equal((await j.start()).status, 403);
    assert.equal(j.s.rows.length, 0);
});
test('withdrawal during scanning prevents a clean verdict write and never trusts the returned scanner fact alone', async () => {
    const h = world({ scanner: true });
    await h.start();
    h.s.afterScan = () => { h.s.released = false; };
    const count = h.s.audits.length;
    assert.equal((await h.call('POST', h.basePath + '/submissions/' + h.s.rows[0].id + '/finalize')).status, 403);
    assert.equal(h.s.rows[0].file_size_bytes, 0);
    assert.equal(h.s.rows[0].scan_status, 'pending');
    assert.equal(h.s.audits.length, count);
});
test('body selectors, forged finalize facts, missing keys and wrong selected enrollment never authorize a request', async () => {
    const h = world();
    assert.equal((await h.call('POST', h.basePath + '/submissions', { file_name: 'hw.pdf', file_type: 'application/pdf' })).status, 400);
    assert.equal((await h.call('POST', h.basePath + '/submissions', { file_name: 'hw.pdf', file_type: 'application/pdf', storage_key: 'forged' }, h.requestKey)).status, 400);
    assert.equal((await h.call('GET', h.basePath + '/submission-policy', {}, undefined, { ...principal, studentEnrollmentId: 'foreign' })).status, 403);
    assert.equal(h.s.signs, 0);
    await h.start();
    assert.equal((await h.call('POST', h.basePath + '/submissions/' + h.s.rows[0].id + '/finalize', { scan_status: 'clean' })).status, 400);
    assert.equal(h.s.stats, 0);
});
test('current source deadline/policy is enforced again on write, and the history bound fails closed', async () => {
    const h = world();
    h.s.assignment.deadline_at = '2026-11-06T11:00:00Z';
    assert.equal((await h.start()).status, 403);
    assert.equal(h.s.rows.length, 0);
    const j = world();
    j.s.beforeWrite = () => { j.s.assignment.max_submissions = 1; j.s.rows.push({ id: id(80), assignment_id: id(4), tenant_id: 'tenant', student_enrollment_id: scope.enrollmentId, version: 1, status: 'submitted', file_size_bytes: 2048, submitted_at: '2026-11-06T12:00:00Z' }); };
    assert.equal((await j.start()).status, 403);
    assert.equal(j.s.audits.length, 0);
    const late=world();late.s.assignment.deadline_at='2026-11-06T12:01:00Z';late.s.assignment.late_policy='mark_late';late.s.beforeWrite=()=>{late.s.clock='2026-11-06T12:02:00Z';};
    assert.equal((await late.start()).body.status,'late');assert.equal(late.s.rows[0].is_late,1);
    const k = world();
    for (let n = 0; n < 1001; n++)
        k.s.rows.push({ assignment_id: id(4), tenant_id: 'tenant', student_enrollment_id: scope.enrollmentId, version: n });
    assert.equal((await k.call('GET', k.basePath + '/submission-policy')).status, 503);
    assert.equal(k.s.signs, 0);
});
test('a deadline crossed during scanning cannot be extended by the initial request admission', async () => {
    const h = world({ scanner: true });
    h.s.assignment.deadline_at = '2026-11-06T12:01:00Z';
    await h.start();
    h.s.afterScan = () => { h.s.clock = '2026-11-06T12:02:00Z'; };
    const result = await h.call('POST', h.basePath + '/submissions/' + h.s.rows[0].id + '/finalize');
    assert.equal(result.status, 403);
    assert.equal(h.s.rows[0].file_size_bytes, 0);
    assert.equal(h.s.rows[0].scan_status, 'pending');
});
test('cancel reuses original audit/cleanup and preserves the durable receipt without another authorization', async () => {
    const h = world();
    await h.start();
    const sid = h.s.rows[0].id;
    const result = await h.call('POST', h.basePath + '/submissions/' + sid + '/cancel');
    assert.equal(result.status, 200);
    assert.equal(result.body.cancelled, true);
    assert.equal((await h.recover()).body.submission.status, 'revoked');
    assert.equal(h.s.signs, 1);
    assert.equal((await h.start()).body.submission.id, sid);
    assert.equal(h.s.rows.length, 1);
});
test('concurrent creation with one key never creates two versions and pure recovery names the winner', async () => {
    const h = world();
    const replies = await Promise.all([h.start(), h.start()]);
    assert.ok(replies.some(reply => reply.status === 201));
    assert.equal(h.s.rows.length, 1);
    assert.equal(h.s.audits.length, 1);
    assert.equal((await h.recover()).body.submission.id, h.s.rows[0].id);
});
test('a durable marker keeps generic access closed after the lesson reference is detached', async () => {
    const h = world();
    await h.start();
    h.s.bindings = [];
    assert.equal((await h.call('GET', `/${id(4)}/submissions/mine`)).status, 403);
    assert.equal((await h.recover()).status, 403);
    assert.equal(h.s.rows.length, 1);
});
