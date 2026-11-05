import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogPlaybackAuthority, parseCatalogVideoSelectors, parseCatalogVideoContext, type CatalogVideoContext } from '../src/services/catalog-video-session';
const id = (n: number) => `f1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const principal = { id: 'student', email: null, phone: null, role: 'student', tenantId: id(7), studentEnrollmentId: id(6), sessionId: id(1), tokenVersion: 0, identitySource: 'users' as const };
const selectors = { course_id: id(4), lesson_id: id(5), content_id: id(3) };
function fixture() {
    const s = { schema: true, engine: 'InnoDB', primary: true, login: true, consent: true, grant: true, source: true, binding: true, durable: true, tokenVersion: 0, revision: 100, encryptionKey: 'a'.repeat(32), hls: `${id(2)}/playlist.m3u8`, context: null as CatalogVideoContext | null, rollbackFails: false, beginFails: false, rollbacks: 0, destroys: 0, releases: 0, calls: [] as string[] };
    const connection = { beginTransaction: async () => { if (s.beginFails)
            throw Error('begin'); }, rollback: async () => { s.rollbacks++; if (s.rollbackFails)
            throw Error('rollback'); }, release: () => { s.releases++; }, destroy: () => { s.destroys++; },
        execute: async (sql: string, p: any[] = []): Promise<[
            any,
            any
        ]> => {
            const q = sql.replace(/\s+/g, ' ').trim();
            s.calls.push(q);
            if (q.includes('information_schema.COLUMNS'))
                return [q.includes("TABLE_NAME='video_sessions'") ? (s.schema ? [{ column_name: 'catalog_context' }] : []) : ['id', 'lesson_id', 'video_id', 'display_order'].map(column_name => ({ column_name })), []];
            if (q.includes('information_schema.TABLES'))
                return [['video_sessions', 'login_sessions', 'video_security_consents', 'course_lesson_videos', 'videos', 'course_lesson_contents', 'course_lessons', 'course_units', 'courses', 'tenants', 'users', 'audit_events', 'lectures', 'course_materials', 'students', 'student_courses', 'course_lesson_completions', 'groups', 'branches', 'branch_memberships'].map(table_name => ({ table_name, engine: s.engine })), []];
            if (q.includes('information_schema.STATISTICS')) {
                if (q.includes("IN ('video_sessions','login_sessions')"))
                    return [s.primary ? ['video_sessions', 'login_sessions'].map(table_name => ({ table_name, column_name: 'id', seq_in_index: 1 })) : [], []];
                if (q.includes("TABLE_NAME='videos'"))
                    return [[{ column_name: 'id', seq_in_index: 1 }], []];
                return [['PRIMARY', 'uq_lesson_videos_source', 'uq_lesson_videos_order'].flatMap(index_name => (index_name === 'PRIMARY' ? ['id'] : index_name === 'uq_lesson_videos_source' ? ['lesson_id', 'video_id'] : ['lesson_id', 'display_order']).map((column_name, n) => ({ index_name, column_name, seq_in_index: n + 1, non_unique: 0 }))), []];
            }
            if (q.includes('FROM login_sessions'))
                return [s.login ? [{ id: id(1), user_id: 'student', identity_source: 'users', token_version: 0, issued_at_ms: 1, expires_at_ms: 100000, revoked_at_ms: null }] : [], []];
            if (q.startsWith('SELECT id FROM video_security_consents'))
                return [s.consent ? [{ id: 'consent' }] : [], []];
            if (q.startsWith('SELECT id,is_active'))
                return [[{ id: 'student', is_active: 1, token_version: s.tokenVersion, suspension_active: 0 }], []];
            if (q.includes('FROM students s INNER JOIN tenants'))
                return [s.grant ? [{ enrollment_id: id(6), tenant_id: id(7) }] : [], []];
            if (q.startsWith('SELECT sc.id'))
                return [s.grant ? [{ student_course_id: 'link' }] : [], []];
            if (q.startsWith('SELECT c.id AS course_id'))
                return [[{ course_id: id(4) }], []];
            if (q.startsWith('SELECT l.id,l.prerequisite_lesson_id'))
                return [[{ id: id(5), is_released: 1, is_prerequisite_met: 1 }], []];
            if (q.startsWith('SELECT g.id,g.course_id'))
                return [[{ id: id(8), course_id: id(4), tenant_id: id(7), branch_id: null, branch_scope: 'tenant', instructor_id: 'teacher' }], []];
            if (q.startsWith('SELECT b.id AS content_id,b.video_id'))
                return [s.binding ? [{ content_id: id(3), video_id: id(2), source_id: id(2), display_order: 0, title: 'Private course video', status: 'ready', is_encrypted: 1, hls_key: s.hls, original_key: 'private-original' }] : [], []];
            if (q.startsWith('SELECT id,display_order'))
                return [[], []];
            if (q.startsWith('SELECT id,is_encrypted'))
                return [s.source ? [{ id: id(2), is_encrypted: 1, hls_key: s.hls, original_key: 'private-original', encryption_key: s.encryptionKey, revision: s.revision }] : [], []];
            if (q.startsWith('SELECT catalog_context')) {
                assert.deepEqual(p, [id(10), 'student', id(2)]);
                return [s.durable ? [{ catalog_context: s.context === null ? null : JSON.stringify(s.context) }] : [], []];
            }
            if (q.startsWith('SELECT id FROM course_lesson_videos'))
                return [s.binding ? [{ id: id(3) }] : [], []];
            throw Error('Unexpected SQL ' + q);
        } };
    const authority = createCatalogPlaybackAuthority({ getConnection: async () => connection as any, now: () => 10000, termsVersion: 'video-security-v1' });
    const session = () => ({ sessionId: id(10), userId: 'student', videoId: id(2), tenantId: id(7), studentEnrollmentId: id(6), previewOnly: false, ...(s.context ? { catalogContext: s.context } : {}) });
    return { s, authority, session, resolve: () => authority.resolve(principal, selectors) };
}
test('catalog context is exact, canonical, bounded and never accepts a client authority or source fingerprint', () => {
    assert.deepEqual(parseCatalogVideoSelectors(selectors), selectors);
    for (const value of [{ ...selectors, tenant_id: id(7) }, { ...selectors, video_id: id(2) }, { ...selectors, content_id: 'bad' }, null])
        assert.throws(() => parseCatalogVideoSelectors(value));
    assert.throws(() => parseCatalogVideoContext({}));
});
test('catalog authority resolves a live login/consent/reference and verifies identical durable context privately', async () => {
    const h = fixture(), resolved = await h.resolve();
    assert.ok(resolved);
    assert.equal(resolved.videoId, id(2));
    assert.equal(resolved.context.sourceFingerprint.length, 64);
    assert.ok(!JSON.stringify(resolved).includes('private-original'));
    assert.ok(!JSON.stringify(resolved).includes('a'.repeat(32)));
    h.s.context = resolved.context;
    assert.equal(await h.authority.check(h.session()), true);
    assert.equal(h.s.rollbacks, 2);
    assert.equal(h.s.releases, 2);
    assert.ok(!h.s.calls.some(q => /^(INSERT|UPDATE|DELETE)/.test(q)));
});
for (const cause of ['schema', 'engine', 'primary'] as const)
    test(`catalog ${cause} readiness fails closed`, async () => {
        const h = fixture();
        if (cause === 'engine')
            h.s.engine = 'MyISAM';
        else
            h.s[cause] = false;
        await assert.rejects(h.resolve());
        assert.equal(h.s.destroys, 0);
        assert.equal(h.s.rollbacks, 1);
    });
for (const cause of ['login', 'consent', 'grant', 'source', 'binding'] as const)
    test(`catalog ${cause} is required at issuance and again during delivery`, async () => {
        const h = fixture(), resolved = await h.resolve();
        assert.ok(resolved);
        h.s.context = resolved.context;
        h.s[cause] = false;
        assert.equal(await h.authority.check(h.session()), false);
        assert.equal(await h.resolve(), null);
    });
for (const cause of ['key', 'revision', 'path', 'user-version'] as const)
    test(`catalog context pins source/session identity after ${cause} changes`, async () => {
        const h = fixture(), resolved = await h.resolve();
        assert.ok(resolved);
        h.s.context = resolved.context;
        if (cause === 'key')
            h.s.encryptionKey = 'b'.repeat(32);
        if (cause === 'revision')
            h.s.revision++;
        if (cause === 'path')
            h.s.hls = 'foreign/playlist.m3u8';
        if (cause === 'user-version')
            h.s.tokenVersion++;
        assert.equal(await h.authority.check(h.session()), false);
    });
test('catalog durable row/context/preview or ownership mismatch cannot fall back to course access', async () => {
    const h = fixture(), resolved = await h.resolve();
    assert.ok(resolved);
    const context = resolved.context;
    h.s.context = context;
    const session = h.session();
    h.s.context = { ...context, lessonId: id(99) };
    assert.equal(await h.authority.check(session), false);
    h.s.context = context;
    h.s.durable = false;
    assert.equal(await h.authority.check(session), false);
    h.s.durable = true;
    assert.equal(await h.authority.check({ ...session, previewOnly: true }), false);
    assert.equal(await h.authority.check({ ...session, tenantId: 'foreign' }), false);
    assert.equal(await h.authority.check({ ...session, catalogContext: undefined }), false);
});
test('catalog source requires exact encrypted HLS namespace and AES key metadata; no login session means no issue', async () => {
    const h = fixture();
    h.s.encryptionKey = 'invalid';
    assert.equal(await h.resolve(), null);
    h.s.encryptionKey = 'a'.repeat(32);
    h.s.hls = 'private-original';
    assert.equal(await h.resolve(), null);
    assert.equal(await h.authority.resolve({ ...principal, sessionId: undefined }, selectors), null);
});
test('catalog read transaction begin/rollback failures discard the connection without a usable result', async () => {
    const h = fixture();
    h.s.rollbackFails = true;
    await assert.rejects(h.resolve());
    assert.equal(h.s.destroys, 1);
    const begin = fixture();
    begin.s.beginFails = true;
    await assert.rejects(begin.resolve());
    assert.equal(begin.s.destroys, 1);
    assert.equal(begin.s.rollbacks, 0);
});
test('generic fallback check follows current catalog references and only returns a boolean', async () => {
    const h = fixture();
    assert.equal(await h.authority.hasBindings(id(2)), true);
    h.s.binding = false;
    assert.equal(await h.authority.hasBindings(id(2)), false);
});
