import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeachingWorkspaceRouter } from '../src/routes/teaching-workspace';
import { createSeasonCourseReuseRouter } from '../src/routes/season-course-reuse';
import { createSeasonTemplateImportRouter } from '../src/routes/season-template-import';
import { proveTeachingIdentity, proveTeachingCourse } from '../src/services/teaching-authority';
import { makeReq, runChain, COURSE_A1, UNIT_A1, LESSON_1, OWNER_A, TENANT_A } from './helpers/m2-course-lessons-harness';
import { uid } from './helpers/lesson-package-fixture';
const teacher = uid(777); // Deliberately not the institution owner.
function harness() {
  const s = { identity: true, assigned: true, count: 1, corrupt: false, fail: false, cleanupFail: false, rollback: 0, released: 0, destroyed: 0, sql: [] as Array<{ q: string; p: any[] }> };
  const conn: any = {
    beginTransaction: async () => {}, commit: async () => { throw Error('Read only'); },
    rollback: async () => { s.rollback++; if (s.cleanupFail) throw Error('cleanup'); },
    release: () => { s.released++; }, destroy: () => { s.destroyed++; },
    execute: async (sql: string, p: any[] = []) => {
      const q = sql.replace(/\s+/g, ' ').trim(); s.sql.push({ q, p }); assert.match(q, /^SELECT /);
      if (s.fail) throw Error('Unavailable schema');
      if (q.startsWith('SELECT id AS academic_tenant_id')) return [p[0] === TENANT_A ? [{ academic_tenant_id: TENANT_A }] : [], []];
      if (q.startsWith('SELECT u.id AS teaching_user_id')) return [s.identity && p[0] === TENANT_A && p[1] === teacher && p[2] === 4 ? [{ teaching_user_id: teacher }] : [], []];
      if (q.startsWith('SELECT c.id AS teaching_course_id')) return [s.assigned && p[0] === COURSE_A1 && p[2] === teacher ? [{ teaching_course_id: COURSE_A1 }] : [], []];
      if (q.startsWith('SELECT c.id,c.name')) { assert.deepEqual(p.slice(0, 2), [TENANT_A, teacher]); return [Array.from({ length: s.count }, (_, i) => ({ id: uid(i + 1), name: s.corrupt ? '' : 'Teacher course' })), []]; }
      if (q.startsWith('SELECT l.id,l.unit_id,l.title')) { assert.equal(p[0], COURSE_A1); return [[{ id: LESSON_1, unit_id: UNIT_A1, title: 'Teacher lesson' }], []]; }
      throw Error('Unexpected SQL');
    },
  };
  const router = createTeachingWorkspaceRouter({ getConnection: async () => conn });
  const request = async (path = '/teaching/courses', extra: any = {}) => {
    const req: any = makeReq({ method: 'GET', pathName: path, query: extra.query ?? {}, headers: extra.headers ?? {}, body: extra.body ?? {} });
    req.user = extra.user ?? { id: teacher, tenantId: TENANT_A, role: 'teacher', tokenVersion: 4 };
    req.impersonation = extra.impersonation;
    const r = await runChain([router], req); await new Promise(r => setImmediate(r)); return r;
  };
  return { s, conn, request };
}
test('non-owner teacher discovery is scoped by live teaching identity and course responsibility, with no-store/no writes', async () => {
  const h = harness(), r = await h.request(); assert.equal(r.status, 200); assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.deepEqual(r.body.items, [{ id: uid(1), name: 'Teacher course' }]);
  assert.equal((await h.request(`/teaching/courses/${COURSE_A1}/lessons`)).status, 200);
  assert.equal(h.s.rollback, 2); assert.equal(h.s.released, 2);
  assert.match(h.s.sql[0].q, /AS academic_tenant_id/);
  const proof = h.s.sql[1]; assert.match(proof.q, /u\.token_version=\?/); assert.match(proof.q, /u\.center_account=0/);
  assert.match(proof.q, /NOT EXISTS.*admin_user_roles/); assert.match(proof.q, /m.status='active'/); assert.match(proof.q, /suspended_until/);
  assert.ok(h.s.sql.every(x => !x.q.includes('owner_user_id')));
});
for (const role of ['admin', 'staff', 'student']) test(`${role} cannot acquire academic choices through a selected workspace`, async () => {
  const h = harness(); assert.equal((await h.request(undefined, { user: { id: OWNER_A, tenantId: TENANT_A, role } })).status, 403); assert.equal(h.s.sql.length, 0);
});
for (const kind of ['billing', 'staff-source', 'impersonation', 'header-impersonation', 'revoked', 'stale-token', 'foreign-tenant']) test(`teaching ${kind} authority fails without course/lesson evidence`, async () => {
  const h = harness(), user: any = { id: teacher, tenantId: TENANT_A, role: 'instructor', tokenVersion: 4 }, extra: any = { user };
  if (kind === 'billing') user.billingOnly = true;
  if (kind === 'staff-source') user.identitySource = 'staff';
  if (kind === 'impersonation') extra.impersonation = {};
  if (kind === 'header-impersonation') extra.headers = { 'x-impersonation': 'x' };
  if (kind === 'revoked') h.s.identity = false;
  if (kind === 'stale-token') user.tokenVersion = 3;
  if (kind === 'foreign-tenant') user.tenantId = uid(999);
  assert.equal((await h.request(undefined, extra)).status, 403);
  assert.ok(!h.s.sql.some(x => x.q.includes('FROM courses') || x.q.includes('FROM course_lessons')));
});
test('course handover is reproven before reading lesson names', async () => {
  const h = harness(); h.s.assigned = false;
  assert.equal((await h.request(`/teaching/courses/${COURSE_A1}/lessons`)).status, 404);
  assert.ok(!h.s.sql.some(x => x.q.includes('FROM course_lessons')));
  await assert.rejects(() => proveTeachingCourse(h.conn, { user: { id: teacher, tenantId: TENANT_A } } as any, COURSE_A1));
});
test('bounded keyset pages and corrupt/schema/cleanup failures never invent choices', async () => {
  const h = harness(); h.s.count = 26; const page = await h.request(); assert.equal(page.body.items.length, 25); assert.equal(page.body.next_cursor, uid(25));
  h.s.count = 27; assert.equal((await h.request()).status, 503); h.s.count = 1; h.s.corrupt = true; assert.equal((await h.request()).status, 503);
  h.s.corrupt = false; h.s.fail = true; assert.equal((await h.request()).status, 503);
  const clean = harness(); clean.s.cleanupFail = true; assert.equal((await clean.request()).status, 200); assert.equal(clean.s.destroyed, 1); assert.equal(clean.s.released, 0);
});
test('selectors and extra payloads are rejected before any database read', async () => {
  for (const extra of [{ query: { student_id: uid(3) } }, { query: { cursor: 'bad' } }, { headers: { 'x-tenant-id': TENANT_A } }, { body: { extra: true } }]) {
    const h = harness(); assert.equal((await h.request(undefined, extra)).status, 400); assert.equal(h.s.sql.length, 0);
  }
});
test('identity helper rejects a mismatched returned identity rather than granting current membership', async () => {
  const h = harness(); await assert.rejects(() => proveTeachingIdentity(h.conn, { user: { id: OWNER_A, tenantId: TENANT_A, role: 'teacher', tokenVersion: 4 }, headers: {} } as any));
});
test('platform/operational roles cannot enter season reuse or template import even when tenant-owner-shaped', async () => {
  for (const factory of [createSeasonCourseReuseRouter, createSeasonTemplateImportRouter]) {
    const router = factory({ getConnection: async () => { throw Error('Must not acquire'); } });
    for (const role of ['admin', 'staff', 'student']) {
      const req: any = makeReq({ method: 'GET', pathName: factory === createSeasonCourseReuseRouter ? '/season-reuse/periods' : '/season-template-import/operations/' + uid(999), body: {} });
      req.user = { id: OWNER_A, tenantId: TENANT_A, role, tokenVersion: 0 };
      assert.equal((await runChain([router], req)).status, 403);
    }
  }
});
